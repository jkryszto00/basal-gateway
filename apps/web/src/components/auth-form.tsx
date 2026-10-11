"use client";

import Link from "next/link";
import { useActionState } from "react";
import { type FormState, resendVerification, resetPassword } from "@/app/actions";
import { PASSWORD } from "@/lib/password";
import { Turnstile } from "./turnstile";
import { Button, inputClass } from "./ui";

type Action = (state: FormState, form: FormData) => Promise<FormState>;

export function FormMessage({ state }: { state: FormState }) {
  if (state?.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state?.notice)
    return (
      <p role="status" className="rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
        {state.notice}
      </p>
    );
  return null;
}

function EmailField({ defaultValue }: { defaultValue?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm">Email</span>
      <input
        name="email"
        type="email"
        autoComplete="email"
        defaultValue={defaultValue}
        required
        className={inputClass}
      />
    </label>
  );
}

function PasswordField({
  name = "password",
  label = "Password",
  autoComplete,
}: {
  name?: string;
  label?: string;
  autoComplete: string;
}) {
  return (
    <input
      name={name}
      type="password"
      aria-label={label}
      autoComplete={autoComplete}
      minLength={autoComplete === "new-password" ? PASSWORD.min : undefined}
      maxLength={PASSWORD.max}
      required
      className={inputClass}
    />
  );
}

export function AuthForm({
  mode,
  action,
  turnstileSiteKey,
  oauth,
  signupOpen = true,
  next,
}: {
  mode: "login" | "signup";
  action: Action;
  turnstileSiteKey?: string;
  oauth?: React.ReactNode; // GitHub / Google buttons, above the email form
  signupOpen?: boolean; // the login page links to sign up only when it is open
  next?: string; // where to go after signing in
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const signup = mode === "signup";
  if (state?.sent) return <CheckInbox email={state.sent} />;
  return (
    <>
      {oauth}
      <form action={formAction} className="space-y-4">
        {signup && (
          <label className="block space-y-1">
            <span className="text-sm">Name</span>
            <input
              name="name"
              autoComplete="name"
              maxLength={64}
              defaultValue={state?.values?.name}
              required
              className={inputClass}
            />
          </label>
        )}
        {next && <input type="hidden" name="next" value={next} />}
        <EmailField defaultValue={state?.values?.email} />
        <label className="block space-y-1">
          <span className="flex items-baseline justify-between text-sm">
            Password
            {!signup && (
              <Link
                href="/forgot-password"
                className="text-xs text-muted underline-offset-4 hover:text-fg hover:underline"
              >
                Forgot password?
              </Link>
            )}
          </span>
          <PasswordField autoComplete={signup ? "new-password" : "current-password"} />
          {signup && <span className="block text-xs text-muted">At least {PASSWORD.min} characters.</span>}
        </label>
        {signup && turnstileSiteKey && <Turnstile siteKey={turnstileSiteKey} action="signup" resetOn={state} />}
        <FormMessage state={state} />
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? (signup ? "Creating account…" : "Signing in…") : signup ? "Create account" : "Sign in"}
        </Button>
        {(signup || signupOpen) && (
          <p className="text-center text-sm text-muted">
            {signup ? "Have an account? " : "New here? "}
            <Link href={signup ? "/login" : "/signup"} className="text-fg underline underline-offset-4">
              {signup ? "Sign in" : "Create an account"}
            </Link>
          </p>
        )}
      </form>
    </>
  );
}

function CheckInbox({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState(resendVerification, undefined);
  return (
    <div className="space-y-4 text-sm">
      <p className="font-medium">Check your inbox</p>
      <p className="text-muted">
        We sent a confirmation link to <span className="text-fg">{email}</span>. Open it to activate your account. The
        link expires in 24 hours.
      </p>
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="email" value={email} />
        <FormMessage state={state} />
        <Button type="submit" variant="ghost" disabled={pending} className="w-full">
          {pending ? "Sending…" : "Send the link again"}
        </Button>
      </form>
      <p className="text-center text-muted">
        Already confirmed?{" "}
        <Link href="/login" className="text-fg underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  );
}

/** One email field: password reset requests and new confirmation links. */
export function EmailForm({ action, submit, defaultEmail }: { action: Action; submit: string; defaultEmail?: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-4">
      <EmailField defaultValue={state?.values?.email ?? defaultEmail} />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Sending…" : submit}
      </Button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(resetPassword, undefined);
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <label className="block space-y-1">
        <span className="text-sm">New password</span>
        <PasswordField label="New password" autoComplete="new-password" />
        <span className="block text-xs text-muted">At least {PASSWORD.min} characters.</span>
      </label>
      <label className="block space-y-1">
        <span className="text-sm">Repeat the new password</span>
        <PasswordField name="confirm" label="Repeat the new password" autoComplete="new-password" />
      </label>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}
