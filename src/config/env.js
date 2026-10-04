import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  // jsonwebtoken expiresIn string. Empty (as in .env.example) means the default.
  JWT_EXPIRY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .min(1)
      .regex(/^\d+[smhd]$/, 'JWT_EXPIRY must be a number followed by s, m, h or d (e.g. "15m", "8h")')
      .default("15m")
  ),
  PORT: z.coerce.number().int().positive(),
  // Empty (as in .env.example) means admin routes are disabled.
  ADMIN_TOKEN: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(32, "ADMIN_TOKEN must be at least 32 characters").optional()
  ),
  FINSIGHT_LLM_BASE_URL: z.string().url().optional(),
  FINSIGHT_LLM_API_KEY: z.string().min(1).optional(),
  FINSIGHT_LLM_MODEL: z.string().min(1).default("llama-3.3-70b-versatile"),
  // Comma-separated browser origins allowed to call the API. Empty means none.
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(",").map((o) => o.trim()).filter(Boolean)),
  RATE_LIMIT_ASK_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_LOGIN_PER_15MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_REGISTER_PER_HOUR: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_UPLOAD_PER_HOUR: z.coerce.number().int().positive().default(30),
  // POST /api/members per tenant per hour.
  RATE_LIMIT_MEMBER_CREATE_PER_HOUR: z.coerce.number().int().positive().default(20),
  // LLM calls per tenant per UTC day. Abstentions before the LLM don't count.
  LLM_DAILY_BUDGET_PER_TENANT: z.coerce.number().int().positive().default(200),
  // When true, the API process also runs the BullMQ invoice scheduler and the
  // invoice/document workers (single-instance free hosting). src/worker.js
  // remains the standalone entry point. Empty (as in .env.example) means false.
  RUN_WORKER: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["true", "false"]).default("false").transform((v) => v === "true")
  ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;
