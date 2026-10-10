"use server";

import { and, apiKeys, count, eq, isNull } from "@basal/db";
import { apiKeyCacheKey, generateApiKey } from "@basal/shared/keys";
import { APIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { isPasswordCompromised } from "better-auth/plugins";
import { auth, OAUTH_PROVIDERS, type OAuthProvider, PASSWORD_COMPROMISED, requireUser } from "@/lib/auth";
import { clientIp } from "@/lib/client-ip";
import { signInMethods } from "@/lib/data";
import { db } from "@/lib/db";
import { PASSWORD } from "@/lib/password";
import { hit, tooMany } from "@/lib/rate-limit";
import { redis } from "@/lib/redis";
import { verifyTurnstile } from "@/lib/turnstile";

// `values` refills the non-secret fields: React resets a form after its action runs
export type FormState = { error?: string; notice?: string; sent?: string; values?: Record<string, string> } | undefined;

const keep = (form: FormData, ...names: string[]) =>
  Object.fromEntries(names.map((n) => [n, String(form.get(n) ?? "")]));

const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address"));
const password = z
  .string()
  .min(PASSWORD.min, `Use at least ${PASSWORD.min} characters`)
  .max(PASSWORD.max, `Use at most ${PASSWORD.max} characters`);

const codeOf = (e: APIError) => (e.body as { code?: string } | undefined)?.code;

/** Message for a new password Better Auth refused (haveibeenpwned plugin), or null for other errors. */
function passwordProblem(e: APIError): string | null {
  if (codeOf(e) === "PASSWORD_COMPROMISED") return PASSWORD_COMPROMISED;
  if (e.status === "INTERNAL_SERVER_ERROR") return "We could not check the password right now. Try again in a moment.";
  return null;
}

// The verification link lands on /verify, which signs the user in or explains an expired link.
const VERIFY_CALLBACK = "/verify";

export async function signUp(_: FormState, form: FormData): Promise<FormState> {
  const parsed = z
    .object({ name: z.string().trim().min(1, "Enter your name").max(64, "Use at most 64 characters"), email, password })
    .safeParse(Object.fromEntries(form));
  const values = keep(form, "name", "email");
  if (!parsed.success) return { error: parsed.error.issues[0]?.message, values };
  const ip = await clientIp();
  const wait = await hit("signUp", { ip });
  if (wait) return { error: tooMany(wait), values };
  if (!(await verifyTurnstile(form.get("cf-turnstile-response"), ip)))
    return { error: "We could not verify that you are human. Complete the check and try again.", values };
  try {
    // with requireEmailVerification Better Auth answers the same for a new and a taken email: no account enumeration
    await auth.api.signUpEmail({ body: { ...parsed.data, callbackURL: VERIFY_CALLBACK }, headers: await headers() });
  } catch (e) {
    if (e instanceof APIError)
      return { error: passwordProblem(e) ?? "We could not create the account. Try again in a moment.", values };
    throw e;
  }
  return { sent: parsed.data.email };
}

export async function signIn(_: FormState, form: FormData): Promise<FormState> {
  const parsed = z.object({ email, password: z.string().min(1, "Enter your password") }).safeParse(Object.fromEntries(form));
  const values = keep(form, "email");
  if (!parsed.success) return { error: parsed.error.issues[0]?.message, values };
  const wait = await hit("signIn", { ip: await clientIp(), email: parsed.data.email });
  if (wait) return { error: tooMany(wait), values };
  try {
    await auth.api.signInEmail({ body: { ...parsed.data, callbackURL: VERIFY_CALLBACK }, headers: await headers() });
  } catch (e) {
    if (!(e instanceof APIError)) throw e;
    // only reachable with the right password, so it does not reveal that the account exists
    if (codeOf(e) === "EMAIL_NOT_VERIFIED")
      return { error: `Confirm your email first. We sent a new link to ${parsed.data.email}.`, values };
    return { error: "Wrong email or password.", values };
  }
  redirect("/dashboard");
}

/** Starts GitHub / Google sign in; new accounts are created on the way back (/api/auth/callback/<provider>). */
export async function signInWith(provider: OAuthProvider) {
  if (!OAUTH_PROVIDERS.includes(provider)) redirect("/login");
  if (await hit("oauth", { ip: await clientIp() })) redirect("/login?error=rate_limited");
  const { url } = await auth.api.signInSocial({
    body: { provider, callbackURL: "/dashboard", newUserCallbackURL: "/dashboard?welcome=1", errorCallbackURL: "/login" },
    headers: await headers(),
  });
  if (!url) redirect("/login?error=oauth");
  redirect(url);
}

export async function resendVerification(_: FormState, form: FormData): Promise<FormState> {
  const parsed = email.safeParse(form.get("email"));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message, values: keep(form, "email") };
  const wait = await hit("resendVerification", { ip: await clientIp(), email: parsed.data });
  if (wait) return { error: tooMany(wait), values: keep(form, "email") };
  // answers the same whether or not the address has an unconfirmed account
  await auth.api.sendVerificationEmail({ body: { email: parsed.data, callbackURL: VERIFY_CALLBACK }, headers: await headers() });
  return { notice: `If ${parsed.data} is waiting for confirmation, a new link is on its way.` };
}

