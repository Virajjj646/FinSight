import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../helpers/server.js";
import { closeTestResources } from "../helpers/teardown.js";

// test/setup.js sets CORS_ORIGINS=http://allowed.example.
const ALLOWED = "http://allowed.example";

let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server?.close();
  await closeTestResources();
});

test("responses carry security headers and no X-Powered-By", async () => {
  const res = await fetch(`${server.baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(res.headers.get("strict-transport-security"), /max-age=/);
});

test("error responses carry security headers too", async () => {
  const res = await fetch(`${server.baseUrl}/nope`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("CORS: allowlisted origin gets Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${server.baseUrl}/health`, { headers: { Origin: ALLOWED } });
  assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
  assert.match(res.headers.get("vary"), /Origin/);
});

test("CORS: other origins get no CORS headers", async () => {
  const res = await fetch(`${server.baseUrl}/health`, { headers: { Origin: "http://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("CORS: preflight from an allowlisted origin returns 204", async () => {
  const res = await fetch(`${server.baseUrl}/api/ask`, {
    method: "OPTIONS",
    headers: {
      Origin: ALLOWED,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
  assert.match(res.headers.get("access-control-allow-methods"), /POST/);
  assert.match(res.headers.get("access-control-allow-headers"), /Authorization/);
});

test("JSON bodies over 100kb are rejected with 413", async () => {
  const res = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@example.com", password: "x".repeat(200 * 1024) }),
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "PAYLOAD_TOO_LARGE");
});
