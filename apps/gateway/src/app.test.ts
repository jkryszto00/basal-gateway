// Integration test: real Postgres + Redis from docker compose (`bun run db:up && bun run db:migrate`), fake
// inference server.
import { apiKeys, createDb, eq, usageEvents, user } from "@basal/db";
import { generateApiKey } from "@basal/shared/keys";
import { Hono } from "hono";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { apiError, createApp, type UserLimits } from "./app";
import { UsageFlusher } from "./usage";
import { createUpstreams } from "./upstream";

const db = createDb(process.env.DATABASE_URL ?? "postgres://basal:basal@localhost:5432/basal");
const redis = new Redis(process.env.REDIS_TEST_URL ?? "redis://localhost:6379/15");
const userId = `test-${crypto.randomUUID()}`;

let fake: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof createApp>;
let strict: ReturnType<typeof createApp>; // low per-account limits
let daily: ReturnType<typeof createApp>; // low daily limit
let open: ReturnType<typeof createApp>; // credits not required
let rs: ReturnType<typeof createApp>; // basal-rs style upstream
let v10: ReturnType<typeof createApp>; // basal-1.0 server
let hooked: ReturnType<typeof createApp>; // with extension hooks
let seenEvents: { model: string; inputTokens: number }[] = [];
let refuseNext = false;

const limits = (overrides: Partial<UserLimits> = {}): UserLimits => ({
  rpm: 1_000,
  concurrency: 100,
  dailyRequests: 0,
  ...overrides,
});
let upstreamCalls = 0;
let upstreamDelayMs = 0;

const body = (state = "Klient: nie mogę się zalogować.") => ({
  state,
  questions: { dept: { type: "choice", instructions: "Dział?", criteria: { cards: "Karty", online: "Bankowość" } } },
});

async function newKey(opts: { rpmLimit?: number; concurrencyLimit?: number } = {}) {
  const k = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({ userId, name: "test", hash: k.hash, prefix: k.prefix, ...opts })
    .returning({ id: apiKeys.id });
  return { key: k.key, id: row!.id };
}

const post = (key: string | null, payload: unknown, to = app) =>
  to.request("/v1/systemone", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

beforeAll(async () => {
  const upstream = new Hono();
  upstream.post("/v1/systemone", async (c) => {
    upstreamCalls++;
    if (c.req.header("authorization") !== "Bearer upstream-secret") return c.json({ error: "unauthorized" }, 401);
    const req = await c.req.json();
    if (upstreamDelayMs) await new Promise((r) => setTimeout(r, upstreamDelayMs));
    if (req.state === "bad") return c.json({ error: "option letters are not single tokens" }, 422);
    if ("model" in req) return c.json({ error: "model must not be forwarded" }, 500);
    return c.json({
      model: "basal-1.5-4.5B",
      answers: { dept: { type: "choice", choice: "online", probabilities: { cards: 0.01, online: 0.99 }, confidence: 0.99 } },
      usage: { input_tokens: 300, output_tokens: 0, questions: 1, branches: 1, latency_ms: 12.5 },
    });
  });
  // basal-rs: several models in one process, chosen by the request's "model"; 529 when its queue is full
  upstream.post("/v1/basal", async (c) => {
    const req = await c.req.json();
    if (req.model !== "basal-1.5-max") return c.json({ error: `Unknown model: ${req.model}` }, 422);
    if (req.state === "busy") return new Response(JSON.stringify({ error: "overloaded" }), { status: 529 });
    return c.json({
      model: "basal-1.5-max",
      answers: { dept: { type: "choice", choice: "cards", probabilities: { cards: 0.9, online: 0.1 }, confidence: 0.9 } },
      usage: { input_tokens: 100, output_tokens: 0, questions: 1, branches: 1, latency_ms: 8 },
    });
  });
  // basal-1.0 server: usage has token counts only
  upstream.post("/v1/basal10", async (c) => {
    const req = await c.req.json();
    return c.json({
      model: "basal-1.0-4.5B",
      answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "choice", choice: "a" }])),
      usage: { input_tokens: 200, output_tokens: 0 },
    });
  });
  fake = Bun.serve({ fetch: upstream.fetch, port: 0 });
  const url = `http://127.0.0.1:${fake.port}`;
  app = createApp({
    db,
    redis,
    upstreams: createUpstreams({
      "basal-1.5": { url, token: "upstream-secret", maxInFlight: 1, timeoutMs: 5_000 },
    }),
    userLimits: limits(),
    defaultModel: "basal-1.5",
  });
  strict = createApp({
    db,
    redis,
    upstreams: createUpstreams({ "basal-1.5": { url, token: "upstream-secret", maxInFlight: 10, timeoutMs: 5_000 } }),
    userLimits: limits({ rpm: 3, concurrency: 1 }),
    defaultModel: "basal-1.5",
  });
  daily = createApp({
    db,
    redis,
    upstreams: createUpstreams({ "basal-1.5": { url, token: "upstream-secret", maxInFlight: 10, timeoutMs: 5_000 } }),
    userLimits: limits({ dailyRequests: 2 }),
    defaultModel: "basal-1.5",
  });
  open = createApp({
    db,
    redis,
    upstreams: createUpstreams({ "basal-1.5": { url, token: "upstream-secret", maxInFlight: 10, timeoutMs: 5_000 } }),
    userLimits: limits(),
    defaultModel: "basal-1.5",
  });
  rs = createApp({
    db,
    redis,
    upstreams: createUpstreams({
      "basal-1.5": { url, path: "/v1/basal", model: "basal-1.5-max" }, // public name -> server model
      "basal-1.5-max": { url, path: "/v1/basal", model: "basal-1.5-max" },
    }),
    userLimits: limits(),
    defaultModel: "basal-1.5-max",
  });
  v10 = createApp({
    db,
    redis,
    upstreams: createUpstreams({ "basal-1.0": { url, path: "/v1/basal10" } }),
    userLimits: limits(),
    defaultModel: "basal-1.0",
  });
  hooked = createApp({
    db,
    redis,
    upstreams: createUpstreams({ "basal-1.5": { url, token: "upstream-secret" } }),
    userLimits: limits(),
    defaultModel: "basal-1.5",
    hooks: {
      // what a hosted build would do with prepaid credits
      beforeUpstream: () => (refuseNext ? apiError("insufficient_credits", "balance is empty", 402) : undefined),
      onUsage: (_ctx, event) => {
        seenEvents.push({ model: event.model, inputTokens: event.inputTokens });
        return { cost: 42 };
      },
    },
  });
  await db.insert(user).values({ id: userId, name: "Test", email: `${userId}@example.com` });
});

