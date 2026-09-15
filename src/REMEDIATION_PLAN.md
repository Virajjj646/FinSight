# FinSight — Backend Remediation Plan

You are working on FinSight, a backend-first fintech portfolio project. The
existing code is a working first draft with real correctness and security
defects. Your job is to fix them in the phased order below.

Read this whole file before making any change.

---

## Ground rules

- **Plain JavaScript only. No TypeScript.** No `.ts` files, no build step, no
  `tsc`. ESM throughout (`import`/`export`, `"type": "module"` is already set).
- **Do not add dependencies** beyond the ones explicitly named in this plan.
  Use Node's built-in test runner (`node:test` + `node:assert/strict`), not
  Jest or Vitest.
- **Do not hand-edit migrations that have already been applied**
  (`drizzle/0000_*` through `drizzle/0004_*`). Change `schema.js` and generate
  new migrations with `npx drizzle-kit generate`. For raw SQL that Drizzle
  cannot express (triggers, partial indexes), use
  `npx drizzle-kit generate --custom` and write the SQL by hand.
- **Work one phase at a time.** After each phase: run the test suite, commit
  with a message explaining *why* the change was needed, then stop and report
  what you did before starting the next phase. Do not run all phases in one go.
- **Every bug fixed in Phases 0–3 gets a regression test** that fails before
  the fix and passes after. Write the test first where practical.
- Preserve the existing module layout (`src/modules/<name>/`,
  `src/infrastructure/<name>/`). Do not restructure directories.
- Do not add features that aren't in this plan. No RAG, no document upload, no
  frontend, no reconciliation, no webhooks. Those come later.

---

## Phase 0 — Hygiene and tooling

1. Delete `src/test_db.js`.
2. Remove unused imports that are autocomplete accidents:
   - `src/infrastructure/db/schema.js`: `time` from `drizzle-orm/singlestore-core`,
     `quotelessJson` from `zod/v3`
   - `src/modules/invoices/invoice.service.js`: `any` from `zod`
   - Check every other file for unused imports and remove them.
3. Rewrite `README.md` as **UTF-8** (it is currently UTF-16LE, which renders as
   mojibake on GitHub). Content: project name, one-paragraph description, stack
   list, local setup steps, and a placeholder `## Benchmark results` section.
4. Add `.env.example` with every required variable name and no values.
5. Set up the test runner:
   - Add `"test": "node --test --test-concurrency=1 test/"` to `package.json`
     scripts.
   - Create `test/` at the repo root.
   - Tests need a real Postgres. Read `DATABASE_URL_TEST` from the environment;
     if it is unset, skip the DB-dependent tests with a clear message rather
     than failing.
   - Add a `test/helpers/db.js` that truncates all tables between tests.
6. Replace the database driver. `package.json` currently has both `pg` and
   `@neondatabase/serverless`. This is a long-running Express process, not an
   edge runtime, so the WebSocket driver is unnecessary overhead:
   - `src/infrastructure/db/index.js` → use `pg`'s `Pool` with
     `drizzle-orm/node-postgres`.
   - Remove `@neondatabase/serverless`, `ws`, and `bufferutil` from dependencies.
   - Keep pointing at the same Neon connection string.


---

## Phase 1 — Fix what is broken at runtime

These three defects mean the code throws or silently misbehaves today. Write a
failing test for each first.

1. **`updtedAt` / `updatedAt` mismatch.** The schema key for `invoices` is
   misspelled `updtedAt`. Three call sites use the typo; `createInvoicePayment`
   uses the correct spelling, which means it passes Drizzle a key that is not in
   the column map. Fix the schema key to `updatedAt` and update all four call
   sites. Add a test that records a payment end to end.

2. **Reversed comparison in `voidInvoice`.** The SELECT reads
   `eq(invoiceId, invoices.id)` — arguments swapped. Should be
   `eq(invoices.id, invoiceId)`. The UPDATE below it is already correct.

3. **Wrong operand in `markOverdueInvoices`.** The inner UPDATE passes
   `inArray(invoice.status, [...])` — a plain string where a column is
   required. Should be `invoices.status`.


---

## Phase 2 — Schema correctness

All changes go in `src/infrastructure/db/schema.js`, then
`npx drizzle-kit generate` and `npx drizzle-kit migrate`. The tables are
effectively empty, so destructive renames are acceptable.

