import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../helpers/server.js";
import { closeTestResources } from "../helpers/teardown.js";

const { env } = await import("../../src/config/env.js");
const { invoiceQueue, MARK_OVERDUE_JOB } = await import("../../src/infrastructure/queue/invoice.queue.js");

const TOKEN = "t".repeat(40);
const originalToken = env.ADMIN_TOKEN;
env.ADMIN_TOKEN = TOKEN;

const server = await startServer();

after(async () => {
  env.ADMIN_TOKEN = originalToken;
  await server.close();
  await closeTestResources();
});

function trigger(headers = {}) {
  return fetch(`${server.baseUrl}/api/admin/invoices/mark-overdue`, { method: "POST", headers });
}

test("POST /api/admin/invoices/mark-overdue rejects requests without the admin token", async () => {
  assert.equal((await trigger()).status, 401);
  assert.equal((await trigger({ "X-Admin-Token": "nope" })).status, 401);
});

test("POST /api/admin/invoices/mark-overdue enqueues a mark-overdue job", async () => {
  const res = await trigger({ "X-Admin-Token": TOKEN });
  assert.equal(res.status, 202);

  const { jobId } = await res.json();
  const job = await invoiceQueue.getJob(jobId);
  assert.equal(job?.name, MARK_OVERDUE_JOB);
});
