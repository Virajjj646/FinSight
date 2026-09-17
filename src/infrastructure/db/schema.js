import { pgTable, uuid, varchar, timestamp, unique, bigint, text, integer, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const tenants = pgTable("tenants",{
  id:uuid("id").defaultRandom().primaryKey(),
  name:varchar("name", { length: 150}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const memberships = pgTable("memberships", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  role: varchar("role",{ length: 30 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
},
(table) => [
  unique().on(table.userId, table.tenantId),
  index("memberships_user_id_idx").on(table.userId),
  index("memberships_tenant_id_idx").on(table.tenantId),
]);

export const accounts = pgTable("accounts",{
  id:uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: varchar("name" , { length: 150 }).notNull(),
  type: varchar("type", { length: 20 }).notNull(),
  currency: varchar("currency" , { length: 3 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
},
(table) => [
  index("accounts_tenant_id_idx").on(table.tenantId),
  check("accounts_type_check", sql`${table.type} IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')`),
  check("accounts_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
]);

export const journalEntries = pgTable("journal_entries",{
  id:uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  description: text("description").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
  reversedByEntryId: uuid("reversed_by_entry_id").references(() => journalEntries.id)
},
(table) => [
  unique().on(table.tenantId, table.idempotencyKey),
  index("journal_entries_tenant_id_occurred_at_idx").on(table.tenantId, table.occurredAt),
]);

export const entryLines = pgTable("entry_lines", {
  id:uuid("id").defaultRandom().primaryKey(),
  entryId: uuid("entry_id").notNull().references(() => journalEntries.id),
  accountId : uuid("account_id").notNull().references(() => accounts.id),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  amountMinor: bigint("amount_minor", { mode : "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
},
(table) => [
  index("entry_lines_account_id_idx").on(table.accountId),
  index("entry_lines_entry_id_idx").on(table.entryId),
  index("entry_lines_tenant_id_idx").on(table.tenantId),
]);

export const invoices = pgTable("invoices",{
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  invoiceNumber:  varchar("invoice_number", { length: 50 }).notNull(),
  customerName: varchar("customer_name", { length: 150 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("DRAFT"),
  currency: varchar("currency", { length: 3 }).notNull(),
  issueDate: timestamp("issue_date", { withTimezone: true }),
  dueDate: timestamp("due_date", { withTimezone: true }),
  totalAmountMinor: bigint("total_amount_minor",{ mode: "bigint"}).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
},
(table) => [
  unique().on(table.tenantId, table.invoiceNumber),
  index("invoices_tenant_id_status_idx").on(table.tenantId, table.status),
  index("invoices_tenant_id_due_date_idx").on(table.tenantId, table.dueDate),
  check("invoices_status_check", sql`${table.status} IN ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','OVERDUE','VOID')`),
  check("invoices_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
]);

export const invoiceItems = pgTable("invoice_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  description: varchar("description" , { length: 255 }).notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceMinor: bigint("unit_price_minor",{ mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
},
(table) => [
  index("invoice_items_invoice_id_idx").on(table.invoiceId),
  check("invoice_items_quantity_check", sql`${table.quantity} > 0`),
  check("invoice_items_unit_price_minor_check", sql`${table.unitPriceMinor} > 0`),
]);

export const invoicePayments = pgTable("invoice_payments",{
  id:uuid("id").defaultRandom().primaryKey(),
  invoiceId: uuid("invoice_id").notNull().references(()=> invoices.id),
  amountMinor: bigint("amount_minor" , { mode: "bigint" }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
  journalEntryId: uuid("journal_entry_id").references(()=>journalEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
},
(table) => [
  unique().on(table.tenantId, table.idempotencyKey),
  index("invoice_payments_invoice_id_idx").on(table.invoiceId),
  check("invoice_payments_amount_minor_check", sql`${table.amountMinor} > 0`),
]);

export const invoiceStatusHistory = pgTable("invoice_status_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  invoiceId: uuid("invoice_id").notNull().references(()=>invoices.id),
  fromStatus: varchar("from_status", { length: 30 }),
  toStatus: varchar("to_status", { length: 30 }).notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  reason: text("reason")
},
(table) => [
  index("invoice_status_history_invoice_id_idx").on(table.invoiceId),
]);
