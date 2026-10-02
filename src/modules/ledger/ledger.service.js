import { db } from "../../infrastructure/db/index.js";
import { journalEntries, entryLines, accounts } from "../../infrastructure/db/schema.js";
import { eq, and, inArray, gte, lte, desc, sql } from "drizzle-orm";
import { AppError } from "../../lib/AppError.js";
import { fingerprint } from "../../lib/idempotency.js";
import { encodeCursor, decodeCursor } from "../../lib/cursor.js";

export async function createJournalEntry({tenantId,idempotencyKey,data}){
    return await db.transaction(async(tx)=>{
        return await createJournalEntryTx({
            tx, tenantId, idempotencyKey, data
        });
    });
}

export async function createJournalEntryTx({tx,tenantId,idempotencyKey,data}){
    const{description, occurredAt, lines} = data;

    //Verify: Entry balances
    const total = lines.reduce((sum,line) => sum + line.amountMinor, 0n);
    if(total!==0n) throw new AppError("Journal entry must balance to zero", 422, "JOURNAL_ENTRY_UNBALANCED");

    const requestFingerprint = fingerprint(data);

    const[entry] = await tx
        .insert(journalEntries)
        .values({tenantId, description, occurredAt, idempotencyKey, requestFingerprint})
        .onConflictDoNothing({target: [journalEntries.tenantId, journalEntries.idempotencyKey]})
        .returning();

    if(!entry){
        const[existing] = await tx
            .select()
            .from(journalEntries)
            .where(
                and(
                    eq(journalEntries.tenantId, tenantId),
                    eq(journalEntries.idempotencyKey,idempotencyKey),
                ),
            )
            .limit(1);

        if (existing.requestFingerprint !== requestFingerprint) {
            throw new AppError(
            "This Idempotency-Key was already used with a different request body",
            409,
            "IDEMPOTENCY_KEY_REUSED",
            );
        }

        const existingLines = await tx
            .select()
            .from(entryLines)
            .where(eq(entryLines.entryId, existing.id));

        return { entry: existing, lines: existingLines, replayed: true};
    }

    const accountsIds = [...new Set(lines.map((line)=> line.accountId))];
    const tenantAccounts = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, accountsIds)));

    if(tenantAccounts.length != accountsIds.length) throw new AppError("One or more accounts are invalid", 422, "INVALID_ACCOUNT");

    const currencies = new Set(tenantAccounts.map((account) => account.currency));
    if(currencies.size > 1) throw new AppError("All accounts in a journal entry must share one currency", 422, "CURRENCY_MISMATCH");

    const insertedLines = await tx.insert(entryLines).values(
        lines.map((line) => ({
            entryId: entry.id,
            tenantId,
            accountId: line.accountId,
            amountMinor: line.amountMinor,
        })),
    ).returning();

    return { entry, lines: insertedLines, replayed: false };
}

export async function listEntries({tenantId, limit, cursor, accountId, from, to}){
    const filters = [eq(journalEntries.tenantId, tenantId)];

    if(from) filters.push(gte(journalEntries.occurredAt, from));
    if(to) filters.push(lte(journalEntries.occurredAt, to));

    if(cursor){
        const decoded = decodeCursor(cursor);
        if(!decoded) throw new AppError("Invalid cursor", 400, "INVALID_CURSOR");
        filters.push(sql`(${journalEntries.occurredAt}, ${journalEntries.id}) < (${decoded.occurredAt}, ${decoded.id})`);
    }

    if(accountId){
        filters.push(sql `EXISTS (
            SELECT 1 FROM ${entryLines}
            WHERE ${entryLines.entryId} = ${journalEntries.id}
                AND ${entryLines.accountId} = ${accountId}
        )`);
    }

    const rows = await db  
        .select()
        .from(journalEntries)
        .where(and(...filters))
        .orderBy(desc(journalEntries.occurredAt), desc(journalEntries.id))
        .limit(limit + 1);
    
    const hasMore = rows.length > limit;
    const page = hasMore? rows.slice(0,limit) : rows;

    const lines = page.length
        ? await db.select().from(entryLines)
            .where(and(
                eq(entryLines.tenantId,tenantId),
                inArray(entryLines.entryId, page.map(e => e.id))
            ))
        : [];

    const byEntry = new Map();

    for(const line of lines){
        if(!byEntry.has(line.entryId)) byEntry.set(line.entryId, []);
        byEntry.get(line.entryId).push({...line, amountMinor: line.amountMinor.toString()});
    }

    return{
        data: page.map(e => ({ ...e, lines: byEntry.get(e.id) ?? []})),
        nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    };
}

export async function getAccountBalance({ tenantId, accountId, asOf }) {
  const [account] = await db.select().from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.tenantId, tenantId)));

  if (!account) throw new AppError("Account not found", 404, "NOT_FOUND");

  const { rows } = await db.execute(sql`
    SELECT COALESCE(SUM(el.amount_minor), 0)::text AS raw_balance,
           COUNT(*)::int AS line_count
    FROM entry_lines el
    ${asOf ? sql`JOIN journal_entries je ON je.id = el.entry_id` : sql``}
    WHERE el.tenant_id = ${tenantId}
      AND el.account_id = ${accountId}
      ${asOf ? sql`AND je.occurred_at <= ${asOf}` : sql``}
  `);

  return {
    accountId: account.id,
    name: account.name,
    type: account.type,
    currency: account.currency,
    asOf: asOf ?? null,
    balanceMinor: signedBalance(account.type, BigInt(rows[0].raw_balance)).toString(),
    lineCount: rows[0].line_count,
  };
}

const CREDIT_NORMAL_TYPES = new Set(["LIABILITY", "EQUITY", "REVENUE"]);

// Lines are stored debit-positive. Credit-normal accounts report the negated
// sum so a healthy liability, equity or revenue balance reads positive.
export function signedBalance(type, rawMinor) {
  return CREDIT_NORMAL_TYPES.has(type) ? -rawMinor : rawMinor;
}

// Every account in the tenant with its balance, in one query, ordered like
// GET /api/accounts. The journal_entries join sits inside the LEFT JOIN so an
// account whose lines all fall after asOf still comes back with "0".
export async function listAccountBalances({ tenantId, asOf }) {
  const lines = asOf
    ? sql`(entry_lines el
          JOIN journal_entries je
            ON je.id = el.entry_id
           AND je.tenant_id = el.tenant_id
           AND je.occurred_at <= ${asOf})`
    : sql`entry_lines el`;

  const { rows } = await db.execute(sql`
    SELECT a.id AS account_id,
           a.name,
           a.type,
           a.currency,
           COALESCE(SUM(el.amount_minor), 0)::text AS raw_balance,
           COUNT(el.id)::int AS line_count
    FROM accounts a
    LEFT JOIN ${lines}
      ON el.account_id = a.id
     AND el.tenant_id = a.tenant_id
    WHERE a.tenant_id = ${tenantId}
    GROUP BY a.id, a.name, a.type, a.currency
    ORDER BY a.type ASC, a.name ASC
  `);

  return rows.map((row) => ({
    accountId: row.account_id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    balanceMinor: signedBalance(row.type, BigInt(row.raw_balance)).toString(),
    lineCount: row.line_count,
  }));
}