// The project's headline correctness suite: eight properties the API must
// hold under real concurrent load against real Postgres. `pg`'s pool
// defaults to 10 connections (src/infrastructure/db/index.js), so firing 50
// parallel requests means most of them queue on the pool rather than all
// hitting Postgres at once - that's fine and realistic, and it's exactly
// the kind of queuing a production deployment would see too.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "./helpers/db.js";
import { startServer } from "./helpers/server.js";
import { api } from "./helpers/api.js";
import {
  registerAndLogin,
  createAccount,
  createInvoice as createInvoiceViaApi,
  issueInvoice as issueInvoiceViaApi,
} from "./helpers/fixtures.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

// ---------------------------------------------------------------------------
// 1. Ledger idempotency
// ---------------------------------------------------------------------------
test(
  "1. ledger idempotency: 50 parallel POST /api/ledger/entries with the same key collapse to one entry",
  { skip },
  async () => {
    await truncateAll();
    const { baseUrl, close } = await startServer();
    try {
      const { token, tenantId } = await registerAndLogin(baseUrl);
      const bank = await createAccount(baseUrl, token, { type: "ASSET" });
      const revenue = await createAccount(baseUrl, token, { type: "REVENUE" });
      const request = api(baseUrl, token);

      const body = {
        description: "Concurrent sale",
        occurredAt: new Date().toISOString(),
        lines: [
          { accountId: bank.id, amountMinor: "100" },
          { accountId: revenue.id, amountMinor: "-100" },
        ],
      };

      const responses = await Promise.all(
        Array.from({ length: 50 }, () =>
          request("POST", "/api/ledger/entries", { body, idempotencyKey: "concurrency-ledger-key" })
        )
      );

      const statuses = responses.map((r) => r.status);
      assert.equal(statuses.filter((s) => s >= 500).length, 0, "no 5xx responses");
      assert.equal(statuses.filter((s) => s === 201).length, 1, "exactly one 201 (the winner)");
      assert.equal(statuses.filter((s) => s === 200).length, 49, "the other 49 replay as 200");

      const entryIds = new Set(responses.map((r) => r.body.id));
      assert.equal(entryIds.size, 1, "every response must carry the same journal entry ID");

      const { db } = await import("../src/infrastructure/db/index.js");
      const { eq } = await import("drizzle-orm");
      const { journalEntries, entryLines } = await import("../src/infrastructure/db/schema.js");

      const entryRows = await db.select().from(journalEntries).where(eq(journalEntries.tenantId, tenantId));
      assert.equal(entryRows.length, 1, "exactly one journal_entries row must exist");

      const lineRows = await db.select().from(entryLines).where(eq(entryLines.entryId, entryRows[0].id));
      assert.equal(lineRows.length, 2, "exactly the expected number of entry_lines rows must exist");
    } finally {
      await close();
    }
  }
);

