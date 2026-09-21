import { pool } from "../../src/infrastructure/db/index.js";

export const testDbAvailable = Boolean(process.env.DATABASE_URL_TEST);

const TABLES = [
  "invoice_status_history",
  "invoice_payments",
  "invoice_items",
  "invoices",
  "invoice_sequences",
  "entry_lines",
  "journal_entries",
  "accounts",
  "memberships",
  "users",
  "tenants",
];

export async function truncateAll() {
  if (!testDbAvailable) return;
  await pool.query(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

export async function closeTestDb() {
  if (!testDbAvailable) return;
  await pool.end();
}
