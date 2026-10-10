# basal gateway

A self-hosted API gateway for [basal](https://github.com/rkinas/basal) typed-decision models. Put it in front of your
own inference server and get what an API needs to serve more than one app or client: API keys, rate and concurrency
limits, usage metering, credits, and a dashboard.

basal is not a chat model: one forward pass returns calibrated probabilities for the options of typed questions
(`choice`, `noul`, `score`, `multi`, `act`). The gateway speaks the same API (`POST /v1/systemone`) and forwards it
to [basal-rs](https://github.com/itsoltech/basal-rs) or `basal-serve`, on your GPU, a Mac, or a serverless GPU.

> This project is not affiliated with the authors of basal or basal-rs. basal models and code are by Remigiusz Kinas
> (Apache-2.0); see [NOTICE](NOTICE).

```
client ──► gateway (Hono, Bun) ──► inference: basal-rs or basal-serve (own GPU, Mac, Modal, ...)
              │  keys, limits, usage, credits
              ├── Redis      key cache, rate limits, concurrency, hot balance
              └── Postgres   users, API keys, credit ledger, usage
web (Next.js) ── sign up, API keys, usage, balance, settings
```

## Features

- **API keys**: created in the dashboard, shown once, stored as a SHA-256 hash, revoked immediately.
- **Limits**: requests per minute and concurrent requests per key and per account (over all its keys), optional
  requests per day per account, request size limit, per-upstream capacity.
- **Usage and credits**: every successful request is recorded (input tokens, questions, branches, latency) and priced
  from a per-model price list. With `CREDITS_ENABLED=true` accounts have a prepaid balance in integer micro-USD and
  requests are refused at zero. Failed requests are never billed.
- **Accounts**: email and password with confirmation links and password reset, optional GitHub and Google sign in,
  breached-password check (Have I Been Pwned), optional Cloudflare Turnstile, rate-limited sign in, sign up and resets,
  password change and account deletion.
- **Several models**: each public model name maps to its own inference server (`UPSTREAMS`).

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

The response is basal's, plus a request `id` and the cost:

```json
{
  "id": "6f1c…",
  "model": "basal-1.5",
  "answers": { "intent": { "type": "choice", "choice": "refund", "probabilities": { "refund": 0.97, "…": 0.01 }, "confidence": 0.97 } },
  "usage": { "input_tokens": 302, "output_tokens": 0, "questions": 1, "branches": 1, "latency_ms": 61.2, "cost_micro_usd": 36 }
}
```

Credits are off by default: usage and cost are recorded, nothing is refused. With `CREDITS_ENABLED=true` new accounts
start with `SIGNUP_CREDIT_MICROUSD` and requests stop at a zero balance. To give an account credits, add a row to
`credit_transactions` (an admin page is on the roadmap):

```sql
insert into credit_transactions (user_id, amount_micro_usd, reason)
select id, 10000000, 'adjustment' from "user" where email = 'someone@example.com';   -- $10
```

## Inference servers

The gateway forwards to anything that serves the basal API (`POST /v1/systemone`). Configure one entry per public
model name in `UPSTREAMS`:

```bash
UPSTREAMS={"basal-1.5":{"url":"http://localhost:8000","maxInFlight":64,"timeoutMs":180000,"token":"optional"}}
```

| server | where | notes |
|---|---|---|
| [basal-rs](https://github.com/itsoltech/basal-rs) | NVIDIA GPU (CUDA), Apple Silicon (Metal) | Rust, no Python; `basal serve` or its Docker image. Recommended. |
| [basal-serve](https://github.com/rkinas/basal) | NVIDIA GPU, Apple Silicon, CPU | the reference Python server; engines: PyTorch, vLLM, SGLang, MLX, llama.cpp |
| [Modal template](inference/) | serverless GPU | basal-serve with a GPU memory snapshot, scales to zero |

`token` is sent as `Authorization: Bearer <token>` (for example a Modal proxy token); leave it out for a server on a
private network. `maxInFlight` caps requests in flight to that server; beyond it the gateway answers 503 instead of
queueing.

## Configuration

All settings are environment variables, read from `.env` at the repository root by both apps.

| variable | default | |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | | Postgres and Redis |
| `UPSTREAMS` | | model name → inference server (JSON, see above) |
| `GATEWAY_PORT` | `8787` | |
| `USER_RPM_LIMIT`, `USER_CONCURRENCY_LIMIT` | `120`, `16` | per account over all its keys; each key also has its own limits (60/min, 8) |
| `USER_DAILY_REQUESTS` | `0` | requests per UTC day per account, `0` = unlimited |
| `CREDITS_ENABLED` | `false` | prepaid credits: refuse requests at a zero balance |
| `APP_NAME` | `basal gateway` | shown in the dashboard and emails |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | | session secret and the dashboard's public URL |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8787` | gateway URL shown in the dashboard |
| `SIGNUP_CREDIT_MICROUSD` | `0` | credits for each new account once its email is confirmed |
| `CLIENT_IP_HEADER` | `x-forwarded-for` | header with the visitor's IP (`cf-connecting-ip` behind Cloudflare); only trust it if the dashboard cannot be reached around your proxy |
| `RESEND_API_KEY`, `EMAIL_FROM` | | email through Resend; without a key emails are printed to the log |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | | optional Cloudflare Turnstile on sign up |
| `GITHUB_CLIENT_ID`/`_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET` | | optional OAuth sign in; callback `<BETTER_AUTH_URL>/api/auth/callback/<github\|google>` |

Prices per model are in [`packages/shared/src/pricing.ts`](packages/shared/src/pricing.ts) (micro-USD per million
input tokens and per thousand branches).

## API errors

Errors are `{"error": {"code", "message"}}`:

| status | code | |
|---|---|---|
| 400 | `invalid_json` | |
| 401 | `unauthorized` | missing, unknown or revoked API key |
| 402 | `insufficient_credits` | balance is zero (with `CREDITS_ENABLED`) |
| 404 | `unknown_model` | |
| 413 | `payload_too_large` | body over 256 KiB |
| 422 | `invalid_request` | does not match the schema, or the model rejected it |
| 429 | `rate_limited`, `concurrency_limited`, `daily_limit_reached` | with `retry-after` |
| 503 | `overloaded` | the inference server is at `maxInFlight` |
| 502, 504 | `upstream_error`, `upstream_timeout` | |

Only successful requests are billed.

## Development

```
apps/gateway      Hono on Bun: /v1/systemone, /v1/basal, /v1/models, auth, limits, billing
apps/web          Next.js: dashboard and accounts (Better Auth)
packages/db       Drizzle schema and migrations
packages/shared   request schema, pricing, API key helpers
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

- Organizations: keys, limits, credits and usage per team or client
- Admin page and sign up modes (open, invite only, closed)
- Offline mode: every external service optional, for air-gapped installs
- Usage export (CSV, API)
- Upstream failover and overflow
- Docker Compose with basal-rs, one command from clone to API

## License

[Apache-2.0](LICENSE). basal and basal-rs are separate projects under their own licenses; model weights are published
on Hugging Face under their own terms.
