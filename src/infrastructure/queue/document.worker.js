import { Worker } from "bullmq";
import { redis } from "../redis/index.js";
import { DOCUMENT_QUEUE } from "./document.queue.js";
import { ingestDocument, markDocumentsFailed } from "../../modules/documents/document.ingest.js";
import { logger } from "../../lib/logger.js";

export function startDocumentWorker(){
    const worker = new Worker(
        DOCUMENT_QUEUE,
        async (job) => {
            try{
                return await ingestDocument(job.data);
            }catch(error){
                const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
                if(isFinalAttempt) await markDocumentsFailed({ ...job.data, error});
                throw error;
            }
        },
        { connection: redis, concurrency: 1 },
    );

    worker.on("failed", (job, error) => {
        logger.warn({ jobId: job?.id, attempt: job?.attemptsMade, err: error}, "document ingestion failed");
    });
    return worker;
}
