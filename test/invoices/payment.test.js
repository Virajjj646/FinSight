import { test } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

test("createInvoicePayment records a payment end to end and stamps updatedAt", { skip }, async () => {
  const { db } = await import("../../src/infrastructure/db/index.js");
  const { tenants, accounts } = await import("../../src/infrastructure/db/schema.js");
  const { createInvoice, issueInvoice, createInvoicePayment } = await import(
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
    items: [{ description: "Widget", quantity: 2, unitPriceMinor: 500n }],
  });
  await issueInvoice(invoice.id, tenant.id);

  const result = await createInvoicePayment({
    invoiceId: invoice.id,
    tenantId: tenant.id,
    amountMinor: 1000n,
    paidAt: new Date(),
    bankAccountId: bank.id,
    accountReceivableAccountId: ar.id,
    idempotencyKey: "payment-1",
  });

  assert.equal(result.invoice.status, "PAID");
  assert.ok(result.invoice.updatedAt instanceof Date, "updatedAt should be a Date, not undefined");
  assert.notEqual(
    result.invoice.updatedAt.getTime(),
    invoice.updatedAt.getTime(),
    "updatedAt should change after the payment is applied"
  );

  await truncateAll();
  await closeTestDb();
});
