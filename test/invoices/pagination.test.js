import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

test(
  "listInvoices pages through 25 concurrently created invoices with no gaps or duplicates",
  { skip },
  async () => {
    const { db } = await import("../../src/infrastructure/db/index.js");
    const { tenants } = await import("../../src/infrastructure/db/schema.js");
    const { createInvoice, listInvoices } = await import("../../src/modules/invoices/invoice.service.js");

    await truncateAll();

    const [tenant] = await db.insert(tenants).values({ name: "Pagination Co" }).returning();

    const created = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        createInvoice({
          tenantId: tenant.id,
          customerName: `Customer ${i}`,
          currency: "USD",
          dueDate: new Date(Date.now() + 86400000).toISOString(),
          items: [{ description: "Widget", quantity: 1, unitPriceMinor: 100n }],
        })
      )
    );
    assert.equal(created.length, 25);

    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const { data, nextCursor } = await listInvoices({ tenantId: tenant.id, limit: 10, cursor });
      seen.push(...data.map((row) => row.id));
      cursor = nextCursor;
      pages += 1;
      assert.ok(pages <= 10, "pagination should terminate well within 10 pages of 10 rows each");
    } while (cursor);

    assert.equal(seen.length, 25, "exactly 25 rows must be returned across all pages, no duplicates or gaps");
    assert.equal(new Set(seen).size, 25, "every invoice ID returned must be distinct");

    const createdIds = new Set(created.map((inv) => inv.id));
    for (const id of seen) {
      assert.ok(createdIds.has(id), `unexpected invoice id ${id} not among the 25 created`);
    }

    await truncateAll();
  }
);

after(async () => {
  if (!testDbAvailable) return;
  await closeTestDb();
});
