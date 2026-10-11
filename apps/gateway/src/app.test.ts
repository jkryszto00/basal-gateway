// Integration test: real Postgres + Redis from docker compose (`bun run db:up && bun run db:migrate`), fake
// inference server.
import {
  apiKeys,
  createDb,
  eq,
  ensurePersonalOrganization,
  organization,
  organizationQuotas,
  usageEvents,
  user,
} from "@basal/db";
import { generateApiKey } from "@basal/shared/keys";
import { Hono } from "hono";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { apiError, createApp, type OrgLimits } from "./app";
import { UsageFlusher } from "./usage";
import { createUpstreams } from "./upstream";

const db = createDb(process.env.DATABASE_URL ?? "postgres://basal:basal@localhost:5432/basal");
const redis = new Redis(process.env.REDIS_TEST_URL ?? "redis://localhost:6379/15");
const userId = `test-${crypto.randomUUID()}`;
let orgId: string;

let fake: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof createApp>;
let strict: ReturnType<typeof createApp>; // low per-account limits
let daily: ReturnType<typeof createApp>; // low daily limit
let open: ReturnType<typeof createApp>; // credits not required
let rs: ReturnType<typeof createApp>; // basal-rs style upstream
let omni: ReturnType<typeof createApp>; // passthrough model next to a basal one
let hooked: ReturnType<typeof createApp>; // with extension hooks
let monthly: ReturnType<typeof createApp>; // default monthly quota of 2 requests per organization
let seenEvents: { model: string; inputTokens: number }[] = [];
let refuseNext = false;

const limits = (overrides: Partial<OrgLimits> = {}): OrgLimits => ({
  rpm: 1_000,
  concurrency: 100,
  dailyRequests: 0,
  monthlyRequests: 0,
  monthlyTokens: 0,
  ...overrides,
});
let upstreamCalls = 0;
let upstreamDelayMs = 0;

const body = (state = "Klient: nie mogę się zalogować.") => ({
  state,
  questions: { dept: { type: "choice", instructions: "Dział?", criteria: { cards: "Karty", online: "Bankowość" } } },
});

async function newKey(
  opts: { rpmLimit?: number; concurrencyLimit?: number; monthlyRequests?: number; monthlyTokens?: number } = {},
) {
  const k = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({ organizationId: orgId, createdBy: userId, name: "test", hash: k.hash, prefix: k.prefix, ...opts })
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
      answers: {
        dept: { type: "choice", choice: "online", probabilities: { cards: 0.01, online: 0.99 }, confidence: 0.99 },
      },
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
      answers: {
        dept: { type: "choice", choice: "cards", probabilities: { cards: 0.9, online: 0.1 }, confidence: 0.9 },
      },
      usage: { input_tokens: 100, output_tokens: 0, questions: 1, branches: 1, latency_ms: 8 },
    });
  });
  // a model family the gateway does not know (e.g. omni): any request shape, its own usage units
  upstream.post("/v1/omni", async (c) => {
    const req = (await c.req.json()) as { audio?: string; model?: string };
    return c.json({
      transcript_label: "complaint",
      echoed_model: req.model ?? null,
      audio_chars: req.audio?.length ?? 0,
      usage: { input_tokens: 40, audio_seconds: 12.5 },
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
    orgLimits: limits(),
    defaultModel: "basal-1.5",
  });
  strict = createApp({
    db,
    redis,
    upstreams: createUpstreams({ "basal-1.5": { url, token: "upstream-secret", maxInFlight: 10, timeoutMs: 5_000 } }),
    orgLimits: limits({ rpm: 3, concurrency: 1 }),
    defaultModel: "basal-1.5",
  });
  daily = createApp({
    db,
    redis,
    upstreams: createUpstreams({ "basal-1.5": { url, token: "upstream-secret", maxInFlight: 10, timeoutMs: 5_000 } }),
    orgLimits: limits({ dailyRequests: 2 }),
    defaultModel: "basal-1.5",
  });
  open = createApp({
    db,
    redis,
    upstreams: createUpstreams({ "basal-1.5": { url, token: "upstream-secret", maxInFlight: 10, timeoutMs: 5_000 } }),
    orgLimits: limits(),
    defaultModel: "basal-1.5",
  });
  rs = createApp({
    db,
    redis,
    upstreams: createUpstreams({
      "basal-1.5": { url, path: "/v1/basal", model: "basal-1.5-max" }, // public name -> server model
      "basal-1.5-max": { url, path: "/v1/basal", model: "basal-1.5-max" },
    }),
    orgLimits: limits(),
    defaultModel: "basal-1.5-max",
  });
  omni = createApp({
    db,
    redis,
    upstreams: createUpstreams({
      "basal-1.5": { url, token: "upstream-secret" },
      "basal-omni": {
        url,
        path: "/v1/omni",
        api: "passthrough",
        maxBodyBytes: 1024 * 1024,
        model: "basal-omni-preview",
        meta: { modalities: ["text", "audio"] },
      },
    }),
    orgLimits: limits(),
    defaultModel: "basal-1.5",
  });
  monthly = createApp({
    db,
    redis,
    upstreams: createUpstreams({ "basal-1.5": { url, token: "upstream-secret", maxInFlight: 10 } }),
    orgLimits: limits({ monthlyRequests: 2 }),
    defaultModel: "basal-1.5",
  });
  hooked = createApp({
    db,
    redis,
    upstreams: createUpstreams({ "basal-1.5": { url, token: "upstream-secret" } }),
    orgLimits: limits(),
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
  orgId = await ensurePersonalOrganization(db, { id: userId, name: "Test" });
});

beforeEach(async () => {
  await redis.flushdb();
  upstreamCalls = 0;
  upstreamDelayMs = 0;
  seenEvents = [];
  refuseNext = false;
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId)); // cascades to keys and usage
  await db.delete(user).where(eq(user.id, userId));
  await redis.flushdb();
  redis.disconnect();
  await fake.stop(true);
});

