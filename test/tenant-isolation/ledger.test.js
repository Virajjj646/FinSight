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

test("tenant A and tenant B can both use idempotency key 'key-1' and get back their own entry", { skip }, async () => {
  const { db, tenants, accounts, createJournalEntry } = await loadDeps();

  await truncateAll();

  const [tenantA] = await db.insert(tenants).values({ name: "Tenant A" }).returning();
  const [tenantB] = await db.insert(tenants).values({ name: "Tenant B" }).returning();

  const [bankA] = await db
    .insert(accounts)
    .values({ tenantId: tenantA.id, name: "Bank", type: "ASSET", currency: "USD" })
    .returning();
  const [revenueA] = await db
    .insert(accounts)
    .values({ tenantId: tenantA.id, name: "Revenue", type: "REVENUE", currency: "USD" })
    .returning();
  const [bankB] = await db
    .insert(accounts)
    .values({ tenantId: tenantB.id, name: "Bank", type: "ASSET", currency: "USD" })
    .returning();
  const [revenueB] = await db
    .insert(accounts)
    .values({ tenantId: tenantB.id, name: "Revenue", type: "REVENUE", currency: "USD" })
    .returning();

  const occurredAtA = new Date();
  const entryA = await createJournalEntry({
    tenantId: tenantA.id,
    idempotencyKey: "key-1",
    data: {
      description: "A's sale",
      occurredAt: occurredAtA,
      lines: [
        { accountId: bankA.id, amountMinor: 100n },
        { accountId: revenueA.id, amountMinor: -100n },
      ],
    },
  });

  const entryB = await createJournalEntry({
    tenantId: tenantB.id,
    idempotencyKey: "key-1",
    data: {
      description: "B's sale",
      occurredAt: new Date(),
      lines: [
        { accountId: bankB.id, amountMinor: 200n },
        { accountId: revenueB.id, amountMinor: -200n },
      ],
    },
  });

  assert.notEqual(entryA.entry.id, entryB.entry.id, "each tenant must get its own entry for the same key");
  assert.equal(entryA.entry.tenantId, tenantA.id);
  assert.equal(entryB.entry.tenantId, tenantB.id);

  // A true retry must resend the exact same body; request fingerprinting
  // (Phase 4) treats a different body under the same key as a client bug,
  // not a retry, so this must match entryA's payload exactly.
  const replayA = await createJournalEntry({
    tenantId: tenantA.id,
    idempotencyKey: "key-1",
    data: {
      description: "A's sale",
      occurredAt: occurredAtA,
      lines: [
        { accountId: bankA.id, amountMinor: 100n },
        { accountId: revenueA.id, amountMinor: -100n },
      ],
    },
  });
  assert.equal(replayA.entry.id, entryA.entry.id, "replaying tenant A's key must return tenant A's original entry");
});

test("tenant A cannot post a journal entry against tenant B's account", { skip }, async () => {
  const { db, tenants, accounts, createJournalEntry } = await loadDeps();

  await truncateAll();

  const [tenantA] = await db.insert(tenants).values({ name: "Tenant A" }).returning();
  const [tenantB] = await db.insert(tenants).values({ name: "Tenant B" }).returning();

  const [bankA] = await db
    .insert(accounts)
    .values({ tenantId: tenantA.id, name: "Bank", type: "ASSET", currency: "USD" })
    .returning();
  const [revenueB] = await db
    .insert(accounts)
    .values({ tenantId: tenantB.id, name: "Revenue", type: "REVENUE", currency: "USD" })
    .returning();

  await assert.rejects(
    () =>
      createJournalEntry({
        tenantId: tenantA.id,
        idempotencyKey: "cross-tenant-attempt",
        data: {
          description: "Should not be allowed",
          occurredAt: new Date(),
          lines: [
            { accountId: bankA.id, amountMinor: 100n },
            { accountId: revenueB.id, amountMinor: -100n },
          ],
        },
      }),
    (error) => error.status === 422,
    "referencing another tenant's account must be rejected, not silently allowed"
  );
});

after(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  await closeTestDb();
});
