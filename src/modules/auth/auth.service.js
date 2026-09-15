import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../../infrastructure/db/index.js";
import { tenants, users, memberships } from "../../infrastructure/db/schema.js";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/AppError.js";

const BCRYPT_COST = 12;
const TOKEN_EXPIRY = "15m";

function toPublicUser(user) {
  const { passwordHash, ...publicUser } = user;
  return publicUser;
}

export async function registerUser({ name, email, password, tenantName }) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  return await db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenants).values({ name: tenantName }).returning();

    const [user] = await tx
      .insert(users)
      .values({ name, email, passwordHash })
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
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");

  const [membership] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1);
  if (!membership) throw new AppError("User has no tenant membership", 401, "INVALID_CREDENTIALS");

  const token = jwt.sign(
    { sub: user.id, tenantId: membership.tenantId, role: membership.role },
    env.JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  return { token };
}
