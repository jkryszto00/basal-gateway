# basal gateway

[![CI](https://github.com/jkryszto00/basal-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/jkryszto00/basal-gateway/actions/workflows/ci.yml)

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
- **Organizations**: API keys, limits and usage belong to an organization. Everyone has a personal one; shared ones
  have owners, admins and members, invited by email, so a team or each client of an agency gets its own keys and
  usage.
- **Limits and quotas**: requests per minute and concurrent requests per key and per organization (over all its
  keys), optional requests per day, monthly quotas of requests and input tokens per key and per organization, request
  size limit, per-upstream capacity.
- **Usage**: every successful request is recorded (model, key, member, input tokens, questions, branches, latency),
  shown per model and request, and exported as CSV or through `GET /v1/usage`. Usage is measured in units, not money: what a decision costs depends on your hardware, so turn
  it into your own rates or internal charges; [hooks](#extending) let a build add pricing.
- **Accounts**: email and password with optional email confirmation and password reset (SMTP or Resend), optional
  GitHub and Google sign in, open, invite-only or closed sign up and allowed email domains, an admin page, breached-password check (Have I Been
  Pwned), optional Cloudflare Turnstile, rate-limited sign in, sign up and resets, password change and account
  deletion.
- **Hardened defaults**: Content Security Policy and anti-framing headers on the dashboard (HSTS when served over
  HTTPS), secure headers on the API, Better Auth's HTTP endpoints limited to the emailed links and OAuth callbacks.
- **Several models**: each public model name maps to an inference server (`UPSTREAMS`), clients
  pick one with `"model"`, and the dashboard lists them and breaks usage down per model.

## Quick start

### With Docker

Everything in containers: Postgres, Redis, the gateway (applies migrations on start), the dashboard, and an inference
server.

```bash
git clone https://github.com/jkryszto00/basal-gateway.git && cd basal-gateway
cp .env.example .env                          # set BETTER_AUTH_SECRET (openssl rand -hex 32)
docker compose --profile mock up -d --build   # mock basal server: try it without a GPU (made-up answers)
docker compose --profile gpu up -d --build    # or basal-rs on an NVIDIA GPU (NVIDIA Container Toolkit)
docker compose logs -f web                    # confirmation links, when no email is configured
```

Dashboard on http://localhost:3000, API on http://localhost:8787. Both profiles point the gateway at their inference
container; to use your own server instead, set `UPSTREAMS_DOCKER` in `.env` and start with `--profile app`. The images
can also be built on their own (`apps/gateway/Dockerfile`, `apps/web/Dockerfile`, from the repository root); the
dashboard image reads every setting at runtime.

### For development

Requirements: [Bun](https://bun.sh) 1.3+, Node.js 20+ (the dashboard runs on Next.js), Docker, and an inference
server, or the mock server to try everything without a GPU.

```bash
git clone https://github.com/jkryszto00/basal-gateway.git && cd basal-gateway
bun install
cp .env.example .env              # set BETTER_AUTH_SECRET (openssl rand -hex 32) and UPSTREAMS
bun run db:up                     # Postgres and Redis (docker compose)
bun run db:migrate
bun run mock                      # no GPU yet? a mock basal server on :8000 (made-up answers)
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


## Administration

Accounts listed in `ADMIN_EMAILS` see an **Admin** page in the dashboard: create accounts (the password is shown
once), confirm, disable (no sign in; their organizations' keys keep working) and delete them, invite addresses to
sign up (`SIGNUP_MODE=invite`), and see every organization's usage this month and set its monthly quota.

The same and more from the command line: `bun run admin` works on the database directly, whatever `SIGNUP_MODE`
says, e.g. to create the first accounts of a closed instance:

```bash
bun run admin users                                   # accounts and how many organizations they are in
bun run admin users add ana@acme.com --name Ana       # confirmed account with its personal organization;
                                                      # prints a generated password once
bun run admin users verify ana@acme.com               # mark an email as confirmed
bun run admin users disable ana@acme.com              # no sign in (enable to undo)
bun run admin users invite ana@acme.com               # invitation to sign up; prints the link to send
bun run admin users delete ana@acme.com --yes         # with the organizations only it belongs to
bun run admin keys <org>                              # an organization's API keys (slug or id)
bun run admin keys revoke <key-id>                    # revoke a key at once
bun run admin orgs                                    # organizations: slug, members, keys, last request
bun run admin orgs add-member <org> ana@acme.com --role admin   # add an account without an invitation
bun run admin orgs quota <org> --requests 100000 --tokens 50000000   # monthly quota; 0 clears
bun run admin usage --days 30 --csv                   # requests, decisions, branches, tokens per organization and model
```

## Monthly quotas

A quota caps an organization's or a key's successful requests and input tokens per calendar month (UTC); past it
the API answers 429 `quota_exceeded` until the 1st. The admin sets an organization's quota with `bun run admin orgs
quota` (or a default for all with `ORG_MONTHLY_REQUESTS` / `ORG_MONTHLY_TOKENS`); members give a key its own, lower
quota when they create it, e.g. one key per client. The dashboard shows the month's usage against the
organization's quota. Counters live in Redis and are rebuilt from the usage in Postgres when missing; the check runs
before a request and the count after it, so a quota can be overshot by the requests in flight when it runs out.

## Usage reports

Every member can download the organization's usage as CSV from the **Usage** page (daily totals per model and key,
or every request). The same totals are available over the API with any of the organization's keys, e.g. to bill
clients automatically:

```bash
curl "http://localhost:8787/v1/usage?from=2026-10-01&to=2026-10-31&group_by=day,model" \
  -H "Authorization: Bearer $BASAL_KEY"
```

```json
{
  "organization_id": "…", "from": "2026-10-01T00:00:00.000Z", "to": "2026-11-01T00:00:00.000Z", "group_by": ["day", "model"],
  "data": [{ "day": "2026-10-01", "model": "basal-1.5", "requests": 1200, "decisions": 2400, "branches": 2400, "input_tokens": 360000 }]
}
```

`from` and `to` are UTC dates, both inclusive (default: this month so far, at most 366 days); `group_by` is any of
`day`, `model`, `key` (default `day`; empty for one total). Usage reaches the report a few seconds after a request.

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
| mock (`bun run mock`) | anywhere | made-up, deterministic answers with basal's response shape, for development and tests; never for real use |

| field | default | |
|---|---|---|
| `url` | | base URL of the server |
| `path` | `/v1/systemone` | endpoint to call: `/v1/systemone` for basal-serve, `/v1/basal` for basal-rs (its endpoint with basal-serve's semantics; its `/v1/systemone` follows the stricter TypeSafe contract) |
| `model` | | model name sent in the request, for one basal-rs process serving several models (e.g. `basal-1.5-max`) |
| `token` | | sent as `Authorization: Bearer <token>` (e.g. a Modal proxy token); leave out on a private network |
| `maxInFlight` | `64` | requests in flight to this server; beyond it the gateway answers 503 instead of queueing |
| `timeoutMs` | `180000` | per request, long enough for a serverless cold start |
| `api` | `basal` | `basal`: basal-1.5 requests validated before the GPU; `passthrough`: any JSON object, see below |
| `maxBodyBytes` | `262144` | largest request body for this model (up to 64 MiB), e.g. more for audio or video inputs |
| `meta` | | free-form facts shown in `/v1/models`, e.g. `{"modalities": ["text", "audio"]}` |


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

### New model families (omni, 2.0, ...)

The gateway validates basal-1.5 requests (questions, options, state size) before they reach a GPU. A newer family
with other inputs, such as audio or video, or other question types, does not have to wait for a gateway release:
mark it `"api": "passthrough"` and the gateway forwards any JSON object to the server, which validates it.

```bash
UPSTREAMS={
  "basal-1.5":  {"url":"http://gpu:8000","path":"/v1/basal"},
  "basal-omni": {"url":"http://gpu:8001","path":"/v1/omni","api":"passthrough","maxBodyBytes":16777216,
                 "meta":{"modalities":["text","audio","video"]}}
}
```

Keys, limits, routing by `"model"` and the hooks work the same. From the server's `usage` block the gateway records
the fields it knows (`input_tokens`, `questions`, `branches`, `latency_ms`) and keeps the whole block in
`usage_events.details`, so new units (audio seconds, video frames) are stored without a schema change.

## Configuration

All settings are environment variables, read from `.env` at the repository root by both apps.

| variable | default | |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | | Postgres and Redis |
| `UPSTREAMS` | | model name → inference server (JSON, see above) |
| `DEFAULT_MODEL` | first in `UPSTREAMS` | model of requests without `"model"` |
| `GATEWAY_PORT` | `8787` | |
| `API_KEY_PREFIX` | `bg_live_` | start of new API keys; existing keys keep working after a change |
| `ORG_RPM_LIMIT`, `ORG_CONCURRENCY_LIMIT` | `120`, `16` | per organization over all its keys; each key also has its own limits (60/min, 8) |
| `ORG_DAILY_REQUESTS` | `0` | requests per UTC day per organization, `0` = unlimited |
| `ORG_MONTHLY_REQUESTS`, `ORG_MONTHLY_TOKENS` | `0`, `0` | default monthly quota (UTC month) of organizations without their own, `0` = none |
| `APP_NAME` | `basal gateway` | shown in the dashboard and emails |
| `SIGNUP_MODE` | `open` | `invite`: only invited addresses (by an admin or to an organization); `closed`: no sign up, admins create accounts; existing accounts still sign in |
| `SIGNUP_ALLOWED_DOMAINS` | | with `open`: only these email domains may sign up, e.g. `acme.com,acme.pl` (email and OAuth) |
| `ADMIN_EMAILS` | | instance admins: `ana@acme.com,@acme.com` (`@domain` covers a domain); they get the admin page |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | | session secret and the dashboard's public URL |
| `GATEWAY_PUBLIC_URL` | `http://localhost:8787` | gateway URL shown in the dashboard |
| `GATEWAY_INTERNAL_URL` | `GATEWAY_PUBLIC_URL` | where the dashboard reaches the gateway for its model list |
| `CLIENT_IP_HEADER` | `x-forwarded-for` | header with the visitor's IP (`cf-connecting-ip` behind Cloudflare); only trust it if the dashboard cannot be reached around your proxy |
| `SMTP_URL` | | email over SMTP: `smtp://user:pass@host:587` (STARTTLS) or `smtps://…:465` |
| `RESEND_API_KEY` | | email through Resend when `SMTP_URL` is not set; without either, emails are printed to the log |
| `EMAIL_FROM` | `<APP_NAME> <noreply@localhost>` | sender of confirmation and reset emails |
| `HIBP_ENABLED` | `true` | breached-password check against haveibeenpwned.com; `false` for installs without internet access |
| `EMAIL_VERIFICATION` | `true` | `false`: accounts work right after sign up, for installs that cannot send email |
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
      (await balanceOf(key.organizationId)) <= 0 ? apiError("insufficient_credits", "balance is empty", 402) : undefined,
    // after a successful decision, once its usage is queued; returned fields are added to the response's usage
    onUsage: async ({ key }, event) => ({ cost: await charge(key.organizationId, event) }),
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
| 429 | `rate_limited`, `concurrency_limited`, `daily_limit_reached`, `quota_exceeded` | with `retry-after` |
| 503 | `overloaded` | the inference server is at `maxInFlight` |
| 502, 504 | `upstream_error`, `upstream_timeout` | |

Only successful requests are recorded as usage.

## Development

```
apps/gateway      Hono on Bun: /v1/systemone, /v1/basal, /v1/models, auth, limits, billing
apps/web          Next.js: dashboard and accounts (Better Auth)
apps/cli          admin CLI (bun run admin)
apps/mock         mock basal server for development and tests (bun run mock)
packages/db       Drizzle schema and migrations
packages/shared   request schema, usage, API key helpers
inference/        basal-serve on Modal (Python, uv)
```

```bash
bun run typecheck
bun run test          # gateway integration tests use Postgres and Redis from docker compose
bun run db:generate   # after changing packages/db/src/schema.ts
bun run format        # Prettier (bun run format:check in CI)
```

The mock server (`MOCK_PORT`, default 8000) answers `/v1/systemone` and `/v1/basal` like basal, and simulates errors
with special states: `"mock:422"` (rejected by the model), `"mock:529"` (overloaded), `"mock:500"` (inference
failure), `"mock:slow:5000"` (answers after 5 s).

Browser smoke test of the dashboard (sign up, confirmation, keys, password reset, account deletion), against a
running app started without `RESEND_API_KEY` so emails land in its log:

```bash
cd apps/web && RESEND_API_KEY= bun run dev > /tmp/web.log 2>&1 &
WEB_LOG=/tmp/web.log bun run e2e
```

## Deployment, security, contributing

- [Deployment](docs/deployment.md): checklist, reverse proxy with TLS, backups, upgrades, offline installs
- [Security](SECURITY.md): reporting vulnerabilities
- [Contributing](CONTRIBUTING.md) and the [changelog](CHANGELOG.md)

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
