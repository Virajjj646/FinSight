import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const { requireAdminToken } = await import("../../src/middleware/requireAdminToken.js");
const { env } = await import("../../src/config/env.js");

const TOKEN = "a".repeat(40);
const originalToken = env.ADMIN_TOKEN;

afterEach(() => {
  env.ADMIN_TOKEN = originalToken;
});

function run(headerValue) {
  const req = { header: (name) => (name === "X-Admin-Token" ? headerValue : undefined) };
  let received = "not-called";
  requireAdminToken(req, {}, (err) => {
    received = err;
  });
  return received;
}

test("requireAdminToken 404s when ADMIN_TOKEN is not configured", () => {
  env.ADMIN_TOKEN = undefined;
  assert.equal(run(TOKEN)?.status, 404);
});

test("requireAdminToken rejects a missing or wrong token", () => {
  env.ADMIN_TOKEN = TOKEN;
  assert.equal(run(undefined)?.status, 401);
  assert.equal(run("b".repeat(40))?.status, 401);
  assert.equal(run("short")?.status, 401);
});

test("requireAdminToken accepts the configured token", () => {
  env.ADMIN_TOKEN = TOKEN;
  assert.equal(run(TOKEN), undefined);
});