export async function requestPasswordReset(_: FormState, form: FormData): Promise<FormState> {
  const parsed = email.safeParse(form.get("email"));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message, values: keep(form, "email") };
  const wait = await hit("passwordReset", { ip: await clientIp(), email: parsed.data });
  if (wait) return { error: tooMany(wait), values: keep(form, "email") };
  // answers the same whether or not the account exists
  await auth.api.requestPasswordReset({ body: { email: parsed.data, redirectTo: "/reset-password" }, headers: await headers() });
  return { notice: `If an account exists for ${parsed.data}, we sent it a link to choose a new password. The link expires in 1 hour.` };
}

export async function resetPassword(_: FormState, form: FormData): Promise<FormState> {
  const parsed = z
    .object({ token: z.string().min(1), password, confirm: z.string() })
    .refine((d) => d.password === d.confirm, { message: "The passwords do not match", path: ["confirm"] })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const wait = await hit("resetPassword", { ip: await clientIp() });
  if (wait) return { error: tooMany(wait) };
  try {
    // checked here too: Better Auth uses up the token before hashing, so a refused password would burn the link
    if (await isPasswordCompromised(parsed.data.password)) return { error: PASSWORD_COMPROMISED };
    await auth.api.resetPassword({ body: { token: parsed.data.token, newPassword: parsed.data.password }, headers: await headers() });
  } catch (e) {
    if (!(e instanceof APIError)) throw e;
    return { error: passwordProblem(e) ?? "This link has expired or was already used. Ask for a new one." };
  }
  redirect("/login?reset=1");
}

export async function signOut() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/");
}

const newPassword = z
  .object({ password, confirm: z.string() })
  .refine((d) => d.password === d.confirm, { message: "The new passwords do not match", path: ["confirm"] });

export async function changePassword(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = z
    .object({ current: z.string().min(1, "Enter your current password") })
    .and(newPassword)
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const wait = await hit("changePassword", { ip: await clientIp(), email: user.email });
  if (wait) return { error: tooMany(wait) };
  try {
    await auth.api.changePassword({
      body: { currentPassword: parsed.data.current, newPassword: parsed.data.password, revokeOtherSessions: true },
      headers: await headers(),
    });
  } catch (e) {
    if (!(e instanceof APIError)) throw e;
    if (codeOf(e) === "INVALID_PASSWORD") return { error: "Your current password is wrong." };
    return { error: passwordProblem(e) ?? "We could not change the password. Try again in a moment." };
  }
  return { notice: "Password changed. Your other devices were signed out." };
}

/** Accounts created with GitHub or Google have no password until they set one. */
export async function setPassword(_: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const parsed = newPassword.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  try {
    if (await isPasswordCompromised(parsed.data.password)) return { error: PASSWORD_COMPROMISED };
    await auth.api.setPassword({ body: { newPassword: parsed.data.password }, headers: await headers() });
  } catch (e) {
    if (!(e instanceof APIError)) throw e;
    return { error: passwordProblem(e) ?? "We could not set the password. Try again in a moment." };
  }
  revalidatePath("/dashboard/settings");
  return { notice: "Password set. You can also sign in with your email and this password." };
}

export async function deleteAccount(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const confirm = String(form.get("confirm") ?? "").trim().toLowerCase();
  const pw = form.get("password");
  if (confirm !== user.email.toLowerCase()) return { error: "Type your email address exactly to confirm." };
  if ((await signInMethods()).includes("credential") && !(typeof pw === "string" && pw)) return { error: "Enter your password." };
  const wait = await hit("deleteAccount", { ip: await clientIp(), email: user.email });
  if (wait) return { error: tooMany(wait) };
  try {
    // with a password Better Auth checks it; without one (GitHub / Google accounts) the session must be recent
    await auth.api.deleteUser({ body: typeof pw === "string" && pw ? { password: pw } : {}, headers: await headers() });
  } catch (e) {
    if (!(e instanceof APIError)) throw e;
    if (codeOf(e) === "INVALID_PASSWORD") return { error: "Wrong password." };
    if (codeOf(e) === "SESSION_EXPIRED")
      return { error: "For your security, sign out and sign in again, then delete the account." };
    return { error: "We could not delete the account. Try again in a moment." };
  }
  redirect("/login?deleted=1");
}

const MAX_ACTIVE_KEYS = 10;

export type CreateKeyState = { error?: string; key?: string; name?: string } | undefined;

export async function createKey(_: CreateKeyState, form: FormData): Promise<CreateKeyState> {
  const user = await requireUser();
  const name = z.string().trim().min(1).max(64).safeParse(form.get("name"));
  if (!name.success) return { error: "Name the key (1–64 characters)" };

  const [active] = await db
    .select({ n: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)));
  if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS) return { error: `At most ${MAX_ACTIVE_KEYS} active keys` };

  const k = generateApiKey();
  await db.insert(apiKeys).values({ userId: user.id, name: name.data, hash: k.hash, prefix: k.prefix });
  revalidatePath("/dashboard/keys");
  return { key: k.key, name: name.data }; // shown once, never stored
}

export async function revokeKey(form: FormData) {
  const user = await requireUser();
  const id = z.uuid().parse(form.get("id"));
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)))
    .returning({ hash: apiKeys.hash });
  if (row) await redis.del(apiKeyCacheKey(row.hash)); // the gateway stops accepting it immediately
  revalidatePath("/dashboard/keys");
}
