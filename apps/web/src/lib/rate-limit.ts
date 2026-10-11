import "server-only";
import { createHash } from "node:crypto";
import { redis } from "./redis";

// Fixed window per key: INCR, and the first hit of a window sets its expiry. Returns [count, seconds left].
const HIT = `local n = redis.call("INCR", KEYS[1])
if n == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return {n, redis.call("TTL", KEYS[1])}`;

export type Rule = { by: "ip" | "email"; value: string | null; max: number; windowSec: number };

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/** Limits per action. Every attempt counts, successful or not. */
export const RULES = {
  // per email: slows password guessing on one account (it can also lock its owner out for the window)
  signIn: { ip: [{ max: 30, windowSec: 15 * MINUTE }], email: [{ max: 10, windowSec: 15 * MINUTE }] },
  oauth: { ip: [{ max: 30, windowSec: 15 * MINUTE }], email: [] },
  signUp: {
    ip: [
      { max: 5, windowSec: HOUR },
      { max: 20, windowSec: 24 * HOUR },
    ],
    email: [],
  },
  // per email: no inbox gets flooded with our emails
  passwordReset: { ip: [{ max: 10, windowSec: HOUR }], email: [{ max: 3, windowSec: HOUR }] },
  resendVerification: { ip: [{ max: 10, windowSec: HOUR }], email: [{ max: 3, windowSec: HOUR }] },
  resetPassword: { ip: [{ max: 10, windowSec: 15 * MINUTE }], email: [] },
  // signed in: per account email, guessing the current password from a stolen session
  changePassword: { ip: [], email: [{ max: 5, windowSec: 15 * MINUTE }] },
  deleteAccount: { ip: [], email: [{ max: 5, windowSec: 15 * MINUTE }] },
  // invitations email strangers: per inviting account
  invite: { ip: [{ max: 30, windowSec: HOUR }], email: [{ max: 20, windowSec: HOUR }] },
} satisfies Record<string, { ip: Omit<Rule, "by" | "value">[]; email: Omit<Rule, "by" | "value">[] }>;

// emails are hashed so Redis holds no addresses
const id = (by: string, value: string | null) =>
  by === "email"
    ? createHash("sha256")
        .update(value ?? "")
        .digest("hex")
        .slice(0, 32)
    : (value ?? "unknown");

/**
 * Counts one attempt of `action` against each of its limits. Returns null when allowed, otherwise the seconds until
 * the most restrictive exceeded window ends.
 */
export async function hit(
  action: keyof typeof RULES,
  who: { ip: string | null; email?: string },
): Promise<number | null> {
  const rules = RULES[action];
  const checks = [
    ...rules.ip.map((r) => ({ ...r, by: "ip" as const, value: who.ip })),
    ...(who.email ? rules.email.map((r) => ({ ...r, by: "email" as const, value: who.email! })) : []),
  ];
  const results = await Promise.all(
    checks.map(async (r) => {
      const key = `rl:${action}:${r.by}:${r.windowSec}:${id(r.by, r.value)}`;
      const [count, ttl] = (await redis.eval(HIT, 1, key, r.windowSec)) as [number, number];
      return count > r.max ? Math.max(ttl, 1) : null;
    }),
  );
  const blocked = results.filter((s): s is number => s !== null);
  return blocked.length ? Math.max(...blocked) : null;
}

export function tooMany(retryAfterSec: number) {
  const minutes = Math.ceil(retryAfterSec / MINUTE);
  const wait =
    retryAfterSec < MINUTE ? "a minute" : minutes < 120 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
  return `Too many attempts. Try again in ${wait}.`;
}
