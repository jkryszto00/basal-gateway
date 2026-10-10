# basal gateway

A self-hosted API gateway for [basal](https://github.com/rkinas/basal) typed-decision models. Put it in front of your
own inference server and get what an API needs to serve more than one app or client: API keys, rate and concurrency
limits, usage metering and a dashboard.

basal is not a chat model: one forward pass returns calibrated probabilities for the options of typed questions
(`choice`, `noul`, `score`, `multi`, `act`). The gateway speaks the same API (`POST /v1/systemone`) and forwards it
to [basal-rs](https://github.com/itsoltech/basal-rs) or `basal-serve`, on your GPU, a Mac, or a serverless GPU.

> This project is not affiliated with the authors of basal or basal-rs. basal models and code are by Remigiusz Kinas
> (Apache-2.0); see [NOTICE](NOTICE).

```
client ──► gateway (Hono, Bun) ──► inference: basal-rs or basal-serve (own GPU, Mac, Modal, ...)
              │  keys, limits, usage
              ├── Redis      key cache, rate limits, concurrency, hot balance
              └── Postgres   users, API keys, usage
web (Next.js) ── sign up, API keys, usage, balance, settings
```

## Features

- **API keys**: created in the dashboard, shown once, stored as a SHA-256 hash, revoked immediately.
- **Limits**: requests per minute and concurrent requests per key and per account (over all its keys), optional
  requests per day per account, request size limit, per-upstream capacity.
- **Usage**: every successful request is recorded (model, key, input tokens, questions, branches, latency) and shown
  per model and per request. Usage is measured in units, not money: what a decision costs depends on your hardware, so turn
  it into your own rates or internal charges; [hooks](#extending) let a build add pricing.
- **Accounts**: email and password with confirmation links and password reset, optional GitHub and Google sign in,
  breached-password check (Have I Been Pwned), optional Cloudflare Turnstile, rate-limited sign in, sign up and resets,
  password change and account deletion.
- **Several models**: basal 1.5 and 1.0; each public model name maps to an inference server (`UPSTREAMS`), clients
  pick one with `"model"`, and the dashboard lists them and breaks usage down per model.

## Quick start

Requirements: [Bun](https://bun.sh) 1.3+, Node.js 20+ (the dashboard runs on Next.js), Docker, and an inference
server.

```bash
git clone https://github.com/jkryszto00/basal-gateway.git && cd basal-gateway
bun install
cp .env.example .env              # set BETTER_AUTH_SECRET (openssl rand -hex 32) and UPSTREAMS
bun run db:up                     # Postgres and Redis (docker compose)
bun run db:migrate
bun run dev                       # dashboard on :3000, gateway on :8787
```

Open http://localhost:3000, sign up (without `RESEND_API_KEY` the confirmation link is printed in the dashboard's log),
create an API key, and call the gateway:

```bash
curl http://localhost:8787/v1/systemone \
  -H "Authorization: Bearer $BASAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"state": "Order #1042 arrived damaged, I want my money back.",
       "questions": {"intent": {"type": "choice", "instructions": "What does the customer want?",
         "criteria": {"refund": "Refund", "replace": "Replacement", "info": "Information"}}}}'
```

The response is basal's, plus a request `id`:

```json
{
  "id": "6f1c…",
  "model": "basal-1.5",
  "answers": { "intent": { "type": "choice", "choice": "refund", "probabilities": { "refund": 0.97, "…": 0.01 }, "confidence": 0.97 } },
  "usage": { "input_tokens": 302, "output_tokens": 0, "questions": 1, "branches": 1, "latency_ms": 61.2 }
}
```


## Inference servers

The gateway forwards to anything that serves the basal API (`POST /v1/systemone`). Configure one entry per public
model name in `UPSTREAMS`:

```bash
UPSTREAMS={"basal-1.5":{"url":"http://localhost:8000","path":"/v1/basal","maxInFlight":64,"timeoutMs":180000}}
```

| server | where | notes |
|---|---|---|
| [basal-rs](https://github.com/itsoltech/basal-rs) | NVIDIA GPU (CUDA), Apple Silicon (Metal) | Rust, no Python; `basal serve` or its Docker image. Recommended. |
| [basal-serve](https://github.com/rkinas/basal) | NVIDIA GPU, Apple Silicon, CPU | the reference Python server; engines: PyTorch, vLLM, SGLang, MLX, llama.cpp |
| [Modal template](inference/) | serverless GPU | basal-serve with a GPU memory snapshot, scales to zero |

| field | default | |
|---|---|---|
| `url` | | base URL of the server |
| `path` | `/v1/systemone` | endpoint to call: `/v1/systemone` for basal-serve, `/v1/basal` for basal-rs (its endpoint with basal-serve's semantics; its `/v1/systemone` follows the stricter TypeSafe contract) |
| `model` | | model name sent in the request, for one basal-rs process serving several models (e.g. `basal-1.5-max`) |
| `token` | | sent as `Authorization: Bearer <token>` (e.g. a Modal proxy token); leave out on a private network |
| `maxInFlight` | `64` | requests in flight to this server; beyond it the gateway answers 503 instead of queueing |
| `timeoutMs` | `180000` | per request, long enough for a serverless cold start |


A server that answers 503 or 529 (basal-rs, queue full) is reported to the client as 503 `overloaded` with
`retry-after`.

### Several models

Every entry in `UPSTREAMS` is a model clients can pick with `"model"` in the request; requests without it go to
`DEFAULT_MODEL` (the first entry by default). Several entries can point at the same basal-rs process:

```bash
UPSTREAMS={
  "basal-1.5-mini": {"url":"http://gpu:8000","path":"/v1/basal","model":"basal-1.5-mini"},
  "basal-1.5":      {"url":"http://gpu:8000","path":"/v1/basal","model":"basal-1.5-4.5B"},
  "basal-1.5-max":  {"url":"https://<workspace>--basal-1-5-max-fast-nocompile-basal-web.modal.run","token":"wk-….ws-…"}
}
DEFAULT_MODEL=basal-1.5
```

`GET /v1/models` lists the models and the default.

### basal 1.0

basal-1.0 models (`Remek/basal-1.0-4.5B`, `Remek/basal-1.0-1.5B`) work the same way, served by basal-rs or a basal
1.0 server. They answer `choice`, `noul` and `score` questions; `multi`, `act` and `facts` are basal-1.5 features
that a 1.0 server rejects (422). A 1.0 server reports only token counts, so the gateway fills in `questions`,
`branches` and `latency_ms` from the request and its own timing.

### basal-rs with Docker

On a machine with an NVIDIA GPU and the [NVIDIA Container
Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/):

```bash
docker compose --profile gpu up -d          # basal-rs on :8000, BASAL_MODEL=mini|4.5B|max (default 4.5B)
docker compose logs -f basal-rs             # first start: model download and GEMM tables, minutes
```

```bash
UPSTREAMS={"basal-1.5":{"url":"http://localhost:8000","path":"/v1/basal"}}
```

On a Mac, run basal-rs natively (Metal): `brew install itsoltech/tap/basal-rs && basal serve`.

## Configuration

All settings are environment variables, read from `.env` at the repository root by both apps.

| variable | default | |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | | Postgres and Redis |
| `UPSTREAMS` | | model name → inference server (JSON, see above) |
| `DEFAULT_MODEL` | first in `UPSTREAMS` | model of requests without `"model"` |
| `GATEWAY_PORT` | `8787` | |
| `API_KEY_PREFIX` | `bg_live_` | start of new API keys; existing keys keep working after a change |
| `USER_RPM_LIMIT`, `USER_CONCURRENCY_LIMIT` | `120`, `16` | per account over all its keys; each key also has its own limits (60/min, 8) |
| `USER_DAILY_REQUESTS` | `0` | requests per UTC day per account, `0` = unlimited |
| `APP_NAME` | `basal gateway` | shown in the dashboard and emails |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | | session secret and the dashboard's public URL |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8787` | gateway URL shown in the dashboard |
| `GATEWAY_INTERNAL_URL` | `NEXT_PUBLIC_API_URL` | where the dashboard reaches the gateway for its model list |
| `CLIENT_IP_HEADER` | `x-forwarded-for` | header with the visitor's IP (`cf-connecting-ip` behind Cloudflare); only trust it if the dashboard cannot be reached around your proxy |
| `RESEND_API_KEY`, `EMAIL_FROM` | | email through Resend; without a key emails are printed to the log |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | | optional Cloudflare Turnstile on sign up |
| `GITHUB_CLIENT_ID`/`_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET` | | optional OAuth sign in; callback `<BETTER_AUTH_URL>/api/auth/callback/<github\|google>` |


## Extending

The gateway has two hooks, for builds that add something on top of it (a hosted service selling prepaid credits,
an internal chargeback, an audit trail):

```ts
import { apiError, createApp } from "./app";

createApp({
  ...deps,
  hooks: {
    // after authentication, validation and the per-minute limits, before the inference server
    beforeUpstream: async ({ key, model }) =>
      (await balanceOf(key.userId)) <= 0 ? apiError("insufficient_credits", "balance is empty", 402) : undefined,
    // after a successful decision, once its usage is queued; returned fields are added to the response's usage
    onUsage: async ({ key }, event) => ({ cost: await charge(key.userId, event) }),
  },
});
```

## API errors

Errors are `{"error": {"code", "message"}}`:

| status | code | |
|---|---|---|
| 400 | `invalid_json` | |
| 401 | `unauthorized` | missing, unknown or revoked API key |
| 404 | `unknown_model` | the message lists the available models |
| 413 | `payload_too_large` | body over 256 KiB |
| 422 | `invalid_request` | does not match the schema, or the model rejected it |
| 429 | `rate_limited`, `concurrency_limited`, `daily_limit_reached` | with `retry-after` |
| 503 | `overloaded` | the inference server is at `maxInFlight` |
| 502, 504 | `upstream_error`, `upstream_timeout` | |

Only successful requests are recorded as usage.

## Development

```
apps/gateway      Hono on Bun: /v1/systemone, /v1/basal, /v1/models, auth, limits, billing
apps/web          Next.js: dashboard and accounts (Better Auth)
packages/db       Drizzle schema and migrations
packages/shared   request schema, usage, API key helpers
inference/        basal-serve on Modal (Python, uv)
```

```bash
bun run typecheck
bun run test          # gateway integration tests use Postgres and Redis from docker compose
bun run db:generate   # after changing packages/db/src/schema.ts
```

Browser smoke test of the dashboard (sign up, confirmation, keys, password reset, account deletion), against a
running app started without `RESEND_API_KEY` so emails land in its log:

```bash
cd apps/web && RESEND_API_KEY= bun run dev > /tmp/web.log 2>&1 &
WEB_LOG=/tmp/web.log bun run e2e
```

## Roadmap

- Organizations: keys, limits and usage per team or client
- Monthly quotas per key and account (requests, tokens)
- Admin page and sign up modes (open, invite only, closed)
- Offline mode: every external service optional, for air-gapped installs
- Usage export (CSV, API)
- Upstream failover and overflow
- Docker images for the gateway and dashboard: one `docker compose up` from clone to API

## License

[Apache-2.0](LICENSE). basal and basal-rs are separate projects under their own licenses; model weights are published
on Hugging Face under their own terms.
