import { apiKeys, type Db, eq } from "@basal/db";
import { apiKeyCacheKey, hashApiKey, looksLikeApiKey } from "@basal/shared/keys";
import type { Redis } from "ioredis";

export type KeyInfo = { keyId: string; userId: string; rpmLimit: number; concurrencyLimit: number };

const TTL_S = 60; // revocation also deletes the cache entry (web app); the TTL bounds staleness otherwise
const MISS_TTL_S = 10; // unknown keys: avoid a database query per attempt

export async function resolveKey(db: Db, redis: Redis, header: string | undefined): Promise<KeyInfo | null> {
  const key = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!key || !looksLikeApiKey(key)) return null;
  const hash = hashApiKey(key);
  const cacheKey = apiKeyCacheKey(hash);

  const cached = await redis.get(cacheKey);
  if (cached !== null) return cached === "" ? null : (JSON.parse(cached) as KeyInfo);

  const [row] = await db
    .select({
      keyId: apiKeys.id,
      userId: apiKeys.userId,
      rpmLimit: apiKeys.rpmLimit,
      concurrencyLimit: apiKeys.concurrencyLimit,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.hash, hash));

  if (!row || row.revokedAt) {
    await redis.set(cacheKey, "", "EX", MISS_TTL_S);
    return null;
  }
  const info: KeyInfo = {
    keyId: row.keyId,
    userId: row.userId,
    rpmLimit: row.rpmLimit,
    concurrencyLimit: row.concurrencyLimit,
  };
  await redis.set(cacheKey, JSON.stringify(info), "EX", TTL_S);
  return info;
}
