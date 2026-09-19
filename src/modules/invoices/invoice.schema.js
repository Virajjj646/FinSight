import { z } from "zod";
import { positiveBigIntFromString } from "../../lib/money.js";

export const createInvoiceSchema = z.object({
    customerName: z.string().min(1).max(150),
    currency: z.string().length(3).toUpperCase(),
    dueDate: z.coerce.date(),
    items: z.array(
        z.object({ description: z.string().min(1).max(255),
            quantity: z.number().int().positive(),
            unitPriceMinor: positiveBigIntFromString
        })
    ).min(1)
});

export const INVOICE_STATUSES = [ "DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE", "VOID"];

export const listInvoicesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
    status: z
        .string()
        .optional()
        .transform((s) => (s ? s.split(",").map((v) => v.trim().toUpperCase()) : undefined))
        .refine(
            (arr) => !arr || arr.every((v) => INVOICE_STATUSES.includes(v)),
            {message: `status must be one of: ${INVOICE_STATUSES.join(", ")}`}
        ),
        dueBefore: z.coerce.date().optional(),
});
