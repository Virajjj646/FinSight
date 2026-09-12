import { pgTable, uuid, varchar, timestamp, unique , bigint, text, integer} from "drizzle-orm/pg-core";
import { time } from "drizzle-orm/singlestore-core";

export const tenants = pgTable("tenants",{
  id:uuid("id").defaultRandom().primaryKey(),
  name:varchar("name", { length: 150}).notNull(),
  createdAt: timestamp("created_at").default().notNull()
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { lenght: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const memberships = pgTable("memberships", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tenantId: uuid("tenant_id").defaultRandom().references(() => tenants.id),
  role: varchar("role",{ length: 30 }).notNull(),
  createdAt: timestamp("created_at").default().notNull(),
},
(table) => ({ userTenantUnique: unique()
  .on(table.userId,table.tenantId)
}));

export const accounts = pgTable("accounts",{
  id:uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: varchar("name" , { length: 150 }).notNull(),
  type: varchar("type", { length: 20 }).notNull(),
  currency: varchar("currency" , { length: 3 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

export const journalEntries = pgTable("journal_entries",{
  id:uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  description: text("description").notNull(),
  occuredAt: timestamp("occured_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull().unique(),
  reversedByEntryId: uuid("reversed_by_entry_id")
});

export const entryLines = pgTable("entry_lines", {
  id:uuid("key").defaultRandom().primaryKey(),
  entryId: uuid("entry_id").notNull().references(() => journalEntries.id),
  accountId : uuid("account_id").notNull().references(() => accounts.id),
  amountMinor: bigint("amount_minor", { mode : "bigint" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
});