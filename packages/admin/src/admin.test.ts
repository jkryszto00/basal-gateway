// Runs against Postgres and Redis from docker compose (`bun run db:up && bun run db:migrate`).
import { afterAll, describe, expect, it } from "bun:test";
import {
  account,
  apiKeys,
  createDb,
  eq,
  member,
  organization,
  session,
  signupInvitations,
  sql,
  usageEvents,
  user,
} from "@basal/db";
import { apiKeyCacheKey, generateApiKey } from "@basal/shared/keys";
import { verifyPassword } from "better-auth/crypto";
import { Redis } from "ioredis";
import {
  addMember,
  addUser,
  deleteUser,
  disableUser,
  enableUser,
  hasPendingInvitation,
  inviteToSignUp,
  listSignupInvitations,
  revokeSignupInvitation,
  listKeys,
  listOrgs,
  listUsers,
  revokeKey,
  setOrgQuota,
  usageReport,
  verifyUser,
} from "./index";

const db = createDb(process.env.DATABASE_URL ?? "postgres://basal:basal@localhost:5432/basal");
const redis = new Redis(process.env.REDIS_TEST_URL ?? "redis://localhost:6379/15");
const ctx = { db, redis };
const run = crypto.randomUUID().slice(0, 8);
const email = `cli-${run}@example.com`;
const other = `cli-other-${run}@example.com`;
const teamSlug = `team-${run}`;

const userId = async (address: string) => (await db.select().from(user).where(eq(user.email, address)))[0]!.id;
const personalOrg = async (address: string) =>
  (
    await db
      .select()
      .from(organization)
      .where(eq(organization.slug, `personal-${await userId(address)}`))
  )[0]!;

afterAll(async () => {
  await db.delete(signupInvitations).where(sql`${signupInvitations.email} like ${`%${run}@example.com`}`);
  await db.delete(organization).where(eq(organization.slug, teamSlug));
  for (const address of [email, other]) {
    const [u] = await db.select().from(user).where(eq(user.email, address));
    if (u) await db.delete(organization).where(eq(organization.slug, `personal-${u.id}`));
    await db.delete(user).where(eq(user.email, address));
  }
  redis.disconnect();
});