1. **Timestamps.** Every `timestamp(...)` becomes
   `timestamp("...", { withTimezone: true })` — i.e. `timestamptz`. A financial
   system storing wall-clock times without a zone is a latent bug.
2. **Typos.** `journal_entries.occured_at` → `occurred_at`.
   `users.password_hash` has `{ lenght: 255 }`; the typo was silently dropped
   so the column emitted as unbounded `varchar`. Fix to `{ length: 255 }`.
3. **`memberships` table.**
   - `created_at` is `NOT NULL` with no default, because `.default()` was called
     with no argument. Use `.defaultNow()`.
   - `tenant_id` is nullable with `DEFAULT gen_random_uuid()`. A random default
     on a foreign key can only fail the FK check. Make it `.notNull()` with no
     default.
4. **Denormalise tenant onto `entry_lines`.** Add
   `tenantId: uuid("tenant_id").notNull().references(() => tenants.id)`.
   Populate it from the parent entry on insert. This keeps tenant filtering out
   of joins and makes a future RLS policy straightforward.
5. **Indexes.** There are currently none; Postgres does not index foreign keys
   automatically. Add at minimum:
   - `entry_lines`: `(account_id)`, `(entry_id)`, `(tenant_id)`
   - `journal_entries`: `(tenant_id, occurred_at)`
   - `invoices`: `(tenant_id, status)`, `(tenant_id, due_date)`
   - `invoice_items`, `invoice_payments`, `invoice_status_history`: `(invoice_id)`
   - `accounts`: `(tenant_id)`
   - `memberships`: `(user_id)`, `(tenant_id)`
6. **Uniqueness.**
   - `UNIQUE (tenant_id, invoice_number)` on `invoices`.
   - Replace the global `UNIQUE (idempotency_key)` on `journal_entries` with
     `UNIQUE (tenant_id, idempotency_key)`. The global constraint is a
     cross-tenant information leak — see Phase 3.
7. **CHECK constraints**, so a bad write is impossible rather than unlikely:
   - `invoices.status IN ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','OVERDUE','VOID')`
   - `accounts.type IN (...)` — use the standard set: `ASSET`, `LIABILITY`,
     `EQUITY`, `REVENUE`, `EXPENSE`
   - `currency ~ '^[A-Z]{3}$'` on both `accounts` and `invoices`
   - `invoice_items.quantity > 0`, `unit_price_minor > 0`
   - `invoice_payments.amount_minor > 0`
8. **Foreign key on `journal_entries.reversed_by_entry_id`** — currently a bare
   uuid with no reference. Point it at `journal_entries.id`.
9. **Zero-sum invariant enforced by the database.** Write a custom migration
   (`drizzle-kit generate --custom`) that creates a
   `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on `entry_lines`,
   firing at commit, which raises an exception if any touched `entry_id` has
   `SUM(amount_minor) <> 0`. Keep the application-level check as well — the
   trigger is the guarantee, the app check is the friendly error message.
   Add a test that attempts a direct unbalanced insert via raw SQL and asserts
   the commit fails.


---

## Phase 3 — Security: authentication and tenant isolation

This is the most important phase. Today `tenantId` arrives in the request body
and the invoice endpoints don't scope by tenant at all, so any caller who can
guess a UUID can read, issue, pay, or void another tenant's invoices.

New dependencies permitted here, and only here: `bcrypt` and `jsonwebtoken`.

1. **Config module.** Create `src/config/env.js` that loads dotenv **once** and
   validates every variable with Zod (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
   `PORT`), throwing at boot if any is missing or malformed. Export the parsed
   object. Import it as the first line of `src/app.js` and `src/worker.js`.
   Remove `import "dotenv/config"` from every infrastructure module.
   *(This also fixes a live bug: `src/infrastructure/redis/index.js` reads
   `process.env.REDIS_URL` at module scope before any dotenv import has run in
   the worker's import chain, so the worker silently falls back to
   `redis://localhost:6379`.)*

2. **Auth module** at `src/modules/auth/`:
   - `POST /api/auth/register` — creates a user, hashes the password with
     bcrypt (cost 12), creates a tenant, creates an `OWNER` membership.
   - `POST /api/auth/login` — verifies the password, returns a JWT whose
     payload is `{ sub: userId, tenantId, role }` with a short expiry.
   - Never return `passwordHash` in any response. Add a test asserting this.

