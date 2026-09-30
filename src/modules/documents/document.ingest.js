import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../infrastructure/db/index.js";
import { documents, documentFiles } from "../../infrastructure/db/schema.js";
import { extractDocumentText, UnextractableDocumentError } from "./ingest/extract.js";

export async function ingestDocument({ documentId, tenantId }) {
    const [claimed] = await db
        .update(documents)
        .set({ status: "processing", error: null, updatedAt: sql`now()` })
        .where(and(
            eq(documents.id, documentId),
            eq(documents.tenantId, tenantId),
            inArray(documents.status, ["pending", "processing"]),
        ))
        .returning({ id: documents.id });

    if (!claimed) return { skipped: true };

    const [file] = await db
        .select({ bytes: documentFiles.bytes })
        .from(documentFiles)
        .where(and(
            eq(documentFiles.documentId, documentId),
            eq(documentFiles.tenantId, tenantId),
        ));

    if (!file) throw new UnextractableDocumentError("Document file missing");

    const pages = await extractDocumentText(file.bytes);

    // 2c–2d go here: chunk -> embed -> write chunks (one transaction)

    await db
        .update(documents)
        .set({ status: "ready", pageCount: pages.length, updatedAt: sql`now()` })
        .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));

    return { skipped: false, pageCount: pages.length };
}

export async function markDocumentsFailed({ documentId, tenantId, error }) {
    await db
        .update(documents)
        .set({
            status: "failed",
            error: String(error?.message ?? error).slice(0, 1000),
            updatedAt: sql`now()`,
        })
        .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));
}