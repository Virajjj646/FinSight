import { UnrecoverableError, Worker } from "bullmq";
import { redis } from "../redis/index.js";
import { MARK_OVERDUE_JOB } from "./invoice.queue.js";
import { markOverdueInvoices } from "../../modules/invoices/invoice.service.js";
import { requestContext } from "../../lib/requestContext.js";
import { logger } from "../../lib/logger.js";

export function startInvoiceWorker(){
    const worker = new Worker(
        "invoice",
        (job) =>
            requestContext.run({ requestId: `job-${job.id}`}, async() => {
                logger.info("job started", { jobName: job.name });
                switch(job.name){
                    case MARK_OVERDUE_JOB: {
                        const result = await markOverdueInvoices();
                        logger.info("job completed", { jobName: job.name, updated: result.length});
                        return { updated: result.length };
                    }
                    default:
                        throw new UnrecoverableError(`unknown invoice job: ${job.name}`);
                }
        }),
        {connection: redis}
    );

    worker.on("completed", (job) => {
        logger.info("job completed event", { jobId: job.id });
    });

    worker.on("failed", (job, error) => {
        logger.error("job failed event", { jobId: job?.id, error: error.message });
    });
    return worker;
}
