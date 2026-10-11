import { and, count, type Db, eq, gte, sql, usageEvents } from "@basal/db";
import type { Redis } from "ioredis";
import type { Scope } from "./limits";

// Monthly quotas (calendar month, UTC) per API key and per organization, counted in successful requests and input
// tokens. The counters live in Redis, one hash per scope and month; a missing hash (new month, Redis restarted) is
// seeded from the usage in Postgres. The check runs before the inference server and the count after it, so a quota
// can be overshot by the requests in flight when it runs out.

/** null or 0: no quota */
export type Quota = { requests: number | null; tokens: number | null };

const TTL_S = 40 * 86_400;
const month = (now: number) => new Date(now).toISOString().slice(0, 7);
const hashKey = (scope: Scope, now: number) => `month:${scope}:${month(now)}`;

export function secondsToNextMonth(now = Date.now()): number {
  const d = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - now) / 1000));
}

async function used(db: Db, redis: Redis, scope: Scope, now: number): Promise<{ requests: number; tokens: number }> {
  const key = hashKey(scope, now);
  const h = await redis.hgetall(key);
  if (h.requests !== undefined) return { requests: Number(h.requests), tokens: Number(h.tokens ?? 0) };
  const d = new Date(now);
  const since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const [kind, id] = scope.split(/:(.*)/) as ["key" | "org", string];
  const [row] = await db
    .select({ requests: count(), tokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)` })
    .from(usageEvents)
    .where(
      and(
        eq(kind === "key" ? usageEvents.apiKeyId : usageEvents.organizationId, id),
        gte(usageEvents.createdAt, since),
      ),
    );
  const seed = { requests: Number(row?.requests ?? 0), tokens: Number(row?.tokens ?? 0) };
  // NX: requests recorded meanwhile win
  await redis
    .multi()
    .hsetnx(key, "requests", seed.requests)
    .hsetnx(key, "tokens", seed.tokens)
    .expire(key, TTL_S)
    .exec();
  return seed;
}

export type QuotaCheck = { scope: Scope; quota: Quota; of: string };
export type QuotaExceeded = { unit: "requests" | "input tokens"; limit: number; of: string };

/** The first quota already used up, or null. */
export async function checkQuotas(db: Db, redis: Redis, checks: QuotaCheck[], now = Date.now()) {
  for (const { scope, quota, of } of checks) {
    if (!quota.requests && !quota.tokens) continue;
    const u = await used(db, redis, scope, now);
    if (quota.requests && u.requests >= quota.requests) return { unit: "requests", limit: quota.requests, of } as const;
    if (quota.tokens && u.tokens >= quota.tokens) return { unit: "input tokens", limit: quota.tokens, of } as const;
  }
  return null;
}

// only counters that exist: a missing one is seeded from Postgres when next checked
const RECORD = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('HINCRBY', KEYS[1], 'requests', 1)
  redis.call('HINCRBY', KEYS[1], 'tokens', ARGV[1])
end
return 0`;

/** Counts a successful request against the month's counters of its key and organization. */
export async function recordQuotaUsage(redis: Redis, scopes: Scope[], tokens: number, now = Date.now()) {
  await Promise.all(scopes.map((s) => redis.eval(RECORD, 1, hashKey(s, now), tokens)));
}
