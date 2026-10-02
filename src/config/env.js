import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  PORT: z.coerce.number().int().positive(),
  // Empty (as in .env.example) means admin routes are disabled.
  ADMIN_TOKEN: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(32, "ADMIN_TOKEN must be at least 32 characters").optional()
  ),
  FINSIGHT_LLM_BASE_URL: z.string().url().optional(),
  FINSIGHT_LLM_API_KEY: z.string().min(1).optional(),
  FINSIGHT_LLM_MODEL: z.string().min(1).default("llama-3.3-70b-versatile"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;