3. **Auth middleware** at `src/middleware/authenticate.js`:
   - Verifies the bearer token and sets `req.auth = { userId, tenantId, role }`.
   - Returns 401 on a missing, malformed, or expired token.

4. **Remove tenant ID from all client input.**
   - Delete `tenantId` from `createInvoiceSchema`.
   - `ledger.controller.js` must read `req.auth.tenantId`, never `req.body`.
   - Every service function takes `tenantId` as an explicit argument from the
     caller, and the caller is always the middleware-populated `req.auth`.

5. **Scope every query.** Add `eq(table.tenantId, tenantId)` to the WHERE clause
   of every SELECT, UPDATE, and idempotency lookup in both `ledger.service.js`
   and `invoice.service.js`. A row belonging to another tenant must return
   "not found", never a 403 that confirms it exists.

6. **Tenant isolation tests.** Create two tenants, A and B. For each of
   `GET`/`issue`/`void`/`payment`/`journal entry`, assert that A operating on
   B's resource ID gets 404 and that B's data is unchanged. Include a test that
   A and B can both use the idempotency key `"key-1"` independently and each
   gets back their own entry.

7. **Error handling.** Add `src/lib/AppError.js` (message + HTTP status + a
   machine-readable code) and `src/middleware/errorHandler.js` as the last
   `app.use`. Map `ZodError` → 422 with field details, `AppError` → its status,
   unique-violation `23505` → 409, anything else → 500 with a logged stack and
   a generic body. Replace every `throw new Error(...)` in the services with an
   `AppError` carrying the right status. Add a 404 handler for unmatched routes.


---

## Phase 4 — Idempotency and concurrency

This is the phase that produces the project's headline artifact. Do not rush it.

1. **Rewrite ledger idempotency to rely on the unique constraint.** The current
   read-then-insert has a TOCTOU window: under READ COMMITTED two concurrent
   requests both see no existing row, both insert, and one receives a raw 23505
   as a 500 instead of a replayed response. Instead:
   - Insert the journal entry with `.onConflictDoNothing()` on
     `(tenant_id, idempotency_key)`.
   - If zero rows are returned, the key already existed: re-select that entry
     (scoped to tenant) with its lines and return it as the replay.
   - Return HTTP 200 on a replay and 201 on a first write, so the distinction
     is observable.

2. **Require the idempotency key.** It is currently read from the header with
   no validation, so a missing header produces a NOT NULL violation as a 500.
   Validate it (present, 1–255 chars) and return 400 when absent.

3. **Request fingerprinting.** Store a SHA-256 hash of the canonicalised request
   body alongside the key. On replay, if the fingerprint differs, return 409
   with a clear message — same key, different body is a client bug, not a
   retry. Add the column, and a test for both the matching and mismatching case.

4. **Fix payment idempotency.** `createInvoicePayment` currently builds its key
   as `invoice-payment-${invoice.id}-${Date.now()}`, which changes on every
   retry and therefore posts a duplicate journal entry and payment row every
   time. Accept an `Idempotency-Key` header on
   `POST /api/invoices/:id/payments` and thread it through to
   `createJournalEntryTx`. Add a test that the same key posted twice yields one
   payment row, one journal entry, and identical response bodies.

5. **Lock the invoice row before computing the remaining balance.** The payment
   path reads all prior payments, sums them, and inserts — so two concurrent
   payments both see the full amount outstanding and the invoice ends up
   overpaid. Take `SELECT ... FOR UPDATE` on the invoice row as the first
   statement in the transaction, which serialises payments per invoice.

6. **The concurrency test suite.** These are the portfolio artifacts; make them
   readable, and put their results in the README.
   - Fire 50 parallel `POST /api/ledger/entries` with the *same* idempotency
     key. Assert: exactly one `journal_entries` row, exactly N `entry_lines`
     rows, all 50 responses carry the same entry ID, no 5xx.
   - Fire 50 parallel partial payments against one invoice, sized so that only
     some can succeed. Assert: `SUM(amount_minor) <= total_amount_minor`
     exactly, the surplus requests fail with 422, and the final invoice status
     is correct.
   - Run both against a real Postgres, not a mock. A mock proves nothing about
     isolation levels.

