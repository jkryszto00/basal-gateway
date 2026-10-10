// Runs against Postgres and Redis from docker compose (`bun run db:up && bun run db:migrate`).
import { afterAll, describe, expect, it } from "bun:test";
import { account, apiKeys, createDb, eq, usageEvents, user } from "@basal/db";
import { apiKeyCacheKey, generateApiKey } from "@basal/shared/keys";
import { verifyPassword } from "better-auth/crypto";
import { Redis } from "ioredis";
import { addUser, deleteUser, listKeys, listUsers, revokeKey, usageReport, verifyUser } from "./commands";

const db = createDb(process.env.DATABASE_URL ?? "postgres://basal:basal@localhost:5432/basal");
const redis = new Redis(process.env.REDIS_TEST_URL ?? "redis://localhost:6379/15");
const ctx = { db, redis };
const email = `cli-${crypto.randomUUID()}@example.com`;

afterAll(async () => {
  await db.delete(user).where(eq(user.email, email));
  redis.disconnect();
});

describe("admin commands", () => {
  it("adds a confirmed account whose generated password signs in", async () => {
    const { password } = await addUser(ctx, email.toUpperCase(), { name: "CLI" });
    expect(password?.length).toBeGreaterThanOrEqual(20);
    const [u] = await db.select().from(user).where(eq(user.email, email));
    expect(u).toMatchObject({ name: "CLI", emailVerified: true });
    const [acc] = await db.select().from(account).where(eq(account.userId, u!.id));
    expect(acc?.providerId).toBe("credential");
    expect(await verifyPassword({ hash: acc!.password!, password: password! })).toBe(true);
    expect((await listUsers(ctx)).some((r) => r.email === email)).toBe(true);
  });

  it("refuses a taken address, a short password and a bad address", async () => {
    await expect(addUser(ctx, email)).rejects.toThrow("already has an account");
    await expect(addUser(ctx, `other-${email}`, { password: "short" })).rejects.toThrow("at least 10");
    await expect(addUser(ctx, "not-an-email")).rejects.toThrow("not an email address");
  });

  it("confirms an account and revokes keys at once", async () => {
    const [u] = await db.select().from(user).where(eq(user.email, email));
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, u!.id));
    await verifyUser(ctx, email);
    expect((await db.select().from(user).where(eq(user.id, u!.id)))[0]?.emailVerified).toBe(true);

    const k = generateApiKey();
    const [row] = await db
      .insert(apiKeys)
      .values({ userId: u!.id, name: "cli", hash: k.hash, prefix: k.prefix })
      .returning({ id: apiKeys.id });
    await redis.set(apiKeyCacheKey(k.hash), "{}");
    await revokeKey(ctx, row!.id);
    expect(await redis.exists(apiKeyCacheKey(k.hash))).toBe(0);
    expect((await listKeys(ctx, email))[0]?.revoked).not.toBeNull();
    await expect(revokeKey(ctx, row!.id)).rejects.toThrow("no active key");
  });

  it("reports usage per account and model", async () => {
    const [u] = await db.select().from(user).where(eq(user.email, email));
    const event = { userId: u!.id, model: "basal-1.5", questions: 2, branches: 3, upstreamLatencyMs: 5, totalLatencyMs: 9 };
    await db.insert(usageEvents).values([
      { ...event, id: crypto.randomUUID(), inputTokens: 100 },
      { ...event, id: crypto.randomUUID(), inputTokens: 50 },
    ]);
    const mine = (await usageReport(ctx, 1)).filter((r) => r.email === email);
    expect(mine).toEqual([{ email, model: "basal-1.5", requests: 2, decisions: 4, branches: 6, inputTokens: 150 }]);
  });

  it("deletes an account with its keys and usage, and their cache entries", async () => {
    const [u] = await db.select().from(user).where(eq(user.email, email));
    const k = generateApiKey();
    await db.insert(apiKeys).values({ userId: u!.id, name: "live", hash: k.hash, prefix: k.prefix });
    await redis.set(apiKeyCacheKey(k.hash), "{}");
    await deleteUser(ctx, email);
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
    expect(await db.select().from(usageEvents).where(eq(usageEvents.userId, u!.id))).toHaveLength(0);
    expect(await redis.exists(apiKeyCacheKey(k.hash))).toBe(0);
    await expect(deleteUser(ctx, email)).rejects.toThrow("no account");
  });
});
