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