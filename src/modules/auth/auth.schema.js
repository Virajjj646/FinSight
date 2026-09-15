import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(255),
  password: z.string().min(8).max(255),
  tenantName: z.string().min(1).max(150),
});

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1),
});