7. **Currency guard.** Nothing currently prevents a journal entry whose lines
   span accounts in different currencies, which would "balance" to zero
   meaninglessly. Assert in `createJournalEntryTx` that all referenced accounts
   share one currency, and that a payment's accounts match the invoice currency.

8. **Money over the wire.** JSON numbers above 2^53 lose precision before Zod
   ever sees them. Change every `amountMinor` / `unitPriceMinor` input to accept
   a **string** of digits and reject numbers outright. Keep serialising as
   strings on the way out (already done). Add a test with a value above
   `Number.MAX_SAFE_INTEGER` that round-trips exactly.


---

## Phase 5 — Make it demonstrable

The API currently has no read endpoints at all, so nothing can be shown to
anyone.

1. **Accounts module** (`src/modules/accounts/`): `POST /api/accounts` and
   `GET /api/accounts`. Without this the ledger can only be used by hand-writing
   SQL.
2. **Ledger reads:**
   - `GET /api/ledger/entries` — paginated (cursor, not offset), filterable by
     date range and account, newest first.
   - `GET /api/ledger/accounts/:id/balance` — the balance as
     `SUM(amount_minor)` over `entry_lines`, with an optional `asOf` date.
     Write this one as raw SQL and note the query plan before and after the
     Phase 2 indexes; those two numbers go in the README.
3. **Invoice reads:** `GET /api/invoices` (paginated, filter by status) and
   `GET /api/invoices/:id` with items, payments, and status history.
4. **State machine used consistently.** `createInvoicePayment` bypasses
   `canTransition` and string-compares status instead. Route every status change
   in all four service functions through `canTransition`, and have it throw a
   422 `AppError` on an illegal transition. Add a test per illegal edge.
5. **Per-tenant sequential invoice numbers.** `INV-${crypto.randomUUID()}` is
   not a usable invoice number — real numbering is sequential and gapless per
   tenant because tax authorities require it. Add an `invoice_sequences` table
   keyed by tenant, and increment it under a row lock inside the same
   transaction that inserts the invoice. Add a test firing 20 parallel invoice
   creations and asserting the numbers are exactly 1..20 with no gaps or
   duplicates.
6. **Structured logging.** Replace every `console.log` with a small JSON logger
   in `src/lib/logger.js` (no dependency needed). Add a request-ID middleware
   that generates an ID per request, logs method/path/status/duration, and
   includes the ID in error responses.
7. **Graceful shutdown.** On `SIGTERM`/`SIGINT`, stop accepting connections,
   close the pg pool, close the BullMQ worker and the Redis connection, exit.
   Both `app.js` and `worker.js`.

---

## Phase 6 — Reconsider the queue

Do not implement anything here without discussing it first. Report your
analysis and stop.

The project's stated principle is that infrastructure is introduced only when a
measured problem justifies it. The BullMQ + Redis + separate-worker-process
setup currently exists to run one daily `UPDATE` that flips invoices to
`OVERDUE`. That does not clear the bar, and it is a weak answer to "why is
there a queue in this project?"

Two things to assess:

1. **Should `OVERDUE` be stored at all?** It is a pure function of
   `due_date < now()` and payment state. Deriving it in a view or at read time
   removes the scheduled job, the race against concurrent payments, and the
   window during which the stored value is wrong.
2. **If the job goes away, the queue has no justification until document
   ingestion exists** — where "parsing and embedding a 200-page filing takes
   40 seconds and would block the request" is a real, measurable reason.

Recommendation to evaluate: derive `OVERDUE`, keep the BullMQ code in the tree
unused (or on a branch), and reintroduce it at ingestion. Also note
`enqueueMarkOverdue` in `invoice.jobs.js` is currently dead code — nothing
imports it.

---

## Definition of done

- `npm test` passes, including every concurrency test, against a real Postgres.
- No endpoint accepts a tenant ID from client input.
- A request for another tenant's resource returns 404 in every case.
- No `console.log` in `src/`.
- Boot fails loudly and immediately on a missing environment variable.
- README documents setup, the endpoint list, and the concurrency test results.

## Out of scope

RAG, document ingestion, embeddings, pgvector, reconciliation, webhooks,
transactional outbox, multi-currency conversion, balance snapshots,
maker-checker approvals, ML, Docker, deployment, frontend. Do not start any of
these. Note them in a `## Future work` section of the README instead.