import "./config/env.js";
import { setupInvoiceSchedular } from "./infrastructure/queue/invoice.schedular.js";
import { startDocumentWorker } from "./infrastructure/queue/document.worker.js";
import { startInvoiceWorker } from "./infrastructure/queue/invoice.worker.js";
import { invoiceQueue } from "./infrastructure/queue/invoice.queue.js";
import { redis } from "./infrastructure/redis/index.js";
import { pool } from "./infrastructure/db/index.js";
import { registerShutdown } from "./lib/shutdown.js";
import { logger } from "./lib/logger.js";
import { documentQueue } from "./infrastructure/queue/document.queue.js";

logger.info("worker started");

await setupInvoiceSchedular();
const invoiceWorker = startInvoiceWorker();
const documentWorker = startDocumentWorker();

registerShutdown(
  [
    ["bullmq-invoice-worker", () => invoiceWorker.close()],
    ["bullmq-document-worker", () => documentWorker.close()],
    ["bullmq-invoice-queue", () => invoiceQueue.close()],
    ["bullmq-document-queue", () => documentQueue.close()],
    ["redis", () => redis.quit()],
    ["postgres", () => pool.end()],
  ],
  { timeoutMs: 30_000 }
);