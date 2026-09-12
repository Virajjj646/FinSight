import "dotenv/config";

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

const sql = neon(process.env.DATABASE_URL);
export const db = drizzle(sql);

export async function testDatabaseConnection() {
  const result = await sql`SELECT 1`;

  console.log("DATABASE CONNECTED:", result);
}

