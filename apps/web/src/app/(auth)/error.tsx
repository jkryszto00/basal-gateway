"use client";

import { Button } from "@/components/ui";

// Unexpected failures (database, Redis, email provider) on the sign in pages: no internals, a way to retry.
export default function AuthError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted">We could not finish this step. Try again in a moment.</p>
      <Button onClick={reset} className="w-full">
        Try again
      </Button>
    </div>
  );
}
