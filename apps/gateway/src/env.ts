import { z } from "zod";

export const upstreamConfig = z.object({
  url: z.url(),
  /** sent as `Authorization: Bearer <token>`; leave out for an upstream on a private network */
  token: z.string().min(1).optional(),
  /**
   * Endpoint to call. basal-serve: /v1/systemone. basal-rs: /v1/basal, its endpoint with basal-serve's semantics
   * (its /v1/systemone follows the stricter TypeSafe contract).
   */
  path: z.string().startsWith("/").default("/v1/systemone"),
  /** model name sent in the request, for a server with several models in one process (basal-rs) */
  model: z.string().min(1).optional(),
  /** requests in flight to this upstream before the gateway answers 503 instead of queueing */
  maxInFlight: z.number().int().positive().default(64),
  /** a scaled-to-zero Modal container needs time to restore its snapshot */
  timeoutMs: z.number().int().positive().default(180_000),
});

export type UpstreamConfig = z.infer<typeof upstreamConfig>;

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  GATEWAY_PORT: z.coerce.number().int().default(8787),
  /** per account, over all its keys (each key also has its own, lower limits) */
  USER_RPM_LIMIT: z.coerce.number().int().positive().default(120),
  USER_CONCURRENCY_LIMIT: z.coerce.number().int().positive().default(16),
  /** refuse requests at a zero balance (prepaid credits); off: usage and cost are only recorded */
  CREDITS_ENABLED: z.stringbool().default(false),
  /** requests per UTC day per account; 0 means no daily limit */
  USER_DAILY_REQUESTS: z.coerce.number().int().nonnegative().default(0),
  /** {"basal-1.5": {"url": "...", "token": "..."}}: public model name -> basal-serve or basal-rs upstream */
  UPSTREAMS: z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "UPSTREAMS is not valid JSON" });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), upstreamConfig)),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = schema.safeParse(source);
  if (!r.success) throw new Error(`invalid gateway env:\n${z.prettifyError(r.error)}`);
  return r.data;
}
