import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../infrastructure/db/index.js';
import { documents, documentFiles, MAX_UPLOAD_BYTES } from '../../infrastructure/db/schema.js';
import { enqueueIngestion } from '../../infrastructure/queue/document.queue.js';
import { AppError } from '../../lib/AppError.js';

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
    if(!file) throw new AppError(400, 'FILE_REQUIRED','A PDF file is required');
    if(file.size > MAX_UPLOAD_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'Max upload size is 10 MB');
    if(!file.buffer.subarray(0, 5).equals(PDF_MAGIC)){
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only PDF files areaccepted');
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
    if(!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    return doc;
}

