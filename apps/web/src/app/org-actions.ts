"use server";

import { randomUUID } from "node:crypto";
import { apiKeys, eq } from "@basal/db";
import { apiKeyCacheKey } from "@basal/shared/keys";
import { APIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth, canManage, myOrganizations, requireOrg } from "@/lib/auth";
import { clientIp } from "@/lib/client-ip";
import { db } from "@/lib/db";
import { hit, tooMany } from "@/lib/rate-limit";
import { redis } from "@/lib/redis";
import type { FormState } from "./actions";

// Organizations through Better Auth's organization plugin, which also enforces who may do what (owners and admins
// manage members and invitations; only owners delete). Personal organizations stay personal: no invitations, no
// leaving, no deleting.

const message = (e: unknown, fallback: string) => (e instanceof APIError && e.message ? e.message : fallback);
const orgName = z.string().trim().min(1, "Name the organization").max(64, "Use at most 64 characters");
const role = z.enum(["member", "admin", "owner"]);

/** The header's organization switcher lives in the dashboard layout, which a redirect alone does not re-render. */
function refreshAndGo(path: string): never {
  revalidatePath("/dashboard", "layout");
  redirect(path);
}

export async function switchOrganization(form: FormData) {
  const { user } = await requireOrg();
  const id = z.string().min(1).parse(form.get("organizationId"));
  if (!(await myOrganizations(user.id)).some((o) => o.id === id)) redirect("/dashboard");
  await auth.api.setActiveOrganization({ body: { organizationId: id }, headers: await headers() });
  refreshAndGo("/dashboard");
}

export async function createOrganization(_: FormState, form: FormData): Promise<FormState> {
  await requireOrg();
  const name = orgName.safeParse(form.get("name"));
  if (!name.success) return { error: name.error.issues[0]?.message, values: { name: String(form.get("name") ?? "") } };
  try {
    // becomes the active organization
    await auth.api.createOrganization({
      body: { name: name.data, slug: `org-${randomUUID().slice(0, 12)}` },
      headers: await headers(),
    });
  } catch (e) {
    return { error: message(e, "We could not create the organization."), values: { name: name.data } };
  }
  refreshAndGo("/dashboard/organization");
}

export async function renameOrganization(_: FormState, form: FormData): Promise<FormState> {
  const { org } = await requireOrg();
  const name = orgName.safeParse(form.get("name"));
  if (!name.success) return { error: name.error.issues[0]?.message };
  try {
    await auth.api.updateOrganization({
      body: { organizationId: org.id, data: { name: name.data } },
      headers: await headers(),
    });
  } catch (e) {
    return { error: message(e, "We could not rename the organization.") };
  }
  revalidatePath("/dashboard", "layout");
  return { notice: "Renamed." };
}

export async function inviteMember(_: FormState, form: FormData): Promise<FormState> {
  const { user, org } = await requireOrg();
  if (org.personal) return { error: "Personal organizations have no other members. Create a shared one." };
  if (!canManage(org)) return { error: "Only owners and admins invite members." };
  const parsed = z
    .object({ email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")), role })
    .safeParse(Object.fromEntries(form));
  const values = { email: String(form.get("email") ?? "") };
  if (!parsed.success) return { error: parsed.error.issues[0]?.message, values };
  const wait = await hit("invite", { ip: await clientIp(), email: user.email });
  if (wait) return { error: tooMany(wait), values };
  try {
    await auth.api.createInvitation({
      body: { email: parsed.data.email, role: parsed.data.role, organizationId: org.id },
      headers: await headers(),
    });
  } catch (e) {
    return { error: message(e, "We could not send the invitation."), values };
  }
  revalidatePath("/dashboard/organization");
  return { notice: `Invitation sent to ${parsed.data.email}.` };
}

export async function cancelInvitation(form: FormData) {
  await requireOrg();
  const invitationId = z.string().min(1).parse(form.get("invitationId"));
  await auth.api.cancelInvitation({ body: { invitationId }, headers: await headers() }).catch(() => undefined);
  revalidatePath("/dashboard/organization");
}

export async function updateMemberRole(form: FormData) {
  const { org } = await requireOrg();
  const parsed = z.object({ memberId: z.string().min(1), role }).parse(Object.fromEntries(form));
  await auth.api
    .updateMemberRole({ body: { ...parsed, organizationId: org.id }, headers: await headers() })
    .catch(() => undefined); // the plugin refuses what the user's role does not allow
  revalidatePath("/dashboard/organization");
}

export async function removeMember(form: FormData) {
  const { org } = await requireOrg();
  const memberId = z.string().min(1).parse(form.get("memberId"));
  await auth.api
    .removeMember({ body: { memberIdOrEmail: memberId, organizationId: org.id }, headers: await headers() })
    .catch(() => undefined);
  revalidatePath("/dashboard/organization");
}

export async function leaveOrganization(_: FormState): Promise<FormState> {
  const { org } = await requireOrg();
  if (org.personal) return { error: "You cannot leave your personal organization." };
  try {
    await auth.api.leaveOrganization({ body: { organizationId: org.id }, headers: await headers() });
  } catch (e) {
    return { error: message(e, "We could not leave the organization.") };
  }
  refreshAndGo("/dashboard");
}

/** Owners only. Its keys stop working at once (cache cleared), its usage is deleted with it. */
export async function deleteOrganization(_: FormState, form: FormData): Promise<FormState> {
  const { org } = await requireOrg();
  if (org.personal) return { error: "Your personal organization goes with your account." };
  if (org.role !== "owner") return { error: "Only owners delete an organization." };
  if (String(form.get("confirm") ?? "").trim() !== org.name) return { error: "Type the organization's name exactly." };
  const keys = await db.select({ hash: apiKeys.hash }).from(apiKeys).where(eq(apiKeys.organizationId, org.id));
  try {
    await auth.api.deleteOrganization({ body: { organizationId: org.id }, headers: await headers() });
  } catch (e) {
    return { error: message(e, "We could not delete the organization.") };
  }
  if (keys.length) await redis.del(...keys.map((k) => apiKeyCacheKey(k.hash)));
  refreshAndGo("/dashboard");
}

export async function acceptInvitation(form: FormData) {
  await requireOrg();
  const invitationId = z.string().min(1).parse(form.get("invitationId"));
  try {
    const res = await auth.api.acceptInvitation({ body: { invitationId }, headers: await headers() });
    const organizationId = res?.invitation?.organizationId;
    if (organizationId) await auth.api.setActiveOrganization({ body: { organizationId }, headers: await headers() });
  } catch {
    redirect(`/invitations/${invitationId}?error=1`);
  }
  refreshAndGo("/dashboard?joined=1");
}

export async function rejectInvitation(form: FormData) {
  await requireOrg();
  const invitationId = z.string().min(1).parse(form.get("invitationId"));
  await auth.api.rejectInvitation({ body: { invitationId }, headers: await headers() }).catch(() => undefined);
  refreshAndGo("/dashboard");
}