describe("admin commands", () => {
  it("adds a confirmed account with its personal organization and a password that signs in", async () => {
    const { password } = await addUser(ctx, email.toUpperCase(), { name: "CLI" });
    expect(password?.length).toBeGreaterThanOrEqual(20);
    const [u] = await db.select().from(user).where(eq(user.email, email));
    expect(u).toMatchObject({ name: "CLI", emailVerified: true });
    const [acc] = await db.select().from(account).where(eq(account.userId, u!.id));
    expect(await verifyPassword({ hash: acc!.password!, password: password! })).toBe(true);
    const org = await personalOrg(email);
    const [m] = await db.select().from(member).where(eq(member.organizationId, org.id));
    expect(m).toMatchObject({ userId: u!.id, role: "owner" });
    expect((await listUsers(ctx)).find((r) => r.email === email)).toMatchObject({ organizations: 1 });
  });

  it("refuses a taken address, a short password and a bad address", async () => {
    await expect(addUser(ctx, email)).rejects.toThrow("already has an account");
    await expect(addUser(ctx, `x-${email}`, { password: "short" })).rejects.toThrow("at least 10");
    await expect(addUser(ctx, "not-an-email")).rejects.toThrow("not an email address");
  });

  it("confirms an account", async () => {
    await db.update(user).set({ emailVerified: false }).where(eq(user.email, email));
    await verifyUser(ctx, email);
    expect((await db.select().from(user).where(eq(user.email, email)))[0]?.emailVerified).toBe(true);
  });

  it("adds members to shared organizations only", async () => {
    await addUser(ctx, other, { name: "Other" });
    await db.insert(organization).values({ id: crypto.randomUUID(), name: "Team", slug: teamSlug });
    await addMember(ctx, teamSlug, email, "owner");
    await addMember(ctx, teamSlug, other);
    await expect(addMember(ctx, teamSlug, other)).rejects.toThrow("already a member");
    await expect(addMember(ctx, (await personalOrg(email)).slug, other)).rejects.toThrow("personal");
    await expect(addMember(ctx, teamSlug, other, "boss")).rejects.toThrow("role");
    expect((await listOrgs(ctx)).find((o) => o.slug === teamSlug)).toMatchObject({ members: 2, personal: false });
  });

  it("lists and revokes an organization's keys at once", async () => {
    const team = (await db.select().from(organization).where(eq(organization.slug, teamSlug)))[0]!;
    const k = generateApiKey();
    const [row] = await db
      .insert(apiKeys)
      .values({ organizationId: team.id, createdBy: await userId(other), name: "cli", hash: k.hash, prefix: k.prefix })
      .returning({ id: apiKeys.id });
    await redis.set(apiKeyCacheKey(k.hash), "{}");
    expect((await listKeys(ctx, teamSlug))[0]).toMatchObject({ name: "cli", createdBy: other, revoked: null });
    await revokeKey(ctx, row!.id);
    expect(await redis.exists(apiKeyCacheKey(k.hash))).toBe(0);
    await expect(revokeKey(ctx, row!.id)).rejects.toThrow("no active key");
  });

  it("reports usage per organization and model", async () => {
    const team = (await db.select().from(organization).where(eq(organization.slug, teamSlug)))[0]!;
    const event = {
      organizationId: team.id,
      model: "basal-1.5",
      questions: 2,
      branches: 3,
      upstreamLatencyMs: 5,
      totalLatencyMs: 9,
    };
    await db.insert(usageEvents).values([
      { ...event, id: crypto.randomUUID(), inputTokens: 100 },
      { ...event, id: crypto.randomUUID(), inputTokens: 50 },
    ]);
    const mine = (await usageReport(ctx, 1)).filter((r) => r.organization === teamSlug);
    expect(mine).toEqual([
      {
        organization: teamSlug,
        name: "Team",
        model: "basal-1.5",
        requests: 2,
        decisions: 4,
        branches: 6,
        inputTokens: 150,
      },
    ]);
    expect((await listOrgs(ctx)).find((o) => o.slug === teamSlug)?.lastRequest).toBeInstanceOf(Date);
  });

  it("sets and clears an organization's monthly quota, clearing its key cache", async () => {
    const team = (await db.select().from(organization).where(eq(organization.slug, teamSlug)))[0]!;
    const k = generateApiKey();
    await db.insert(apiKeys).values({ organizationId: team.id, name: "q", hash: k.hash, prefix: k.prefix });
    await redis.set(apiKeyCacheKey(k.hash), "{}");
    expect(await setOrgQuota(ctx, teamSlug, { requests: 1000, tokens: 50_000 })).toEqual({
      requests: 1000,
      tokens: 50_000,
    });
    expect(await redis.exists(apiKeyCacheKey(k.hash))).toBe(0);
    expect(await setOrgQuota(ctx, teamSlug, { requests: 0 })).toEqual({ requests: null, tokens: 50_000 }); // 0 clears
    expect((await listOrgs(ctx)).find((o) => o.slug === teamSlug)).toMatchObject({ monthlyTokens: 50_000 });
    await expect(setOrgQuota(ctx, teamSlug, { tokens: -1 })).rejects.toThrow("whole numbers");
  });

  it("refuses to delete the only owner of a shared organization, then deletes with personal organization", async () => {
    await expect(deleteUser(ctx, email)).rejects.toThrow("only owner of Team");
    const team = (await db.select().from(organization).where(eq(organization.slug, teamSlug)))[0]!;
    await db.update(member).set({ role: "owner" }).where(eq(member.organizationId, team.id)); // other is owner too
    const personal = await personalOrg(email);
    const k = generateApiKey();
    await db.insert(apiKeys).values({ organizationId: personal.id, name: "p", hash: k.hash, prefix: k.prefix });
    await redis.set(apiKeyCacheKey(k.hash), "{}");
    await deleteUser(ctx, email);
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
    expect(await db.select().from(organization).where(eq(organization.id, personal.id))).toHaveLength(0);
    expect(await db.select().from(organization).where(eq(organization.id, team.id))).toHaveLength(1); // shared stays
    expect(await redis.exists(apiKeyCacheKey(k.hash))).toBe(0);
    await expect(deleteUser(ctx, email)).rejects.toThrow("no account");
  });
});

describe("sign up invitations and disabled accounts", () => {
  const invited = `invited-${run}@example.com`;

  it("invites an address once, counts it as pending, and refuses addresses with an account", async () => {
    await inviteToSignUp(ctx, invited.toUpperCase());
    await inviteToSignUp(ctx, invited); // replaces the pending one
    expect((await listSignupInvitations(ctx)).filter((i) => i.email === invited)).toHaveLength(1);
    expect(await hasPendingInvitation(db, invited)).toBe(true);
    expect(await hasPendingInvitation(db, `nobody-${run}@example.com`)).toBe(false);
    await expect(inviteToSignUp(ctx, other)).rejects.toThrow("already has an account");
  });

  it("uses up the invitation when the account is created", async () => {
    await addUser(ctx, invited);
    expect(await hasPendingInvitation(db, invited)).toBe(false);
    const [inv] = await listSignupInvitations(ctx).then((l) => l.filter((i) => i.email === invited));
    expect(inv).toBeUndefined();
  });

  it("revokes an invitation", async () => {
    const i = await inviteToSignUp(ctx, `revoked-${run}@example.com`);
    await revokeSignupInvitation(ctx, i.id);
    expect(await hasPendingInvitation(db, `revoked-${run}@example.com`)).toBe(false);
  });

  it("disables an account, ending its sessions, and enables it again", async () => {
    const id = await userId(invited);
    await db.insert(session).values({
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      userId: id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await disableUser(ctx, invited);
    expect((await db.select().from(user).where(eq(user.id, id)))[0]?.disabledAt).not.toBeNull();
    expect(await db.select().from(session).where(eq(session.userId, id))).toHaveLength(0);
    expect((await listUsers(ctx)).find((u) => u.email === invited)?.disabled).not.toBeNull();
    await enableUser(ctx, invited);
    expect((await db.select().from(user).where(eq(user.id, id)))[0]?.disabledAt).toBeNull();
    await deleteUser(ctx, invited);
  });
});
