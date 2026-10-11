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
  /**
   * Request and response format. basal: basal-1.5 requests (questions validated before the GPU) and its usage block.
   * passthrough: any JSON object goes to the server, which validates it; for model families the gateway does not know
   * yet (omni, 2.0). Usage fields it knows are recorded when present, the whole usage block is kept as details.
   */
  api: z.enum(["basal", "passthrough"]).default("basal"),
  /** largest request body for this model, in bytes; media inputs need more than text */
  maxBodyBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024)
    .default(256 * 1024),
  /** free-form facts shown in GET /v1/models, e.g. {"modalities": ["text", "audio", "video"]} */
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type UpstreamConfig = z.infer<typeof upstreamConfig>;

const base = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  GATEWAY_PORT: z.coerce.number().int().default(8787),
  /** per organization, over all its keys (each key also has its own, lower limits) */
  ORG_RPM_LIMIT: z.coerce.number().int().positive().default(120),
  ORG_CONCURRENCY_LIMIT: z.coerce.number().int().positive().default(16),
  /** requests per UTC day per organization; 0 means no daily limit */
  ORG_DAILY_REQUESTS: z.coerce.number().int().nonnegative().default(0),
  /** default monthly quota per organization (calendar month, UTC) unless the admin set one; 0 means none */
  ORG_MONTHLY_REQUESTS: z.coerce.number().int().nonnegative().default(0),
  ORG_MONTHLY_TOKENS: z.coerce.number().int().nonnegative().default(0),
  /** model used when a request names none; default: the first model in UPSTREAMS */
  DEFAULT_MODEL: z.string().min(1).optional(),
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
    // one server per model, or a list in order of preference (overflow and failover)
    .pipe(z.record(z.string(), z.union([upstreamConfig, z.array(upstreamConfig).min(1)]))),
});

const schema = base
  .refine((e) => Object.keys(e.UPSTREAMS).length > 0, { message: "UPSTREAMS has no models", path: ["UPSTREAMS"] })
  .refine((e) => !e.DEFAULT_MODEL || e.DEFAULT_MODEL in e.UPSTREAMS, {
    message: "DEFAULT_MODEL is not one of the models in UPSTREAMS",
    path: ["DEFAULT_MODEL"],
  })
  .transform((e) => ({ ...e, DEFAULT_MODEL: e.DEFAULT_MODEL ?? Object.keys(e.UPSTREAMS)[0]! }));

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = schema.safeParse(source);
  if (!r.success) throw new Error(`invalid gateway env:\n${z.prettifyError(r.error)}`);
  return r.data;
}
