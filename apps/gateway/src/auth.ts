import { apiKeys, type Db, eq, organizationQuotas } from "@basal/db";
import { apiKeyCacheKey, hashApiKey, looksLikeApiKey } from "@basal/shared/keys";
import type { Redis } from "ioredis";

/** An API key belongs to an organization; `userId` is the member who created it (null once they left). */
export type KeyInfo = {
  keyId: string;
  organizationId: string;
  userId: string | null;
  rpmLimit: number;
  concurrencyLimit: number;
  /** the key's own monthly quota, and the organization's when set by the admin (else the gateway's default) */
  monthlyRequests: number | null;
  monthlyTokens: number | null;
  orgMonthlyRequests: number | null;
  orgMonthlyTokens: number | null;
};

const TTL_S = 60; // revocation also deletes the cache entry (web app); the TTL bounds staleness otherwise
const MISS_TTL_S = 10; // unknown keys: avoid a database query per attempt

export async function resolveKey(db: Db, redis: Redis, header: string | undefined): Promise<KeyInfo | null> {
  const key = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!key || !looksLikeApiKey(key)) return null;
  const hash = hashApiKey(key);
  const cacheKey = apiKeyCacheKey(hash);

  const cached = await redis.get(cacheKey);
  if (cached === "") return null;
  const hit = cached === null ? null : (JSON.parse(cached) as Partial<KeyInfo>);
  if (hit?.organizationId && "monthlyRequests" in hit) return hit as KeyInfo; // older cache entries: look up again

  const [row] = await db
    .select({
      keyId: apiKeys.id,
      organizationId: apiKeys.organizationId,
      userId: apiKeys.createdBy,
      rpmLimit: apiKeys.rpmLimit,
      concurrencyLimit: apiKeys.concurrencyLimit,
      monthlyRequests: apiKeys.monthlyRequests,
      monthlyTokens: apiKeys.monthlyTokens,
      orgMonthlyRequests: organizationQuotas.monthlyRequests,
      orgMonthlyTokens: organizationQuotas.monthlyTokens,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .leftJoin(organizationQuotas, eq(organizationQuotas.organizationId, apiKeys.organizationId))
    .where(eq(apiKeys.hash, hash));

  if (!row || row.revokedAt) {
    await redis.set(cacheKey, "", "EX", MISS_TTL_S);
    return null;
  }
  const info: KeyInfo = {
    keyId: row.keyId,
    organizationId: row.organizationId,
    userId: row.userId,
    rpmLimit: row.rpmLimit,
    concurrencyLimit: row.concurrencyLimit,
    monthlyRequests: row.monthlyRequests,
    monthlyTokens: row.monthlyTokens,
    orgMonthlyRequests: row.orgMonthlyRequests,
    orgMonthlyTokens: row.orgMonthlyTokens,
  };
  await redis.set(cacheKey, JSON.stringify(info), "EX", TTL_S);
  return info;
}
