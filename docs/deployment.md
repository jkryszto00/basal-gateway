# Deployment

A production install is the Docker stack from the README behind a reverse proxy with TLS. This page covers what to
set, what to back up and how to upgrade.

## Checklist

- [ ] `BETTER_AUTH_SECRET`: a long random value (`openssl rand -hex 32`), kept out of the repository.
- [ ] `BETTER_AUTH_URL`: the dashboard's public HTTPS URL. HTTPS also turns on HSTS and secure cookies.
- [ ] `GATEWAY_PUBLIC_URL`: the API's public URL, shown to users in the dashboard.
- [ ] `CLIENT_IP_HEADER`: the header your proxy sets to the visitor's IP (see below), and the dashboard reachable only
      through that proxy.
- [ ] `ADMIN_EMAILS`: who gets the admin page.
- [ ] `SIGNUP_MODE` / `SIGNUP_ALLOWED_DOMAINS`: `invite` or `closed` unless strangers should create accounts; admins
      invite or create accounts on the admin page (or with `bun run admin`). `invite` relies on email confirmation to
      prove the address, so keep `EMAIL_VERIFICATION` on with it.
- [ ] Email: `SMTP_URL` or `RESEND_API_KEY`, and `EMAIL_FROM` at a domain with SPF and DKIM. Otherwise
      `EMAIL_VERIFICATION=false`.
- [ ] Postgres and Redis not exposed to the internet (remove their `ports` from `docker-compose.yml` in production).
- [ ] Backups of Postgres; Redis with persistence (below).

## Reverse proxy

Terminate TLS in front of both services, e.g. with [Caddy](https://caddyserver.com), which gets certificates on its
own:

```
dashboard.example.com {
    reverse_proxy localhost:3000
}
api.example.com {
    reverse_proxy localhost:8787
}
```

Caddy sets `X-Forwarded-For`; the default `CLIENT_IP_HEADER=x-forwarded-for` then reads the first address in it. Behind
Cloudflare use `CLIENT_IP_HEADER=cf-connecting-ip` and accept connections only from Cloudflare. If clients can reach
the dashboard around the proxy, they can send any value in that header and slip past the per-IP limits on sign in and
sign up.

Allow long API requests: a serverless inference server can take minutes on a cold start (the gateway waits up to the
upstream's `timeoutMs`, 180 s by default).

## Admin CLI in Docker

The CLI is not in the images; run it from a checkout against the same database:

```bash
DATABASE_URL=postgres://basal:basal@<host>:5432/basal REDIS_URL=redis://<host>:6379 bun run admin users
```

## Backups

Postgres holds everything that matters: accounts, API key hashes and usage.

```bash
docker compose exec -T postgres pg_dump -U basal basal | gzip > basal-$(date +%F).sql.gz   # backup
gunzip -c basal-2026-10-11.sql.gz | docker compose exec -T postgres psql -U basal basal    # restore
```

Redis holds caches, rate-limit counters and the usage queue: successful requests wait there (at most a few seconds)
until the gateway writes them to Postgres. Turn on persistence so a Redis restart does not lose that queue, e.g. in
`docker-compose.yml`: `command: ["redis-server", "--appendonly", "yes"]` with a volume for `/data`. The gateway also
drains the queue when it stops.

## Upgrades

Read the [changelog](../CHANGELOG.md) first: before 1.0, minor versions may change settings.

```bash
git pull
docker compose --profile <profile> up -d --build
```

The gateway applies database migrations when it starts; back up Postgres before upgrading.

## Scaling

One gateway handles many requests (it mostly waits on the inference server). With more than one gateway instance,
`maxInFlight` applies per instance, while rate limits, concurrency per key and account, and daily limits are shared
through Redis.

## Offline installs

The gateway and dashboard work without internet access when every external service is off:

| service | setting |
|---|---|
| breached-password check (haveibeenpwned.com) | `HIBP_ENABLED=false` |
| Cloudflare Turnstile | leave `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` empty |
| GitHub / Google sign in | leave their client IDs empty |
| email | `SMTP_URL` to an internal mail server, or `EMAIL_VERIFICATION=false` |

The dashboard's fonts are bundled at build time. Build the images where internet access is available (or use a
registry mirror), then run them offline. The inference server needs its model weights: basal-rs keeps them in its
`basal-data` volume after the first download.

## Health

`GET /health` on the gateway answers `{"status": "ok", "version": "..."}`; use it for uptime checks and container
health checks.
