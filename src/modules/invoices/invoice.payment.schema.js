import { z } from "zod";
import { positiveBigIntFromString } from "../../lib/money.js";

export const createInvoicePaymentSchema = z.object({
    amountMinor: positiveBigIntFromString,
    paidAt: z.coerce.date(),
    bankAccountId: z.string().uuid(),
    accountReceivableAccountId: z.string().uuid()
});