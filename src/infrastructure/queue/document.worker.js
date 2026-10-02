import { UnrecoverableError, Worker } from "bullmq";
import { redis } from "../redis/index.js";
import { DOCUMENT_QUEUE } from "./document.queue.js";
import { ingestDocument, markDocumentsFailed } from "../../modules/documents/document.ingest.js";
import { logger } from "../../lib/logger.js";
import { UnextractableDocumentError } from "../../modules/documents/ingest/extract.js";

// A job whose document was deleted is a no-op: the claim in ingestDocument
// matches no row and returns { skipped: true }.
export async function processDocumentJob(job){
    try{
        return await ingestDocument(job.data);
    }catch(error){
        const permanent = error instanceof UnextractableDocumentError;
        const isFinalAttempt = permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if(isFinalAttempt) await markDocumentsFailed({ ...job.data, error});
        throw permanent ? new UnrecoverableError(error.message) : error;
    }
}

export function startDocumentWorker(){
    const worker = new Worker(
        DOCUMENT_QUEUE,
        processDocumentJob,
        { connection: redis, concurrency: 1 },
    );

    worker.on("failed", (job, error) => {
        logger.warn("document ingestion failed", { jobId: job?.id, attempt: job?.attemptsMade, error: error.message });
    });
    return worker;
}
