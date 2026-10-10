# Dashboard image (Next.js standalone on Node.js). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t basal-gateway-web .
# All settings are read at runtime from the environment, so one image serves any instance.
FROM node:22-bookworm-slim AS build
COPY --from=oven/bun:1.3.14-slim /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/mock/package.json apps/mock/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile --filter @basal/web

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
# placeholders for modules evaluated while Next.js collects page data; no connection is made and nothing of this
# stage's environment reaches the runtime image
RUN cd apps/web && DATABASE_URL=postgres://build:build@localhost:5432/build BETTER_AUTH_SECRET=build-only-placeholder \
    bun run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
