import { z } from "zod";

const upstream = z.object({
  url: z.url(),
  /** sent as `Authorization: Bearer <token>`; leave out for an upstream on a private network */
  token: z.string().min(1).optional(),
  /** requests in flight to this upstream before the gateway answers 503 instead of queueing */
  maxInFlight: z.number().int().positive().default(64),
  /** a scaled-to-zero Modal container needs time to restore its snapshot */
  timeoutMs: z.number().int().positive().default(180_000),
});

export type UpstreamConfig = z.infer<typeof upstream>;

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
    .pipe(z.record(z.string(), upstream)),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = schema.safeParse(source);
  if (!r.success) throw new Error(`invalid gateway env:\n${z.prettifyError(r.error)}`);
  return r.data;
}
