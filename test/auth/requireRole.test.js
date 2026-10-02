import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../src/config/env.js";
import { requireRole } from "../../src/middleware/requireRole.js";
import { startServer } from "../helpers/server.js";
import { registerAndLogin } from "../helpers/fixtures.js";
import { api } from "../helpers/api.js";
import { truncateAll } from "../helpers/db.js";
import { closeTestResources } from "../helpers/teardown.js";

let server;
let user;

before(async () => {
  server = await startServer();
  user = await registerAndLogin(server.baseUrl);
});

after(async () => {
  await server?.close();
  await truncateAll();
  await closeTestResources();
});

function check(role) {
  let nextArg = "not called";
  requireRole("OWNER", "ADMIN")({ auth: role === undefined ? undefined : { role } }, {}, (arg) => { nextArg = arg; });
  return nextArg;
}

test("allows listed roles", () => {
  assert.equal(check("OWNER"), undefined);
  assert.equal(check("ADMIN"), undefined);
});

test("rejects other roles and missing auth with 403", () => {
  for (const role of ["MEMBER", "owner", undefined]) {
    const err = check(role);
    assert.equal(err.status, 403, String(role));
    assert.equal(err.code, "FORBIDDEN");
  }
});

test("voiding an invoice requires OWNER or ADMIN", async () => {
  const { sub, tenantId } = jwt.decode(user.token);
  const memberToken = jwt.sign({ sub, tenantId, role: "MEMBER" }, env.JWT_SECRET, { expiresIn: "5m" });

  const res = await api(server.baseUrl, memberToken)("POST", `/api/invoices/${randomUUID()}/void`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "FORBIDDEN");
});
