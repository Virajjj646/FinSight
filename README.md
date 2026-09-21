# FinSight

FinSight is a backend-first financial operations and intelligence platform: a
double-entry ledger and invoicing API built on Express, Drizzle ORM, and
PostgreSQL, with tenant-scoped accounting primitives.

## Stack

- Node.js (ESM, plain JavaScript, no TypeScript)
- Express 5
- PostgreSQL via `pg` and Drizzle ORM
- Drizzle Kit for migrations
- BullMQ + Redis (background jobs)
- Zod for validation
- Node's built-in test runner (`node:test`)

## Local setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in the values.
3. Run migrations:
   ```
   npx drizzle-kit migrate
   ```
4. Start the API:
   ```
   npm run dev
   ```
5. Start the worker (separate process):
   ```
   npm run worker
   ```
6. Run tests:
   ```
   npm test
   ```

## Test database

Tests run against a **separate** database, `DATABASE_URL_TEST`, which is
truncated between tests. `npm test` refuses to run if `DATABASE_URL_TEST` is
unset or equal to `DATABASE_URL`, so a misconfigured `.env` can't accidentally
wipe the dev database.

To set one up:

1. Create a separate database (a separate [Neon](https://neon.tech) branch of
   your dev database works well - it starts with the same schema and gives
   you an isolated connection string).
2. Set `DATABASE_URL_TEST` in `.env` to that database's connection string.
3. Run migrations against it:
   ```
   DATABASE_URL=$DATABASE_URL_TEST npx drizzle-kit migrate
   ```
4. Run the tests:
   ```
   npm test
   ```

`npm test` aborts immediately, before any test runs, if `DATABASE_URL_TEST` is
missing or matches `DATABASE_URL` - `DATABASE_URL_TEST` must always be set to
run the suite.

## Endpoints

All routes except `/health` require `Authorization: Bearer <token>`, obtained
from `POST /api/auth/login`. Mutating routes on invoices and ledger entries
require an `Idempotency-Key` header.

| Method | Path                                    | Description                                   |
| ------ | ---------------------------------------- | ---------------------------------------------- |
| GET    | `/health`                                | Liveness/readiness probe                       |
| POST   | `/api/auth/register`                     | Create a tenant and its first (owner) user     |
| POST   | `/api/auth/login`                        | Exchange credentials for a JWT                 |
| POST   | `/api/accounts`                          | Create a chart-of-accounts account             |
| GET    | `/api/accounts`                          | List accounts, optionally filtered by type     |
| POST   | `/api/invoices`                          | Create a draft invoice                         |
| GET    | `/api/invoices`                          | List invoices (cursor-paginated)               |
| GET    | `/api/invoices/:id`                      | Get one invoice with items, payments, history  |
| POST   | `/api/invoices/:id/issue`                | Transition a draft invoice to ISSUED           |
| POST   | `/api/invoices/:id/payments`             | Record a payment against an invoice            |
| POST   | `/api/invoices/:id/void`                 | Void an invoice that has no recorded payments  |
| POST   | `/api/ledger/entries`                    | Post a balanced double-entry journal entry     |
| GET    | `/api/ledger/entries`                    | List journal entries (cursor-paginated)        |
| GET    | `/api/ledger/accounts/:accountId/balance`| Get an account's running balance               |

## Correctness guarantees

These properties are exercised under real concurrent load against real
Postgres in `test/concurrency.test.js`; several also have focused
regression tests alongside the code they protect.

| # | Property | Enforced by | Proven by |
| - | -------- | ----------- | --------- |
| 1 | Ledger idempotency: N identical concurrent requests under one `Idempotency-Key` produce exactly one journal entry | Unique constraint on `(tenant_id, idempotency_key)` in `journal_entries`, `ON CONFLICT DO NOTHING` + replay read in `createJournalEntryTx` | `test/concurrency.test.js` §1, `test/ledger/concurrency.test.js` |
| 2 | Idempotency key reuse with a different body is rejected, not silently replayed | Request fingerprint (SHA-256 of canonicalised body) compared against the stored fingerprint on replay | `test/concurrency.test.js` §2, `test/ledger/idempotency.test.js` |
| 3 | Payment idempotency: N identical concurrent payment requests produce exactly one payment and one journal entry | Unique constraint on `(tenant_id, idempotency_key)` in `invoice_payments`, same conflict-and-replay pattern | `test/concurrency.test.js` §3 |
| 4 | No overpayment: concurrent payments can never sum past an invoice's total | `SELECT ... FOR UPDATE` lock on the invoice row in `createInvoicePayment` serializes concurrent payment attempts | `test/concurrency.test.js` §4, `test/invoices/paymentConcurrency.test.js` |
| 5 | Void vs. payment: a void can never win against a payment that already committed, and never leaves a VOID invoice with payments recorded | `SELECT ... FOR UPDATE` lock shared by `issueInvoice`, `voidInvoice`, and `createInvoicePayment`; `voidInvoice` also rejects any invoice with `SUM(payments) > 0` | `test/concurrency.test.js` §5, `test/invoices/void.test.js` |
| 6 | Gapless invoice numbers: concurrent invoice creation in one tenant yields a contiguous 1..N sequence; other tenants are unaffected | `invoice_sequences` row-per-tenant counter allocated via `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` inside the invoice's own transaction | `test/concurrency.test.js` §6 |
| 7 | Database-level zero-sum: no path, including raw SQL, can leave a journal entry's lines unbalanced | Deferred constraint trigger on `entry_lines` (checked at commit) | `test/concurrency.test.js` §7, `test/schema/entryLinesBalance.test.js` |
| 8 | Tenant isolation: no operation can read or mutate another tenant's data, and idempotency keys don't collide across tenants | Every query filters on `tenant_id`; idempotency and payment uniqueness constraints are scoped to `(tenant_id, ...)` | `test/concurrency.test.js` §8, `test/tenant-isolation/*` |
| - | Append-only ledger: posted journal entries and entry lines can never be altered or deleted, only reversed | `BEFORE UPDATE OR DELETE` triggers on `journal_entries` and `entry_lines` | `test/schema/appendOnlyLedger.test.js` |

## Design notes

- **Payment replay returns current state, not the original response.** When
  a payment request is replayed under its `Idempotency-Key` (same key, same
  body), the response reflects the invoice's *current* state - not a stored
  copy of the original response body. In the common case these are
  identical. They can diverge if, say, the invoice was independently voided
  or received another payment between the original call and the replay. This
  is a deliberate simplification: storing and replaying the exact original
  response would require persisting full response bodies per idempotency
  key, which this project does not do.

## Benchmark results

Run `npm test` with `DATABASE_URL_TEST` pointed at a real Postgres database
to exercise `test/concurrency.test.js` - it prints per-test pass/fail and
timing via Node's built-in test reporter. No fixed throughput numbers are
published here since they depend entirely on the Postgres instance and
network the suite runs against; the properties it proves are listed above
under **Correctness guarantees**.
