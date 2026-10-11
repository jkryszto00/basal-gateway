import { randomBytes, randomUUID } from "node:crypto";
import {
  account,
  accountDeletionPlan,
  and,
  apiKeys,
  type Db,
  desc,
  ensurePersonalOrganization,
  eq,
  gte,
  inArray,
  isNull,
  isPersonalOrganization,
  member,
  organization,
  organizationQuotas,
  sql,
  usageEvents,
  user,
} from "@basal/db";
import { apiKeyCacheKey } from "@basal/shared/keys";
import { hashPassword } from "better-auth/crypto";
import type { Redis } from "ioredis";

// Administration straight on the database, for what the dashboard does not do (yet): accounts on a closed instance,
// confirming or removing accounts, adding members, revoking keys, usage over all organizations. Works whatever
// SIGNUP_MODE says.

const MIN_PASSWORD = 10;
const ROLES = ["member", "admin", "owner"] as const;

export type Ctx = { db: Db; redis: Redis };

async function userByEmail({ db }: Ctx, email: string) {
  const [row] = await db.select().from(user).where(eq(user.email, email.trim().toLowerCase()));
  if (!row) throw new Error(`no account for ${email}`);
  return row;
}

/** An organization by slug or id (`bun run admin orgs` lists both). */
async function orgByRef({ db }: Ctx, ref: string) {
  const [row] = await db
    .select()
    .from(organization)
    .where(sql`${organization.slug} = ${ref} or ${organization.id} = ${ref}`);
  if (!row) throw new Error(`no organization ${ref}`);
  return row;
}

export async function listUsers({ db }: Ctx) {
  return db
    .select({
      email: user.email,
      name: user.name,
      verified: user.emailVerified,
      created: user.createdAt,
      organizations: sql<number>`(select count(*)::int from member m where m.user_id = "user".id)`,
    })
    .from(user)
    .orderBy(user.createdAt);
}

/**
 * An account with a confirmed email, a password and its personal organization, signed in like any other. Without
 * `password` a random one is generated and returned (shown once).
 */
export async function addUser(ctx: Ctx, email: string, opts: { name?: string; password?: string } = {}) {
  const { db } = ctx;
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error(`not an email address: ${email}`);
  const password = opts.password ?? randomBytes(15).toString("base64url");
  if (password.length < MIN_PASSWORD) throw new Error(`the password needs at least ${MIN_PASSWORD} characters`);
  const id = randomUUID();
  const name = opts.name ?? address.split("@")[0]!;
  await db.transaction(async (tx) => {
    const [taken] = await tx.select({ id: user.id }).from(user).where(eq(user.email, address));
    if (taken) throw new Error(`${address} already has an account`);
    await tx.insert(user).values({ id, email: address, name, emailVerified: true });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: await hashPassword(password),
    });
  });
  await ensurePersonalOrganization(db, { id, name });
  return { email: address, password: opts.password ? undefined : password };
}

export async function verifyUser(ctx: Ctx, email: string) {
  const u = await userByEmail(ctx, email);
  await ctx.db.update(user).set({ emailVerified: true, updatedAt: new Date() }).where(eq(user.id, u.id));
}

/**
 * Deletes the account with its personal organization and those only it belongs to (their keys and usage cascade);
 * refused while it is the only owner of a shared organization. Deleted keys stop working at once.
 */
export async function deleteUser(ctx: Ctx, email: string) {
  const u = await userByEmail(ctx, email);
  const plan = await accountDeletionPlan(ctx.db, u.id);
  if (plan.soleOwnerOf.length)
    throw new Error(`${email} is the only owner of ${plan.soleOwnerOf.join(", ")}: add another owner first`);
  if (plan.organizationIds.length) {
    const keys = await ctx.db
      .select({ hash: apiKeys.hash })
      .from(apiKeys)
      .where(inArray(apiKeys.organizationId, plan.organizationIds));
    if (keys.length) await ctx.redis.del(...keys.map((k) => apiKeyCacheKey(k.hash)));
    await ctx.db.delete(organization).where(inArray(organization.id, plan.organizationIds));
  }
  await ctx.db.delete(user).where(eq(user.id, u.id));
}

