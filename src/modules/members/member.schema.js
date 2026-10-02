import { z } from "zod";

// OWNER is only ever created by registration; members are added as ADMIN or MEMBER.
export const MEMBER_ROLES = ["ADMIN", "MEMBER"];

export const createMemberSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(255),
  password: z.string().min(8).max(255),
  role: z.enum(MEMBER_ROLES),
});
