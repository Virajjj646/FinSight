import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

test(
  "50 concurrent journal entries sharing one Idempotency-Key collapse to a single entry",
  { skip },
  async () => {
    const { db } = await import("../../src/infrastructure/db/index.js");
    const { eq } = await import("drizzle-orm");
    const { tenants, accounts, journalEntries, entryLines } = await import(
      "../../src/infrastructure/db/schema.js"
    );
    const { createJournalEntry } = await import("../../src/modules/ledger/ledger.service.js");

    await truncateAll();

    const [tenant] = await db.insert(tenants).values({ name: "Concurrency Co" }).returning();
    const [bank] = await db
      .insert(accounts)
      .values({ tenantId: tenant.id, name: "Bank", type: "ASSET", currency: "USD" })
      .returning();
    const [revenue] = await db
      .insert(accounts)
      .values({ tenantId: tenant.id, name: "Revenue", type: "REVENUE", currency: "USD" })
      .returning();

    // Same Date instance for every attempt: the request fingerprint hashes
    // occurredAt, so two calls that differ even by a millisecond would be
    // treated as conflicting bodies for the same key, not as retries.
    const occurredAt = new Date();
    const attempts = Array.from({ length: 50 }, () =>
      createJournalEntry({
        tenantId: tenant.id,
        idempotencyKey: "concurrent-key",
        data: {
          description: "Concurrent sale",
          occurredAt,
          lines: [
            { accountId: bank.id, amountMinor: 100n },
            { accountId: revenue.id, amountMinor: -100n },
          ],
        },
      })
    );

    // Promise.all (not allSettled): every one of the 50 must resolve, none may reject.
    const results = await Promise.all(attempts);

    const entryIds = new Set(results.map((r) => r.entry.id));
    assert.equal(entryIds.size, 1, "all 50 responses must carry the same entry ID");

    const entryRows = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.tenantId, tenant.id));
    assert.equal(entryRows.length, 1, "exactly one journal_entries row must exist");

    const lineRows = await db
      .select()
      .from(entryLines)
      .where(eq(entryLines.entryId, entryRows[0].id));
    assert.equal(lineRows.length, 2, "exactly N entry_lines rows must exist for the single entry");

    await truncateAll();
  }
);

after(async () => {
  if (!testDbAvailable) return;
  await closeTestDb();
});
