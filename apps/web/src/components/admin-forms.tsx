"use client";

import { useActionState } from "react";
import { adminCreateUser, adminDeleteUser, adminInvite, adminSetQuota } from "@/app/admin-actions";
import { FormMessage } from "./auth-form";
import { Button, inputClass } from "./ui";

export function CreateUserForm() {
  const [state, action, pending] = useActionState(adminCreateUser, undefined);
  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          name="email"
          type="email"
          placeholder="name@example.com"
          required
          className={`${inputClass} min-w-56 flex-1`}
        />
        <input name="name" placeholder="Name (optional)" maxLength={64} className={`${inputClass} w-48`} />
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create account"}
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function InviteForm() {
  const [state, action, pending] = useActionState(adminInvite, undefined);
  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          name="email"
          type="email"
          placeholder="name@example.com"
          required
          className={`${inputClass} min-w-56 flex-1`}
        />
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Invite to sign up"}
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function DeleteUserForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(adminDeleteUser, undefined);
  return (
    <details className="text-left">
      <summary className="cursor-pointer text-xs text-danger">Delete</summary>
      <form action={action} className="mt-2 w-64 space-y-2">
        <input type="hidden" name="email" value={email} />
        <input
          name="confirm"
          placeholder={`Type ${email}`}
          autoComplete="off"
          className={`${inputClass} py-1 text-xs`}
        />
        <Button
          type="submit"
          variant="danger"
          disabled={pending}
          className="w-full border border-danger/40 py-1 text-xs"
        >
          Delete account
        </Button>
        <FormMessage state={state} />
      </form>
    </details>
  );
}

export function QuotaForm({
  organizationId,
  requests,
  tokens,
}: {
  organizationId: string;
  requests: number | null;
  tokens: number | null;
}) {
  const [state, action, pending] = useActionState(adminSetQuota, undefined);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="organizationId" value={organizationId} />
      <div className="flex gap-1">
        <input
          name="requests"
          type="number"
          min={0}
          defaultValue={requests ?? ""}
          placeholder="requests"
          aria-label="Monthly requests"
          className={`${inputClass} w-28 py-1 text-xs`}
        />
        <input
          name="tokens"
          type="number"
          min={0}
          defaultValue={tokens ?? ""}
          placeholder="tokens"
          aria-label="Monthly input tokens"
          className={`${inputClass} w-32 py-1 text-xs`}
        />
        <Button type="submit" variant="ghost" disabled={pending} className="px-2 py-1 text-xs">
          Save
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
