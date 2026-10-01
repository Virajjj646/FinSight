import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../infrastructure/db/index.js";
import { documents, documentFiles } from "../../infrastructure/db/schema.js";
import { extractDocumentText, UnextractableDocumentError } from "./ingest/extract.js";
import { parseStructure } from "./ingest/structure.js";
import { chunkDocument } from "./ingest/chunk.js";
import { getTokenCounter } from "./ingest/model.js";
import { embedTexts } from "./ingest/embed.js";
import { writeChunks } from "./ingest/write.js";

export async function ingestDocument({ documentId, tenantId }) {
    const [claimed] = await db
        .update(documents)
        .set({ status: "processing", error: null, updatedAt: sql`now()` })
        .where(and(
            eq(documents.id, documentId),
            eq(documents.tenantId, tenantId),
            inArray(documents.status, ["pending", "processing"]),
        ))
        .returning({ id: documents.id, title: documents.title });

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
    const chunks = chunkDocument(parseStructure(pages), {
        countTokens: await getTokenCounter(),
        fallbackTitle: claimed.title?.replace(/\.pdf$/i, "") || undefined,
    });

    if(chunks.length === 0) throw new UnextractableDocumentError("Document produced no chunkable text");

    const vectors = await embedTexts(chunks.map((c) => c.content));

    const written = await writeChunks({
        documentId,
        tenantId,
        pageCount: pages.length,
        chunks,
        vectors,
    });

    if(!written) return { skipped: true };
    return { skipped: false, pageCount: pages.length, chunkCount: chunks.length };
}

export async function markDocumentsFailed({ documentId, tenantId, error }) {
    await db
        .update(documents)
        .set({
            status: "failed",
            error: String(error?.message ?? error).slice(0, 1000),
            updatedAt: sql`now()`,
        })
        .where(and(
            eq(documents.id, documentId),
            eq(documents.tenantId, tenantId),
            inArray(documents.status, ["pending", "processing"]),
        ));
}