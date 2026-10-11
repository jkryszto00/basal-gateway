"use client";

import { useActionState } from "react";
import { createKey } from "@/app/actions";
import { CopyButton } from "./copy-button";
import { Button, inputClass } from "./ui";

export function CreateKeyForm() {
  const [state, action, pending] = useActionState(createKey, undefined);
  return (
    <div className="space-y-3">
      <form action={action} className="space-y-2">
        <div className="flex gap-2">
          <input name="name" placeholder="Key name, e.g. production" maxLength={64} required className={inputClass} />
          <Button type="submit" disabled={pending} className="shrink-0">
            Create key
          </Button>
        </div>
        <details className="text-sm">
          <summary className="text-muted">Monthly limits for this key (optional)</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              name="monthlyRequests"
              type="number"
              min={1}
              placeholder="Requests per month"
              aria-label="Requests per month"
              className={`${inputClass} w-52`}
            />
            <input
              name="monthlyTokens"
              type="number"
              min={1}
              placeholder="Input tokens per month"
              aria-label="Input tokens per month"
              className={`${inputClass} w-52`}
            />
          </div>
        </details>
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
