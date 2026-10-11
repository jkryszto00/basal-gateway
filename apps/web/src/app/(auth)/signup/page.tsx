import Link from "next/link";
import { signUp } from "@/app/actions";
import { AuthForm } from "@/components/auth-form";
import { OAuthButtons } from "@/components/oauth-buttons";
import { OAUTH_PROVIDERS } from "@/lib/auth";
import { EMAIL_VERIFICATION } from "@/lib/email";
import { SIGNUP_DOMAINS, SIGNUP_MODE } from "@/lib/signup";
import { TURNSTILE_SITE_KEY } from "@/lib/turnstile";

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const { email } = await searchParams;
  if (SIGNUP_MODE === "closed")
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
        {SIGNUP_MODE === "invite"
          ? "By invitation: use the address you were invited at. "
          : SIGNUP_DOMAINS.length
            ? `For addresses at ${SIGNUP_DOMAINS.join(", ")}. `
            : ""}
        {EMAIL_VERIFICATION ? "You will get API keys once you confirm your email." : "Then create API keys."}
      </p>
      <AuthForm
        mode="signup"
        oauth={<OAuthButtons providers={OAUTH_PROVIDERS} />}
        action={signUp}
        turnstileSiteKey={TURNSTILE_SITE_KEY}
        defaultEmail={typeof email === "string" ? email : undefined}
      />
    </>
  );
}
