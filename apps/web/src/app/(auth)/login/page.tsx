import { signIn } from "@/app/actions";
import { AuthForm, FormMessage } from "@/components/auth-form";
import { OAuthButtons } from "@/components/oauth-buttons";
import { OAUTH_PROVIDERS } from "@/lib/auth";

const NOTICES: Record<string, string> = {
  reset: "Your password was changed and other sessions were signed out. Sign in with the new password.",
  verified: "Your email is confirmed. Sign in to continue.",
  deleted: "Your account and its API keys, credits and usage history were deleted.",
};

// ?error= from a GitHub / Google round trip (Better Auth's codes) or from signInWith
const ERRORS: Record<string, string> = {
  account_not_linked:
    "An account with this email exists but is not confirmed yet. Confirm it with the link we emailed you, or sign in with your password.",
  email_not_verified: "Confirm your email first: we sent a link to the address of that account.",
  email_not_found: "We could not read a verified email address from that account.",
  access_denied: "Sign in was cancelled.",
  rate_limited: "Too many attempts. Try again in a few minutes.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const notice = Object.keys(NOTICES).find((k) => params[k] !== undefined);
  const error =
    typeof params.error === "string"
      ? (ERRORS[params.error] ?? "We could not sign you in with that account. Try again.")
      : null;
  return (
    <>
      <h1 className="mb-6 text-lg font-semibold">Sign in</h1>
      {(notice || error) && (
        <div className="mb-4">
          <FormMessage state={error ? { error } : { notice: NOTICES[notice!] }} />
        </div>
      )}
      <AuthForm mode="login" oauth={<OAuthButtons providers={OAUTH_PROVIDERS} />} action={signIn} />
    </>
  );
}
