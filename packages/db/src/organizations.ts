import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index";
import { member, organization } from "./schema";

/**
 * Every account owns a personal organization from the start, so API keys and usage always belong to an organization;
 * shared organizations are created on top. Idempotent: returns the existing one.
 */
export async function ensurePersonalOrganization(db: Db, user: { id: string; name: string }): Promise<string> {
  const slug = `personal-${user.id}`;
  const [existing] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug));
  if (existing) return existing.id;
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(organization).values({ id, name: user.name, slug });
    await tx.insert(member).values({ id: randomUUID(), organizationId: id, userId: user.id, role: "owner" });
  });
  return id;
}

export const isPersonalOrganization = (org: { slug: string }) => org.slug.startsWith("personal-");

/** The user's role in the organization, or null when they are not a member. */
export async function memberRole(db: Db, organizationId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)));
  return row?.role ?? null;
}

/**
 * What deleting an account takes along: its personal organization and those it is the only member of (their keys and
 * usage cascade). Shared organizations it is the only owner of block the deletion until another member is an owner.
 */
export async function accountDeletionPlan(
  db: Db,
  userId: string,
): Promise<{ organizationIds: string[]; soleOwnerOf: string[] }> {
  const mine = await db
    .select({ orgId: member.organizationId, role: member.role, slug: organization.slug, name: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId));
  const organizationIds: string[] = [];
  const soleOwnerOf: string[] = [];
  for (const m of mine) {
    const all = await db.select({ role: member.role }).from(member).where(eq(member.organizationId, m.orgId));
    if (isPersonalOrganization(m) || all.length === 1) organizationIds.push(m.orgId);
    else if (m.role === "owner" && all.filter((x) => x.role === "owner").length === 1) soleOwnerOf.push(m.name);
  }
  return { organizationIds, soleOwnerOf };
}
