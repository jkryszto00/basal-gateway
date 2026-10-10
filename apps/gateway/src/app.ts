import { randomUUID } from "node:crypto";
import type { Db } from "@basal/db";
import { completeUsage, decisionRequest, serverUsage } from "@basal/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Redis } from "ioredis";
import { z } from "zod";
import { type KeyInfo, resolveKey } from "./auth";
import { acquireSlot, checkDaily, checkRate, releaseSlot } from "./limits";
import type { Upstream } from "./upstream";
import { recordUsage, type UsageEvent } from "./usage";

/** Limits per account, summed over all its API keys (10 keys x 60 rpm would otherwise allow 600 rpm). */
export type UserLimits = {
  rpm: number;
  concurrency: number;
  /** requests per UTC day; 0 means no daily limit */
  dailyRequests: number;
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
  userLimits: UserLimits;
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
  | "overloaded"
  | "upstream_error"
  | "upstream_timeout";

/** The gateway's error body, `{"error": {"code", "message"}}`; for hooks that refuse a request. */
export const apiError = (code: string, message: string, status: number, details?: unknown) =>
  Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });

const fail = (code: ErrorCode, message: string, status: ContentfulStatusCode, details?: unknown) =>
  apiError(code, message, status, details);

/** Rejected before parsing; a maximal valid request (32k-char state, 16 questions) is far below it. */
export const MAX_BODY_BYTES = 256 * 1024;

const upstreamResponse = z.looseObject({ answers: z.record(z.string(), z.unknown()), usage: serverUsage });

export function createApp({ db, redis, upstreams, userLimits, defaultModel, hooks = {} }: Deps) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => fail("payload_too_large", `request body is larger than ${MAX_BODY_BYTES / 1024} KiB`, 413),
    }),
  );

  app.get("/v1/models", (c) =>
    c.json({
      default: defaultModel,
      models: [...upstreams.values()].map((u) => ({
        name: u.model,
        default: u.model === defaultModel,
      })),
    }),
  );

  const decide = async (c: Context) => {
    const t0 = performance.now();
    const requestId = randomUUID();

    const key = await resolveKey(db, redis, c.req.header("authorization"));
    if (!key) return fail("unauthorized", "missing or invalid API key", 401);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail("invalid_json", "request body is not valid JSON", 400);
    }
    const parsed = decisionRequest.safeParse(raw);
    if (!parsed.success) return fail("invalid_request", "request does not match the schema", 422, z.treeifyError(parsed.error));
    const { model = defaultModel, ...body } = parsed.data;

    const upstream = upstreams.get(model);
    if (!upstream) return fail("unknown_model", `unknown model ${model}; available: ${[...upstreams.keys()].join(", ")}`, 404);

    const keyScope = `key:${key.keyId}` as const;
    const userScope = `user:${key.userId}` as const;
    for (const [scope, rpm, of] of [
      [keyScope, key.rpmLimit, "this API key"],
      [userScope, userLimits.rpm, "this account"],
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

    if (userLimits.dailyRequests > 0) {
      const daily = await checkDaily(redis, key.userId, userLimits.dailyRequests);
      if (!daily.ok) {
        const res = fail(
          "daily_limit_reached",
          `limit of ${userLimits.dailyRequests} requests per day for this account, resets at 00:00 UTC`,
          429,
        );
        res.headers.set("retry-after", String(daily.retryAfterS));
        return res;
      }
    }

    if (!(await acquireSlot(redis, keyScope, key.concurrencyLimit, requestId))) {
      return fail("concurrency_limited", `limit of ${key.concurrencyLimit} concurrent requests for this API key`, 429);
    }
    if (!(await acquireSlot(redis, userScope, userLimits.concurrency, requestId))) {
      await releaseSlot(redis, keyScope, requestId);
      return fail("concurrency_limited", `limit of ${userLimits.concurrency} concurrent requests for this account`, 429);
    }
    try {
      if (!upstream.tryAcquire()) return fail("overloaded", "model is at capacity, retry shortly", 503);
      let result;
      const sentAt = performance.now();
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
      const out = upstreamResponse.safeParse(result.body);
      if (result.status !== 200 || !out.success) {
        console.error(`[${requestId}] upstream ${model} status ${result.status}`, result.body);
        return fail("upstream_error", "inference failed", 502);
      }

      // basal-1.0 servers report only token counts: questions, branches and latency are filled in here
      const usage = completeUsage(out.data.usage, body, performance.now() - sentAt);
      const event: UsageEvent = {
        id: requestId,
        userId: key.userId,
        apiKeyId: key.keyId,
        model,
        inputTokens: usage.input_tokens,
        questions: usage.questions,
        branches: usage.branches,
        upstreamLatencyMs: usage.latency_ms,
        totalLatencyMs: performance.now() - t0,
        createdAt: new Date().toISOString(),
      };
      await recordUsage(redis, event);
      const extra = await hooks.onUsage?.(ctx, event);
      return Response.json(
        { id: requestId, ...out.data, model, usage: { ...usage, ...extra } },
        { headers: { "x-request-id": requestId } },
      );
    } finally {
      await Promise.all([releaseSlot(redis, keyScope, requestId), releaseSlot(redis, userScope, requestId)]);
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
