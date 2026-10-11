import "server-only";
import {
  accountDeletionPlan,
  and,
  apiKeys,
  ensurePersonalOrganization,
  eq,
  inArray,
  isPersonalOrganization,
  member,
  organization,
  schema,
} from "@basal/db";
import { apiKeyCacheKey } from "@basal/shared/keys";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned, isPasswordCompromised, organization as organizations } from "better-auth/plugins";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { EMAIL_VERIFICATION, invitationEmail, resetPasswordEmail, trySendEmail, verificationEmail } from "./email";
import { PASSWORD } from "./password";
import { redis } from "./redis";
import { SIGNUP_OPEN, signupAllowed } from "./signup";

// GitHub and Google sign in, each enabled when its OAuth app is configured. Callback URLs to register with them:
// <BETTER_AUTH_URL>/api/auth/callback/github and <BETTER_AUTH_URL>/api/auth/callback/google
const env = process.env;
const socialProviders = {
  ...(env.GITHUB_CLIENT_ID &&
    env.GITHUB_CLIENT_SECRET && {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        requireEmailVerification: EMAIL_VERIFICATION,
        disableSignUp: !SIGNUP_OPEN, // existing accounts can still sign in
      },
    }),
  ...(env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET && {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account" as const,
        requireEmailVerification: EMAIL_VERIFICATION,
        disableSignUp: !SIGNUP_OPEN,
      },
    }),
};
export const PASSWORD_COMPROMISED =
  "This password appeared in a data breach (haveibeenpwned.com). Choose a different one.";

/** Breached-password check against haveibeenpwned.com; HIBP_ENABLED=false for installs without internet access. */
export const HIBP_ENABLED = !["false", "0", "no", "off"].includes((process.env.HIBP_ENABLED ?? "true").toLowerCase());

/** For the actions that set a password outside the plugin's paths (reset, set password); false when the check is off. */
export async function passwordBreached(password: string): Promise<boolean> {
  return HIBP_ENABLED && (await isPasswordCompromised(password));
}

export type OAuthProvider = "github" | "google";
export const OAUTH_PROVIDERS = Object.keys(socialProviders) as OAuthProvider[];

// public URL of the dashboard, for links in emails
const APP_URL = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: PASSWORD.min,
    maxPasswordLength: PASSWORD.max,
    // no session until the email is confirmed; sign up then answers the same for new and taken emails
    requireEmailVerification: EMAIL_VERIFICATION,
    sendResetPassword: ({ user, url }) => trySendEmail(resetPasswordEmail(user.email, url)),
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: {
    sendOnSignUp: EMAIL_VERIFICATION,
    sendOnSignIn: EMAIL_VERIFICATION, // a correct password on an unconfirmed account sends a fresh link
    expiresIn: 24 * 60 * 60,
    autoSignInAfterVerification: true,
    sendVerificationEmail: ({ user, url }) => trySendEmail(verificationEmail(user.email, url)),
  },
  // A provider's verified email signs into the account with that email only if it is confirmed here too
  // (requireLocalEmailVerified, the default): registering someone's address first cannot capture their account.
  socialProviders,
  databaseHooks: {
    user: {
      create: {
        // every way in (email, GitHub, Google) creates the user here; the admin CLI writes to the database directly
        before: async (user) => {
          if (!signupAllowed(user.email))
            throw new APIError("FORBIDDEN", { code: "SIGNUP_NOT_ALLOWED", message: "Sign up is not allowed" });
        },
        // API keys and usage belong to organizations: everyone starts with a personal one
        after: async (user) => {
          await ensurePersonalOrganization(db, user);
        },
      },
    },
    session: {
      create: {
        // a new session opens on the user's personal organization
        before: async (session) => {
          if (session.activeOrganizationId) return;
          const [u] = await db
            .select({ id: schema.user.id, name: schema.user.name })
            .from(schema.user)
            .where(eq(schema.user.id, session.userId));
          if (!u) return;
          return { data: { ...session, activeOrganizationId: await ensurePersonalOrganization(db, u) } };
        },
      },
    },
  },
  user: {
    deleteUser: {
      enabled: true,
      // The account's organizations: personal ones and those it is alone in go with it (keys and usage cascade);
      // a shared organization it is the only owner of has to get another owner first. The gateway's Redis cache
      // would keep deleted keys working for up to a minute, so it goes first.
      beforeDelete: async (user) => {
        const plan = await accountDeletionPlan(db, user.id);
        if (plan.soleOwnerOf.length)
          throw new APIError("BAD_REQUEST", {
            code: "SOLE_OWNER",
            message: `Make another member an owner of ${plan.soleOwnerOf.join(", ")} first`,
          });
        if (!plan.organizationIds.length) return;
        const keys = await db
          .select({ hash: apiKeys.hash })
          .from(apiKeys)
          .where(inArray(apiKeys.organizationId, plan.organizationIds));
        if (keys.length) await redis.del(...keys.map((k) => apiKeyCacheKey(k.hash)));
        await db.delete(organization).where(inArray(organization.id, plan.organizationIds));
      },
    },
  },
  // failures before the callback URL is known (forged or expired OAuth state) land on the login page, not Better
  // Auth's own error page
  onAPIError: { errorURL: "/login" },
  plugins: [
    // refuses new passwords found in breaches (k-anonymity: only 5 hex chars of the SHA-1 leave the server); fails
    // closed when the service is down. setPassword has no path, so its action checks itself.
    ...(HIBP_ENABLED
      ? [
          haveIBeenPwned({
            paths: ["/sign-up/email", "/change-password", "/reset-password"],
            customPasswordCompromisedMessage: PASSWORD_COMPROMISED,
          }),
        ]
      : []),
    organizations({
      creatorRole: "owner",
      invitationExpiresIn: 7 * 24 * 60 * 60,
      cancelPendingInvitationsOnReInvite: true,
      sendInvitationEmail: ({ email, id }) => trySendEmail(invitationEmail(email, `${APP_URL}/invitations/${id}`)),
    }),
    nextCookies(), // lets server actions set the session cookie; stays last
  ],
});

