import { invoiceQueue } from "./invoice.queue.js";
import { logger } from "../../lib/logger.js";

export async function setupInvoiceSchedular(){
    await invoiceQueue.upsertJobScheduler(
        "mark-overdue-invoices",
        { pattern: "0 0 * * *"},
        {
            name: "mark-overdue", 
            data: {},
            opts: {
                attempts: 3,
                backoff: { type: "exponential", delay: 5000},
                removeOnComplete: 100,
                removeOnFail: 100
            }
        }
    );
    logger.info("invoice schedular configured");
}