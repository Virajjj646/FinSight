import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

test("voidInvoice finds the invoice by its own id, not a reversed comparison", { skip }, async () => {
  const { db } = await import("../../src/infrastructure/db/index.js");
  const { tenants } = await import("../../src/infrastructure/db/schema.js");
  const { createInvoice, voidInvoice } = await import("../../src/modules/invoices/invoice.service.js");

  await truncateAll();

  const [tenant] = await db.insert(tenants).values({ name: "Acme Co" }).returning();

  const invoice = await createInvoice({
    tenantId: tenant.id,
    customerName: "Test Customer",
    currency: "USD",
    dueDate: new Date(Date.now() + 86400000).toISOString(),
    items: [{ description: "Widget", quantity: 1, unitPriceMinor: 100n }],
  });

  const voided = await voidInvoice(invoice.id, tenant.id);

  assert.ok(voided, "voidInvoice should find and return the invoice");
  assert.equal(voided.id, invoice.id);
  assert.equal(voided.status, "VOID");

  await truncateAll();
});

test(
  "void racing a concurrent full payment never results in VOID with payments recorded",
  { skip },
  async () => {
    const { db } = await import("../../src/infrastructure/db/index.js");
    const { eq } = await import("drizzle-orm");
    const { tenants, accounts, invoices, invoicePayments } = await import(
      "../../src/infrastructure/db/schema.js"
    );
    const { createInvoice, issueInvoice, createInvoicePayment, voidInvoice } = await import(
      "../../src/modules/invoices/invoice.service.js"
    );

    await truncateAll();

    const [tenant] = await db.insert(tenants).values({ name: "Race Co" }).returning();
    const [bank] = await db
      .insert(accounts)
      .values({ tenantId: tenant.id, name: "Bank", type: "ASSET", currency: "USD" })
      .returning();
    const [ar] = await db
      .insert(accounts)
      .values({ tenantId: tenant.id, name: "Accounts Receivable", type: "ASSET", currency: "USD" })
      .returning();

    for (let i = 0; i < 20; i++) {
      const invoice = await createInvoice({
        tenantId: tenant.id,
        customerName: "Race Customer",
        currency: "USD",
        dueDate: new Date(Date.now() + 86400000).toISOString(),
        items: [{ description: "Widget", quantity: 1, unitPriceMinor: 100n }],
      });
      await issueInvoice(invoice.id, tenant.id);

      const [paymentResult, voidResult] = await Promise.allSettled([
        createInvoicePayment({
          invoiceId: invoice.id,
          tenantId: tenant.id,
          amountMinor: 100n,
          paidAt: new Date(),
          bankAccountId: bank.id,
          accountReceivableAccountId: ar.id,
          idempotencyKey: `race-payment-${i}`,
        }),
        voidInvoice(invoice.id, tenant.id),
      ]);

      const [final] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
      const payments = await db
        .select()
        .from(invoicePayments)
        .where(eq(invoicePayments.invoiceId, invoice.id));

      assert.ok(
        final.status === "PAID" || final.status === "VOID",
        `iteration ${i}: final status must be a legal outcome, got ${final.status}`
      );

      if (final.status === "VOID") {
        assert.equal(
          payments.length,
          0,
          `iteration ${i}: a VOID invoice must never have payments recorded`
        );
        assert.equal(voidResult.status, "fulfilled", `iteration ${i}: void should have won the race`);
        assert.equal(
          paymentResult.status,
          "rejected",
          `iteration ${i}: payment must be rejected once the invoice is void`
        );
      } else {
        assert.equal(payments.length, 1, `iteration ${i}: a PAID invoice must have its payment recorded`);
        assert.equal(paymentResult.status, "fulfilled", `iteration ${i}: payment should have won the race`);
        assert.equal(
          voidResult.status,
          "rejected",
          `iteration ${i}: void must be rejected once the invoice is paid`
        );
      }
    }

    await truncateAll();
  }
);

test("voidInvoice rejects an invoice that has payments recorded", { skip }, async () => {
  const { db } = await import("../../src/infrastructure/db/index.js");
  const { eq } = await import("drizzle-orm");
  const { tenants, accounts, invoices } = await import("../../src/infrastructure/db/schema.js");
  const { createInvoice, issueInvoice, createInvoicePayment, voidInvoice } = await import(
    "../../src/modules/invoices/invoice.service.js"
  );

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

  const invoice = await createInvoice({
    tenantId: tenant.id,
    customerName: "Test Customer",
    currency: "USD",
    dueDate: new Date(Date.now() + 86400000).toISOString(),
    items: [{ description: "Widget", quantity: 3, unitPriceMinor: 100n }],
  });
  await issueInvoice(invoice.id, tenant.id);

  await createInvoicePayment({
    invoiceId: invoice.id,
    tenantId: tenant.id,
    amountMinor: 100n,
    paidAt: new Date(),
    bankAccountId: bank.id,
    accountReceivableAccountId: ar.id,
    idempotencyKey: "partial-payment-1",
  });

  await assert.rejects(
    () => voidInvoice(invoice.id, tenant.id),
    (error) => error.status === 422 && error.code === "INVOICE_HAS_PAYMENTS",
    "voiding an invoice with recorded payments must be rejected with 422 INVOICE_HAS_PAYMENTS"
  );

  const [reloaded] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
  assert.equal(reloaded.status, "PARTIALLY_PAID", "status must be unchanged after the rejected void");

  await truncateAll();
});

after(async () => {
  if (!testDbAvailable) return;
  await closeTestDb();
});
