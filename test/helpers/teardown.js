import { documentQueue } from "../../src/infrastructure/queue/document.queue.js";
import { invoiceQueue } from "../../src/infrastructure/queue/invoice.queue.js";
import { redis } from "../../src/infrastructure/redis/index.js";
import { closeTestDb } from "./db.js";

// Booting src/app.js opens a BullMQ queue and a shared IORedis connection that
// keep the event loop alive. Close queue -> Redis -> pool, in that order.
export async function closeTestResources() {
  await documentQueue.close();
  await invoiceQueue.close();
  await redis.quit();
  await closeTestDb();
}