describe("POST /v1/systemone", () => {
  it("rejects missing and unknown keys", async () => {
    expect((await post(null, body())).status).toBe(401);
    expect((await post("bg_live_00000000000000000000000000000000", body())).status).toBe(401);
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
    expect(((await ok.json()) as { usage: Record<string, number> }).usage).toMatchObject({
      input_tokens: 300,
      cost: 42,
    });
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
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toContain(
      "basal-1.5, basal-1.5-max",
    );
  });
  it("lists models with the default, their format, body limit and meta", async () => {
    const res = await omni.request("/v1/models");
    expect(await res.json()).toEqual({
      default: "basal-1.5",
      models: [
        { name: "basal-1.5", default: true, api: "basal", max_body_bytes: 262_144 },
        {
          name: "basal-omni",
          default: false,
          api: "passthrough",
          max_body_bytes: 1_048_576,
          meta: { modalities: ["text", "audio"] },
        },
      ],
    });
  });

  it("passes any request to a passthrough model and keeps its usage units", async () => {
    const { key } = await newKey();
    const audio = "x".repeat(400 * 1024); // over the basal model's 256 KiB, under omni's 1 MiB
    const res = await post(key, { model: "basal-omni", audio }, omni);
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown> & { id: string };
    expect(out).toMatchObject({
      model: "basal-omni",
      transcript_label: "complaint",
      echoed_model: "basal-omni-preview", // the server's model name, not the public one
      audio_chars: audio.length,
      usage: { input_tokens: 40, audio_seconds: 12.5 },
    });

    expect(await new UsageFlusher(db, redis).flush()).toBe(1);
    const [ev] = await db.select().from(usageEvents).where(eq(usageEvents.id, out.id));
    expect(ev).toMatchObject({ model: "basal-omni", inputTokens: 40, questions: 0, branches: 0 });
    expect(ev?.details).toEqual({ input_tokens: 40, audio_seconds: 12.5 });

    const big = await post(key, { ...body(), state: audio }, omni); // same size to the basal model
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { message: string } }).error.message).toContain("the limit of basal-1.5");
    expect((await post(key, "[1, 2]", omni)).status).toBe(400); // not an object
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
    expect(ev).toMatchObject({
      organizationId: orgId,
      userId,
      apiKeyId: keyId,
      model: "basal-1.5",
      inputTokens: 300,
      questions: 1,
      branches: 1,
    });
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

  it("enforces requests per minute per organization, over all its keys", async () => {
    const a = await newKey();
    const b = await newKey();
    const statuses = [];
    for (const k of [a, b, a, b]) statuses.push((await post(k.key, body(), strict)).status);
    expect(statuses).toEqual([200, 200, 200, 429]); // each key is far below its own 60 rpm
    const res = await post(a.key, body(), strict);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("this organization");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("enforces concurrency per organization and frees the slots afterwards", async () => {
    upstreamDelayMs = 300;
    const a = await newKey();
    const b = await newKey();
    const [x, y] = await Promise.all([post(a.key, body(), strict), post(b.key, body(), strict)]);
    expect([x.status, y.status].sort()).toEqual([200, 429]);
    expect(await redis.zcard(`cc:key:${a.id}`)).toBe(0);
    expect(await redis.zcard(`cc:key:${b.id}`)).toBe(0); // the refused key's slot was given back too
    expect(await redis.zcard(`cc:org:${orgId}`)).toBe(0);
  });

  it("caps requests per organization per day", async () => {
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

  it("enforces a key's monthly quota of requests, counting successful requests only", async () => {
    const { key } = await newKey({ monthlyRequests: 2 });
    expect((await post(key, body("bad"))).status).toBe(422); // rejected by the model: not counted
    expect((await post(key, body())).status).toBe(200);
    expect((await post(key, body())).status).toBe(200);
    const res = await post(key, body());
    expect(res.status).toBe(429);
    const err = ((await res.json()) as { error: { code: string; message: string } }).error;
    expect(err).toMatchObject({ code: "quota_exceeded" });
    expect(err.message).toContain("2 requests for this API key");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("enforces a key's monthly token quota, overshooting by at most the requests in flight", async () => {
    const { key } = await newKey({ monthlyTokens: 500 }); // the fake server reports 300 input tokens
    expect((await post(key, body())).status).toBe(200); // 0 used
    expect((await post(key, body())).status).toBe(200); // 300 used
    const res = await post(key, body()); // 600 used
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("500 input tokens");
  });

  it("seeds the month's counters from Postgres when Redis has none", async () => {
    const { key, id } = await newKey({ monthlyRequests: 3 });
    const past = { organizationId: orgId, apiKeyId: id, model: "basal-1.5", inputTokens: 1, questions: 1, branches: 1 };
    await db
      .insert(usageEvents)
      .values([1, 2, 3].map(() => ({ ...past, id: crypto.randomUUID(), upstreamLatencyMs: 1, totalLatencyMs: 1 })));
    expect((await post(key, body())).status).toBe(429); // used up before Redis knew
  });

  it("applies the default organization quota unless the organization has its own", async () => {
    const owner = `test-${crypto.randomUUID()}`; // a fresh organization: no usage this month yet
    await db.insert(user).values({ id: owner, name: "Quota", email: `${owner}@example.com` });
    const org = await ensurePersonalOrganization(db, { id: owner, name: "Quota" });
    const k = generateApiKey();
    await db
      .insert(apiKeys)
      .values({ organizationId: org, createdBy: owner, name: "q", hash: k.hash, prefix: k.prefix });

    expect((await post(k.key, body(), monthly)).status).toBe(200);
    expect((await post(k.key, body(), monthly)).status).toBe(200);
    const res = await post(k.key, body(), monthly);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("this organization");

    await db.insert(organizationQuotas).values({ organizationId: org, monthlyRequests: 100 });
    await redis.del(`apikey:${k.hash}`); // key cache: the admin's change applies within a minute, at once when cleared
    expect((await post(k.key, body(), monthly)).status).toBe(200);
    await db.delete(organization).where(eq(organization.id, org));
    await db.delete(user).where(eq(user.id, owner));
  });

  it("reports the organization's usage over a period, grouped as asked", async () => {
    const owner = `test-${crypto.randomUUID()}`; // a fresh organization, so the numbers are known
    await db.insert(user).values({ id: owner, name: "Usage", email: `${owner}@example.com` });
    const org = await ensurePersonalOrganization(db, { id: owner, name: "Usage" });
    const k = generateApiKey();
    const [row] = await db
      .insert(apiKeys)
      .values({ organizationId: org, createdBy: owner, name: "billing", hash: k.hash, prefix: k.prefix })
      .returning({ id: apiKeys.id });
    const event = {
      organizationId: org,
      apiKeyId: row!.id,
      questions: 2,
      branches: 3,
      upstreamLatencyMs: 1,
      totalLatencyMs: 2,
    };
    await db.insert(usageEvents).values([
      {
        ...event,
        id: crypto.randomUUID(),
        model: "basal-1.5",
        inputTokens: 100,
        createdAt: new Date("2026-03-01T10:00:00Z"),
      },
      {
        ...event,
        id: crypto.randomUUID(),
        model: "basal-1.5",
        inputTokens: 50,
        createdAt: new Date("2026-03-01T23:00:00Z"),
      },
      {
        ...event,
        id: crypto.randomUUID(),
        model: "basal-1.5-mini",
        inputTokens: 10,
        createdAt: new Date("2026-03-02T08:00:00Z"),
      },
      {
        ...event,
        id: crypto.randomUUID(),
        model: "basal-1.5",
        inputTokens: 999,
        createdAt: new Date("2026-04-01T00:00:00Z"),
      },
    ]);
    const get = (q: string) => app.request(`/v1/usage?${q}`, { headers: { authorization: `Bearer ${k.key}` } });

    const byDay = await (await get("from=2026-03-01&to=2026-03-31")).json();
    expect(byDay).toMatchObject({ organization_id: org, group_by: ["day"], to: "2026-04-01T00:00:00.000Z" });
    expect(byDay.data).toEqual([
      { day: "2026-03-01", requests: 2, decisions: 4, branches: 6, input_tokens: 150 },
      { day: "2026-03-02", requests: 1, decisions: 2, branches: 3, input_tokens: 10 },
    ]);
    const byModelKey = await (await get("from=2026-03-01&to=2026-03-31&group_by=model,key")).json();
    expect(byModelKey.data).toEqual([
      {
        model: "basal-1.5",
        key: "billing",
        key_prefix: k.prefix,
        requests: 2,
        decisions: 4,
        branches: 6,
        input_tokens: 150,
      },
      {
        model: "basal-1.5-mini",
        key: "billing",
        key_prefix: k.prefix,
        requests: 1,
        decisions: 2,
        branches: 3,
        input_tokens: 10,
      },
    ]);
    const total = await (await get("from=2026-03-01&to=2026-04-01&group_by=")).json();
    expect(total.data).toEqual([{ requests: 4, decisions: 8, branches: 12, input_tokens: 1159 }]);

    expect((await get("from=2026-03-01&group_by=week")).status).toBe(400);
    expect((await get("from=03/01/2026")).status).toBe(400);
    expect((await get("from=2025-01-01&to=2026-12-31")).status).toBe(400); // over 366 days
    expect((await app.request("/v1/usage")).status).toBe(401);
    await db.delete(organization).where(eq(organization.id, org));
    await db.delete(user).where(eq(user.id, owner));
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

  it("drops queued usage of a deleted organization, and keeps a departed creator's usage", async () => {
    const other = `test-${crypto.randomUUID()}`;
    await db.insert(user).values({ id: other, name: "Gone", email: `${other}@example.com` });
    const otherOrg = await ensurePersonalOrganization(db, { id: other, name: "Gone" });
    const k = generateApiKey();
    await db
      .insert(apiKeys)
      .values({ organizationId: otherOrg, createdBy: other, name: "gone", hash: k.hash, prefix: k.prefix });
    expect((await post(k.key, body())).status).toBe(200);

    const leaver = `test-${crypto.randomUUID()}`; // created a key in our organization, then deleted their account
    await db.insert(user).values({ id: leaver, name: "Leaver", email: `${leaver}@example.com` });
    const lk = generateApiKey();
    await db
      .insert(apiKeys)
      .values({ organizationId: orgId, createdBy: leaver, name: "leaver", hash: lk.hash, prefix: lk.prefix });
    const kept = await post(lk.key, body());
    expect(kept.status).toBe(200);

    await db.delete(organization).where(eq(organization.id, otherOrg)); // deleted while its usage is still queued
    await db.delete(user).where(eq(user.id, other));
    await db.delete(user).where(eq(user.id, leaver));

    expect(await new UsageFlusher(db, redis).flush()).toBe(1); // only the live organization's event
    expect(await redis.llen("usage:queue")).toBe(0);
    const id = ((await kept.json()) as { id: string }).id;
    const [ev] = await db.select().from(usageEvents).where(eq(usageEvents.id, id));
    expect(ev).toMatchObject({ organizationId: orgId, userId: null });
  });

  it("stops accepting a revoked key once its cache entry is gone", async () => {
    const { key, id } = await newKey();
    expect((await post(key, body())).status).toBe(200);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
    await redis.flushdb(); // the web app deletes the apikey:<hash> entry on revoke
    expect((await post(key, body())).status).toBe(401);
  });
});
