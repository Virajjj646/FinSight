import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

async function loadDeps() {
  const { db } = await import("../../src/infrastructure/db/index.js");
  const { tenants, invoices } = await import("../../src/infrastructure/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { createInvoice, issueInvoice, markOverdueInvoices } = await import(
    "../../src/modules/invoices/invoice.service.js"
  );
  return { db, tenants, invoices, eq, createInvoice, issueInvoice, markOverdueInvoices };
}

test("markOverdueInvoices flips past-due ISSUED invoices to OVERDUE", { skip }, async () => {
  const { db, tenants, createInvoice, issueInvoice, markOverdueInvoices } = await loadDeps();

  await truncateAll();

  const [tenant] = await db.insert(tenants).values({ name: "Acme Co" }).returning();

  const invoice = await createInvoice({
    tenantId: tenant.id,
    customerName: "Test Customer",
    currency: "USD",
    dueDate: new Date(Date.now() - 86400000).toISOString(),
    items: [{ description: "Widget", quantity: 1, unitPriceMinor: 100n }],
  });
  await issueInvoice(invoice.id, tenant.id);

  const updated = await markOverdueInvoices();

  assert.equal(updated.length, 1, "markOverdueInvoices should not throw and should update the invoice");
  assert.equal(updated[0].id, invoice.id);
  assert.equal(updated[0].status, "OVERDUE");
});

test("markOverdueInvoices must not resurrect a concurrently voided invoice", { skip }, async () => {
  const { db, tenants, invoices, eq, createInvoice, issueInvoice, markOverdueInvoices } = await loadDeps();

  await truncateAll();

  const [tenant] = await db.insert(tenants).values({ name: "Acme Co" }).returning();

  const invoice = await createInvoice({
    tenantId: tenant.id,
    customerName: "Test Customer",
    currency: "USD",
    dueDate: new Date(Date.now() - 86400000).toISOString(),
    items: [{ description: "Widget", quantity: 1, unitPriceMinor: 100n }],
  });
  await issueInvoice(invoice.id, tenant.id);

  // Hold a row lock so we control exactly when markOverdueInvoices' inner UPDATE
  // is allowed to see the row: it will block until we commit the VOID below,
  // then must re-evaluate its WHERE clause against that committed state.
  const lockClient = new Client({ connectionString: process.env.DATABASE_URL_TEST });
  await lockClient.connect();
  await lockClient.query("BEGIN");
  await lockClient.query("SELECT status FROM invoices WHERE id = $1 FOR UPDATE", [invoice.id]);

  const markOverduePromise = markOverdueInvoices();

  await lockClient.query("UPDATE invoices SET status = 'VOID' WHERE id = $1", [invoice.id]);
  await lockClient.query("COMMIT");
  await lockClient.end();

  await markOverduePromise;

  const [reloaded] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));

  assert.equal(
    reloaded.status,
    "VOID",
    "a concurrently voided invoice must not be flipped back to OVERDUE"
  );
});

after(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  await closeTestDb();
});
