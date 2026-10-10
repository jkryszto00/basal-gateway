import { createHash, randomBytes } from "node:crypto";

const PREFIX = "bp_live_";

/** A new API key. Only `hash` and `prefix` are stored; `key` is shown to the user once. */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = PREFIX + randomBytes(24).toString("base64url");
  return { key, hash: hashApiKey(key), prefix: key.slice(0, PREFIX.length + 6) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function looksLikeApiKey(key: string): boolean {
  return key.startsWith(PREFIX) && key.length > PREFIX.length + 20;
}

/** Redis key of the gateway's API key cache; the web app deletes it when a key is revoked. */
export const apiKeyCacheKey = (hash: string) => `apikey:${hash}`;
/** Redis key of a user's hot balance (micro-USD). */
export const balanceCacheKey = (userId: string) => `balance:${userId}`;
