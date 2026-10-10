import { apiKeys, balanceMicroUsd, type Db, inArray, sql, usageEvents, user } from "@basal/db";
import { balanceCacheKey } from "@basal/shared/keys";
import type { Redis } from "ioredis";

export type UsageEvent = {
  id: string;
  userId: string;
  apiKeyId: string;
  model: string;
  inputTokens: number;
  questions: number;
  branches: number;
  costMicroUsd: number;
  upstreamLatencyMs: number;
  totalLatencyMs: number;
  createdAt: string;
};

const QUEUE = "usage:queue";

/**
 * Hot balance in Redis (micro-USD). Postgres is the source of truth (credits - usage); Redis is seeded from it on a
 * miss and then moves with every charge, so the request path never sums the ledger.
 */
export async function getBalance(db: Db, redis: Redis, userId: string): Promise<number> {
  const key = balanceCacheKey(userId);
  const cached = await redis.get(key);
  if (cached !== null) return Number(cached);
  await redis.set(key, await balanceMicroUsd(db, userId), "NX"); // NX: a concurrent seed or charge wins
  return Number(await redis.get(key));
}

/** Debit the hot balance and queue the event for Postgres. Requests are short, so a balance > 0 check before the
 * call plus settlement after it can overdraw by at most one in-flight batch per user. */
export async function charge(redis: Redis, event: UsageEvent): Promise<void> {
  await redis
    .multi()
    .decrby(balanceCacheKey(event.userId), event.costMicroUsd)
    .rpush(QUEUE, JSON.stringify(event))
    .exec();
}

/** Moves queued usage events to Postgres in batches. Insert is idempotent on the request id. */
export class UsageFlusher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<number> | undefined;

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly batch = 500,
  ) {}

  start(intervalMs = 1000): void {
    this.timer = setInterval(() => void this.flush().catch((e) => console.error("usage flush failed", e)), intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
    while ((await this.flush()) > 0);
  }

  /** One batch; returns the number of events written. */
  flush(): Promise<number> {
    this.running ??= this.flushOnce().finally(() => (this.running = undefined));
    return this.running;
  }

  private async flushOnce(): Promise<number> {
    const raw = await this.redis.lpop(QUEUE, this.batch);
    if (!raw || raw.length === 0) return 0;
    let events = raw.map((r) => JSON.parse(r) as UsageEvent);
    try {
      await this.db.transaction(async (tx) => {
        // events of an account deleted meanwhile would fail the foreign key and block the queue for everyone
        const ids = [...new Set(events.map((e) => e.userId))];
        const live = new Set((await tx.select({ id: user.id }).from(user).where(inArray(user.id, ids))).map((u) => u.id));
        const dropped = events.length - (events = events.filter((e) => live.has(e.userId))).length;
        if (dropped) console.warn(`usage flush: dropped ${dropped} events of deleted accounts`);
        if (!events.length) return;
        await tx
          .insert(usageEvents)
          .values(events.map((e) => ({ ...e, createdAt: new Date(e.createdAt) })))
          .onConflictDoNothing({ target: usageEvents.id });
        await tx
          .update(apiKeys)
          .set({ lastUsedAt: sql`now()` })
          .where(inArray(apiKeys.id, [...new Set(events.map((e) => e.apiKeyId))]));
      });
    } catch (e) {
      await this.redis.lpush(QUEUE, ...raw.reverse()); // back to the front, in order; retried next tick
      throw e;
    }
    return events.length;
  }
}
