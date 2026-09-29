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

export function enqueueIngestion({ documentId, tenantId }){
    return documentQueue.add(
        INGEST_DOCUMENT_JOB,
        { documentId, tenantId },
        { jobId: `ingest-${documentId}`},
    )
}