import { db } from "../../infrastructure/db/index.js";
import { accounts } from "../../infrastructure/db/schema.js";
import { and, eq, asc } from "drizzle-orm";

export async function createAccount({ tenantId, name, type, currency}){
    const[account] = await db
        .insert(accounts)
        .values({tenantId, name, type, currency})
        .returning();
    return account;
}

export async function listAccounts({ tenantId, type }){
    const filters = [eq(accounts.tenantId, tenantId)];
    if(type) filters.push(eq(accounts.type,type));

    return db
        .select()
        .from(accounts)
        .where(and(...filters))
        .orderBy(asc(accounts.type), asc(accounts.name));
}