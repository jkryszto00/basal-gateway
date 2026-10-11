import type { Redis } from "ioredis";

// Fixed one-minute window per key: INCR and set the expiry on the first hit, atomically.
const RATE = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

// Concurrency slots as a sorted set of request ids scored by start time. Entries older than the TTL are dropped
// first, so a gateway that dies mid-request cannot leak a slot forever.
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;

export type RateResult = { ok: true } | { ok: false; retryAfterS: number };

/** What a limit counts against: one API key, or every key of an organization together. */
export type Scope = `key:${string}` | `org:${string}`;

export async function checkRate(redis: Redis, scope: Scope, rpm: number, now = Date.now()): Promise<RateResult> {
  const window = Math.floor(now / 60_000);
  const n = Number(await redis.eval(RATE, 1, `rl:${scope}:${window}`, 60_000));
  if (n <= rpm) return { ok: true };
  return { ok: false, retryAfterS: Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000)) };
}

/** Slot TTL: longer than the slowest request (upstream timeout + cold start). */
const SLOT_TTL_MS = 5 * 60_000;

export async function acquireSlot(redis: Redis, scope: Scope, limit: number, requestId: string): Promise<boolean> {
  return Number(await redis.eval(ACQUIRE, 1, `cc:${scope}`, Date.now(), SLOT_TTL_MS, limit, requestId)) === 1;
}

export async function releaseSlot(redis: Redis, scope: Scope, requestId: string): Promise<void> {
  await redis.zrem(`cc:${scope}`, requestId);
}

// Requests per UTC day per organization: checked and counted in one step, and only counted while below the limit, so a
// refused request does not use up the day.
const DAILY = `
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 1 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 0`;

export async function checkDaily(
  redis: Redis,
  organizationId: string,
  limit: number,
  now = Date.now(),
): Promise<RateResult> {
  const day = new Date(now).toISOString().slice(0, 10);
  if (Number(await redis.eval(DAILY, 1, `daily:org:${organizationId}:${day}`, limit, 2 * 86_400)) === 0)
    return { ok: true };
  const untilMidnightS = Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now) / 1000);
  return { ok: false, retryAfterS: Math.max(1, untilMidnightS) };
}
