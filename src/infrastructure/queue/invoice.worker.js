import { Worker } from "bullmq";
import { redis } from "../redis/index.js";
import { markOverdueInvoices } from "../../modules/invoices/invoice.service.js";

export const invoiceWorker = new Worker(
    "invoice",
    async (job) => {
        console.log(`Processing invoice job: ${job.name} (${job.id})`);
        if(job.name === "mark-overdue") return await markOverdueInvoices();
        throw new Error(`Unknown invoice job: ${job.name}`);
    },
    {connection: redis, concurrency: 1}
);

invoiceWorker.on("completed", (job) => {
    console.log(`Invoice job completed ${job.id}`);
});

invoiceWorker.on("failed", (job,error) => {
    console.error(`Invoice job failed: ${job?.id}`,error.message);
});