export type CurrentUser = { id: string; name: string; email: string };

/**
 * Request headers with the cookies as they are now: after a server action replaced the session cookie (password
 * change revokes the old session), the re-render of the same request must see the new one, not the request's.
 */
async function sessionHeaders() {
  const h = new Headers(await headers());
  h.set("cookie", (await cookies()).toString());
  return h;
}

/** Data access layer entry point: every page and action that touches user data calls this first. */
export async function requireUser(): Promise<CurrentUser> {
  const session = await auth.api.getSession({ headers: await sessionHeaders() });
  if (!session) redirect("/login");
  return { id: session.user.id, name: session.user.name, email: session.user.email };
}

export async function getOptionalUser(): Promise<CurrentUser | null> {
  const session = await auth.api.getSession({ headers: await sessionHeaders() });
  return session ? { id: session.user.id, name: session.user.name, email: session.user.email } : null;
}

export type ActiveOrg = { id: string; name: string; slug: string; role: string; personal: boolean };

async function membership(organizationId: string, userId: string): Promise<ActiveOrg | null> {
  const [row] = await db
    .select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)));
  return row ? { ...row, personal: isPersonalOrganization(row) } : null;
}

/**
 * The organization the dashboard works on: the session's active one while the user still belongs to it, else their
 * personal one. Every page and action that touches keys or usage goes through this.
 */
export async function requireOrg(): Promise<{ user: CurrentUser; org: ActiveOrg }> {
  const session = await auth.api.getSession({ headers: await sessionHeaders() });
  if (!session) redirect("/login");
  const user = { id: session.user.id, name: session.user.name, email: session.user.email };
  const activeId = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
  const active = activeId ? await membership(activeId, user.id) : null;
  if (active) return { user, org: active };
  const personal = await membership(await ensurePersonalOrganization(db, user), user.id);
  return { user, org: personal! };
}

export const canManage = (org: ActiveOrg) => org.role === "owner" || org.role === "admin";

/** The user's organizations, personal first. */
export async function myOrganizations(userId: string): Promise<ActiveOrg[]> {
  const rows = await db
    .select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(organization.createdAt);
  return rows
    .map((r) => ({ ...r, personal: isPersonalOrganization(r) }))
    .sort((a, b) => Number(b.personal) - Number(a.personal));
}
