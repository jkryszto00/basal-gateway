import "server-only";
import { Redis } from "ioredis";

const g = globalThis as unknown as { __redis?: Redis };
export const redis = (g.__redis ??= new Redis(process.env.REDIS_URL ?? "redis://localhost:6379"));
