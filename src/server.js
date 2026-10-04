import { env } from "./config/env.js";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { registerShutdown } from "./lib/shutdown.js";
import { pool } from "./infrastructure/db/index.js";
import { documentQueue } from "./infrastructure/queue/document.queue.js";
import { invoiceQueue } from "./infrastructure/queue/invoice.queue.js";
import { redis } from "./infrastructure/redis/index.js";
import { setupInvoiceSchedular } from "./infrastructure/queue/invoice.schedular.js";
import { startInvoiceWorker } from "./infrastructure/queue/invoice.worker.js";
import { startDocumentWorker } from "./infrastructure/queue/document.worker.js";

const server = app.listen(env.PORT, () => {
  logger.info("server started", { port: env.PORT });
});

const workerSteps = [];

if (env.RUN_WORKER) {
  await setupInvoiceSchedular();
  const invoiceWorker = startInvoiceWorker();
  const documentWorker = startDocumentWorker();
  workerSteps.push(
    ["bullmq-invoice-worker", () => invoiceWorker.close()],
    ["bullmq-document-worker", () => documentWorker.close()],
  );
  logger.info("in-process workers started");
}

// Workers close before the queues, redis and postgres they depend on.
registerShutdown(
  [
    [
      "http",
      () =>
        new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeIdleConnections();
        }),
    ],
    ...workerSteps,
    ["document-queue", () => documentQueue.close()],
    ["invoice-queue", () => invoiceQueue.close()],
    ["redis", () => redis.quit()],
    ["postgres", () => pool.end()],
  ],
  { timeoutMs: env.RUN_WORKER ? 25_000 : 10_000 }
);
