import { z } from "zod";

// JSON numbers above Number.MAX_SAFE_INTEGER lose precision before Zod ever
// sees them, so minor-unit amounts must arrive as strings, never numbers.
export const bigIntFromString = z
  .string({ message: "must be a string of digits, not a number" })
  .trim()
  .regex(/^-?\d+$/, "must be a string of digits")
  .transform((value) => BigInt(value));

export const positiveBigIntFromString = bigIntFromString.refine(
  (value) => value > 0n,
  { message: "must be greater than zero" },
);
