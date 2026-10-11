# Contributing

Thanks for helping. Bug reports, fixes and features are all welcome; for a larger change, open an issue first so we
can agree on the approach.

## Setup

Requirements: [Bun](https://bun.sh) 1.3+, Node.js 20+, Docker.

```bash
bun install
cp .env.example .env          # set BETTER_AUTH_SECRET (openssl rand -hex 32)
bun run db:up                 # Postgres and Redis
bun run db:migrate
bun run mock                  # mock basal server on :8000, no GPU needed
bun run dev                   # dashboard on :3000, gateway on :8787
```

Without `RESEND_API_KEY` or `SMTP_URL`, confirmation and reset links are printed in the dashboard's log.

## Checks

CI runs these on every pull request; run them before pushing:

```bash
bun run format:check          # bun run format fixes it
bun run typecheck
bun run test                  # needs db:up and db:migrate
```

The browser smoke test covers sign up, keys, password reset and account deletion against a running dashboard:

```bash
cd apps/web && RESEND_API_KEY= bun run dev > /tmp/web.log 2>&1 &
WEB_LOG=/tmp/web.log GATEWAY_URL=http://localhost:8787 bun run e2e
```

## Changes

- One topic per pull request, with tests for behaviour changes.
- Database changes: edit `packages/db/src/schema.ts`, then `bun run db:generate` and commit the migration. Never
  edit a released migration.
- Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
  `docs:`, `refactor:`, `chore:`, `ci:`, with `!` for breaking changes. Pull requests are squash-merged, so the PR
  title becomes the commit on `main`.
- Code comments explain why, not what. Match the style of the surrounding code.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
