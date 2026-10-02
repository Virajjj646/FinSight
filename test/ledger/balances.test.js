import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll } from "../helpers/db.js";
import { closeTestResources } from "../helpers/teardown.js";
import { startServer } from "../helpers/server.js";
import { api } from "../helpers/api.js";
import { registerAndLogin, createAccount } from "../helpers/fixtures.js";
import { signedBalance } from "../../src/modules/ledger/ledger.service.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

const JAN = "2026-01-10T12:00:00.000Z";
const MAR = "2026-03-10T12:00:00.000Z";
const AS_OF_FEB = "2026-02-01T00:00:00.000Z";

let server;
let owner;
let other;
let acct;

before(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  server = await startServer();
  owner = await registerAndLogin(server.baseUrl);
  other = await registerAndLogin(server.baseUrl);

  const make = (name, type, user = owner) => createAccount(server.baseUrl, user.token, { name, type });
  acct = {
    bank: await make("Bank", "ASSET"),
    ar: await make("Accounts Receivable", "ASSET"),
    loan: await make("Loan", "LIABILITY"),
    equity: await make("Owner Equity", "EQUITY"),
    revenue: await make("Sales", "REVENUE"),
    rent: await make("Rent", "EXPENSE"),
    unused: await make("Petty Cash", "ASSET"),
  };

  const post = (key, occurredAt, lines) =>
    api(server.baseUrl, owner.token)("POST", "/api/ledger/entries", {
      idempotencyKey: key,
      body: { description: key, occurredAt, lines },
    });

  // January: capital and a loan land in the bank, a sale on account.
  await post("jan-capital", JAN, [
    { accountId: acct.bank.id, amountMinor: "50000" },
    { accountId: acct.equity.id, amountMinor: "-50000" },
  ]);
  await post("jan-loan", JAN, [
    { accountId: acct.bank.id, amountMinor: "20000" },
    { accountId: acct.loan.id, amountMinor: "-20000" },
  ]);
  await post("jan-sale", JAN, [
    { accountId: acct.ar.id, amountMinor: "7000" },
    { accountId: acct.revenue.id, amountMinor: "-7000" },
  ]);
  // March: rent paid, the customer pays. AR is touched again; rent only exists after Feb.
  await post("mar-rent", MAR, [
    { accountId: acct.rent.id, amountMinor: "3000" },
    { accountId: acct.bank.id, amountMinor: "-3000" },
  ]);
  await post("mar-collect", MAR, [
    { accountId: acct.bank.id, amountMinor: "7000" },
    { accountId: acct.ar.id, amountMinor: "-7000" },
  ]);

  // The other tenant has same-named accounts with their own activity.
  const otherBank = await make("Bank", "ASSET", other);
  const otherRevenue = await make("Sales", "REVENUE", other);
  await api(server.baseUrl, other.token)("POST", "/api/ledger/entries", {
    idempotencyKey: "other-sale",
    body: {
      description: "other sale",
      occurredAt: JAN,
      lines: [
        { accountId: otherBank.id, amountMinor: "999" },
        { accountId: otherRevenue.id, amountMinor: "-999" },
      ],
    },
  });
});

after(async () => {
  if (!testDbAvailable) return;
  await server?.close();
  await truncateAll();
  await closeTestResources();
});

const balances = (user, query = "") => api(server.baseUrl, user.token)("GET", `/api/ledger/balances${query}`);

test("signedBalance negates credit-normal account types only", () => {
  for (const type of ["ASSET", "EXPENSE"]) assert.equal(signedBalance(type, 5n), 5n, type);
  for (const type of ["LIABILITY", "EQUITY", "REVENUE"]) assert.equal(signedBalance(type, -5n), 5n, type);
});

