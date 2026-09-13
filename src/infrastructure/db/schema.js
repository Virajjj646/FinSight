import { pgTable, uuid, varchar, timestamp, unique , bigint, text, integer} from "drizzle-orm/pg-core";
import { time } from "drizzle-orm/singlestore-core";
import { quotelessJson } from "zod/v3";

export const tenants = pgTable("tenants",{
  id:uuid("id").defaultRandom().primaryKey(),
  name:varchar("name", { length: 150}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
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
  occurredAt: timestamp("occured_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull().unique(),
  reversedByEntryId: uuid("reversed_by_entry_id")
});

export const entryLines = pgTable("entry_lines", {
  id:uuid("id").defaultRandom().primaryKey(),
  entryId: uuid("entry_id").notNull().references(() => journalEntries.id),
  accountId : uuid("account_id").notNull().references(() => accounts.id),
  amountMinor: bigint("amount_minor", { mode : "bigint" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

export const invoices = pgTable("invoices",{
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  invoiceNumber:  varchar("invoice_number", { length: 50 }).notNull(),
  customerName: varchar("customer_name", { length: 150 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("DRAFT"),
  currency: varchar("currency", { length: 3 }).notNull(),
  issueDate: timestamp("issue_date"),
  dueDate: timestamp("due_date"),
  totalAmountMinor: bigint("total_amount_minor",{ mode: "bigint"}).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updtedAt: timestamp("updated_at").defaultNow().notNull()
});

export const invoiceItems = pgTable("invoice_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  description: varchar("description" , { length: 255 }).notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceMinor: bigint("unit_price_minor",{ mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

export const invoicePayments = pgTable("invoice_payments",{
  id:uuid("id").defaultRandom().primaryKey(),
  invoiceId: uuid("invoice_id").notNull().references(()=> invoices.id),
  amountMinor: bigint("amount_minor" , { mode: "bigint" }).notNull(),
  paidAt: timestamp("paid_at").notNull(),
  journalEntryId: uuid("journal_entry_id").references(()=>journalEntries.id),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

export const invoiceStatusHistory = pgTable("invoice_status_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  invoiceId: uuid("invoice_id").notNull().references(()=>invoices.id),
  fromStatus: varchar("from_status", { length: 30 }),
  toStatus: varchar("to_status", { length: 30 }).notNull(),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
  reason: text("reason")
});