import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { rateLimit } from "../../src/middleware/rateLimit.js";
import { consumeLlmBudget } from "../../src/modules/ask/llmBudget.js";
import { getGenerator } from "../../src/infrastructure/llm/generator.js";
import { AppError } from "../../src/lib/AppError.js";
import { redis } from "../../src/infrastructure/redis/index.js";

after(async () => {
  await redis.quit();
});

// A throwaway app that runs one handler and then the real errorHandler.
async function call(...handlers) {
  const app = express();
  app.get("/", ...handlers);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    return { status: res.status, headers: res.headers, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("LLM_BUDGET_EXCEEDED responds 429 with Retry-After = seconds to UTC midnight", async () => {
  const tenant = randomUUID();
  const now = new Date("2026-10-03T23:00:00.000Z");
  await consumeLlmBudget(tenant, { limit: 1, now });

  const res = await call(async (req, res, next) => {
    try {
      await consumeLlmBudget(tenant, { limit: 1, now });
      res.json({});
    } catch (error) { next(error); }
  });

  assert.equal(res.status, 429);
  assert.equal(res.body.code, "LLM_BUDGET_EXCEEDED");
  assert.equal(res.headers.get("retry-after"), "3600");
});

test("an AppError without retryAfterSec sets no Retry-After", async () => {
  const res = await call((req, res, next) => next(new AppError("Nope", 409, "CONFLICT")));
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("retry-after"), null);
});

test("RATE_LIMITED still responds 429 with the limiter's Retry-After", async () => {
  const limiter = rateLimit({ name: `test-${randomUUID()}`, limit: 1, windowSec: 60, key: () => "k" });
  const ok = (req, res) => res.json({});

  assert.equal((await call(limiter, ok)).status, 200);
  const res = await call(limiter, ok);
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "RATE_LIMITED");
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After was ${retryAfter}`);
});

test("missing LLM config responds 503 LLM_NOT_CONFIGURED", async () => {
  const res = await call((req, res, next) => {
    try {
      getGenerator({});
      res.json({});
    } catch (error) { next(error); }
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "LLM_NOT_CONFIGURED");
});
