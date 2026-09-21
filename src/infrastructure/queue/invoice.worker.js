import { Worker } from "bullmq";
import { redis } from "../redis/index.js";
import { markOverdueInvoices } from "../../modules/invoices/invoice.service.js";
import { requestContext } from "../../lib/requestContext.js";
import { logger } from "../../lib/logger.js";

export const invoiceWorker = new Worker(
    "invoice",
    (job) => 
        requestContext.run({ requestId: `job-${job.id}`}, async() => {
            logger.info("job started", { jobName: job.name });
            const result = await markOverdueInvoices();
            logger.info("job completed", { jobName: job.name, updated: result.length});
    }),
    {connection: redis}
);

invoiceWorker.on("completed", (job) => {
    logger.info("job completed event", { jobId: job.id });
});

invoiceWorker.on("failed", (job, error) => {
    logger.error("job failed event", { jobId: job?.id, error: error.message });
});