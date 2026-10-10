import Link from "next/link";
import { signUp } from "@/app/actions";
import { AuthForm } from "@/components/auth-form";
import { OAuthButtons } from "@/components/oauth-buttons";
import { OAUTH_PROVIDERS } from "@/lib/auth";
import { SIGNUP_DOMAINS, SIGNUP_OPEN } from "@/lib/signup";
import { TURNSTILE_SITE_KEY } from "@/lib/turnstile";

export default function SignupPage() {
  if (!SIGNUP_OPEN)
    return (
      <>
        <h1 className="text-lg font-semibold">Sign up is closed</h1>
        <p className="mb-6 mt-1 text-sm text-muted">Ask an administrator of this instance for an account.</p>
        <Link href="/login" className="text-sm text-fg underline underline-offset-4">
          Sign in
        </Link>
      </>
    );
  return (
    <>
      <h1 className="text-lg font-semibold">Create an account</h1>
      <p className="mb-6 mt-1 text-sm text-muted">
        {SIGNUP_DOMAINS.length ? `For addresses at ${SIGNUP_DOMAINS.join(", ")}. ` : ""}You will get API keys once you
        confirm your email.
      </p>
      <AuthForm
        mode="signup"
        oauth={<OAuthButtons providers={OAUTH_PROVIDERS} />}
        action={signUp}
        turnstileSiteKey={TURNSTILE_SITE_KEY}
      />
    </>
  );
}
