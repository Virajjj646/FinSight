import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll } from "../helpers/db.js";
import { closeTestResources } from "../helpers/teardown.js";
import { startServer } from "../helpers/server.js";
import { api } from "../helpers/api.js";
import {
  registerAndLogin,
  createAccount,
  createInvoice as createInvoiceViaApi,
  issueInvoice as issueInvoiceViaApi,
} from "../helpers/fixtures.js";
import {
  serializeEntry,
  serializeJournalEntry,
  serializePayment,
} from "../../src/lib/serialize.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

const INTERNAL_FIELDS = ["idempotencyKey", "requestFingerprint"];

function assertNoInternalFields(obj, label) {
  for (const field of INTERNAL_FIELDS) {
    assert.equal(Object.hasOwn(obj, field), false, `${label} must not expose ${field}`);
  }
}

test("serializers drop idempotency fields and stringify money", () => {
  const entry = {
    id: "e1",
    description: "Sale",
    idempotencyKey: "k",
    requestFingerprint: "f",
  };
  const line = { id: "l1", amountMinor: 100n };

  const serialized = serializeEntry(entry, [line]);
  assertNoInternalFields(serialized, "entry");
  assert.equal(serialized.lines[0].amountMinor, "100");

  assertNoInternalFields(serializeJournalEntry(entry), "journal entry");
  assert.equal(serializeJournalEntry(null), null);

  const payment = serializePayment({ id: "p1", amountMinor: 250n, idempotencyKey: "k", requestFingerprint: "f" });
  assertNoInternalFields(payment, "payment");
  assert.equal(payment.amountMinor, "250");
});

test("ledger and invoice responses never expose idempotencyKey or requestFingerprint", { skip }, async () => {
  await truncateAll();
  const { baseUrl, close } = await startServer();
  try {
    const { token } = await registerAndLogin(baseUrl);
    const bank = await createAccount(baseUrl, token, { type: "ASSET" });
    const ar = await createAccount(baseUrl, token, { type: "ASSET" });
    const revenue = await createAccount(baseUrl, token, { type: "REVENUE" });
    const request = api(baseUrl, token);

    const entryBody = {
      description: "Sale",
      occurredAt: new Date().toISOString(),
      lines: [
        { accountId: bank.id, amountMinor: "100" },
        { accountId: revenue.id, amountMinor: "-100" },
      ],
    };

    const created = await request("POST", "/api/ledger/entries", { body: entryBody, idempotencyKey: "serialize-entry" });
    assert.equal(created.status, 201);
    assertNoInternalFields(created.body, "POST /api/ledger/entries");

    const replayed = await request("POST", "/api/ledger/entries", { body: entryBody, idempotencyKey: "serialize-entry" });
    assert.equal(replayed.status, 200);
    assertNoInternalFields(replayed.body, "replayed POST /api/ledger/entries");

    const listed = await request("GET", "/api/ledger/entries");
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.length > 0);
    for (const entry of listed.body.data) assertNoInternalFields(entry, "GET /api/ledger/entries item");

    const invoice = await createInvoiceViaApi(baseUrl, token);
    await issueInvoiceViaApi(baseUrl, token, invoice.id, {
      receivableAccountId: ar.id,
      revenueAccountId: revenue.id,
    });

    const paymentBody = {
      amountMinor: "100",
      bankAccountId: bank.id,
      accountReceivableAccountId: ar.id,
    };

    const paid = await request("POST", `/api/invoices/${invoice.id}/payments`, { body: paymentBody, idempotencyKey: "serialize-payment" });
    assert.equal(paid.status, 201);
    assertNoInternalFields(paid.body.payment, "payment");
    assertNoInternalFields(paid.body.journalEntry, "payment journalEntry");
    assert.equal(paid.body.payment.amountMinor, "100");

    const replayedPayment = await request("POST", `/api/invoices/${invoice.id}/payments`, { body: paymentBody, idempotencyKey: "serialize-payment" });
    assert.equal(replayedPayment.status, 200);
    assertNoInternalFields(replayedPayment.body.payment, "replayed payment");
    assertNoInternalFields(replayedPayment.body.journalEntry, "replayed payment journalEntry");

    const fetched = await request("GET", `/api/invoices/${invoice.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.payments.length, 1);
    assertNoInternalFields(fetched.body.payments[0], "GET /api/invoices/:id payment");
    assert.equal(fetched.body.payments[0].amountMinor, "100");
  } finally {
    await close();
    await truncateAll();
  }
});

after(async () => {
  if (!testDbAvailable) return;
  await closeTestResources();
});
