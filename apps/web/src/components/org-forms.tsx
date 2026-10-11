"use client";

import { useActionState } from "react";
import {
  createOrganization,
  deleteOrganization,
  inviteMember,
  leaveOrganization,
  renameOrganization,
} from "@/app/org-actions";
import { FormMessage } from "./auth-form";
import { Button, inputClass } from "./ui";

export function NewOrganizationForm() {
  const [state, action, pending] = useActionState(createOrganization, undefined);
  return (
    <form action={action} className="max-w-sm space-y-4">
      <label className="block space-y-1">
        <span className="text-sm">Name</span>
        <input name="name" defaultValue={state?.values?.name} maxLength={64} required className={inputClass} />
      </label>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}

export function RenameForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState(renameOrganization, undefined);
  return (
    <form action={action} className="flex max-w-md flex-wrap items-start gap-2">
      <input name="name" defaultValue={name} maxLength={64} required className={`${inputClass} flex-1`} />
      <Button type="submit" variant="ghost" disabled={pending}>
        Rename
      </Button>
      <div className="w-full">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function InviteForm({ canInviteOwners }: { canInviteOwners: boolean }) {
  const [state, action, pending] = useActionState(inviteMember, undefined);
  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          name="email"
          type="email"
          placeholder="name@example.com"
          defaultValue={state?.values?.email}
          required
          className={`${inputClass} min-w-56 flex-1`}
        />
        <select name="role" defaultValue="member" className={`${inputClass} w-auto`} aria-label="Role">
          <option value="member">member</option>
          <option value="admin">admin</option>
          {canInviteOwners && <option value="owner">owner</option>}
        </select>
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Invite"}
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function LeaveForm() {
  const [state, action, pending] = useActionState(leaveOrganization, undefined);
  return (
    <form action={action} className="space-y-2">
      <Button type="submit" variant="ghost" disabled={pending}>
        {pending ? "Leaving…" : "Leave organization"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function DeleteOrganizationForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState(deleteOrganization, undefined);
  return (
    <form action={action} className="max-w-sm space-y-3">
      <label className="block space-y-1">
        <span className="text-sm">Type {name} to confirm</span>
        <input name="confirm" autoComplete="off" required className={inputClass} />
      </label>
      <FormMessage state={state} />
      <Button type="submit" variant="danger" disabled={pending} className="border border-danger/40">
        {pending ? "Deleting…" : "Delete organization"}
      </Button>
    </form>
  );
}
