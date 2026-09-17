import { z } from "zod";

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];

export const createAccountSchema = z.object({
    name: z.string().min(1).max(150),
    type: z.enum(ACCOUNT_TYPES),
    currency: z.string().length(3).toUpperCase()
});

export const listAccountsQuerySchema = z.object({
    type: z.enum(ACCOUNT_TYPES).optional(),
})