// ---------------------------------------------------------------------------
// 2. Idempotency key reuse with a different body
// ---------------------------------------------------------------------------
test(
  "2. idempotency key reuse: the same key with a different body is rejected with 409",
  { skip },
  async () => {
    await truncateAll();
    const { baseUrl, close } = await startServer();
    try {
      const { token } = await registerAndLogin(baseUrl);
      const bank = await createAccount(baseUrl, token, { type: "ASSET" });
      const revenue = await createAccount(baseUrl, token, { type: "REVENUE" });
      const request = api(baseUrl, token);

      const first = await request("POST", "/api/ledger/entries", {
        idempotencyKey: "reuse-key",
        body: {
          description: "Sale A",
          occurredAt: new Date().toISOString(),
          lines: [
            { accountId: bank.id, amountMinor: "100" },
            { accountId: revenue.id, amountMinor: "-100" },
          ],
        },
      });
      assert.equal(first.status, 201);

      const second = await request("POST", "/api/ledger/entries", {
        idempotencyKey: "reuse-key",
        body: {
          description: "Sale B (different amount)",
          occurredAt: new Date().toISOString(),
          lines: [
            { accountId: bank.id, amountMinor: "200" },
            { accountId: revenue.id, amountMinor: "-200" },
          ],
        },
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.code, "IDEMPOTENCY_KEY_REUSED");
    } finally {
      await close();
    }
  }
);

// ---------------------------------------------------------------------------
// 3. Payment idempotency
// ---------------------------------------------------------------------------
test(
  "3. payment idempotency: 50 parallel payments with the same key collapse to one payment and one journal entry",
  { skip },
  async () => {
    await truncateAll();
    const { baseUrl, close } = await startServer();
    try {
      const { token } = await registerAndLogin(baseUrl);
      const bank = await createAccount(baseUrl, token, { type: "ASSET" });
      const ar = await createAccount(baseUrl, token, { name: "Accounts Receivable", type: "ASSET" });
      const invoice = await createInvoiceViaApi(baseUrl, token, {
        items: [{ description: "Service", quantity: 1, unitPriceMinor: "1000" }],
      });
      await issueInvoiceViaApi(baseUrl, token, invoice.id);

      const request = api(baseUrl, token);
      const body = {
        amountMinor: "1000",
        paidAt: new Date().toISOString(),
        bankAccountId: bank.id,
        accountReceivableAccountId: ar.id,
      };

      const responses = await Promise.all(
        Array.from({ length: 50 }, () =>
          request("POST", `/api/invoices/${invoice.id}/payments`, { body, idempotencyKey: "concurrency-payment-key" })
        )
      );

      assert.equal(responses.filter((r) => r.status >= 500).length, 0, "no 5xx responses");
      const paymentIds = new Set(responses.map((r) => r.body.payment.id));
      assert.equal(paymentIds.size, 1, "every response must carry the same payment ID");

      const { db } = await import("../src/infrastructure/db/index.js");
      const { eq } = await import("drizzle-orm");
      const { invoicePayments, journalEntries } = await import("../src/infrastructure/db/schema.js");

      const paymentRows = await db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, invoice.id));
      assert.equal(paymentRows.length, 1, "exactly one payment row must exist");

      const entryRows = await db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.id, paymentRows[0].journalEntryId));
      assert.equal(entryRows.length, 1, "exactly one journal entry must back the payment");
    } finally {
      await close();
    }
  }
);

// ---------------------------------------------------------------------------
// 4. No overpayment
// ---------------------------------------------------------------------------
test(
  "4. no overpayment: 50 parallel payments of 1,000 against a 10,000 invoice, exactly 10 succeed",
  { skip },
  async () => {
    await truncateAll();
    const { baseUrl, close } = await startServer();
    try {
      const { token } = await registerAndLogin(baseUrl);
      const bank = await createAccount(baseUrl, token, { type: "ASSET" });
      const ar = await createAccount(baseUrl, token, { name: "Accounts Receivable", type: "ASSET" });
      const invoice = await createInvoiceViaApi(baseUrl, token, {
        items: [{ description: "Consulting", quantity: 1, unitPriceMinor: "10000" }],
      });
      await issueInvoiceViaApi(baseUrl, token, invoice.id);

      const request = api(baseUrl, token);
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          request("POST", `/api/invoices/${invoice.id}/payments`, {
            idempotencyKey: `overpay-key-${i}`,
            body: {
              amountMinor: "1000",
              paidAt: new Date().toISOString(),
              bankAccountId: bank.id,
              accountReceivableAccountId: ar.id,
            },
          })
        )
      );

      assert.equal(responses.filter((r) => r.status >= 500).length, 0, "no 5xx responses");
      const succeeded = responses.filter((r) => r.status === 201);
      const failed = responses.filter((r) => r.status === 422);
      assert.equal(succeeded.length, 10, "exactly 10 payments of 1,000 fit into a 10,000 invoice");
      assert.equal(failed.length, 40, "the other 40 attempts must be rejected");
      assert.ok(
        failed.every((r) => r.body.code === "PAYMENT_EXCEEDS_REMAINING"),
        "every rejection must be PAYMENT_EXCEEDS_REMAINING"
      );

      const invoiceRes = await request("GET", `/api/invoices/${invoice.id}`);
      assert.equal(invoiceRes.body.status, "PAID");
      assert.equal(invoiceRes.body.paidAmountMinor, "10000", "paid total must equal exactly the invoice total");

      const balanceRes = await request("GET", `/api/ledger/accounts/${ar.id}/balance`);
      // AR is an ASSET (debit-normal, reported raw). Each of the 10 payments
      // credits AR by 1,000, so the raw sum is -10,000.
      assert.equal(balanceRes.body.balanceMinor, "-10000", "the receivable account balance must match");
    } finally {
      await close();
    }
  }
);

