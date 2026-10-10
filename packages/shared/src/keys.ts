import { createHash, randomBytes } from "node:crypto";

/**
 * Start of new API keys, so a leaked key is recognisable (and findable by secret scanners). Changing it does not
 * invalidate existing keys: they are looked up by hash.
 */
export const API_KEY_PREFIX = keyPrefix(process.env.API_KEY_PREFIX ?? "bg_live_");

function keyPrefix(prefix: string): string {
  if (!/^[a-z][a-z0-9_]{1,15}$/.test(prefix)) throw new Error(`API_KEY_PREFIX "${prefix}": 2-16 of a-z, 0-9, _`);
  return prefix;
}

/** A new API key. Only `hash` and `prefix` are stored; `key` is shown to the user once. */
export function generateApiKey(prefix = API_KEY_PREFIX): { key: string; hash: string; prefix: string } {
  const key = prefix + randomBytes(24).toString("base64url");
  return { key, hash: hashApiKey(key), prefix: key.slice(0, prefix.length + 6) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Cheap shape check before a hash lookup: any prefix (keys outlive a prefix change) and a 32-char random part. */
export function looksLikeApiKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{1,15}[A-Za-z0-9_-]{32}$/.test(key);
}

/** Redis key of the gateway's API key cache; the web app deletes it when a key is revoked. */
export const apiKeyCacheKey = (hash: string) => `apikey:${hash}`;
