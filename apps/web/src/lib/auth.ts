import "server-only";
import { apiKeys, eq, schema } from "@basal/db";
import { apiKeyCacheKey } from "@basal/shared/keys";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned } from "better-auth/plugins";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { resetPasswordEmail, trySendEmail, verificationEmail } from "./email";
import { PASSWORD } from "./password";
import { redis } from "./redis";

// GitHub and Google sign in, each enabled when its OAuth app is configured. Callback URLs to register with them:
// <BETTER_AUTH_URL>/api/auth/callback/github and <BETTER_AUTH_URL>/api/auth/callback/google
const env = process.env;
const socialProviders = {
  ...(env.GITHUB_CLIENT_ID &&
    env.GITHUB_CLIENT_SECRET && {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        requireEmailVerification: true,
      },
    }),
  ...(env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET && {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account" as const,
        requireEmailVerification: true,
      },
    }),
};
export const PASSWORD_COMPROMISED =
  "This password appeared in a data breach (haveibeenpwned.com). Choose a different one.";

export type OAuthProvider = "github" | "google";
export const OAUTH_PROVIDERS = Object.keys(socialProviders) as OAuthProvider[];

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: PASSWORD.min,
    maxPasswordLength: PASSWORD.max,
    // no session until the email is confirmed; sign up then answers the same for new and taken emails
    requireEmailVerification: true,
    sendResetPassword: ({ user, url }) => trySendEmail(resetPasswordEmail(user.email, url)),
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true, // a correct password on an unconfirmed account sends a fresh link
    expiresIn: 24 * 60 * 60,
    autoSignInAfterVerification: true,
    sendVerificationEmail: ({ user, url }) => trySendEmail(verificationEmail(user.email, url)),
  },
  // A provider's verified email signs into the account with that email only if it is confirmed here too
  // (requireLocalEmailVerified, the default): registering someone's address first cannot capture their account.
  socialProviders,
  user: {
    deleteUser: {
      enabled: true,
      // Postgres cascades keys and usage; the gateway's Redis cache would keep the keys working for up to a minute,
      // so it goes first
      beforeDelete: async (user) => {
        const keys = await db.select({ hash: apiKeys.hash }).from(apiKeys).where(eq(apiKeys.userId, user.id));
        if (keys.length) await redis.del(...keys.map((k) => apiKeyCacheKey(k.hash)));
      },
    },
  },
  // failures before the callback URL is known (forged or expired OAuth state) land on the login page, not Better
  // Auth's own error page
  onAPIError: { errorURL: "/login" },
  plugins: [
    // refuses new passwords found in breaches (k-anonymity: only 5 hex chars of the SHA-1 leave the server); fails
    // closed when the service is down. setPassword has no path, so its action checks itself.
    haveIBeenPwned({
      paths: ["/sign-up/email", "/change-password", "/reset-password"],
      customPasswordCompromisedMessage: PASSWORD_COMPROMISED,
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
