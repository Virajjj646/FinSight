import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

test(
  "50 concurrent partial payments against one invoice never overpay it",
  { skip },
  async () => {
    const { db } = await import("../../src/infrastructure/db/index.js");
    const { eq } = await import("drizzle-orm");
    const { tenants, accounts, invoices, invoicePayments } = await import(
      "../../src/infrastructure/db/schema.js"
    );
    const { createInvoice, issueInvoice, createInvoicePayment } = await import(
      "../../src/modules/invoices/invoice.service.js"
    );

    await truncateAll();

    const [tenant] = await db.insert(tenants).values({ name: "Concurrency Co" }).returning();
    const [bank] = await db
      .insert(accounts)
      .values({ tenantId: tenant.id, name: "Bank", type: "ASSET", currency: "USD" })
      .returning();
    const [ar] = await db
      .insert(accounts)
      .values({ tenantId: tenant.id, name: "Accounts Receivable", type: "ASSET", currency: "USD" })
      .returning();

    const draftInvoice = await createInvoice({
      tenantId: tenant.id,
      customerName: "Concurrency Customer",
      currency: "USD",
      dueDate: new Date(Date.now() + 86400000).toISOString(),
      // total = 1000 minor units; 50 payments of 30 each (1500) oversubscribe it on purpose.
      items: [{ description: "Service", quantity: 1000, unitPriceMinor: 1n }],
    });
    await issueInvoice(draftInvoice.id, tenant.id);

    const PAYMENT_AMOUNT = 30n;
    const attempts = Array.from({ length: 50 }, (_, i) =>
      createInvoicePayment({
        invoiceId: draftInvoice.id,
        tenantId: tenant.id,
        amountMinor: PAYMENT_AMOUNT,
        paidAt: new Date(),
        bankAccountId: bank.id,
        accountReceivableAccountId: ar.id,
        idempotencyKey: `payment-${i}`,
      })
    );

    const results = await Promise.allSettled(attempts);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    assert.ok(succeeded.length > 0, "at least some payments must succeed");
    assert.ok(failed.length > 0, "the oversubscribed payments must be rejected, not silently accepted");
    for (const failure of failed) {
      assert.equal(failure.reason.status, 422, "surplus payments must fail with 422, not a 5xx");
    }

    const rows = await db
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, draftInvoice.id));
    const totalPaid = rows.reduce((sum, row) => sum + row.amountMinor, 0n);

    assert.equal(rows.length, succeeded.length, "one payment row per successful attempt");
    assert.ok(
      totalPaid <= draftInvoice.totalAmountMinor,
      `sum of payments (${totalPaid}) must never exceed the invoice total (${draftInvoice.totalAmountMinor})`
    );

    const [finalInvoice] = await db.select().from(invoices).where(eq(invoices.id, draftInvoice.id));
    const expectedStatus = totalPaid === draftInvoice.totalAmountMinor ? "PAID" : "PARTIALLY_PAID";
    assert.equal(finalInvoice.status, expectedStatus);

    await truncateAll();
  }
);

after(async () => {
  if (!testDbAvailable) return;
  await closeTestDb();
});
