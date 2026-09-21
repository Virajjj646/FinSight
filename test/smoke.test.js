import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testDbAvailable, truncateAll, closeTestDb } from "./helpers/db.js";
import { startServer } from "./helpers/server.js";
import { api } from "./helpers/api.js";
import { registerAndLogin, createAccount } from "./helpers/fixtures.js";

const skip = !testDbAvailable && "DATABASE_URL_TEST not set; skipping DB-dependent test";

test(
  "register, log in, create an account, list accounts, and find the row in the test database",
  { skip },
  async () => {
    await truncateAll();

    const { baseUrl, close } = await startServer();
    try {
      const { token } = await registerAndLogin(baseUrl);
      const account = await createAccount(baseUrl, token, {
        name: "Operating Bank",
        type: "ASSET",
        currency: "USD",
      });

      const listRes = await api(baseUrl, token)("GET", "/api/accounts");
      assert.equal(listRes.status, 200);
      assert.ok(
        listRes.body.some((a) => a.id === account.id),
        "listAccounts must include the account just created"
      );

      // Prove the wiring actually hit the *test* database, not just the API's
      // own view of it.
      const { db } = await import("../src/infrastructure/db/index.js");
      const { accounts } = await import("../src/infrastructure/db/schema.js");
      const { eq } = await import("drizzle-orm");

      const [row] = await db.select().from(accounts).where(eq(accounts.id, account.id));
      assert.ok(row, "the created account must exist in the test database");
      assert.equal(row.name, "Operating Bank");
    } finally {
      await close();
    }
  }
);

after(async () => {
  if (!testDbAvailable) return;
  await truncateAll();
  await closeTestDb();
});
