# FinSight — Follow-up Plan (post Phase 5)

Phases 0–5 of the remediation plan are mostly done. A review found one gap
(no tests exist), four correctness bugs, and unfinished cleanup. Fix them in
the phased order below.

Read this whole file before making any change.

---

## Ground rules

Same as before:

- **Plain JavaScript, ESM, no TypeScript.** No new dependencies. Tests use
  `node:test` and `node:assert/strict` only. HTTP tests use the built-in
  `fetch` against the app listening on an ephemeral port — no supertest.
- **Never hand-edit applied migrations.** Change `schema.js`, run
  `npx drizzle-kit generate`; use `--custom` for raw SQL.
- **One phase at a time.** After each phase: run `npm test`, commit with a
  message explaining why, then stop and report.
- **Every bug in Phase B gets a test that fails before the fix.** Write the
  test first and show it failing.
- Do not start RAG, document ingestion, or anything under "Out of scope".

---

## Phase A — Test infrastructure

Nothing can be tested today, for two reasons. Fix both.

1. **Split the app from the server.** `src/app.js` calls `app.listen()` on
   import, so tests can't import it.
   - `src/app.js` builds and `export default app` — no `listen`.
   - New `src/server.js` imports the app, listens on `env.PORT`, logs startup
     with `logger`, and owns graceful shutdown (Phase D).
   - Update `dev` and `start` scripts in `package.json` to run `src/server.js`.

2. **Point the app at the test database.** The app always uses
   `DATABASE_URL`, while `test/helpers/db.js` truncates `DATABASE_URL_TEST`,
   so integration tests would write to the dev database and clean a different
   one.
   - Create `test/setup.js` that loads dotenv, then sets
     `process.env.DATABASE_URL = process.env.DATABASE_URL_TEST` **before**
     anything imports `src/config/env.js`. (dotenv does not override variables
     already set, so the later `import "dotenv/config"` in `env.js` won't undo
     this.)
   - **Safety guard:** if `DATABASE_URL_TEST` is unset, or equals the
     original `DATABASE_URL`, throw and abort the run. Tests must never touch
     the dev database.
   - Change the test script to
     `node --test --test-concurrency=1 --import ./test/setup.js "test/**/*.test.js"`
     and name test files `*.test.js` so the helper isn't picked up as a test.
   - `test/helpers/db.js` should reuse the app's `pool` from
     `src/infrastructure/db/index.js` rather than opening its own. Add
     `invoice_sequences` to its truncate list.

3. **Test helpers** in `test/helpers/`:
   - `server.js` — start the app on port 0, return the base URL and a `close()`.
   - `fixtures.js` — `registerAndLogin()` returning a token and tenant ID,
     `createAccount(token, {...})`, `createInvoice(token, {...})`,
     `issueInvoice(token, id)`.
   - A small `api(token)` wrapper around `fetch` that sets the auth header,
     JSON content type, and an optional `Idempotency-Key`.

4. Document in the README how to create and migrate the test database
   (a separate Neon branch works well).

5. One smoke test proving the wiring: register, log in, create an account,
   list accounts, and assert the row exists in the **test** database.

**Then stop and report.**

---

## Phase B — Correctness bugs

Write the failing test first for each.

1. **Void can race a payment and void a PAID invoice.** `voidInvoice` and
   `issueInvoice` read the invoice without a lock, and their UPDATE filters
   only on id and tenant. If a payment holds the row lock and commits `PAID`,
   the void's UPDATE runs against the new row and sets `VOID`, bypassing the
   state machine.
   - Add `.for("update")` to the invoice read in both functions.
   - Test: fire a payment that fully pays the invoice and a void concurrently,
     20 times. Assert the final status is always a legal outcome (`PAID` with
     the void rejected, or `VOID` with the payment rejected) and never
     `VOID` with payments recorded.

2. **Voiding an invoice that has payments.** `PARTIALLY_PAID → VOID` and
   `OVERDUE → VOID` leave received money in the ledger against a voided
   invoice with no reversal. In accounting, a paid invoice is corrected with a
   credit note, not voided.
   - In `voidInvoice`, after taking the lock, sum payments; if greater than
     zero, throw `AppError(..., 422, "INVOICE_HAS_PAYMENTS")`.
   - Test: partially pay, attempt void, assert 422 and status unchanged.

3. **`paidAt` validation is frozen at server start.** In
   `invoice.payment.schema.js`, `z.coerce.date().max(new Date(), ...)`
   evaluates `new Date()` once at module load, so after the server has run a
   while, a legitimate payment dated today is rejected as "in the future".
   - Replace with `.refine((d) => d <= new Date(), "paidAt cannot be in the future")`.
   - Test: validate a date 1 second in the past after artificially delaying,
     or unit-test the schema by parsing a date newer than module load time.

