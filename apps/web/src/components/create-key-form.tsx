"use client";

import { useActionState } from "react";
import { createKey } from "@/app/actions";
import { CopyButton } from "./copy-button";
import { Button, inputClass } from "./ui";

export function CreateKeyForm() {
  const [state, action, pending] = useActionState(createKey, undefined);
  return (
    <div className="space-y-3">
      <form action={action} className="flex gap-2">
        <input name="name" placeholder="Key name, e.g. production" maxLength={64} required className={inputClass} />
        <Button type="submit" disabled={pending} className="shrink-0">
          Create key
        </Button>
      </form>
      {state?.error && <p className="text-sm text-danger">{state.error}</p>}
      {state?.key && (
        <div className="rounded-md border border-accent/40 bg-accent/5 p-3">
          <p className="text-sm">
            <strong>{state.name}</strong>: copy this key now. It is not stored and will not be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-bg px-2 py-1.5 font-mono text-xs">{state.key}</code>
            <CopyButton text={state.key} />
          </div>
        </div>
      )}
    </div>
  );
}
