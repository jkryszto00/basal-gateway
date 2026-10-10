# Gateway image (Bun). Build from the repository root: docker build -f apps/gateway/Dockerfile -t basal-gateway .
# Applies pending database migrations, then serves the API on :8787.
FROM oven/bun:1.3.14-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/mock/package.json apps/mock/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile --production --filter @basal/gateway

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/gateway apps/gateway

USER bun
EXPOSE 8787
CMD ["sh", "-c", "bun packages/db/src/migrate.ts && exec bun apps/gateway/src/index.ts"]
