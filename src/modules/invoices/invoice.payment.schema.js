import { z } from "zod";

export const createInvoicePaymentSchema = z.object({
    amountMinor: z.coerce.bigint().positive(),
    paidAt: z.coerce.date(),
    bankAccountId: z.string().uuid(),
    accountReceivableAccountId: z.string().uuid()
});