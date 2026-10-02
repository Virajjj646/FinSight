import { asc, eq } from "drizzle-orm";
import { db } from "../../infrastructure/db/index.js";
import { users, memberships } from "../../infrastructure/db/schema.js";
import { hashPassword, normalizeEmail, toPublicUser } from "../auth/auth.service.js";

export async function listMembers({ tenantId }) {
  return db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId))
    .orderBy(asc(memberships.createdAt), asc(users.id));
}

// users.email is globally unique, so an existing email fails the insert with
// 23505, which errorHandler maps to 409 CONFLICT and rolls back the membership.
export async function createMember({ tenantId, name, email, password, role }) {
  const passwordHash = await hashPassword(password);

  return await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ name, email: normalizeEmail(email), passwordHash })
      .returning();

    const [membership] = await tx
      .insert(memberships)
      .values({ userId: user.id, tenantId, role })
      .returning();

    return { user: toPublicUser(user), role: membership.role };
  });
}
