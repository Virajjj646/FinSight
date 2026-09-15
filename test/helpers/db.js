import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL_TEST;

export const testDbAvailable = Boolean(connectionString);

const pool = connectionString ? new Pool({ connectionString }) : null;

const TABLES = [
  "invoice_status_history",
  "invoice_payments",
  "invoice_items",
  "invoices",
  "entry_lines",
  "journal_entries",
  "accounts",
  "memberships",
  "users",
  "tenants",
];

export async function truncateAll() {
  if (!pool) return;
  await pool.query(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

export async function closeTestDb() {
  if (!pool) return;
  await pool.end();
}
