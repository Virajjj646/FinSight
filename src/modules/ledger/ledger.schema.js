import { z } from "zod";

export const createJournalEntrySchema = z.object({
    description: z.string().min(1).max(500),
    occurredAt: z.coerce.date(),
    lines: z.array(z.object({
        accountId: z.string().uuid(),
        amountMinor: z.coerce.bigint()
    }))
    .min(2)
});