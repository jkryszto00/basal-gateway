import { randomBytes, randomUUID } from "node:crypto";
import { account, and, apiKeys, type Db, desc, eq, gte, isNull, sql, usageEvents, user } from "@basal/db";
import { apiKeyCacheKey } from "@basal/shared/keys";
import { hashPassword } from "better-auth/crypto";
import type { Redis } from "ioredis";

// Administration straight on the database, for what the dashboard does not do (yet): accounts on a closed instance,
// confirming or removing accounts, revoking keys, usage over all accounts. Works whatever SIGNUP_MODE says.

const MIN_PASSWORD = 10;

export type Ctx = { db: Db; redis: Redis };

async function userByEmail({ db }: Ctx, email: string) {
  const [row] = await db.select().from(user).where(eq(user.email, email.trim().toLowerCase()));
  if (!row) throw new Error(`no account for ${email}`);
  return row;
}

export async function listUsers({ db }: Ctx) {
  return db
    .select({
      email: user.email,
      name: user.name,
      verified: user.emailVerified,
      created: user.createdAt,
      // correlated subqueries, qualified by hand: drizzle leaves columns unqualified inside sql``
      keys: sql<number>`(select count(*)::int from api_keys k where k.user_id = "user".id and k.revoked_at is null)`,
      lastRequest: sql<Date | null>`(select max(u.created_at) from usage_events u where u.user_id = "user".id)`,
    })
    .from(user)
    .orderBy(user.createdAt);
}

/**
 * An account with a confirmed email and a password, signed in like any other. Without `password` a random one is
 * generated and returned (shown once).
 */
export async function addUser({ db }: Ctx, email: string, opts: { name?: string; password?: string } = {}) {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error(`not an email address: ${email}`);
  const password = opts.password ?? randomBytes(15).toString("base64url");
  if (password.length < MIN_PASSWORD) throw new Error(`the password needs at least ${MIN_PASSWORD} characters`);
  const id = randomUUID();
  await db.transaction(async (tx) => {
    const [taken] = await tx.select({ id: user.id }).from(user).where(eq(user.email, address));
    if (taken) throw new Error(`${address} already has an account`);
    await tx.insert(user).values({ id, email: address, name: opts.name ?? address.split("@")[0]!, emailVerified: true });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: await hashPassword(password),
    });
  });
  return { email: address, password: opts.password ? undefined : password };
}

export async function verifyUser(ctx: Ctx, email: string) {
  const u = await userByEmail(ctx, email);
  await ctx.db.update(user).set({ emailVerified: true, updatedAt: new Date() }).where(eq(user.id, u.id));
}

/** Deletes the account with its keys, sessions and usage (cascade); its keys stop working at once. */
export async function deleteUser(ctx: Ctx, email: string) {
  const u = await userByEmail(ctx, email);
  const keys = await ctx.db.select({ hash: apiKeys.hash }).from(apiKeys).where(eq(apiKeys.userId, u.id));
  if (keys.length) await ctx.redis.del(...keys.map((k) => apiKeyCacheKey(k.hash)));
  await ctx.db.delete(user).where(eq(user.id, u.id));
}

export async function listKeys(ctx: Ctx, email: string) {
  const u = await userByEmail(ctx, email);
  return ctx.db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      rpm: apiKeys.rpmLimit,
      concurrency: apiKeys.concurrencyLimit,
      created: apiKeys.createdAt,
      lastUsed: apiKeys.lastUsedAt,
      revoked: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, u.id))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeKey({ db, redis }: Ctx, id: string) {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ hash: apiKeys.hash });
  if (!row) throw new Error(`no active key ${id}`);
  await redis.del(apiKeyCacheKey(row.hash)); // the gateway stops accepting it immediately
}

/** Requests, decisions, branches and input tokens per account and model over the last `days`. */
export async function usageReport({ db }: Ctx, days: number) {
  const rows = await db
    .select({
      email: user.email,
      model: usageEvents.model,
      requests: sql<number>`count(*)::int`,
      decisions: sql<number>`sum(${usageEvents.questions})::int`,
      branches: sql<number>`sum(${usageEvents.branches})::int`,
      inputTokens: sql<string>`sum(${usageEvents.inputTokens})::bigint`,
    })
    .from(usageEvents)
    .innerJoin(user, eq(user.id, usageEvents.userId))
    .where(gte(usageEvents.createdAt, new Date(Date.now() - days * 86_400_000)))
    .groupBy(user.email, usageEvents.model)
    .orderBy(user.email, usageEvents.model);
  return rows.map((r) => ({ ...r, inputTokens: Number(r.inputTokens) }));
}
