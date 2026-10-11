# Changelog

All notable changes are listed here; the format follows [Keep a Changelog](https://keepachangelog.com/) and versions
follow [Semantic Versioning](https://semver.org/). Before 1.0, minor versions may contain breaking changes.

## [Unreleased]

### Added

- Gateway for basal inference servers (basal-rs, basal-serve): `POST /v1/systemone` and `/v1/basal`, `GET /v1/models`.
- Organizations: API keys, limits and usage per organization; a personal one for everyone, shared ones with owners,
  admins and members, email invitations, an organization switcher in the dashboard.
- API keys with per-key and per-organization limits: requests per minute, concurrency, optional requests per day.
- Monthly quotas of requests and input tokens per organization (admin CLI, or a default) and per key.
- Usage reports: CSV export in the dashboard and `GET /v1/usage` (per day, model and key) with an API key.
- Several models per gateway, routed by `"model"`, with a default model; basal-rs `path` and `model` per upstream.
- Several servers per model with overflow, failover and a circuit breaker (e.g. own GPU first, serverless behind).
- `passthrough` models for new basal families (omni, 2.0): any JSON request, per-model body limit, `meta`, and the
  server's whole usage block stored as `details`.
- Usage metering in units (tokens, questions, branches, latency) per model and request; extension hooks
  (`beforeUpstream`, `onUsage`) for builds that add pricing.
- Dashboard: sign up with email confirmation, GitHub and Google sign in, password reset and change, account deletion,
  API keys, usage per model, model list, quick start.
- Sign up modes (`open`, `closed`) and allowed email domains; SMTP or Resend email; optional email verification;
  breached-password check (Have I Been Pwned) with a switch for offline installs; Cloudflare Turnstile (optional);
  rate-limited sign in, sign up and resets; security headers.
- Admin page for `ADMIN_EMAILS` and admin CLI (`bun run admin`): create, confirm, disable and delete accounts, sign up
  invitations, organization quotas, usage; invite-only sign up (`SIGNUP_MODE=invite`).
- Mock basal server (`bun run mock`) for development and tests.
- Docker images and docker compose profiles (`mock`, `gpu`, `app`); Modal template for serverless GPU.
