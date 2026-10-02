import { Queue } from "bullmq";
import { redis } from "../redis/index.js";

export const MARK_OVERDUE_JOB = "mark-overdue";

export const invoiceQueue = new Queue("invoice", {connection: redis});
