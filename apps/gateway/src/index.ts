import { createDb } from "@basal/db";
import { Redis } from "ioredis";
import { createApp } from "./app";
import { UsageFlusher } from "./billing";
import { loadEnv } from "./env";
import { createUpstreams } from "./upstream";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL);
const upstreams = createUpstreams(env.UPSTREAMS);
const flusher = new UsageFlusher(db, redis);
flusher.start();

const userLimits = {
  rpm: env.USER_RPM_LIMIT,
  concurrency: env.USER_CONCURRENCY_LIMIT,
  dailyRequests: env.USER_DAILY_REQUESTS,
};
const app = createApp({
  db,
  redis,
  upstreams,
  userLimits,
  requireCredits: env.CREDITS_ENABLED,
  defaultModel: env.DEFAULT_MODEL,
});
const server = Bun.serve({ fetch: app.fetch, port: env.GATEWAY_PORT });
console.log(`gateway on :${server.port}, models: ${[...upstreams.keys()].join(", ")} (default ${env.DEFAULT_MODEL})`);

async function shutdown() {
  await server.stop();
  await flusher.stop(); // write queued usage before exiting
  redis.disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