4. **Invoice pagination skips rows, and `sequenceNumber` doesn't exist.**
   - The invoice cursor is built from `createdAt`. Postgres stores
     microseconds; JS Dates truncate to milliseconds. Rows created in the same
     millisecond as a page boundary are silently skipped on the next page.
   - Separately, `createInvoice` inserts `sequenceNumber`, but there is no
     such column, so the value is dropped and `serializeInvoice` returns
     `undefined`.
   - Fix both together: add `sequenceNumber: bigint("sequence_number", { mode: "bigint" })`
     to `invoices` with `UNIQUE (tenant_id, sequence_number)`. Migration: add
     nullable, backfill existing rows with `ROW_NUMBER()` per tenant ordered by
     `created_at`, set `invoice_sequences.last_value` to each tenant's max,
     then set `NOT NULL`.
   - Paginate `listInvoices` on `sequence_number DESC` with a cursor that
     encodes only the sequence number. Keep `lib/cursor.js` generic or add a
     separate encoder; don't reuse the `occurredAt` field name for something
     that isn't one.
   - Test: create 25 invoices in parallel, page through with `limit=10`,
     assert exactly 25 distinct IDs with no duplicates or gaps.

**then stop and report.**

---

## Phase C — The concurrency suite

These are the project's headline artifacts. Put them in
`test/concurrency.test.js`, make them readable, and run them against real
Postgres. Note that `pg`'s pool defaults to 10 connections, so 50 parallel
requests will queue on the pool — that's fine and realistic; say so in a
comment.

1. **Ledger idempotency:** 50 parallel `POST /api/ledger/entries` with the
   same `Idempotency-Key` and body. Assert: exactly one `journal_entries` row,
   exactly the expected number of `entry_lines` rows, every response has the
   same entry ID, exactly one 201 and the rest 200, no 5xx.
2. **Idempotency key reuse:** same key, different body → 409
   `IDEMPOTENCY_KEY_REUSED`.
3. **Payment idempotency:** 50 parallel payments with the same key → one
   payment row, one journal entry, no 5xx.
4. **No overpayment:** an invoice of 10,000 minor units; 50 parallel payments
   of 1,000 each with distinct keys. Assert exactly 10 succeed, 40 fail with
   422 `PAYMENT_EXCEEDS_REMAINING`, paid total equals exactly 10,000, status
   is `PAID`, and the ledger's receivable account balance matches.
5. **Void vs. payment** (from Phase B.1), kept here too.
6. **Gapless invoice numbers:** 20 parallel invoice creations in one tenant →
   sequence numbers exactly 1..20, no gaps, no duplicates. A second tenant
   creating in parallel starts at its own 1.
7. **Database-level zero-sum:** a raw-SQL transaction inserting unbalanced
   lines directly fails at commit.
8. **Tenant isolation:** tenant A operating on each of tenant B's resources
   (get/issue/void/pay invoice, balance, journal entry) gets 404; both tenants
   can use the same idempotency key independently.

Then update the README: add an `## Correctness guarantees` section listing
each property above, how it's enforced (constraint, lock, trigger), and the
test that proves it. Replace `_TBD._` under Benchmark results with the
concurrency results, and add the full endpoint list.

**then stop and report.**

---

## Phase D — Cleanup

1. **Graceful shutdown.** In `src/server.js` and `src/worker.js`: on
   `SIGTERM`/`SIGINT`, stop accepting connections, wait for in-flight
   requests, close the pg pool, close the BullMQ worker and Redis, then exit.
   Add a timeout that force-exits after 10 seconds.
2. **No `console.*` in `src/`.** Replace the remaining calls in `worker.js`,
   `invoice.worker.js`, and `invoice.schedular.js` with `logger`.
3. **Dead code:** delete `src/middleware/requestId.js` (superseded by
   `requestLogger`). Remove unused imports: `accounts` in
   `ledger.controller.js`; `requestId` and `logger` in `app.js` if unused after
   the split; `requestId` in `invoice.worker.js`. Check every file for others.
4. **Move `src/REMEDIATION_PLAN.md`** to `docs/`.
5. **Login hardening:**
   - When the email isn't found, still run `bcrypt.compare` against a fixed
     dummy hash, so response time doesn't reveal which emails are registered.
   - Lowercase and trim emails on register and login.
   - Pass `{ algorithms: ["HS256"] }` to `jwt.verify`.
6. **Append-only ledger.** Custom migration adding triggers that reject
   `UPDATE` and `DELETE` on `entry_lines`, and reject `DELETE` and any
   `UPDATE` on `journal_entries` except setting `reversed_by_entry_id` from
   NULL. Add a test for each rejected operation.
7. **Document the replay semantics.** A payment replay returns the invoice's
   current state, not the original response body. Note this in the README as
   a deliberate simplification versus storing full responses.

**then stop and report.**

---

## Still open (do not implement)

Phase 6 from the previous plan — whether `OVERDUE` should be derived rather
than stored, and whether the queue is justified before document ingestion —
is still a design decision for the owner. Additional evidence: the job
currently flip-flops invoices (`OVERDUE` → partial payment →
`PARTIALLY_PAID` → `OVERDUE` again the next night). Leave the code as is.

## Definition of done

- `npm test` passes and refuses to run against the dev database.
- All eight concurrency properties have passing tests.
- README documents setup, test DB setup, endpoints, correctness guarantees,
  and results.
- No `console.*` in `src/`, no unused imports, no dead files.

## Out of scope

RAG, ingestion, embeddings, pgvector, reconciliation, webhooks, outbox,
Docker, deployment, frontend.
