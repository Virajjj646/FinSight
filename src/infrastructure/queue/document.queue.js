import { Queue } from 'bullmq';
import { redis } from '../redis/index.js';

export const DOCUMENT_QUEUE = 'documents';
export const INGEST_DOCUMENT_JOB = 'ingest_document';

export const documentQueue = new Queue(DOCUMENT_QUEUE, {
    connection: redis,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
    },
});

// The default jobId dedupes repeat uploads of one document. BullMQ ignores an
// add whose jobId still exists (failed jobs are kept), so a retry must pass
// its own jobId.
export function enqueueIngestion({ documentId, tenantId }, { jobId = `ingest-${documentId}` } = {}){
    return documentQueue.add(
        INGEST_DOCUMENT_JOB,
        { documentId, tenantId },
        { jobId },
    )
}