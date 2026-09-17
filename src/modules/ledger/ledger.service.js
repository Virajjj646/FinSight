import { db } from "../../infrastructure/db/index.js";
import { journalEntries, entryLines, accounts } from "../../infrastructure/db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { AppError } from "../../lib/AppError.js";
import { fingerprint } from "../../lib/idempotency.js";

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
