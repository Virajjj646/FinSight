import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDbAvailable, truncateAll } from "../helpers/db.js";
import { closeTestResources } from "../helpers/teardown.js";
import { startServer } from "../helpers/server.js";
import { api } from "../helpers/api.js";
import { registerAndLogin, createAccount, createInvoice } from "../helpers/fixtures.js";
import { db } from "../../src/infrastructure/db/index.js";
import { journalEntries } from "../../src/infrastructure/db/schema.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

let server;
let owner;
let other;

before(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  server = await startServer();
  owner = await registerAndLogin(server.baseUrl);
  other = await registerAndLogin(server.baseUrl);
});

after(async () => {
  if (!testDbAvailable) return;
  await server?.close();
  await truncateAll();
  await closeTestResources();
});

// A fresh AR/revenue/bank set per test keeps balances independent.
async function ledgerAccounts(user, currency = "USD") {
  return {
    ar: await createAccount(server.baseUrl, user.token, { type: "ASSET", currency }),
    revenue: await createAccount(server.baseUrl, user.token, { type: "REVENUE", currency }),
    bank: await createAccount(server.baseUrl, user.token, { type: "ASSET", currency }),
  };
}

const issue = (user, invoiceId, body) =>
  api(server.baseUrl, user.token)("POST", `/api/invoices/${invoiceId}/issue`, { body });

const balance = async (user, accountId) =>
  (await api(server.baseUrl, user.token)("GET", `/api/ledger/accounts/${accountId}/balance`)).body;

async function entriesForInvoice(invoiceId) {
  return db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `invoice-issue:${invoiceId}`));
}

async function assertStillDraft(user, invoiceId) {
  const res = await api(server.baseUrl, user.token)("GET", `/api/invoices/${invoiceId}`);
  assert.equal(res.body.status, "DRAFT");
  assert.equal(res.body.issueJournalEntryId, null);
  assert.equal((await entriesForInvoice(invoiceId)).length, 0, "no journal entry may be posted");
}

