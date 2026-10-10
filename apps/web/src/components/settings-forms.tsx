"use client";

import { useActionState } from "react";
import { changePassword, deleteAccount, setPassword } from "@/app/actions";
import { PASSWORD } from "@/lib/password";
import { FormMessage } from "./auth-form";
import { Button, inputClass } from "./ui";

function Field({ label, hint, ...props }: React.ComponentProps<"input"> & { label: string; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <input className={inputClass} required {...props} />
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

function NewPasswordFields() {
  return (
    <>
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD.min}
        maxLength={PASSWORD.max}
        hint={`At least ${PASSWORD.min} characters.`}
      />
      <Field
        label="Repeat the new password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        maxLength={PASSWORD.max}
      />
    </>
  );
}

export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const [state, action, pending] = useActionState(hasPassword ? changePassword : setPassword, undefined);
  return (
    <form action={action} className="max-w-sm space-y-4">
      {hasPassword && (
        <Field
          label="Current password"
          name="current"
          type="password"
          autoComplete="current-password"
          maxLength={PASSWORD.max}
        />
      )}
      <NewPasswordFields />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : hasPassword ? "Change password" : "Set password"}
      </Button>
    </form>
  );
}

export function DeleteAccountForm({ email, hasPassword }: { email: string; hasPassword: boolean }) {
  const [state, action, pending] = useActionState(deleteAccount, undefined);
  return (
    <form action={action} className="max-w-sm space-y-4">
      <Field label={`Type ${email} to confirm`} name="confirm" autoComplete="off" spellCheck={false} />
      {hasPassword && (
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          maxLength={PASSWORD.max}
        />
      )}
      <FormMessage state={state} />
      <Button type="submit" variant="danger" disabled={pending} className="border border-danger/40">
        {pending ? "Deleting…" : "Delete account"}
      </Button>
    </form>
  );
}