// ---------------------------------------------------------------------------
// 5. Void vs. payment (also covered in test/invoices/void.test.js)
// ---------------------------------------------------------------------------
test(
  "5. void vs. payment: racing a full payment against a void never leaves VOID with payments recorded",
  { skip },
  async () => {
    const { db } = await import("../src/infrastructure/db/index.js");
    const { eq } = await import("drizzle-orm");
    const { tenants, accounts, invoices, invoicePayments } = await import("../src/infrastructure/db/schema.js");
    const { createInvoice, issueInvoice, createInvoicePayment, voidInvoice } = await import(
      "../src/modules/invoices/invoice.service.js"
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

      await Promise.allSettled([
        createInvoicePayment({
          invoiceId: invoice.id,
          tenantId: tenant.id,
          amountMinor: 100n,
          paidAt: new Date(),
          bankAccountId: bank.id,
          accountReceivableAccountId: ar.id,
          idempotencyKey: `suite-race-payment-${i}`,
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
        assert.equal(payments.length, 0, `iteration ${i}: VOID must never carry recorded payments`);
      } else {
        assert.equal(payments.length, 1, `iteration ${i}: PAID must carry exactly its one payment`);
      }
    }

    await truncateAll();
  }
);

// ---------------------------------------------------------------------------
// 6. Gapless invoice numbers
// ---------------------------------------------------------------------------
test(
  "6. gapless invoice numbers: 20 parallel invoices in one tenant get sequence numbers 1..20; a second tenant starts at its own 1",
  { skip },
  async () => {
    const { db } = await import("../src/infrastructure/db/index.js");
    const { tenants } = await import("../src/infrastructure/db/schema.js");
    const { createInvoice } = await import("../src/modules/invoices/invoice.service.js");

    await truncateAll();

    const [tenantA] = await db.insert(tenants).values({ name: "Gapless A" }).returning();
    const [tenantB] = await db.insert(tenants).values({ name: "Gapless B" }).returning();

    const makeInvoice = (tenantId, i) =>
      createInvoice({
        tenantId,
        customerName: `Customer ${i}`,
        currency: "USD",
        dueDate: new Date(Date.now() + 86400000).toISOString(),
        items: [{ description: "Widget", quantity: 1, unitPriceMinor: 100n }],
      });

    const [invoicesA, invoicesB] = await Promise.all([
      Promise.all(Array.from({ length: 20 }, (_, i) => makeInvoice(tenantA.id, i))),
      Promise.all(Array.from({ length: 5 }, (_, i) => makeInvoice(tenantB.id, i))),
    ]);

    const sortBigints = (arr) => [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const sequenceNumbersA = sortBigints(invoicesA.map((inv) => inv.sequenceNumber));
    const expectedA = Array.from({ length: 20 }, (_, i) => BigInt(i + 1));
    assert.deepEqual(
      sequenceNumbersA,
      expectedA,
      "tenant A's sequence numbers must be exactly 1..20 with no gaps or duplicates"
    );

    const sequenceNumbersB = sortBigints(invoicesB.map((inv) => inv.sequenceNumber));
    const expectedB = Array.from({ length: 5 }, (_, i) => BigInt(i + 1));
    assert.deepEqual(
      sequenceNumbersB,
      expectedB,
      "tenant B must start its own sequence at 1, independent of tenant A's concurrent activity"
    );

    await truncateAll();
  }
);

// ---------------------------------------------------------------------------
// 7. Database-level zero-sum
// ---------------------------------------------------------------------------
test(
  "7. database-level zero-sum: a raw-SQL transaction inserting unbalanced lines fails at commit",
  { skip },
  async () => {
    const { db } = await import("../src/infrastructure/db/index.js");
    const { sql } = await import("drizzle-orm");
    const { tenants, accounts } = await import("../src/infrastructure/db/schema.js");

    await truncateAll();

    const [tenant] = await db.insert(tenants).values({ name: "Zero Sum Co" }).returning();
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
                  values (${tenant.id}, ${"unbalanced raw insert"}, now(), ${"suite-unbalanced-key"}, ${"test-fingerprint"})
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
      "the deferred constraint trigger must raise at commit when lines for an entry don't sum to zero"
    );

    await truncateAll();
  }
);

// ---------------------------------------------------------------------------
// 8. Tenant isolation
// ---------------------------------------------------------------------------
test(
  "8. tenant isolation: cross-tenant access 404s; both tenants can use the same idempotency key independently",
  { skip },
  async () => {
    const { db } = await import("../src/infrastructure/db/index.js");
    const { tenants, accounts } = await import("../src/infrastructure/db/schema.js");
    const { createInvoice, issueInvoice, voidInvoice, createInvoicePayment, getInvoice } = await import(
      "../src/modules/invoices/invoice.service.js"
    );
    const { createJournalEntry, getAccountBalance, listEntries } = await import(
      "../src/modules/ledger/ledger.service.js"
    );

    await truncateAll();

    const [tenantA] = await db.insert(tenants).values({ name: "Isolation A" }).returning();
    const [tenantB] = await db.insert(tenants).values({ name: "Isolation B" }).returning();

    const [bankA] = await db
      .insert(accounts)
      .values({ tenantId: tenantA.id, name: "Bank", type: "ASSET", currency: "USD" })
      .returning();
    const [arA] = await db
      .insert(accounts)
      .values({ tenantId: tenantA.id, name: "Accounts Receivable", type: "ASSET", currency: "USD" })
      .returning();
    const [revenueA] = await db
      .insert(accounts)
      .values({ tenantId: tenantA.id, name: "Revenue", type: "REVENUE", currency: "USD" })
      .returning();

    const invoiceA = await createInvoice({
      tenantId: tenantA.id,
      customerName: "Customer A",
      currency: "USD",
      dueDate: new Date(Date.now() + 86400000).toISOString(),
      items: [{ description: "Widget", quantity: 1, unitPriceMinor: 500n }],
    });

    const entryA = await createJournalEntry({
      tenantId: tenantA.id,
      idempotencyKey: "shared-key",
      data: {
        description: "A's sale",
        occurredAt: new Date(),
        lines: [
          { accountId: bankA.id, amountMinor: 100n },
          { accountId: revenueA.id, amountMinor: -100n },
        ],
      },
    });

    const is404 = (error) => error.status === 404;

    await assert.rejects(
      () => getInvoice({ tenantId: tenantB.id, invoiceId: invoiceA.id }),
      is404,
      "get must 404 across tenants"
    );
    await assert.rejects(() => issueInvoice(invoiceA.id, tenantB.id), is404, "issue must 404 across tenants");
    await assert.rejects(
      () =>
        createInvoicePayment({
          invoiceId: invoiceA.id,
          tenantId: tenantB.id,
          amountMinor: 500n,
          paidAt: new Date(),
          bankAccountId: bankA.id,
          accountReceivableAccountId: arA.id,
          idempotencyKey: "cross-tenant-pay",
        }),
      is404,
      "pay must 404 across tenants"
    );
    await assert.rejects(() => voidInvoice(invoiceA.id, tenantB.id), is404, "void must 404 across tenants");
    await assert.rejects(
      () => getAccountBalance({ tenantId: tenantB.id, accountId: bankA.id }),
      is404,
      "balance must 404 across tenants"
    );

    // Both tenants may reuse the exact same idempotency key independently.
    const [bankB] = await db
      .insert(accounts)
      .values({ tenantId: tenantB.id, name: "Bank", type: "ASSET", currency: "USD" })
      .returning();
    const [revenueB] = await db
      .insert(accounts)
      .values({ tenantId: tenantB.id, name: "Revenue", type: "REVENUE", currency: "USD" })
      .returning();
    const entryB = await createJournalEntry({
      tenantId: tenantB.id,
      idempotencyKey: "shared-key",
      data: {
        description: "B's sale",
        occurredAt: new Date(),
        lines: [
          { accountId: bankB.id, amountMinor: 200n },
          { accountId: revenueB.id, amountMinor: -200n },
        ],
      },
    });
    assert.notEqual(entryA.entry.id, entryB.entry.id, "shared idempotency keys must not collide across tenants");

    const { data: bEntries } = await listEntries({ tenantId: tenantB.id, limit: 20 });
    assert.ok(
      !bEntries.some((e) => e.id === entryA.entry.id),
      "tenant B must never see tenant A's journal entry"
    );

    const stillDraft = await getInvoice({ tenantId: tenantA.id, invoiceId: invoiceA.id });
    assert.equal(stillDraft.status, "DRAFT", "tenant A's invoice must be untouched by tenant B's attempts");

    await truncateAll();
  }
);

after(async () => {
  if (!testDbAvailable) return;
  await closeTestDb();
});
