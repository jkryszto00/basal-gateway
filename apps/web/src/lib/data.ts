import "server-only";
import { account, and, apiKeys, balanceMicroUsd, desc, eq, gte, isNull, sql, usageEvents } from "@basal/db";
import { balanceCacheKey } from "@basal/shared/keys";
import { requireUser } from "./auth";
import { db } from "./db";
import { redis } from "./redis";

// Every getter resolves the user itself, so no caller can ask for another user's data.

export async function getBalance(): Promise<number> {
  const user = await requireUser();
  // the gateway's hot balance includes charges not yet flushed to Postgres
  const hot = await redis.get(balanceCacheKey(user.id));
  return hot !== null ? Number(hot) : balanceMicroUsd(db, user.id);
}

export async function listKeys() {
  const user = await requireUser();
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      rpmLimit: apiKeys.rpmLimit,
      concurrencyLimit: apiKeys.concurrencyLimit,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));
}

export async function usageSummary(days = 30) {
  const user = await requireUser();
  const since = new Date(Date.now() - days * 86_400_000);
  const [row] = await db
    .select({
      requests: sql<number>`count(*)::int`,
      decisions: sql<number>`coalesce(sum(${usageEvents.questions}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::bigint`,
      cost: sql<number>`coalesce(sum(${usageEvents.costMicroUsd}), 0)::bigint`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by ${usageEvents.totalLatencyMs})`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, user.id), gte(usageEvents.createdAt, since)));
  return {
    requests: Number(row?.requests ?? 0),
    decisions: Number(row?.decisions ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    cost: Number(row?.cost ?? 0),
    p50: row?.p50 === null || row?.p50 === undefined ? null : Number(row.p50),
  };
}

/** Requests, decisions, tokens and cost per model over the last `days`, most used first. */
export async function usageByModel(days = 30) {
  const user = await requireUser();
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      model: usageEvents.model,
      requests: sql<number>`count(*)::int`,
      decisions: sql<number>`coalesce(sum(${usageEvents.questions}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::bigint`,
      cost: sql<number>`coalesce(sum(${usageEvents.costMicroUsd}), 0)::bigint`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, user.id), gte(usageEvents.createdAt, since)))
    .groupBy(usageEvents.model)
    .orderBy(desc(sql`count(*)`));
  return rows.map((r) => ({ ...r, inputTokens: Number(r.inputTokens), cost: Number(r.cost) }));
}

export async function recentUsage(limit = 100) {
  const user = await requireUser();
  return db
    .select({
      id: usageEvents.id,
      model: usageEvents.model,
      keyName: apiKeys.name,
      inputTokens: usageEvents.inputTokens,
      questions: usageEvents.questions,
      branches: usageEvents.branches,
      cost: usageEvents.costMicroUsd,
      latency: usageEvents.totalLatencyMs,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .leftJoin(apiKeys, eq(apiKeys.id, usageEvents.apiKeyId))
    .where(eq(usageEvents.userId, user.id))
    .orderBy(desc(usageEvents.createdAt))
    .limit(limit);
}

/** How the user can sign in: "credential" (email and password), "github", "google". */
export async function signInMethods(): Promise<string[]> {
  const user = await requireUser();
  const rows = await db.select({ provider: account.providerId }).from(account).where(eq(account.userId, user.id));
  return rows.map((r) => r.provider);
}
