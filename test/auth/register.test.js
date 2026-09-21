import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "../helpers/db.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

if (testDbAvailable) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

test("registerUser never includes passwordHash in its response", { skip }, async () => {
  const { registerUser } = await import("../../src/modules/auth/auth.service.js");

  await truncateAll();

  const result = await registerUser({
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: "correct horse battery staple",
    tenantName: "Analytical Engines Inc",
  });

  assert.equal(result.user.email, "ada@example.com");
  assert.equal("passwordHash" in result.user, false, "response must not include passwordHash");
  assert.equal(result.tenant.name, "Analytical Engines Inc");
});

test("loginUser rejects a wrong password and never leaks whether the email exists", { skip }, async () => {
  const { registerUser, loginUser } = await import("../../src/modules/auth/auth.service.js");

  await truncateAll();

  await registerUser({
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: "correct horse battery staple",
    tenantName: "Analytical Engines Inc",
  });

  await assert.rejects(
    () => loginUser({ email: "ada@example.com", password: "wrong password" }),
    (error) => error.status === 401
  );
  await assert.rejects(
    () => loginUser({ email: "nobody@example.com", password: "whatever" }),
    (error) => error.status === 401
  );
});

test("emails are normalized (trimmed and lowercased) on register and login", { skip }, async () => {
  const { registerUser, loginUser } = await import("../../src/modules/auth/auth.service.js");

  await truncateAll();

  await registerUser({
    name: "Ada Lovelace",
    email: "  Ada@Example.com  ",
    password: "correct horse battery staple",
    tenantName: "Analytical Engines Inc",
  });

  const { token } = await loginUser({ email: "ADA@EXAMPLE.COM", password: "correct horse battery staple" });
  assert.ok(token, "login must succeed when the email differs only by case or surrounding whitespace");
});

test("loginUser takes roughly the same time whether or not the email is registered", { skip }, async () => {
  const { registerUser, loginUser } = await import("../../src/modules/auth/auth.service.js");

  await truncateAll();

  await registerUser({
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: "correct horse battery staple",
    tenantName: "Analytical Engines Inc",
  });

  // Both branches must run bcrypt.compare, so a missing user shouldn't
  // short-circuit dramatically faster than a wrong password for an existing
  // one. This is a coarse smoke check, not a precise timing assertion.
  const time = async (fn) => {
    const start = process.hrtime.bigint();
    await assert.rejects(fn);
    return Number(process.hrtime.bigint() - start) / 1e6;
  };

  const knownEmailMs = await time(() => loginUser({ email: "ada@example.com", password: "wrong password" }));
  const unknownEmailMs = await time(() => loginUser({ email: "nobody@example.com", password: "wrong password" }));

  assert.ok(
    unknownEmailMs > knownEmailMs * 0.5,
    `an unknown email must not resolve dramatically faster than a known one (known: ${knownEmailMs}ms, unknown: ${unknownEmailMs}ms)`
  );
});

test("loginUser issues a JWT carrying the user's tenant and role", { skip }, async () => {
  const jwt = (await import("jsonwebtoken")).default;
  const { env } = await import("../../src/config/env.js");
  const { registerUser, loginUser } = await import("../../src/modules/auth/auth.service.js");

  await truncateAll();

  const { tenant } = await registerUser({
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: "correct horse battery staple",
    tenantName: "Analytical Engines Inc",
  });

  const { token } = await loginUser({ email: "ada@example.com", password: "correct horse battery staple" });
  const payload = jwt.verify(token, env.JWT_SECRET);

  assert.equal(payload.tenantId, tenant.id);
  assert.equal(payload.role, "OWNER");
});

after(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  await closeTestDb();
});
