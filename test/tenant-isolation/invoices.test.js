import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

async function loadDeps() {
  const { db } = await import("../../src/infrastructure/db/index.js");
  const { tenants, accounts, invoices } = await import("../../src/infrastructure/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { createInvoice, issueInvoice, voidInvoice, createInvoicePayment } = await import(
    "../../src/modules/invoices/invoice.service.js"
  );
  return { db, tenants, accounts, invoices, eq, createInvoice, issueInvoice, voidInvoice, createInvoicePayment };
}

test("tenant B cannot issue, pay, or void tenant A's invoice", { skip }, async () => {
  const { db, tenants, accounts, invoices, eq, createInvoice, issueInvoice, voidInvoice, createInvoicePayment } =
    await loadDeps();

  await truncateAll();

  const [tenantA] = await db.insert(tenants).values({ name: "Tenant A" }).returning();
  const [tenantB] = await db.insert(tenants).values({ name: "Tenant B" }).returning();

  const [bankA] = await db
    .insert(accounts)
    .values({ tenantId: tenantA.id, name: "Bank", type: "ASSET", currency: "USD" })
    .returning();
  const [arA] = await db
    .insert(accounts)
    .values({ tenantId: tenantA.id, name: "Accounts Receivable", type: "ASSET", currency: "USD" })
    .returning();

  const invoiceA = await createInvoice({
    tenantId: tenantA.id,
    customerName: "Customer A",
    currency: "USD",
    dueDate: new Date(Date.now() + 86400000).toISOString(),
    items: [{ description: "Widget", quantity: 1, unitPriceMinor: 500n }],
  });

  await assert.rejects(
    () => issueInvoice(invoiceA.id, tenantB.id),
    (error) => error.status === 404,
    "tenant B issuing tenant A's invoice must 404"
  );

  await assert.rejects(
    () =>
      createInvoicePayment({
        invoiceId: invoiceA.id,
        tenantId: tenantB.id,
        amountMinor: 500n,
        paidAt: new Date(),
        bankAccountId: bankA.id,
        accountReceivableAccountId: arA.id,
      }),
    (error) => error.status === 404,
    "tenant B paying tenant A's invoice must 404"
  );

  await assert.rejects(
    () => voidInvoice(invoiceA.id, tenantB.id),
    (error) => error.status === 404,
    "tenant B voiding tenant A's invoice must 404"
  );

  const [unchanged] = await db.select().from(invoices).where(eq(invoices.id, invoiceA.id));
  assert.equal(unchanged.status, "DRAFT", "tenant A's invoice must be untouched by tenant B's attempts");

  const issued = await issueInvoice(invoiceA.id, tenantA.id);
  assert.equal(issued.status, "ISSUED", "tenant A can still issue its own invoice");
});

after(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  await closeTestDb();
});
