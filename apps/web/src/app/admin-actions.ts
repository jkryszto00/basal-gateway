"use server";

import {
  addUser,
  deleteUser,
  disableUser,
  enableUser,
  inviteToSignUp,
  revokeSignupInvitation,
  setOrgQuota,
  verifyUser,
} from "@basal/admin";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { APP_URL } from "@/lib/app-name";
import { db } from "@/lib/db";
import { signupInvitationEmail, trySendEmail } from "@/lib/email";
import { redis } from "@/lib/redis";
import type { FormState } from "./actions";

// Instance administration from the dashboard: every action checks the caller against ADMIN_EMAILS first.

const ctx = { db, redis };
const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address"));
const failed = (e: unknown) => ({ error: e instanceof Error ? e.message : "That did not work." });
const done = (notice: string): FormState => {
  revalidatePath("/dashboard/admin");
  return { notice };
};

export async function adminCreateUser(_: FormState, form: FormData): Promise<FormState> {
  await requireAdmin();
  const address = email.safeParse(form.get("email"));
  if (!address.success) return { error: address.error.issues[0]?.message };
  const name = String(form.get("name") ?? "").trim() || undefined;
  try {
    const { password } = await addUser(ctx, address.data, { name });
    return done(`Created ${address.data}. Password, shown once: ${password}`);
  } catch (e) {
    return failed(e);
  }
}

export async function adminInvite(_: FormState, form: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const address = email.safeParse(form.get("email"));
  if (!address.success) return { error: address.error.issues[0]?.message };
  try {
    await inviteToSignUp(ctx, address.data, admin.id);
  } catch (e) {
    return failed(e);
  }
  await trySendEmail(
    signupInvitationEmail(address.data, `${APP_URL}/signup?email=${encodeURIComponent(address.data)}`),
  );
  return done(`Invitation sent to ${address.data}.`);
}

export async function adminRevokeInvitation(form: FormData) {
  await requireAdmin();
  await revokeSignupInvitation(ctx, z.uuid().parse(form.get("id")));
  revalidatePath("/dashboard/admin");
}

/** confirm / disable / enable an account */
export async function adminAccount(form: FormData) {
  const admin = await requireAdmin();
  const { action, email: address } = z
    .object({ action: z.enum(["verify", "disable", "enable"]), email })
    .parse(Object.fromEntries(form));
  if (action === "disable" && address === admin.email.toLowerCase()) return; // never lock yourself out
  await { verify: verifyUser, disable: disableUser, enable: enableUser }[action](ctx, address);
  revalidatePath("/dashboard/admin");
}

export async function adminDeleteUser(_: FormState, form: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const address = email.safeParse(form.get("email"));
  if (!address.success) return { error: "No account given" };
  if (address.data === admin.email.toLowerCase()) return { error: "Delete your own account in Settings." };
  if (
    String(form.get("confirm") ?? "")
      .trim()
      .toLowerCase() !== address.data
  )
    return { error: `Type ${address.data} to confirm.` };
  try {
    await deleteUser(ctx, address.data);
  } catch (e) {
    return failed(e);
  }
  return done(`Deleted ${address.data}.`);
}

export async function adminSetQuota(_: FormState, form: FormData): Promise<FormState> {
  await requireAdmin();
  const parsed = z
    .object({
      organizationId: z.string().min(1),
      requests: z.coerce.number().int().nonnegative(),
      tokens: z.coerce.number().int().nonnegative(),
    })
    .safeParse({
      organizationId: form.get("organizationId"),
      requests: form.get("requests") || 0,
      tokens: form.get("tokens") || 0,
    });
  if (!parsed.success) return { error: "Quotas are whole numbers; empty or 0 for the default" };
  try {
    await setOrgQuota(ctx, parsed.data.organizationId, parsed.data);
  } catch (e) {
    return failed(e);
  }
  return done("Quota saved; it applies at once.");
}
