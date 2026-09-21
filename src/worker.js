import "./config/env.js";
import { setupInvoiceSchedular } from "./infrastructure/queue/invoice.schedular.js";
import { invoiceWorker } from "./infrastructure/queue/invoice.worker.js";
import { invoiceQueue } from "./infrastructure/queue/invoice.queue.js";
import { redis } from "./infrastructure/redis/index.js";
import { pool } from "./infrastructure/db/index.js";
import { registerShutdown } from "./lib/shutdown.js";
import { logger } from "./lib/logger.js";

logger.info("worker started");

await setupInvoiceSchedular();

registerShutdown(
  [
    ["bullmq-worker", () => invoiceWorker.close()],
    ["bullmq-queue", () => invoiceQueue.close()],
    ["redis", () => redis.quit()],
    ["postgres", () => pool.end()],
  ],
  { timeoutMs: 30_000 }
);