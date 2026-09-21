import "dotenv/config";

// Must run (via --import) before anything imports src/config/env.js, so the
// app's pool, JWT secret, etc. are built against the test database from the
// very first import. dotenv does not override variables already set, so this
// assignment sticks even though src/config/env.js itself does `import
// "dotenv/config"` again later.
const originalDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseUrl = process.env.DATABASE_URL_TEST;

if (!testDatabaseUrl) {
  throw new Error(
    "DATABASE_URL_TEST is not set. Tests must never run against the dev " +
      "database (DATABASE_URL) - set DATABASE_URL_TEST in .env before running `npm test`."
  );
}

if (testDatabaseUrl === originalDatabaseUrl) {
  throw new Error(
    "DATABASE_URL_TEST is the same as DATABASE_URL. Tests must never run " +
      "against the dev database - point DATABASE_URL_TEST at a separate database."
  );
}

process.env.DATABASE_URL = testDatabaseUrl;
