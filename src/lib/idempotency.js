import { createHash } from "node:crypto";
import { z } from "zod";

function canonicalise(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (value instanceof Date) return `"${value.toISOString()}"`;
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(data) {
  return createHash("sha256").update(canonicalise(data)).digest("hex");
}

export const idempotencyKeySchema = z
  .string({ message: "Idempotency-Key header is required" })
  .trim()
  .min(1, "Idempotency-Key must not be empty")
  .max(255, "Idempotency-Key must be at most 255 characters");
