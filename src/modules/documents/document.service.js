import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../infrastructure/db/index.js';
import { documents, documentChunks, documentFiles, MAX_UPLOAD_BYTES } from '../../infrastructure/db/schema.js';
import { enqueueIngestion } from '../../infrastructure/queue/document.queue.js';
import { AppError } from '../../lib/AppError.js';
import { encodeTimestampCursor, decodeTimestampCursor } from '../../lib/cursor.js';

const PDF_MAGIC = Buffer.from('%PDF-');

const documentColumns = {
    id: documents.id,
    title: documents.title,
    status: documents.status,
    error: documents.error,
    pageCount: documents.pageCount,
    contentSha256: documents.contentSha256,
    createdAt: documents.createdAt,
    updatedAt: documents.updatedAt,
};

function assertPdf(file){
    if(!file) throw new AppError('A PDF file is required', 400, 'FILE_REQUIRED');
    if(file.size > MAX_UPLOAD_BYTES) throw new AppError('Max upload size is 10 MB', 413, 'FILE_TOO_LARGE');
    if(!file.buffer.subarray(0, 5).equals(PDF_MAGIC)){
        throw new AppError('Only PDF files areaccepted', 415, 'UNSUPPORTED_MEDIA_TYPE',);
    }
}

export async function createDocument({ tenantId, title, file }){
    assertPdf(file);
    const contentSha256 = createHash('sha256').update(file.buffer).digest('hex');

    const result = await db.transaction(async (tx) => {
        const [created] = await tx
            .insert(documents)
            .values({ tenantId, title: title ?? file.originalname, contentSha256})
            .onConflictDoNothing({ target: [documents.tenantId, documents.contentSha256] })
            .returning(documentColumns);

            if(!created){
                const[existing] = await tx
                    .select(documentColumns)
                    .from(documents)
                    .where(and(eq(documents.tenantId, tenantId), eq(documents.contentSha256, contentSha256)));
                return { document: existing, created: false};
            }
        
            await tx.insert(documentFiles).values({
                documentId: created.id,
                tenantId,
                mimeType: 'application/pdf',
                sizeBytes: file.size,
                bytes: file.buffer,
            });

            return { document: created, created: true };
    });
    if(result.created || result.document.status == 'pending'){
        await enqueueIngestion({ documentId: result.document.id, tenantId });
    }
    return result;
}

export async function getDocument({ tenantId, documentId }){
    const [doc] = await db
        .select(documentColumns)
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.tenantId,tenantId)));
    if(!doc) throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    return doc;
}

// failed -> pending, then a fresh ingestion job. The conditional update makes
// concurrent retries safe: only one of them matches status 'failed'.
export async function retryDocument({ tenantId, documentId }){
    const [doc] = await db
        .update(documents)
        .set({ status: 'pending', error: null, updatedAt: sql`now()` })
        .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId), eq(documents.status, 'failed')))
        .returning(documentColumns);

    if(!doc){
        await getDocument({ tenantId, documentId }); // 404 if missing for this tenant
        throw new AppError('Only failed documents can be retried', 409, 'DOCUMENT_NOT_RETRYABLE');
    }

    await enqueueIngestion({ documentId, tenantId }, { jobId: `ingest-${documentId}-retry-${randomUUID()}` });
    return doc;
}

// Deletes chunks, file and document together. The row lock serialises this
// against the worker's claim: if the worker claimed first we see 'processing'
// and refuse; if we commit first its claim matches no row and it skips.
export async function deleteDocument({ tenantId, documentId }){
    await db.transaction(async (tx) => {
        const [doc] = await tx
            .select({ status: documents.status })
            .from(documents)
            .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
            .for('update');

        if(!doc) throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
        if(doc.status === 'processing'){
            throw new AppError('Document is being processed; try again when it finishes', 409, 'DOCUMENT_BUSY');
        }

        await tx.delete(documentChunks)
            .where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.tenantId, tenantId)));
        await tx.delete(documentFiles)
            .where(and(eq(documentFiles.documentId, documentId), eq(documentFiles.tenantId, tenantId)));
        await tx.delete(documents)
            .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));
    });
}

// The stored PDF. 404 when the document or its file row is missing for this tenant.
export async function getDocumentFile({ tenantId, documentId }){
    const [file] = await db
        .select({
            documentId: documents.id,
            title: documents.title,
            sizeBytes: documentFiles.sizeBytes,
            bytes: documentFiles.bytes,
        })
        .from(documents)
        .innerJoin(
            documentFiles,
            and(eq(documentFiles.documentId, documents.id), eq(documentFiles.tenantId, documents.tenantId)),
        )
        .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));
    if(!file) throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    return file;
}

// Keyset pagination on (created_at, id). The cursor carries created_at as
// Postgres text, never a JS Date, which would truncate microseconds to ms.
export async function listDocuments({ tenantId, limit, cursor, status }){
    const filters = [eq(documents.tenantId, tenantId)];

    if(status) filters.push(eq(documents.status, status));

    if(cursor){
        const decoded = decodeTimestampCursor(cursor);
        if(!decoded) throw new AppError('Invalid cursor', 400, 'INVALID_CURSOR');
        filters.push(sql`(${documents.createdAt}, ${documents.id}) < (${decoded.createdAtText}::timestamptz, ${decoded.id}::uuid)`);
    }

    const rows = await db
        .select({
            id: documents.id,
            title: documents.title,
            status: documents.status,
            error: documents.error,
            pageCount: documents.pageCount,
            createdAt: documents.createdAt,
            updatedAt: documents.updatedAt,
            createdAtText: sql`${documents.createdAt}::text`,
        })
        .from(documents)
        .where(and(...filters))
        .orderBy(desc(documents.createdAt), desc(documents.id))
        .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
        items: page.map(({ createdAtText, ...doc }) => doc),
        nextCursor: hasMore ? encodeTimestampCursor({ createdAtText: last.createdAtText, id: last.id }) : null,
    };
}

