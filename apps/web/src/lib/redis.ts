import "server-only";
import { Redis } from "ioredis";

const g = globalThis as unknown as { __redis?: Redis };
// lazyConnect: connects on the first command, so importing it (e.g. during `next build`) opens no connection
export const redis = (g.__redis ??= new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  lazyConnect: true,
}));
