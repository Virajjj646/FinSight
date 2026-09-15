import { invoiceQueue } from "./invoice.queue.js";

export async function enqueueMarkOverdue(){
    return await invoiceQueue.add("mark-overdue",{});
}