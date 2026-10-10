import { signUp } from "@/app/actions";
import { AuthForm } from "@/components/auth-form";
import { OAuthButtons } from "@/components/oauth-buttons";
import { OAUTH_PROVIDERS } from "@/lib/auth";
import { TURNSTILE_SITE_KEY } from "@/lib/turnstile";

export default function SignupPage() {
  return (
    <>
      <h1 className="text-lg font-semibold">Create an account</h1>
      <p className="mb-6 mt-1 text-sm text-muted">Free credits to try the API once you confirm your email.</p>
      <AuthForm
        mode="signup"
        oauth={<OAuthButtons providers={OAUTH_PROVIDERS} />}
        action={signUp}
        turnstileSiteKey={TURNSTILE_SITE_KEY}
      />
    </>
  );
}
