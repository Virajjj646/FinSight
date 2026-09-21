import { test } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

test("a direct unbalanced entry_lines insert is rejected at commit by the zero-sum trigger", { skip }, async () => {
  const { db } = await import("../../src/infrastructure/db/index.js");
  const { sql } = await import("drizzle-orm");
  const { tenants, accounts } = await import("../../src/infrastructure/db/schema.js");

  await truncateAll();

  const [tenant] = await db.insert(tenants).values({ name: "Acme Co" }).returning();
  const [bank] = await db
    .insert(accounts)
    .values({ tenantId: tenant.id, name: "Bank", type: "ASSET", currency: "USD" })
    .returning();
  const [ar] = await db
    .insert(accounts)
    .values({ tenantId: tenant.id, name: "Accounts Receivable", type: "ASSET", currency: "USD" })
    .returning();

  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        const [entry] = await tx
          .execute(
            sql`insert into journal_entries (tenant_id, description, occurred_at, idempotency_key, request_fingerprint)
                values (${tenant.id}, ${"unbalanced raw insert"}, now(), ${"unbalanced-test-key"}, ${"test-fingerprint"})
                returning id`
          )
          .then((res) => res.rows);

        await tx.execute(
          sql`insert into entry_lines (entry_id, account_id, tenant_id, amount_minor)
              values (${entry.id}, ${bank.id}, ${tenant.id}, 100)`
        );
        await tx.execute(
          sql`insert into entry_lines (entry_id, account_id, tenant_id, amount_minor)
              values (${entry.id}, ${ar.id}, ${tenant.id}, -50)`
        );
      }),
    (error) => /do not balance to zero/.test(error.cause?.message ?? error.message),
    "the deferred constraint trigger should raise at commit when lines for an entry don't sum to zero"
  );

  await truncateAll();
  await closeTestDb();
});
