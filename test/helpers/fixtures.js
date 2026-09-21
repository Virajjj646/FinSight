import { api } from "./api.js";

let counter = 0;
function unique(label) {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

async function unwrap(promise, action) {
  const { status, body } = await promise;
  if (status < 200 || status >= 300) {
    throw new Error(`${action} failed with ${status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export async function registerAndLogin(baseUrl, overrides = {}) {
  const email = overrides.email ?? `${unique("user")}@example.com`;
  const password = overrides.password ?? "correct horse battery staple";
  const request = api(baseUrl);

  const { tenant } = await unwrap(
    request("POST", "/api/auth/register", {
      body: {
        name: overrides.name ?? "Test User",
        email,
        password,
        tenantName: overrides.tenantName ?? unique("Test Tenant"),
      },
    }),
    "registerAndLogin: register"
  );

  const { token } = await unwrap(
    request("POST", "/api/auth/login", { body: { email, password } }),
    "registerAndLogin: login"
  );

  return { token, tenantId: tenant.id };
}

export async function createAccount(baseUrl, token, overrides = {}) {
  return unwrap(
    api(baseUrl, token)("POST", "/api/accounts", {
      body: {
        name: overrides.name ?? unique("Account"),
        type: overrides.type ?? "ASSET",
        currency: overrides.currency ?? "USD",
      },
    }),
    "createAccount"
  );
}

export async function createInvoice(baseUrl, token, overrides = {}) {
  return unwrap(
    api(baseUrl, token)("POST", "/api/invoices", {
      body: {
        customerName: overrides.customerName ?? "Test Customer",
        currency: overrides.currency ?? "USD",
        dueDate: overrides.dueDate ?? new Date(Date.now() + 86400000).toISOString(),
        items: overrides.items ?? [
          { description: "Widget", quantity: 1, unitPriceMinor: "100" },
        ],
      },
    }),
    "createInvoice"
  );
}

export async function issueInvoice(baseUrl, token, id) {
  return unwrap(
    api(baseUrl, token)("POST", `/api/invoices/${id}/issue`),
    "issueInvoice"
  );
}
