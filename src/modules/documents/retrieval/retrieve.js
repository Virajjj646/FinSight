import { and, asc, cosineDistance, eq, inArray } from 'drizzle-orm';
import { db } from '../../../infrastructure/db/index.js';
import { documentChunks, documents, EMBEDDING_DIMENSIONS } from '../../../infrastructure/db/schema.js';
import { embedQuery } from '../ingest/embed.js';

export const DEFAULT_K = 5;
export const MAX_K = 20;

export async function searchChunks({tenantId, vector, k = DEFAULT_K}, { database = db } = {}) {
    if(!tenantId) throw new Error ('tenantId is required');
    if(!Array.isArray(vector) || vector.length != EMBEDDING_DIMENSIONS){
        throw new Error (`vector must have ${EMBEDDING_DIMENSIONS} dimensions`);
    }
    const limit = Math.min(Math.max(Number.isInteger(k) ? k : DEFAULT_K, 1), MAX_K);
    const distance = cosineDistance(documentChunks.embedding, vector);

    const rows = await database
    .select({
        chunkId: documentChunks.id,
        documentId: documentChunks.documentId,
        documentTitle: documents.title,
        section: documentChunks.section,
        pageStart: documentChunks.pageStart,
        pageEnd: documentChunks.pageEnd,
        content: documentChunks.content,
        distance,
    })
    .from(documentChunks)
    .innerJoin(
        documents,
        and(
            eq(documents.id, documentChunks.documentId),
            eq(documents.tenantId, documentChunks.tenantId),
        ),
    )
    .where(
        and(
            eq(documentChunks.tenantId, tenantId),
            eq(documents.tenantId, tenantId),
            eq(documents.status, 'ready'),
        ),
    )
    .orderBy(distance, asc(documentChunks.id))
    .limit(limit);

    return rows.map(({ distance: d, ...row }) => ({ ...row, score: 1 - Number(d) }));
}

export async function retrieveChunks({tenantId, question, k} , deps = {}) {
    const q = typeof question === 'string' ? question.trim() : '';
    if(!q) throw new Error('question must be non-empty string');
    const vector = await embedQuery(q);
    return searchChunks({ tenantId, vector, k}, deps);
}

// True when the tenant has documents still on their way to 'ready', i.e.
// retrieval may come back empty only because ingestion hasn't finished.
export async function hasDocumentsInProgress({ tenantId }, { database = db } = {}) {
    if(!tenantId) throw new Error ('tenantId is required');
    const rows = await database
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), inArray(documents.status, ['pending', 'processing'])))
        .limit(1);
    return rows.length > 0;
}
