import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

async function loadDeps() {
  const { db } = await import("../../src/infrastructure/db/index.js");
  const { tenants, accounts } = await import("../../src/infrastructure/db/schema.js");
  const { createJournalEntry } = await import("../../src/modules/ledger/ledger.service.js");
  return { db, tenants, accounts, createJournalEntry };
}

test("replaying the same Idempotency-Key with the same body returns the original entry", { skip }, async () => {
  const { db, tenants, accounts, createJournalEntry } = await loadDeps();
  await truncateAll();

  const [tenant] = await db.insert(tenants).values({ name: "Replay Co" }).returning();
  const [bank] = await db
    .insert(accounts)
    .values({ tenantId: tenant.id, name: "Bank", type: "ASSET", currency: "USD" })
    .returning();
  const [revenue] = await db
    .insert(accounts)
    .values({ tenantId: tenant.id, name: "Revenue", type: "REVENUE", currency: "USD" })
    .returning();

  const data = {
    description: "Sale",
    occurredAt: new Date(),
    lines: [
      { accountId: bank.id, amountMinor: 100n },
      { accountId: revenue.id, amountMinor: -100n },
    ],
  };

  const first = await createJournalEntry({ tenantId: tenant.id, idempotencyKey: "same-body", data });
  const replay = await createJournalEntry({ tenantId: tenant.id, idempotencyKey: "same-body", data });

  assert.equal(replay.entry.id, first.entry.id);
  assert.equal(replay.replayed, true);
  assert.equal(first.replayed, false);
});

test("reusing the same Idempotency-Key with a different body is rejected with 409", { skip }, async () => {
  const { db, tenants, accounts, createJournalEntry } = await loadDeps();
  await truncateAll();

  const [tenant] = await db.insert(tenants).values({ name: "Replay Co" }).returning();
  const [bank] = await db
    .insert(accounts)
    .values({ tenantId: tenant.id, name: "Bank", type: "ASSET", currency: "USD" })
    .returning();
  const [revenue] = await db
    .insert(accounts)
    .values({ tenantId: tenant.id, name: "Revenue", type: "REVENUE", currency: "USD" })
    .returning();

  await createJournalEntry({
    tenantId: tenant.id,
    idempotencyKey: "conflicting-body",
    data: {
      description: "Sale A",
      occurredAt: new Date(),
      lines: [
        { accountId: bank.id, amountMinor: 100n },
        { accountId: revenue.id, amountMinor: -100n },
      ],
    },
  });

  await assert.rejects(
    () =>
      createJournalEntry({
        tenantId: tenant.id,
        idempotencyKey: "conflicting-body",
        data: {
          description: "Sale B (different amount)",
          occurredAt: new Date(),
          lines: [
            { accountId: bank.id, amountMinor: 200n },
            { accountId: revenue.id, amountMinor: -200n },
          ],
        },
      }),
    (error) => error.status === 409 && error.code === "IDEMPOTENCY_KEY_REUSED"
  );
});

after(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  await closeTestDb();
});