export async function listOrgs({ db }: Ctx) {
  const rows = await db
    .select({
      slug: organization.slug,
      name: organization.name,
      created: organization.createdAt,
      members: sql<number>`(select count(*)::int from member m where m.organization_id = "organization".id)`,
      monthlyRequests: organizationQuotas.monthlyRequests,
      monthlyTokens: organizationQuotas.monthlyTokens,
      keys: sql<number>`(select count(*)::int from api_keys k where k.organization_id = "organization".id and k.revoked_at is null)`,
      lastRequest: sql<
        string | null
      >`(select max(u.created_at) from usage_events u where u.organization_id = "organization".id)`,
    })
    .from(organization)
    .leftJoin(organizationQuotas, eq(organizationQuotas.organizationId, organization.id))
    .orderBy(organization.createdAt);
  // raw sql`` values come back as text, unlike typed columns
  return rows.map((r) => ({
    ...r,
    personal: isPersonalOrganization(r),
    lastRequest: r.lastRequest === null ? null : new Date(r.lastRequest),
  }));
}

/** Adds an existing account to an organization without an invitation (e.g. on a closed instance). */
export async function addMember(ctx: Ctx, orgRef: string, email: string, role: string = "member") {
  if (!ROLES.includes(role as (typeof ROLES)[number])) throw new Error(`role: ${ROLES.join(", ")}`);
  const org = await orgByRef(ctx, orgRef);
  if (isPersonalOrganization(org)) throw new Error("personal organizations have no other members");
  const u = await userByEmail(ctx, email);
  const [existing] = await ctx.db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, org.id), eq(member.userId, u.id)));
  if (existing) throw new Error(`${email} is already a member of ${org.name}`);
  await ctx.db.insert(member).values({ id: randomUUID(), organizationId: org.id, userId: u.id, role });
}

export async function listKeys(ctx: Ctx, orgRef: string) {
  const org = await orgByRef(ctx, orgRef);
  return ctx.db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      createdBy: user.email,
      rpm: apiKeys.rpmLimit,
      concurrency: apiKeys.concurrencyLimit,
      created: apiKeys.createdAt,
      lastUsed: apiKeys.lastUsedAt,
      revoked: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .leftJoin(user, eq(user.id, apiKeys.createdBy))
    .where(eq(apiKeys.organizationId, org.id))
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

/** Requests, decisions, branches and input tokens per organization and model over the last `days`. */
export async function usageReport({ db }: Ctx, days: number) {
  const rows = await db
    .select({
      organization: organization.slug,
      name: organization.name,
      model: usageEvents.model,
      requests: sql<number>`count(*)::int`,
      decisions: sql<number>`sum(${usageEvents.questions})::int`,
      branches: sql<number>`sum(${usageEvents.branches})::int`,
      inputTokens: sql<string>`sum(${usageEvents.inputTokens})::bigint`,
    })
    .from(usageEvents)
    .innerJoin(organization, eq(organization.id, usageEvents.organizationId))
    .where(gte(usageEvents.createdAt, new Date(Date.now() - days * 86_400_000)))
    .groupBy(organization.slug, organization.name, usageEvents.model)
    .orderBy(organization.slug, usageEvents.model);
  return rows.map((r) => ({ ...r, inputTokens: Number(r.inputTokens) }));
}

/**
 * Sets an organization's monthly quota (calendar month, UTC); 0 clears a value, which then falls back to
 * ORG_MONTHLY_REQUESTS / ORG_MONTHLY_TOKENS. Clears the gateway's key cache so it applies at once.
 */
export async function setOrgQuota(ctx: Ctx, orgRef: string, quota: { requests?: number; tokens?: number }) {
  const org = await orgByRef(ctx, orgRef);
  for (const v of [quota.requests, quota.tokens])
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new Error("quotas are whole numbers, 0 to clear");
  const value = (v: number | undefined) => (v === undefined ? undefined : v || null);
  const set = { monthlyRequests: value(quota.requests), monthlyTokens: value(quota.tokens), updatedAt: new Date() };
  await ctx.db
    .insert(organizationQuotas)
    .values({ organizationId: org.id, ...set })
    .onConflictDoUpdate({ target: organizationQuotas.organizationId, set });
  const keys = await ctx.db.select({ hash: apiKeys.hash }).from(apiKeys).where(eq(apiKeys.organizationId, org.id));
  if (keys.length) await ctx.redis.del(...keys.map((k) => apiKeyCacheKey(k.hash)));
  const [row] = await ctx.db.select().from(organizationQuotas).where(eq(organizationQuotas.organizationId, org.id));
  return { requests: row?.monthlyRequests ?? null, tokens: row?.monthlyTokens ?? null };
}
