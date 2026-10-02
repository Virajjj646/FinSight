import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { testDbAvailable, truncateAll } from "../helpers/db.js";
import { closeTestResources } from "../helpers/teardown.js";
import { startServer } from "../helpers/server.js";
import { api } from "../helpers/api.js";
import { registerAndLogin, createAccount, createInvoice, issueInvoice } from "../helpers/fixtures.js";
import { db } from "../../src/infrastructure/db/index.js";
import { invoices, invoicePayments, journalEntries } from "../../src/infrastructure/db/schema.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

let server;
let owner;

before(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  server = await startServer();
  owner = await registerAndLogin(server.baseUrl);
});

after(async () => {
  if (!testDbAvailable) return;
  await server?.close();
  await truncateAll();
  await closeTestResources();
});

// A fresh AR/revenue/bank set per test keeps balances independent; `otherAr`
// is a valid ASSET in the same currency that the issue entry did not debit.
async function issuedInvoice(total = "1000") {
  const accounts = {
    ar: await createAccount(server.baseUrl, owner.token, { type: "ASSET" }),
    otherAr: await createAccount(server.baseUrl, owner.token, { type: "ASSET" }),
    revenue: await createAccount(server.baseUrl, owner.token, { type: "REVENUE" }),
    bank: await createAccount(server.baseUrl, owner.token, { type: "ASSET" }),
  };
  const invoice = await createInvoice(server.baseUrl, owner.token, {
    items: [{ description: "Service", quantity: 1, unitPriceMinor: total }],
  });
  await issueInvoice(server.baseUrl, owner.token, invoice.id, {
    receivableAccountId: accounts.ar.id,
    revenueAccountId: accounts.revenue.id,
  });
  return { invoice, ...accounts };
}

const pay = (invoiceId, idempotencyKey, body) =>
  api(server.baseUrl, owner.token)("POST", `/api/invoices/${invoiceId}/payments`, { idempotencyKey, body });

const getInvoice = async (invoiceId) =>
  (await api(server.baseUrl, owner.token)("GET", `/api/invoices/${invoiceId}`)).body;

const balance = async (accountId) =>
  (await api(server.baseUrl, owner.token)("GET", `/api/ledger/accounts/${accountId}/balance`)).body;

const tenantEntryCount = async () =>
  (await db.select().from(journalEntries).where(eq(journalEntries.tenantId, owner.tenantId))).length;

test("paying with the issue's AR account succeeds and nets AR to zero", { skip }, async () => {
  const { invoice, ar, bank } = await issuedInvoice("1000");

  for (const [i, amount] of ["400", "600"].entries()) {
    const res = await pay(invoice.id, `ar-match-${invoice.id}-${i}`, {
      amountMinor: amount,
      bankAccountId: bank.id,
      accountReceivableAccountId: ar.id,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  assert.equal((await getInvoice(invoice.id)).status, "PAID");
  assert.equal((await balance(ar.id)).balanceMinor, "0", "AR nets to zero once the invoice is paid");

  const all = await api(server.baseUrl, owner.token)("GET", "/api/ledger/balances");
  assert.equal(all.status, 200);
  const arRow = all.body.data.find((r) => r.accountId === ar.id);
  assert.ok(arRow, "AR appears in /api/ledger/balances");
  assert.equal(arRow.balanceMinor, "0");
});

test("paying with a different ASSET account is 422 RECEIVABLE_ACCOUNT_MISMATCH and writes nothing", { skip }, async () => {
  const { invoice, otherAr, bank } = await issuedInvoice("1000");
  const before = await getInvoice(invoice.id);
  const entriesBefore = await tenantEntryCount();

  const res = await pay(invoice.id, `ar-mismatch-${invoice.id}`, {
    amountMinor: "1000",
    bankAccountId: bank.id,
    accountReceivableAccountId: otherAr.id,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "RECEIVABLE_ACCOUNT_MISMATCH");

  const payments = await db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, invoice.id));
  assert.equal(payments.length, 0, "no invoice_payments row may be written");
  assert.equal(await tenantEntryCount(), entriesBefore, "no journal entry may be posted");

  const afterwards = await getInvoice(invoice.id);
  assert.equal(afterwards.status, before.status);
  assert.equal(afterwards.status, "ISSUED");
  assert.equal(afterwards.paidAmountMinor, before.paidAmountMinor);
  assert.equal(afterwards.paidAmountMinor, "0");
  assert.equal((await balance(otherAr.id)).balanceMinor, "0", "the wrong receivable is untouched");
});

test("a replay with the original key and body still returns 200 with the original payment", { skip }, async () => {
  const { invoice, ar, bank } = await issuedInvoice("1000");
  const key = `ar-replay-${invoice.id}`;
  const body = { amountMinor: "1000", bankAccountId: bank.id, accountReceivableAccountId: ar.id };

  const first = await pay(invoice.id, key, body);
  assert.equal(first.status, 201);

  const replay = await pay(invoice.id, key, body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.payment.id, first.body.payment.id);
  assert.equal(replay.body.journalEntry.id, first.body.journalEntry.id);
  assert.equal(replay.body.invoice.status, "PAID");
});

test("a legacy invoice with no issue entry still accepts any valid ASSET receivable", { skip }, async () => {
  const { invoice, otherAr, bank } = await issuedInvoice("1000");
  await db.update(invoices).set({ issueJournalEntryId: null }).where(eq(invoices.id, invoice.id));

  const res = await pay(invoice.id, `ar-legacy-${invoice.id}`, {
    amountMinor: "1000",
    bankAccountId: bank.id,
    accountReceivableAccountId: otherAr.id,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.invoice.status, "PAID");
});
