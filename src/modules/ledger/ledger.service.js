import { db } from "../../infrastructure/db/index.js";
import { journalEntries, entryLines, accounts } from "../../infrastructure/db/schema.js";
import{ eq, and, inArray } from "drizzle-orm";
import { AppError } from "../../lib/AppError.js";

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
    if(total!==0n) throw new AppError("Journal entry must balance to zero", 422, "UNBALANCED_ENTRY");

    //Check idempotency (scoped to tenant so different tenants can reuse the same key)
    const existing = await tx
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.tenantId,tenantId), eq(journalEntries.idempotencyKey,idempotencyKey)))
        .limit(1);
    if(existing.length>0) return existing[0];

    //Verify: All acounts belongs to tenant
    const accountIds = lines.map((line)=> line.accountId);
    const tenantAccounts = await tx
        .select()
        .from(accounts)
        .where(and(
            eq(accounts.tenantId,tenantId), inArray(accounts.id,accountIds)
        ));

        if(tenantAccounts.length !== accountIds.length){
            throw new AppError("One or more accounts are invalid", 422, "INVALID_ACCOUNT");
        }

            //Create Entry
        const[entry] = await tx
            .insert(journalEntries)
            .values({tenantId,description,occurredAt,idempotencyKey})
            .returning();
            
            //Creat Entry lines
        await tx
            .insert(entryLines)
            .values(
                lines.map((line)=> ({
                    entryId : entry.id,
                    accountId: line.accountId,
                    tenantId,
                    amountMinor: line.amountMinor
                }))
            );
        return entry;
}


