import { invoiceQueue, MARK_OVERDUE_JOB } from "./invoice.queue.js";

export async function enqueueMarkOverdue(){
    return await invoiceQueue.add(MARK_OVERDUE_JOB, {}, {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000},
        removeOnComplete: 100,
        removeOnFail: 100
    });
}
