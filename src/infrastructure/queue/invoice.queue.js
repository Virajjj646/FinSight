import { Queue } from "bullmq";
import { redis } from "../redis/index.js";

export const invoiceQueue = new Queue("invoice", {connection: redis});