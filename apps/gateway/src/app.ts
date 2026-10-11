import { randomUUID } from "node:crypto";
import { aggregateUsage, type Db, parseUsageRange, USAGE_GROUPS, type UsageGroup } from "@basal/db";
import { decisionRequest, decisionUsage } from "@basal/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { version } from "../../../package.json";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Redis } from "ioredis";
import { z } from "zod";
import { type KeyInfo, resolveKey } from "./auth";
import { acquireSlot, checkDaily, checkRate, releaseSlot } from "./limits";
import type { Upstream } from "./upstream";
import { checkQuotas, recordQuotaUsage, secondsToNextMonth } from "./quota";
import { recordUsage, type UsageEvent } from "./usage";

/** Limits per organization, summed over all its API keys (10 keys x 60 rpm would otherwise allow 600 rpm). */
export type OrgLimits = {
  rpm: number;
  concurrency: number;
  /** requests per UTC day; 0 means no daily limit */
  dailyRequests: number;
  /** default monthly quota of organizations without their own; 0 means none */
  monthlyRequests: number;
  monthlyTokens: number;
};

/** What a hook knows about the request it runs for. */
export type RequestContext = { requestId: string; key: KeyInfo; model: string };

type MaybePromise<T> = T | Promise<T>;

/**
 * Extension points for builds on top of the gateway, e.g. a hosted service that sells prepaid credits: check a balance
 * in beforeUpstream, price and charge the request in onUsage. Both run on the request path; keep them fast.
 */
export type GatewayHooks = {
  /** After authentication, validation and the per-minute limits, before the inference server: return a Response
   * (see apiError) to refuse the request. */
  beforeUpstream?: (ctx: RequestContext) => MaybePromise<Response | undefined>;
  /** After a successful decision, once its usage is queued: the returned fields are added to the response's usage. */
  onUsage?: (ctx: RequestContext, event: UsageEvent) => MaybePromise<Record<string, unknown> | undefined>;
};

export type Deps = {
  db: Db;
  redis: Redis;
  upstreams: Map<string, Upstream>;
  orgLimits: OrgLimits;
  /** model of requests that name none */
  defaultModel: string;
  hooks?: GatewayHooks;
};

type ErrorCode =
  | "unauthorized"
  | "invalid_json"
  | "payload_too_large"
  | "invalid_request"
  | "unknown_model"
  | "rate_limited"
  | "concurrency_limited"
  | "daily_limit_reached"
  | "quota_exceeded"
  | "overloaded"
  | "upstream_error"
  | "upstream_timeout";

/** The gateway's error body, `{"error": {"code", "message"}}`; for hooks that refuse a request. */
export const apiError = (code: string, message: string, status: number, details?: unknown) =>
  Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });

const fail = (code: ErrorCode, message: string, status: ContentfulStatusCode, details?: unknown) =>
  apiError(code, message, status, details);

const basalResponse = z.looseObject({ answers: z.record(z.string(), z.unknown()), usage: decisionUsage });

/** passthrough servers: any JSON object; the usage fields the gateway knows are taken when present */
const anyUsage = z.looseObject({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  questions: z.number().int().nonnegative().optional(),
  branches: z.number().int().nonnegative().optional(),
  latency_ms: z.number().nonnegative().optional(),
});
const passthroughResponse = z.looseObject({ usage: anyUsage.optional() });

const jsonObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createApp({ db, redis, upstreams, orgLimits, defaultModel, hooks = {} }: Deps) {
  const app = new Hono();

  // JSON API: no framing, no MIME sniffing, no referrer; HSTS is ignored by browsers on plain HTTP
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));

  app.get("/health", (c) => c.json({ status: "ok", version }));

  // the largest body any model accepts, rejected before reading; each model's own limit is checked once it is known
  const maxBody = Math.max(...[...upstreams.values()].map((u) => u.maxBodyBytes));
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: maxBody,
      onError: () => fail("payload_too_large", `request body is larger than ${Math.floor(maxBody / 1024)} KiB`, 413),
    }),
  );

  app.get("/v1/models", (c) =>
    c.json({
      default: defaultModel,
      models: [...upstreams.values()].map((u) => ({
        name: u.model,
        default: u.model === defaultModel,
        api: u.api,
        max_body_bytes: u.maxBodyBytes,
        ...(u.meta ? { meta: u.meta } : {}),
      })),
    }),
  );

  // The key's organization's usage, for billing or reporting: GET /v1/usage?from=2026-10-01&to=2026-10-31&group_by=day,model
  app.get("/v1/usage", async (c) => {
    const key = await resolveKey(db, redis, c.req.header("authorization"));
    if (!key) return fail("unauthorized", "missing or invalid API key", 401);
    const rate = await checkRate(redis, `key:${key.keyId}`, key.rpmLimit);
    if (!rate.ok) {
      const res = fail("rate_limited", `limit of ${key.rpmLimit} requests per minute for this API key`, 429);
      res.headers.set("retry-after", String(rate.retryAfterS));
      return res;
    }
    const range = parseUsageRange(c.req.query("from"), c.req.query("to"));
    if ("error" in range) return fail("invalid_request", range.error ?? "invalid period", 400);
    const groupBy = (c.req.query("group_by") ?? "day").split(",").filter(Boolean);
    const unknown = groupBy.filter((g) => !USAGE_GROUPS.includes(g as UsageGroup));
    if (unknown.length)
      return fail("invalid_request", `group_by takes ${USAGE_GROUPS.join(", ")}; got ${unknown.join(", ")}`, 400);
    const rows = await aggregateUsage(db, { organizationId: key.organizationId, ...range }, groupBy as UsageGroup[]);
    return c.json({
      organization_id: key.organizationId,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      group_by: groupBy,
      data: rows.map(({ keyPrefix, inputTokens, ...r }) => ({
        ...r,
        ...(keyPrefix !== undefined ? { key_prefix: keyPrefix } : {}),
        input_tokens: inputTokens,
      })),
    });
  });

  const decide = async (c: Context) => {
    const t0 = performance.now();
    const requestId = randomUUID();

    const key = await resolveKey(db, redis, c.req.header("authorization"));
    if (!key) return fail("unauthorized", "missing or invalid API key", 401);

    const text = await c.req.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail("invalid_json", "request body is not valid JSON", 400);
    }
    if (!jsonObject(raw)) return fail("invalid_json", "request body must be a JSON object", 400);

    const model = typeof raw.model === "string" ? raw.model : defaultModel;
    const upstream = upstreams.get(model);
    if (!upstream)
      return fail("unknown_model", `unknown model ${model}; available: ${[...upstreams.keys()].join(", ")}`, 404);
    if (Buffer.byteLength(text) > upstream.maxBodyBytes)
      return fail(
        "payload_too_large",
        `request body is larger than ${Math.floor(upstream.maxBodyBytes / 1024)} KiB, the limit of ${model}`,
        413,
      );

    let body: Record<string, unknown>;
    if (upstream.api === "basal") {
      // basal-1.5: catch malformed requests here instead of on the GPU
      const parsed = decisionRequest.safeParse(raw);
      if (!parsed.success)
        return fail("invalid_request", "request does not match the schema", 422, z.treeifyError(parsed.error));
      const { model: _model, ...rest } = parsed.data;
      body = rest;
    } else {
      const { model: _model, ...rest } = raw; // passthrough: the server validates
      body = rest;
    }

    const keyScope = `key:${key.keyId}` as const;
    const orgScope = `org:${key.organizationId}` as const;
    for (const [scope, rpm, of] of [
      [keyScope, key.rpmLimit, "this API key"],
      [orgScope, orgLimits.rpm, "this organization"],
    ] as const) {
      const rate = await checkRate(redis, scope, rpm);
      if (!rate.ok) {
        const res = fail("rate_limited", `limit of ${rpm} requests per minute for ${of}`, 429);
        res.headers.set("retry-after", String(rate.retryAfterS));
        return res;
      }
    }

    const ctx: RequestContext = { requestId, key, model };
    const refused = await hooks.beforeUpstream?.(ctx);
    if (refused) return refused;

    if (orgLimits.dailyRequests > 0) {
      const daily = await checkDaily(redis, key.organizationId, orgLimits.dailyRequests);
      if (!daily.ok) {
        const res = fail(
          "daily_limit_reached",
          `limit of ${orgLimits.dailyRequests} requests per day for this organization, resets at 00:00 UTC`,
          429,
        );
        res.headers.set("retry-after", String(daily.retryAfterS));
        return res;
      }
    }

    const exceeded = await checkQuotas(db, redis, [
      { scope: keyScope, quota: { requests: key.monthlyRequests, tokens: key.monthlyTokens }, of: "this API key" },
      {
        scope: orgScope,
        quota: {
          requests: key.orgMonthlyRequests ?? orgLimits.monthlyRequests,
          tokens: key.orgMonthlyTokens ?? orgLimits.monthlyTokens,
        },
        of: "this organization",
      },
    ]);
    if (exceeded) {
      const res = fail(
        "quota_exceeded",
        `monthly quota of ${exceeded.limit} ${exceeded.unit} for ${exceeded.of} used up; it renews on the 1st (UTC)`,
        429,
      );
      res.headers.set("retry-after", String(secondsToNextMonth()));
      return res;
    }

    if (!(await acquireSlot(redis, keyScope, key.concurrencyLimit, requestId))) {
      return fail("concurrency_limited", `limit of ${key.concurrencyLimit} concurrent requests for this API key`, 429);
    }
    if (!(await acquireSlot(redis, orgScope, orgLimits.concurrency, requestId))) {
      await releaseSlot(redis, keyScope, requestId);
      return fail(
        "concurrency_limited",
        `limit of ${orgLimits.concurrency} concurrent requests for this organization`,
        429,
      );
    }
    try {
      if (!upstream.tryAcquire()) return fail("overloaded", "model is at capacity, retry shortly", 503);
      let result;
      try {
        result = await upstream.decide(body);
      } finally {
        upstream.release();
      }

      if (result.kind === "timeout") return fail("upstream_timeout", "inference timed out", 504);
      if (result.kind === "network") {
        console.error(`[${requestId}] upstream ${model} unreachable: ${result.error}`);
        return fail("upstream_error", "inference backend unreachable", 502);
      }
      if (result.status === 503 || result.status === 529) {
        // the server's own admission limit (basal-rs answers 529 when its queue is full)
        const res = fail("overloaded", "the inference server is busy, retry shortly", 503);
        res.headers.set("retry-after", "1");
        return res;
      }
      if (result.status === 400 || result.status === 422) {
        const message = (result.body as { error?: unknown })?.error;
        return fail("invalid_request", typeof message === "string" ? message : "rejected by the model", 422);
      }
      const out = (upstream.api === "basal" ? basalResponse : passthroughResponse).safeParse(result.body);
      if (result.status !== 200 || !out.success) {
        console.error(`[${requestId}] upstream ${model} status ${result.status}`, result.body);
        return fail("upstream_error", "inference failed", 502);
      }

      const usage = out.data.usage ?? {};
      const totalMs = performance.now() - t0;
      const event: UsageEvent = {
        id: requestId,
        organizationId: key.organizationId,
        userId: key.userId,
        apiKeyId: key.keyId,
        model,
        inputTokens: usage.input_tokens ?? 0,
        questions: usage.questions ?? 0,
        branches: usage.branches ?? 0,
        upstreamLatencyMs: usage.latency_ms ?? totalMs,
        totalLatencyMs: totalMs,
        details: usage,
        createdAt: new Date().toISOString(),
      };
      await recordUsage(redis, event);
      await recordQuotaUsage(redis, [keyScope, orgScope], event.inputTokens);
      const extra = await hooks.onUsage?.(ctx, event);
      return Response.json(
        { id: requestId, ...out.data, model, usage: { ...usage, ...extra } },
        { headers: { "x-request-id": requestId } },
      );
    } finally {
      await Promise.all([releaseSlot(redis, keyScope, requestId), releaseSlot(redis, orgScope, requestId)]);
    }
  };

  // /v1/basal is basal-serve's alias of the same endpoint
  app.post("/v1/systemone", (c) => decide(c));
  app.post("/v1/basal", (c) => decide(c));

  app.onError((e) => {
    console.error(e);
    return fail("upstream_error", "internal error", 500);
  });

  return app;
}