test("issuing posts debit AR / credit revenue for the total and links the entry", { skip }, async () => {
  const { ar, revenue } = await ledgerAccounts(owner);
  const invoice = await createInvoice(server.baseUrl, owner.token, {
    items: [
      { description: "Widget", quantity: 3, unitPriceMinor: "250" },
      { description: "Setup", quantity: 1, unitPriceMinor: "500" },
    ],
  });
  assert.equal(invoice.issueJournalEntryId, null, "a draft has no issue entry");

  const res = await issue(owner, invoice.id, { receivableAccountId: ar.id, revenueAccountId: revenue.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ISSUED");
  assert.ok(res.body.issueJournalEntryId, "the response carries issueJournalEntryId");
  assert.equal(res.body.totalAmountMinor, "1250");

  const [entry] = await entriesForInvoice(invoice.id);
  assert.equal(entry.id, res.body.issueJournalEntryId);
  assert.equal(entry.tenantId, owner.tenantId);
  assert.equal(entry.description, `Invoice ${invoice.invoiceNumber} issued`);
  assert.equal(entry.occurredAt.toISOString(), res.body.issueDate, "occurredAt is the issue date");

  const listed = await api(server.baseUrl, owner.token)("GET", `/api/ledger/entries?accountId=${ar.id}`);
  const lines = listed.body.data.find((e) => e.id === entry.id).lines;
  const byAccount = Object.fromEntries(lines.map((l) => [l.accountId, l.amountMinor]));
  assert.deepEqual(byAccount, { [ar.id]: "1250", [revenue.id]: "-1250" });

  assert.equal((await balance(owner, ar.id)).balanceMinor, "1250");
  assert.equal((await balance(owner, revenue.id)).balanceMinor, "1250", "revenue is credit-normal");

  const fetched = await api(server.baseUrl, owner.token)("GET", `/api/invoices/${invoice.id}`);
  assert.equal(fetched.body.issueJournalEntryId, entry.id);
  const list = await api(server.baseUrl, owner.token)("GET", "/api/invoices");
  assert.equal(list.body.data.find((i) => i.id === invoice.id).issueJournalEntryId, entry.id);
});

test("after issue and full payment the AR balance is zero", { skip }, async () => {
  const { ar, revenue, bank } = await ledgerAccounts(owner);
  const invoice = await createInvoice(server.baseUrl, owner.token, {
    items: [{ description: "Consulting", quantity: 1, unitPriceMinor: "10000" }],
  });
  await issue(owner, invoice.id, { receivableAccountId: ar.id, revenueAccountId: revenue.id });

  for (const [i, amount] of ["4000", "6000"].entries()) {
    const paid = await api(server.baseUrl, owner.token)("POST", `/api/invoices/${invoice.id}/payments`, {
      idempotencyKey: `issue-test-pay-${invoice.id}-${i}`,
      body: { amountMinor: amount, bankAccountId: bank.id, accountReceivableAccountId: ar.id },
    });
    assert.equal(paid.status, 201);
  }

  const fetched = await api(server.baseUrl, owner.token)("GET", `/api/invoices/${invoice.id}`);
  assert.equal(fetched.body.status, "PAID");

  const arBalance = await balance(owner, ar.id);
  assert.equal(arBalance.balanceMinor, "0", "AR nets to zero once the invoice is paid");
  assert.equal(arBalance.lineCount, 3, "one issue debit plus two payment credits");
  assert.equal((await balance(owner, bank.id)).balanceMinor, "10000");
  assert.equal((await balance(owner, revenue.id)).balanceMinor, "10000");
});

test("missing or malformed body is 422 VALIDATION_FAILED", { skip }, async () => {
  const { ar } = await ledgerAccounts(owner);
  const invoice = await createInvoice(server.baseUrl, owner.token);

  for (const body of [undefined, {}, { receivableAccountId: ar.id }, { receivableAccountId: ar.id, revenueAccountId: "nope" }]) {
    const res = await issue(owner, invoice.id, body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.body.code, "VALIDATION_FAILED");
  }
  await assertStillDraft(owner, invoice.id);
});

test("unknown or other-tenant accounts are 422 INVALID_ACCOUNT", { skip }, async () => {
  const mine = await ledgerAccounts(owner);
  const theirs = await ledgerAccounts(other);
  const invoice = await createInvoice(server.baseUrl, owner.token);

  for (const body of [
    { receivableAccountId: randomUUID(), revenueAccountId: mine.revenue.id },
    { receivableAccountId: mine.ar.id, revenueAccountId: randomUUID() },
    { receivableAccountId: theirs.ar.id, revenueAccountId: mine.revenue.id },
    { receivableAccountId: mine.ar.id, revenueAccountId: theirs.revenue.id },
  ]) {
    const res = await issue(owner, invoice.id, body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_ACCOUNT");
  }
  await assertStillDraft(owner, invoice.id);
});

test("wrong account types are 422 INVALID_ACCOUNT_TYPE", { skip }, async () => {
  const { ar, revenue } = await ledgerAccounts(owner);
  const liability = await createAccount(server.baseUrl, owner.token, { type: "LIABILITY" });
  const invoice = await createInvoice(server.baseUrl, owner.token);

  for (const body of [
    { receivableAccountId: revenue.id, revenueAccountId: ar.id }, // swapped
    { receivableAccountId: liability.id, revenueAccountId: revenue.id },
    { receivableAccountId: ar.id, revenueAccountId: liability.id },
  ]) {
    const res = await issue(owner, invoice.id, body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_ACCOUNT_TYPE");
  }
  await assertStillDraft(owner, invoice.id);
});

test("accounts in another currency are 422 CURRENCY_MISMATCH", { skip }, async () => {
  const usd = await ledgerAccounts(owner, "USD");
  const eur = await ledgerAccounts(owner, "EUR");
  const invoice = await createInvoice(server.baseUrl, owner.token, { currency: "USD" });

  for (const body of [
    { receivableAccountId: eur.ar.id, revenueAccountId: eur.revenue.id },
    { receivableAccountId: eur.ar.id, revenueAccountId: usd.revenue.id },
    { receivableAccountId: usd.ar.id, revenueAccountId: eur.revenue.id },
  ]) {
    const res = await issue(owner, invoice.id, body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.body.code, "CURRENCY_MISMATCH");
  }
  await assertStillDraft(owner, invoice.id);
});

test("another tenant issuing the invoice gets 404 and nothing is posted", { skip }, async () => {
  const mine = await ledgerAccounts(owner);
  const theirs = await ledgerAccounts(other);
  const invoice = await createInvoice(server.baseUrl, owner.token);

  for (const body of [
    { receivableAccountId: theirs.ar.id, revenueAccountId: theirs.revenue.id },
    { receivableAccountId: mine.ar.id, revenueAccountId: mine.revenue.id },
  ]) {
    const res = await issue(other, invoice.id, body);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "NOT_FOUND");
  }
  await assertStillDraft(owner, invoice.id);
});

test("re-issuing is 422 ILLEGAL_TRANSITION and posts no second entry", { skip }, async () => {
  const { ar, revenue } = await ledgerAccounts(owner);
  const invoice = await createInvoice(server.baseUrl, owner.token);
  const body = { receivableAccountId: ar.id, revenueAccountId: revenue.id };

  assert.equal((await issue(owner, invoice.id, body)).status, 200);
  const again = await issue(owner, invoice.id, body);
  assert.equal(again.status, 422);
  assert.equal(again.body.code, "ILLEGAL_TRANSITION");
  assert.equal((await entriesForInvoice(invoice.id)).length, 1);
  assert.equal((await balance(owner, ar.id)).balanceMinor, "100");
});

test("concurrent issues of one invoice post exactly one entry", { skip }, async () => {
  const { ar, revenue } = await ledgerAccounts(owner);
  const invoice = await createInvoice(server.baseUrl, owner.token);
  const body = { receivableAccountId: ar.id, revenueAccountId: revenue.id };

  const responses = await Promise.all(Array.from({ length: 10 }, () => issue(owner, invoice.id, body)));
  const statuses = responses.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 1);
  assert.equal(statuses.filter((s) => s === 422).length, 9);
  assert.equal((await entriesForInvoice(invoice.id)).length, 1);
  assert.equal((await balance(owner, ar.id)).balanceMinor, "100");
});
