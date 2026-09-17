import { z } from "zod";
import { bigIntFromString } from "../../lib/money.js";

export const createJournalEntrySchema = z.object({
    description: z.string().min(1).max(500),
    occurredAt: z.coerce.date(),
    lines: z.array(z.object({
        accountId: z.string().uuid(),
        amountMinor: bigIntFromString
    }))
    .min(2)
});

export { idempotencyKeySchema } from "../../lib/idempotency.js";
