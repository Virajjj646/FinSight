import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import { db } from "../../infrastructure/db/index.js";
import { tenants, users, memberships } from "../../infrastructure/db/schema.js";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/AppError.js";

const BCRYPT_COST = 12;

const DUMMY_PASSWORD_HASH = await bcrypt.hash("finsight-dummy-password-for-timing-safety", BCRYPT_COST);

function toPublicUser(user) {
  const { passwordHash, ...publicUser } = user;
  return publicUser;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

export async function registerUser({ name, email, password, tenantName }) {
  const normalizedEmail = normalizeEmail(email);
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  return await db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenants).values({ name: tenantName }).returning();

    const [user] = await tx
      .insert(users)
      .values({ name, email: normalizedEmail, passwordHash })
      .returning();

    await tx.insert(memberships).values({
      userId: user.id,
      tenantId: tenant.id,
      role: "OWNER",
    });

    return { user: toPublicUser(user), tenant };
  });
}

export async function loginUser({ email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);

  const passwordMatches = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");

  const [membership] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1);
  if (!membership) throw new AppError("User has no tenant membership", 401, "INVALID_CREDENTIALS");

  const token = jwt.sign(
    { sub: user.id, tenantId: membership.tenantId, role: membership.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRY }
  );

  return { token, expiresIn: env.JWT_EXPIRY };
}

// The role comes from the membership row, not the token, so a role change or
// a removed membership is reflected before the token expires.
export async function getCurrentUser({ userId, tenantId }) {
  const [row] = await db
    .select({
      user: { id: users.id, name: users.name, email: users.email },
      tenant: { id: tenants.id, name: tenants.name },
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
    .limit(1);

  if (!row) throw new AppError("Invalid or expired token", 401, "UNAUTHENTICATED");
  return row;
}