test("returns every account, ordered like GET /api/accounts, with the documented shape", { skip }, async () => {
  const res = await balances(owner);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ["data"]);

  const accounts = await api(server.baseUrl, owner.token)("GET", "/api/accounts");
  assert.deepEqual(res.body.data.map((b) => b.accountId), accounts.body.map((a) => a.id));

  for (const row of res.body.data) {
    assert.deepEqual(Object.keys(row).sort(), ["accountId", "balanceMinor", "currency", "lineCount", "name", "type"]);
    assert.equal(typeof row.balanceMinor, "string");
  }
});

test("values match the per-account endpoint for every account", { skip }, async () => {
  for (const query of ["", `?asOf=${AS_OF_FEB}`]) {
    const res = await balances(owner, query);
    assert.equal(res.status, 200);
    for (const row of res.body.data) {
      const single = await api(server.baseUrl, owner.token)("GET", `/api/ledger/accounts/${row.accountId}/balance${query}`);
      const { asOf: _asOf, ...expected } = single.body;
      assert.deepEqual(row, expected, `${row.name} ${query}`);
    }
  }
});

test("current balances apply the credit-normal sign rule", { skip }, async () => {
  const byId = Object.fromEntries((await balances(owner)).body.data.map((b) => [b.accountId, b]));

  assert.equal(byId[acct.bank.id].balanceMinor, "74000"); // 50000 + 20000 - 3000 + 7000
  assert.equal(byId[acct.bank.id].lineCount, 4);
  assert.equal(byId[acct.ar.id].balanceMinor, "0");
  assert.equal(byId[acct.ar.id].lineCount, 2);
  assert.equal(byId[acct.loan.id].balanceMinor, "20000");
  assert.equal(byId[acct.equity.id].balanceMinor, "50000");
  assert.equal(byId[acct.revenue.id].balanceMinor, "7000");
  assert.equal(byId[acct.rent.id].balanceMinor, "3000");
});

test("accounts with no lines return \"0\" and lineCount 0", { skip }, async () => {
  const row = (await balances(owner)).body.data.find((b) => b.accountId === acct.unused.id);
  assert.deepEqual(
    { balanceMinor: row.balanceMinor, lineCount: row.lineCount },
    { balanceMinor: "0", lineCount: 0 },
  );
});

test("asOf excludes later entries but keeps accounts whose lines are all later", { skip }, async () => {
  const res = await balances(owner, `?asOf=${AS_OF_FEB}`);
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.body.data.map((b) => [b.accountId, b]));

  assert.equal(res.body.data.length, Object.keys(acct).length, "no account drops out of the list");
  assert.equal(byId[acct.bank.id].balanceMinor, "70000");
  assert.equal(byId[acct.bank.id].lineCount, 2);
  assert.equal(byId[acct.ar.id].balanceMinor, "7000");
  assert.equal(byId[acct.ar.id].lineCount, 1);
  assert.deepEqual(
    { balanceMinor: byId[acct.rent.id].balanceMinor, lineCount: byId[acct.rent.id].lineCount },
    { balanceMinor: "0", lineCount: 0 },
    "rent's only line is after asOf",
  );
});

test("an invalid asOf is 422 VALIDATION_FAILED", { skip }, async () => {
  const res = await balances(owner, "?asOf=not-a-date");
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "VALIDATION_FAILED");
});

test("tenant isolation: each tenant sees only its own accounts and lines", { skip }, async () => {
  const mine = (await balances(owner)).body.data;
  const theirs = (await balances(other)).body.data;

  const mineIds = new Set(mine.map((b) => b.accountId));
  assert.ok(theirs.every((b) => !mineIds.has(b.accountId)), "no shared account ids");
  assert.equal(theirs.length, 2);

  const theirBank = theirs.find((b) => b.name === "Bank");
  assert.equal(theirBank.balanceMinor, "999");
  assert.equal(theirBank.lineCount, 1);
  assert.equal(mine.find((b) => b.name === "Bank").balanceMinor, "74000");
});

test("requires authentication", { skip }, async () => {
  const res = await api(server.baseUrl)("GET", "/api/ledger/balances");
  assert.equal(res.status, 401);
});
