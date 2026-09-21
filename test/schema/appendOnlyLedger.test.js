import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

async function seedEntry() {
  const { db } = await import("../../src/infrastructure/db/index.js");
  const { tenants, accounts } = await import("../../src/infrastructure/db/schema.js");
  const { createJournalEntry } = await import("../../src/modules/ledger/ledger.service.js");

  const [tenant] = await db.insert(tenants).values({ name: "Append Only Co" }).returning();
  const [bank] = await db
    .insert(accounts)
    .values({ tenantId: tenant.id, name: "Bank", type: "ASSET", currency: "USD" })
    .returning();
  const [revenue] = await db
    .insert(accounts)
    .values({ tenantId: tenant.id, name: "Revenue", type: "REVENUE", currency: "USD" })
    .returning();

  const { entry, lines } = await createJournalEntry({
    tenantId: tenant.id,
    idempotencyKey: "append-only-seed",
    data: {
      description: "Seed sale",
      occurredAt: new Date(),
      lines: [
        { accountId: bank.id, amountMinor: 100n },
        { accountId: revenue.id, amountMinor: -100n },
      ],
    },
  });

  return { db, tenant, entry, lines };
}

const isAppendOnlyViolation = (error) =>
  /append-only|can only be set once/.test(error.cause?.message ?? error.message ?? "");

test("entry_lines rows cannot be updated", { skip }, async () => {
  const { db, lines } = await seedEntry();
  const { sql } = await import("drizzle-orm");

  await assert.rejects(
    () => db.execute(sql`update entry_lines set amount_minor = 999 where id = ${lines[0].id}`),
    isAppendOnlyViolation,
    "updating an entry_lines row must be rejected"
  );
});

test("entry_lines rows cannot be deleted", { skip }, async () => {
  const { db, lines } = await seedEntry();
  const { sql } = await import("drizzle-orm");

  await assert.rejects(
    () => db.execute(sql`delete from entry_lines where id = ${lines[0].id}`),
    isAppendOnlyViolation,
    "deleting an entry_lines row must be rejected"
  );
});

test("journal_entries rows cannot be deleted", { skip }, async () => {
  const { db, entry } = await seedEntry();
  const { sql } = await import("drizzle-orm");

  await assert.rejects(
    () => db.execute(sql`delete from journal_entries where id = ${entry.id}`),
    isAppendOnlyViolation,
    "deleting a journal_entries row must be rejected"
  );
});

test("journal_entries rows cannot have any column but reversed_by_entry_id changed", { skip }, async () => {
  const { db, entry } = await seedEntry();
  const { sql } = await import("drizzle-orm");

  await assert.rejects(
    () => db.execute(sql`update journal_entries set description = 'edited' where id = ${entry.id}`),
    isAppendOnlyViolation,
    "editing description must be rejected even without touching reversed_by_entry_id"
  );
});

test("journal_entries.reversed_by_entry_id can be set exactly once, and never twice", { skip }, async () => {
  const { db, tenant, entry } = await seedEntry();
  const { sql } = await import("drizzle-orm");
  const { journalEntries } = await import("../../src/infrastructure/db/schema.js");

  const [reversal] = await db
    .insert(journalEntries)
    .values({
      tenantId: tenant.id,
      description: "Reversal of seed sale",
      occurredAt: new Date(),
      idempotencyKey: "append-only-reversal",
      requestFingerprint: "test-fingerprint",
    })
    .returning();

  // Setting it the first time, from NULL, must be allowed.
  await db.execute(
    sql`update journal_entries set reversed_by_entry_id = ${reversal.id} where id = ${entry.id}`
  );

  // Setting it again, now that it's non-NULL, must be rejected.
  await assert.rejects(
    () =>
      db.execute(
        sql`update journal_entries set reversed_by_entry_id = ${reversal.id} where id = ${entry.id}`
      ),
    isAppendOnlyViolation,
    "reversed_by_entry_id must only be settable once"
  );
});

after(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  await closeTestDb();
});
