import { z } from "zod";
import { bigIntFromString } from "../../lib/money.js";
export { idempotencyKeySchema } from "../../lib/idempotency.js";

export const createJournalEntrySchema = z.object({
    description: z.string().min(1).max(500),
    occurredAt: z.coerce.date(),
    lines: z.array(z.object({
        accountId: z.string().uuid(),
        amountMinor: bigIntFromString
    }))
    .min(2)
});

export const listEntriesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
    accountId: z.string().uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});

export const balanceQuerySchema = z.object({
    asOf: z.coerce.date().optional(),
});