beforeEach(async () => {
  await redis.flushdb();
  upstreamCalls = 0;
  upstreamDelayMs = 0;
  seenEvents = [];
  refuseNext = false;
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId)); // cascades to keys, credits, usage
  await redis.flushdb();
  redis.disconnect();
  await fake.stop(true);
});

describe("POST /v1/systemone", () => {
  it("rejects missing and unknown keys", async () => {
    expect((await post(null, body())).status).toBe(401);
    expect((await post("bp_live_0000000000000000000000000000", body())).status).toBe(401);
  });

  it("validates before touching the upstream", async () => {
    const { key } = await newKey();
    expect((await post(key, "{not json")).status).toBe(400);
    const res = await post(key, { state: "x", questions: { q: { criteria: ["only one"] } } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    expect((await post(key, { ...body(), model: "nope" })).status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  it("rejects oversized bodies before parsing them", async () => {
    const { key } = await newKey();
    const res = await post(key, { ...body("x".repeat(300 * 1024)) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("payload_too_large");
    expect(upstreamCalls).toBe(0);
  });

  it("lets a beforeUpstream hook refuse a request, and adds onUsage fields to the usage", async () => {
    const { key } = await newKey();
    refuseNext = true;
    const refused = await post(key, body(), hooked);
    refuseNext = false;
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("insufficient_credits");
    expect(upstreamCalls).toBe(0);
    const ok = await post(key, body(), hooked);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { usage: Record<string, number> }).usage).toMatchObject({ input_tokens: 300, cost: 42 });
    expect(seenEvents).toEqual([{ model: "basal-1.5", inputTokens: 300 }]);
  });
  it("calls a configured path and model, and maps the server's 529 to 503", async () => {
    const { key } = await newKey();
    const res = await post(key, { ...body(), model: "basal-1.5" }, rs);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answers: { dept: { choice: string } } }).answers.dept.choice).toBe("cards");
    const busy = await post(key, { ...body("busy"), model: "basal-1.5" }, rs);
    expect(busy.status).toBe(503);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("overloaded");
    expect(busy.headers.get("retry-after")).toBe("1");
  });

  it("routes by model: the default without a model field, unknown models listed", async () => {
    const { key } = await newKey();
    const byDefault = (await (await post(key, body(), rs)).json()) as { model: string };
    expect(byDefault.model).toBe("basal-1.5-max");
    const named = (await (await post(key, { ...body(), model: "basal-1.5" }, rs)).json()) as { model: string };
    expect(named.model).toBe("basal-1.5");
    const unknown = await post(key, { ...body(), model: "nope" }, rs);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toContain("basal-1.5, basal-1.5-max");
  });
  it("completes the usage of a basal-1.0 server from the request", async () => {
    const { key } = await newKey();
    const res = await post(
      key,
      {
        state: "x",
        questions: {
          a: { type: "choice", criteria: ["x", "y"] },
          b: { type: "noul" },
          c: { type: "multi", criteria: { p: "P", q: "Q", r: "R" } },
        },
      },
      v10,
    );
    expect(res.status).toBe(200);
    const usage = ((await res.json()) as { usage: Record<string, number> }).usage;
    expect(usage).toMatchObject({ input_tokens: 200, output_tokens: 0, questions: 3, branches: 5 }); // 1 + 1 + 3
    expect(usage.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("lists models with the default", async () => {
    const res = await rs.request("/v1/models");
    expect(await res.json()).toEqual({
      default: "basal-1.5-max",
      models: [
        { name: "basal-1.5", default: false },
        { name: "basal-1.5-max", default: true },
      ],
    });
  });
  it("proxies and records the usage", async () => {
    const { key, id: keyId } = await newKey();

    const res = await post(key, { ...body(), model: "basal-1.5" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; model: string; usage: Record<string, number> };
    expect(json.model).toBe("basal-1.5");
    expect(json.usage).toEqual({ input_tokens: 300, output_tokens: 0, questions: 1, branches: 1, latency_ms: 12.5 });
    expect(res.headers.get("x-request-id")).toBe(json.id);

    expect(await new UsageFlusher(db, redis).flush()).toBe(1);
    const [ev] = await db.select().from(usageEvents).where(eq(usageEvents.id, json.id));
    expect(ev).toMatchObject({ userId, apiKeyId: keyId, model: "basal-1.5", inputTokens: 300, questions: 1, branches: 1 });
    const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(k?.lastUsedAt).not.toBeNull();
  });
  it("does not record requests the model rejects", async () => {
    const { key } = await newKey();
    const res = await post(key, body("bad"));
    expect(res.status).toBe(422);
    expect(await redis.llen("usage:queue")).toBe(0);
  });
  it("enforces requests per minute", async () => {
    const { key } = await newKey({ rpmLimit: 2 });
    expect((await post(key, body())).status).toBe(200);
    expect((await post(key, body())).status).toBe(200);
    const res = await post(key, body());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("enforces requests per minute per account, over all its keys", async () => {
    const a = await newKey();
    const b = await newKey();
    const statuses = [];
    for (const k of [a, b, a, b]) statuses.push((await post(k.key, body(), strict)).status);
    expect(statuses).toEqual([200, 200, 200, 429]); // each key is far below its own 60 rpm
    const res = await post(a.key, body(), strict);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("this account");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("enforces concurrency per account and frees the slots afterwards", async () => {
    upstreamDelayMs = 300;
    const a = await newKey();
    const b = await newKey();
    const [x, y] = await Promise.all([post(a.key, body(), strict), post(b.key, body(), strict)]);
    expect([x.status, y.status].sort()).toEqual([200, 429]);
    expect(await redis.zcard(`cc:key:${a.id}`)).toBe(0);
    expect(await redis.zcard(`cc:key:${b.id}`)).toBe(0); // the refused key's slot was given back too
    expect(await redis.zcard(`cc:user:${userId}`)).toBe(0);
  });

  it("caps requests per account per day", async () => {
    const a = await newKey();
    const b = await newKey();
    expect((await post(a.key, body(), daily)).status).toBe(200);
    expect((await post(b.key, body(), daily)).status).toBe(200);
    const res = await post(a.key, body(), daily);
    expect(res.status).toBe(429);
    const err = ((await res.json()) as { error: { code: string; message: string } }).error;
    expect(err).toMatchObject({ code: "daily_limit_reached" });
    expect(err.message).toContain("2 requests per day");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(a.key, body())).status).toBe(200); // no daily limit configured
  });

  it("enforces per-key concurrency and upstream capacity", async () => {
    upstreamDelayMs = 300;
    const a = await newKey({ concurrencyLimit: 1 });
    const [first, second] = await Promise.all([post(a.key, body()), post(a.key, body())]);
    expect([first.status, second.status].sort()).toEqual([200, 429]);

    const b = await newKey();
    const c = await newKey();
    const [x, y] = await Promise.all([post(b.key, body()), post(c.key, body())]); // upstream maxInFlight = 1
    expect([x.status, y.status].sort()).toEqual([200, 503]);
  });

  it("drops queued usage of a deleted account instead of blocking the queue", async () => {
    const other = `test-${crypto.randomUUID()}`;
    await db.insert(user).values({ id: other, name: "Gone", email: `${other}@example.com` });
    const k = generateApiKey();
    await db.insert(apiKeys).values({ userId: other, name: "gone", hash: k.hash, prefix: k.prefix });
    expect((await post(k.key, body())).status).toBe(200);
    const { key } = await newKey();
    const ok = await post(key, body());
    expect(ok.status).toBe(200);
    await db.delete(user).where(eq(user.id, other)); // account deleted while its usage is still queued

    expect(await new UsageFlusher(db, redis).flush()).toBe(1); // only the live account's event
    expect(await redis.llen("usage:queue")).toBe(0);
    const id = ((await ok.json()) as { id: string }).id;
    expect(await db.select().from(usageEvents).where(eq(usageEvents.id, id))).toHaveLength(1);
  });

  it("stops accepting a revoked key once its cache entry is gone", async () => {
    const { key, id } = await newKey();
    expect((await post(key, body())).status).toBe(200);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
    await redis.flushdb(); // the web app deletes the apikey:<hash> entry on revoke
    expect((await post(key, body())).status).toBe(401);
  });
});
