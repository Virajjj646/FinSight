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
    if(total!==0n) throw new AppError("Journal entry must balance to zero", 422);

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

    if(tenantAccounts.length != accountsIds.length) throw new AppError("One or more accounts are invalid", 422);

    const currencies = new Set(tenantAccounts.map((account) => account.currency));
    if(currencies.size > 1) throw new AppError("All accounts in a journal entry must share one currency", 422);

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

  const raw = BigInt(rows[0].raw_balance);
  const creditNormal = ["LIABILITY", "EQUITY", "REVENUE"].includes(account.type);

  return {
    accountId: account.id,
    name: account.name,
    type: account.type,
    currency: account.currency,
    asOf: asOf ?? null,
    balanceMinor: (creditNormal ? -raw : raw).toString(),
    lineCount: rows[0].line_count,
  };
}