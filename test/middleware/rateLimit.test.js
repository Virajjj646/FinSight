import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rateLimit } from "../../src/middleware/rateLimit.js";
import { consumeLlmBudget, secondsUntilUtcMidnight } from "../../src/modules/ask/llmBudget.js";
import { redis } from "../../src/infrastructure/redis/index.js";

after(async () => {
  await redis.quit();
});

// Calls the middleware the way Express would and reports what it did.
async function run(middleware, req = {}) {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  let nextArg = "not called";
  await middleware(req, res, (arg) => { nextArg = arg; });
  return { error: nextArg, headers };
}

const failingClient = {
  multi() {
    const chain = { incr: () => chain, expire: () => chain, exec: async () => { throw new Error("connection refused"); } };
    return chain;
  },
};

const hangingClient = {
  multi() {
    const chain = { incr: () => chain, expire: () => chain, exec: () => new Promise(() => {}) };
    return chain;
  },
};

test("allows up to the limit, then 429 with Retry-After", async () => {
  const limiter = rateLimit({ name: `test-${randomUUID()}`, limit: 3, windowSec: 60, key: () => "k" });

  for (let i = 0; i < 3; i++) {
    const { error } = await run(limiter);
    assert.equal(error, undefined, `request ${i + 1} should pass`);
  }

  const { error, headers } = await run(limiter);
  assert.equal(error.status, 429);
  assert.equal(error.code, "RATE_LIMITED");
  const retryAfter = Number(headers["Retry-After"]);
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After was ${headers["Retry-After"]}`);
});

test("counts each key separately", async () => {
  const limiter = rateLimit({ name: `test-${randomUUID()}`, limit: 1, windowSec: 60, key: (req) => req.tenant });

  assert.equal((await run(limiter, { tenant: "a" })).error, undefined);
  assert.equal((await run(limiter, { tenant: "b" })).error, undefined);
  assert.equal((await run(limiter, { tenant: "a" })).error.status, 429);
});

test("sets a TTL on the counter", async () => {
  const name = `test-${randomUUID()}`;
  await run(rateLimit({ name, limit: 5, windowSec: 60, key: () => "k" }));

  const [key] = await redis.keys(`rl:${name}:*`);
  const ttl = await redis.ttl(key);
  assert.ok(ttl > 0 && ttl <= 60, `ttl was ${ttl}`);
});

test("fails open when Redis errors", async () => {
  const limiter = rateLimit({ name: "x", limit: 1, windowSec: 60, key: () => "k", client: failingClient });
  assert.equal((await run(limiter)).error, undefined);
  assert.equal((await run(limiter)).error, undefined);
});

test("fails open when Redis does not answer", async () => {
  const limiter = rateLimit({ name: "x", limit: 1, windowSec: 60, key: () => "k", client: hangingClient, timeoutMs: 20 });
  assert.equal((await run(limiter)).error, undefined);
});

test("LLM budget: allows up to the limit per tenant per day, then 429", async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  await consumeLlmBudget(tenantA, { limit: 2 });
  await consumeLlmBudget(tenantA, { limit: 2 });
  await assert.rejects(consumeLlmBudget(tenantA, { limit: 2 }), { status: 429, code: "LLM_BUDGET_EXCEEDED" });

  await consumeLlmBudget(tenantB, { limit: 2 });
  await consumeLlmBudget(tenantA, { limit: 2, now: new Date(Date.now() + 86400000) });
});

test("secondsUntilUtcMidnight counts to the next UTC midnight", () => {
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-03T00:00:00.000Z")), 86400);
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-03T23:59:30.000Z")), 30);
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-03T23:59:59.500Z")), 1);
  assert.equal(secondsUntilUtcMidnight(new Date("2026-12-31T22:00:00.000Z")), 7200);
});

test("LLM budget exceeded carries retryAfterSec until the next UTC midnight", async () => {
  const tenant = randomUUID();
  const now = new Date("2026-10-03T21:30:15.000Z");

  await consumeLlmBudget(tenant, { limit: 1, now });
  await assert.rejects(consumeLlmBudget(tenant, { limit: 1, now }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, "LLM_BUDGET_EXCEEDED");
    assert.equal(error.retryAfterSec, 2 * 3600 + 29 * 60 + 45);
    return true;
  });
});

test("LLM budget fails open when Redis errors", async () => {
  await consumeLlmBudget(randomUUID(), { limit: 1, client: failingClient });
  await consumeLlmBudget(randomUUID(), { limit: 1, client: hangingClient, timeoutMs: 20 });
});
