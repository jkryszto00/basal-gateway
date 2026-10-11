import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "./index";
import { apiKeys, usageEvents, user } from "./schema";

// Usage of an organization over a period, for exports (dashboard CSV, GET /v1/usage). Only events already written to
// Postgres count: the gateway flushes them a few seconds after each request.

export const USAGE_GROUPS = ["day", "model", "key"] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export type UsageRange = { organizationId: string; from: Date; to: Date };

/** Totals per day (UTC), model and/or key, in that order; no groups: one row for the whole period. */
export async function aggregateUsage(db: Db, range: UsageRange, groupBy: UsageGroup[] = []) {
  const day = sql<string>`to_char(${usageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const keyName = sql<string | null>`${apiKeys.name}`;
  const keyPrefix = sql<string | null>`${apiKeys.prefix}`;
  const columns = {
    ...(groupBy.includes("day") ? { day } : {}),
    ...(groupBy.includes("model") ? { model: usageEvents.model } : {}),
    ...(groupBy.includes("key") ? { key: keyName, keyPrefix } : {}),
  };
  const groups = [
    ...(groupBy.includes("day") ? [day] : []),
    ...(groupBy.includes("model") ? [usageEvents.model] : []),
    ...(groupBy.includes("key") ? [keyName, keyPrefix] : []),
  ];
  const rows = await db
    .select({
      ...columns,
      requests: sql<number>`count(*)::int`,
      decisions: sql<number>`coalesce(sum(${usageEvents.questions}), 0)::int`,
      branches: sql<number>`coalesce(sum(${usageEvents.branches}), 0)::int`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)::bigint`,
    })
    .from(usageEvents)
    .leftJoin(apiKeys, eq(apiKeys.id, usageEvents.apiKeyId))
    .where(inRange(range))
    .groupBy(...groups)
    .orderBy(...groups);
  return rows.map((r) => ({ ...r, inputTokens: Number(r.inputTokens) }));
}

/** Every request of the period, oldest first, at most `limit`. */
export async function usageEventsInRange(db: Db, range: UsageRange, limit = 100_000) {
  return db
    .select({
      id: usageEvents.id,
      time: usageEvents.createdAt,
      model: usageEvents.model,
      key: apiKeys.name,
      keyPrefix: apiKeys.prefix,
      member: user.email,
      inputTokens: usageEvents.inputTokens,
      questions: usageEvents.questions,
      branches: usageEvents.branches,
      latencyMs: usageEvents.totalLatencyMs,
      details: usageEvents.details,
    })
    .from(usageEvents)
    .leftJoin(apiKeys, eq(apiKeys.id, usageEvents.apiKeyId))
    .leftJoin(user, eq(user.id, usageEvents.userId))
    .where(inRange(range))
    .orderBy(usageEvents.createdAt)
    .limit(limit);
}

function inRange({ organizationId, from, to }: UsageRange) {
  return and(
    eq(usageEvents.organizationId, organizationId),
    gte(usageEvents.createdAt, from),
    lt(usageEvents.createdAt, to),
  );
}

/**
 * A period from optional ISO dates (YYYY-MM-DD, UTC): `from` inclusive (default: the 1st of this month), `to`
 * exclusive (default: now, or the day after an explicit date). At most 366 days.
 */
export function parseUsageRange(from?: string | null, to?: string | null, now = new Date()) {
  const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : new Date(Number.NaN));
  const start = from ? date(from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = to ? new Date(date(to).getTime() + 86_400_000) : now;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { error: "dates are YYYY-MM-DD" } as const;
  if (end <= start) return { error: "to is before from" } as const;
  if (end.getTime() - start.getTime() > 366 * 86_400_000) return { error: "at most 366 days" } as const;
  return { from: start, to: end } as const;
}
