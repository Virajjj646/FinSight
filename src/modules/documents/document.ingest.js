import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../infrastructure/db/index.js";
import { documents } from "../../infrastructure/db/schema.js";

export async function ingestDocument({ documentId, tenantId }){
    const [claimed] = await db
        .update(documents)
        .set({status: "processing", error: null, updatedAt: sql`now()`})
        .where(and(
            eq(documents.id, documentId),
            eq(documents.tenantId, tenantId),
            inArray(documents.status, ["pending", "processing"]),
        ))
        .returning({ id: documents.id });
    
    if(!claimed) return { skipped: true };

    await db
        .update(documents)
        .set({status: "ready", updatedAt: sql`now()` })
        .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));

    return { skipped: false };
}

export async function markDocumentsFailed({ documentId, tenantId, error }){
    await db
        .update(documents)
        .set({
            status: "failed",
            error: String(error?.message ?? error).slice(0, 1000),
            updatedAt: sql`now()`,
        })
        .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));
}
 