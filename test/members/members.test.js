import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDbAvailable, truncateAll } from "../helpers/db.js";
import { closeTestResources } from "../helpers/teardown.js";
import { startServer } from "../helpers/server.js";
import { api } from "../helpers/api.js";
import { registerAndLogin, createInvoice } from "../helpers/fixtures.js";
import { db } from "../../src/infrastructure/db/index.js";
import { users, memberships } from "../../src/infrastructure/db/schema.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";
const PASSWORD = "correct horse battery staple";

let server;
let owner;
let other;

before(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  server = await startServer();
  owner = await registerAndLogin(server.baseUrl, { email: `owner-${randomUUID()}@example.com` });
  other = await registerAndLogin(server.baseUrl);
});

after(async () => {
  if (!testDbAvailable) return;
  await server?.close();
  await truncateAll();
  await closeTestResources();
});

const uniqueEmail = (label) => `${label}-${randomUUID()}@example.com`;

const addMember = (token, body) => api(server.baseUrl, token)("POST", "/api/members", { body });

async function login(email, password = PASSWORD) {
  const res = await api(server.baseUrl)("POST", "/api/auth/login", { body: { email, password } });
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

test("OWNER creates a member: 201 with the public user and role, and they can log in", { skip }, async () => {
  const email = uniqueEmail("Member");
  const res = await addMember(owner.token, { name: "Mia Member", email: email.toUpperCase(), password: PASSWORD, role: "MEMBER" });

  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ["role", "user"]);
  assert.equal(res.body.role, "MEMBER");
  assert.equal(res.body.user.name, "Mia Member");
  assert.equal(res.body.user.email, email.toLowerCase(), "email is lower-cased like registration");
  assert.equal(Object.hasOwn(res.body.user, "passwordHash"), false);

  const token = await login(email.toUpperCase());
  const me = await api(server.baseUrl, token)("GET", "/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.tenant.id, owner.tenantId);
  assert.equal(me.body.role, "MEMBER");
});

test("ADMIN can create members too", { skip }, async () => {
  const adminEmail = uniqueEmail("admin");
  const created = await addMember(owner.token, { name: "Ada Admin", email: adminEmail, password: PASSWORD, role: "ADMIN" });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, "ADMIN");

  const adminToken = await login(adminEmail);
  const res = await addMember(adminToken, { name: "Made By Admin", email: uniqueEmail("by-admin"), password: PASSWORD, role: "MEMBER" });
  assert.equal(res.status, 201);
  assert.equal(res.body.role, "MEMBER");
});

test("MEMBER gets 403 FORBIDDEN on POST /api/members and on voiding an invoice", { skip }, async () => {
  const email = uniqueEmail("plain-member");
  assert.equal((await addMember(owner.token, { name: "Plain", email, password: PASSWORD, role: "MEMBER" })).status, 201);
  const memberToken = await login(email);

  const attempt = await addMember(memberToken, { name: "Nope", email: uniqueEmail("nope"), password: PASSWORD, role: "MEMBER" });
  assert.equal(attempt.status, 403);
  assert.equal(attempt.body.code, "FORBIDDEN");

  const invoice = await createInvoice(server.baseUrl, owner.token);
  const voided = await api(server.baseUrl, memberToken)("POST", `/api/invoices/${invoice.id}/void`);
  assert.equal(voided.status, 403);
  assert.equal(voided.body.code, "FORBIDDEN");

  const fetched = await api(server.baseUrl, memberToken)("GET", `/api/invoices/${invoice.id}`);
  assert.equal(fetched.status, 200, "a MEMBER can still read the tenant's invoices");
  assert.equal(fetched.body.status, "DRAFT");
});

test("an existing email is 409 CONFLICT, whatever its case or tenant, and leaves no membership", { skip }, async () => {
  const email = uniqueEmail("dupe");
  assert.equal((await addMember(owner.token, { name: "First", email, password: PASSWORD, role: "MEMBER" })).status, 201);

  const sameTenant = await addMember(owner.token, { name: "Second", email: email.toUpperCase(), password: PASSWORD, role: "ADMIN" });
  assert.equal(sameTenant.status, 409);
  assert.equal(sameTenant.body.code, "CONFLICT");

  const otherTenant = await addMember(other.token, { name: "Third", email, password: PASSWORD, role: "MEMBER" });
  assert.equal(otherTenant.status, 409);
  assert.equal(otherTenant.body.code, "CONFLICT");

  const rows = await db.select().from(users).where(eq(users.email, email));
  assert.equal(rows.length, 1);
  const memberRows = await db.select().from(memberships).where(eq(memberships.userId, rows[0].id));
  assert.deepEqual(memberRows.map((m) => [m.tenantId, m.role]), [[owner.tenantId, "MEMBER"]]);
});

test("invalid bodies are 422 VALIDATION_FAILED", { skip }, async () => {
  const base = { name: "Val", email: uniqueEmail("val"), password: PASSWORD, role: "MEMBER" };
  for (const body of [
    undefined,
    { ...base, password: "short" },
    { ...base, role: "OWNER" },
    { ...base, role: "member" },
    { ...base, email: "not-an-email" },
    { ...base, name: "" },
  ]) {
    const res = await addMember(owner.token, body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.body.code, "VALIDATION_FAILED");
  }
});

test("GET /api/members lists the caller's tenant only, for any member", { skip }, async () => {
  const tenant = await registerAndLogin(server.baseUrl, { name: "Olive Owner" });
  const memberEmail = uniqueEmail("lister");
  assert.equal((await addMember(tenant.token, { name: "Lister", email: memberEmail, password: PASSWORD, role: "MEMBER" })).status, 201);
  const memberToken = await login(memberEmail);

  for (const token of [tenant.token, memberToken]) {
    const res = await api(server.baseUrl, token)("GET", "/api/members");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ["data"]);
    assert.deepEqual(
      res.body.data.map((m) => [m.name, m.role]),
      [["Olive Owner", "OWNER"], ["Lister", "MEMBER"]],
      "oldest membership first, no other tenant's members",
    );
    for (const m of res.body.data) {
      assert.deepEqual(Object.keys(m).sort(), ["createdAt", "email", "name", "role", "userId"]);
    }
  }

  const otherList = await api(server.baseUrl, other.token)("GET", "/api/members");
  assert.ok(otherList.body.data.every((m) => m.email !== memberEmail), "other tenant never sees this member");
});

test("requires authentication", { skip }, async () => {
  assert.equal((await api(server.baseUrl)("GET", "/api/members")).status, 401);
  assert.equal((await addMember(undefined, {})).status, 401);
});
