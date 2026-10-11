import { apiKeys, type Db, inArray, organization, sql, usageEvents, user } from "@basal/db";
import type { Redis } from "ioredis";

export type UsageEvent = {
  id: string;
  organizationId: string;
  /** creator of the key, for usage per member */
  userId: string | null;
  apiKeyId: string;
  model: string;
  inputTokens: number;
  questions: number;
  branches: number;
  upstreamLatencyMs: number;
  totalLatencyMs: number;
  /** the server's usage block as returned */
  details?: Record<string, unknown>;
  createdAt: string;
};

const QUEUE = "usage:queue";

/** Queue a successful request's usage; UsageFlusher writes it to Postgres in batches, off the request path. */
export async function recordUsage(redis: Redis, event: UsageEvent): Promise<void> {
  await redis.rpush(QUEUE, JSON.stringify(event));
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
        // events of an organization deleted meanwhile would fail the foreign key and block the queue for everyone
        const orgIds = [...new Set(events.map((e) => e.organizationId))];
        const liveOrgs = new Set(
          (await tx.select({ id: organization.id }).from(organization).where(inArray(organization.id, orgIds))).map(
            (o) => o.id,
          ),
        );
        const dropped = events.length - (events = events.filter((e) => liveOrgs.has(e.organizationId))).length;
        if (dropped) console.warn(`usage flush: dropped ${dropped} events of deleted organizations`);
        if (!events.length) return;
        // a key creator who deleted their account: keep the event, without the member
        const userIds = [...new Set(events.flatMap((e) => (e.userId ? [e.userId] : [])))];
        const liveUsers = new Set(
          userIds.length
            ? (await tx.select({ id: user.id }).from(user).where(inArray(user.id, userIds))).map((u) => u.id)
            : [],
        );
        events = events.map((e) => (e.userId && !liveUsers.has(e.userId) ? { ...e, userId: null } : e));
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
