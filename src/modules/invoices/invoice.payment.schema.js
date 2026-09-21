import { z } from "zod";
import { positiveBigIntFromString } from "../../lib/money.js";

export const createInvoicePaymentSchema = z.object({
    amountMinor: positiveBigIntFromString,
    paidAt: z.coerce.date().refine((d) => d <= new Date(), "paidAt cannot be in the future").optional(),
    bankAccountId: z.string().uuid(),
    accountReceivableAccountId: z.string().uuid()
});