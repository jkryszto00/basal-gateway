import { formatUsd } from "@basal/shared";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { Card, Stat } from "@/components/ui";
import { getBalance, usageSummary } from "@/lib/data";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
// the gateway reads the same variable: with credits off a zero balance does not stop requests
const CREDITS = ["true", "1", "yes", "on"].includes((process.env.CREDITS_ENABLED ?? "").toLowerCase());

export default async function Overview({ searchParams }: PageProps<"/dashboard">) {
  const [{ welcome }, balance, usage] = await Promise.all([searchParams, getBalance(), usageSummary(30)]);
  const curl = `curl ${API_URL}/v1/systemone \\
  -H "Authorization: Bearer $BASAL_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"state": "Zamówienie #1042 dotarło uszkodzone, proszę o zwrot pieniędzy.",
       "questions": {"intent": {"type": "choice", "instructions": "Czego chce klient?",
         "criteria": {"refund": "Zwrot pieniędzy", "replace": "Wymiana towaru", "info": "Informacja"}}}}'`;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-sm text-muted">Last 30 days.</p>
      </div>

      {welcome !== undefined && (
        <p role="status" className="rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
          Your email is confirmed
          {CREDITS && balance > 0 ? ` and ${formatUsd(balance, 2)} of credits are on your balance` : ""}. Create an API
          key to send your first request.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CREDITS && (
          <Stat
            label="Balance"
            value={formatUsd(balance, 2)}
            hint={balance <= 0 ? "Requests are refused at $0" : undefined}
          />
        )}
        <Stat
          label="Requests"
          value={usage.requests.toLocaleString("en")}
          hint={`${usage.decisions.toLocaleString("en")} decisions`}
        />
        <Stat
          label="Spend"
          value={formatUsd(usage.cost, 4)}
          hint={`${usage.inputTokens.toLocaleString("en")} input tokens`}
        />
        <Stat
          label="Latency p50"
          value={usage.p50 === null ? "–" : `${Math.round(usage.p50)} ms`}
          hint="end to end, gateway"
        />
      </div>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold">Quick start</h2>
            <p className="mt-1 text-sm text-muted">
              Create a key on the{" "}
              <Link href="/dashboard/keys" className="text-fg underline underline-offset-4">
                API keys
              </Link>{" "}
              page, export it as <code className="font-mono">BASAL_KEY</code> and send a decision.
            </p>
          </div>
          <CopyButton text={curl} />
        </div>
        <pre className="mt-4 overflow-x-auto rounded-md bg-bg p-4 font-mono text-xs leading-relaxed">{curl}</pre>
        <p className="mt-3 text-xs text-muted">
          The first request after a quiet period can take longer while the model starts. Question types, options and the
          response format follow the{" "}
          <a href="https://github.com/rkinas/basal#api" className="underline underline-offset-4">
            basal API
          </a>
          .
        </p>
      </Card>
    </div>
  );
}
