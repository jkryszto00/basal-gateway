# Security

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: **Security → Report a vulnerability** on this
repository. Include what is affected, how to reproduce it, and the impact you expect.

You will get an answer within a week. Once a fix is released, the advisory is published and you are credited unless
you prefer otherwise.

## Supported versions

Until 1.0, only the latest release gets security fixes.

## Scope

In scope: the gateway (`apps/gateway`), the dashboard (`apps/web`), the admin CLI and the Docker images. Inference
servers (basal-rs, basal-serve) are separate projects; report their issues to them.

## Hardening notes for operators

See [docs/deployment.md](docs/deployment.md): TLS, `CLIENT_IP_HEADER` behind a proxy, closed sign up, secrets and
backups.
