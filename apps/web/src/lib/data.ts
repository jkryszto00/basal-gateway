import "server-only";
import {
  account,
  and,
  apiKeys,
  desc,
  eq,
  gt,
  gte,
  invitation,
  isNull,
  member,
  organization,
  sql,
  usageEvents,
  user as users,
} from "@basal/db";
import { requireOrg, requireUser } from "./auth";
import { db } from "./db";

// Every getter resolves the user and their active organization itself, so no caller can ask for data of an
// organization the user does not belong to.

export async function listKeys() {
  const { org } = await requireOrg();
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      createdBy: apiKeys.createdBy,
      creator: users.name,
      prefix: apiKeys.prefix,
      rpmLimit: apiKeys.rpmLimit,
      concurrencyLimit: apiKeys.concurrencyLimit,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.createdBy))
    .where(and(eq(apiKeys.organizationId, org.id), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));
}

export async function usageSummary(days = 30) {
  const { org } = await requireOrg();
  const since = new Date(Date.now() - days * 86_400_000);
  const [row] = await db
    .select({
      requests: sql<number>`count(*)::int`,
      decisions: sql<number>`coalesce(sum(${usageEvents.questions}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::bigint`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by ${usageEvents.totalLatencyMs})`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.organizationId, org.id), gte(usageEvents.createdAt, since)));
  return {
    requests: Number(row?.requests ?? 0),
    decisions: Number(row?.decisions ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    p50: row?.p50 === null || row?.p50 === undefined ? null : Number(row.p50),
  };
}

/** Requests, decisions, tokens and latency per model over the last `days`, most used first. */
export async function usageByModel(days = 30) {
  const { org } = await requireOrg();
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      model: usageEvents.model,
      requests: sql<number>`count(*)::int`,
      decisions: sql<number>`coalesce(sum(${usageEvents.questions}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::bigint`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by ${usageEvents.totalLatencyMs})`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.organizationId, org.id), gte(usageEvents.createdAt, since)))
    .groupBy(usageEvents.model)
    .orderBy(desc(sql`count(*)`));
  return rows.map((r) => ({ ...r, inputTokens: Number(r.inputTokens), p50: r.p50 === null ? null : Number(r.p50) }));
}

export async function recentUsage(limit = 100) {
  const { org } = await requireOrg();
  return db
    .select({
      id: usageEvents.id,
      model: usageEvents.model,
      keyName: apiKeys.name,
      inputTokens: usageEvents.inputTokens,
      questions: usageEvents.questions,
      branches: usageEvents.branches,
      latency: usageEvents.totalLatencyMs,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .leftJoin(apiKeys, eq(apiKeys.id, usageEvents.apiKeyId))
    .where(eq(usageEvents.organizationId, org.id))
    .orderBy(desc(usageEvents.createdAt))
    .limit(limit);
}

/** How the user can sign in: "credential" (email and password), "github", "google". */
export async function signInMethods(): Promise<string[]> {
  const user = await requireUser();
  const rows = await db.select({ provider: account.providerId }).from(account).where(eq(account.userId, user.id));
  return rows.map((r) => r.provider);
}

/** Members of the active organization, owners first. */
export async function orgMembers() {
  const { org } = await requireOrg();
  const rows = await db
    .select({
      id: member.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      role: member.role,
      joined: member.createdAt,
    })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(eq(member.organizationId, org.id))
    .orderBy(member.createdAt);
  const rank: Record<string, number> = { owner: 0, admin: 1, member: 2 };
  return rows.sort((a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3));
}

/** Invitations of the active organization that can still be accepted. */
export async function orgInvitations() {
  const { org } = await requireOrg();
  return db
    .select({ id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, org.id),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitation.createdAt));
}

/** Invitations waiting for the signed-in user, by their email address. */
export async function myInvitations() {
  const user = await requireUser();
  return db
    .select({ id: invitation.id, organization: organization.name, role: invitation.role })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(
      and(
        eq(invitation.email, user.email.toLowerCase()),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    );
}
