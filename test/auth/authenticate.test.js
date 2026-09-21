import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

test("authenticate rejects an alg=none token instead of accepting it as unsigned", async () => {
  const { authenticate } = await import("../../src/middleware/authenticate.js");

  // A token whose header claims "none" and carries no signature. If
  // jwt.verify is ever called without an explicit `algorithms` allow-list,
  // some configurations will accept this as valid.
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "attacker", tenantId: "any-tenant", role: "OWNER" })
  ).toString("base64url");
  const noneAlgToken = `${header}.${payload}.`;

  const req = { header: (name) => (name === "Authorization" ? `Bearer ${noneAlgToken}` : undefined) };
  let receivedError;
  authenticate(req, {}, (err) => {
    receivedError = err;
  });

  assert.equal(receivedError?.status, 401, "an alg=none token must be rejected, not accepted");
});

test("authenticate accepts a validly-signed HS256 token", async () => {
  const { authenticate } = await import("../../src/middleware/authenticate.js");
  const { env } = await import("../../src/config/env.js");

  const token = jwt.sign({ sub: "user-1", tenantId: "tenant-1", role: "OWNER" }, env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "5m",
  });

  const req = { header: (name) => (name === "Authorization" ? `Bearer ${token}` : undefined) };
  let receivedError;
  let auth;
  authenticate(req, {}, (err) => {
    receivedError = err;
    auth = req.auth;
  });

  assert.equal(receivedError, undefined, "a valid HS256 token must not produce an error");
  assert.equal(auth.tenantId, "tenant-1");
});
