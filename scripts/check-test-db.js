import "dotenv/config";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST });
await client.connect();
const { rows } = await client.query(`
  SELECT
    (SELECT count(*) FROM drizzle.__drizzle_migrations) AS migrations_applied,
    to_regclass('public.invoice_sequences') IS NOT NULL AS has_invoice_sequences,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'invoices' AND column_name = 'sequence_number') AS has_sequence_number,
    (SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgrelid IN ('entry_lines'::regclass, 'journal_entries'::regclass)) AS triggers
`);
console.table(rows);
await client.end();