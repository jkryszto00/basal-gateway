import { formatUsd } from "@basal/shared";
import Link from "next/link";
import { QuickStart } from "@/components/quick-start";
import { Card, Stat } from "@/components/ui";
import { getBalance, usageSummary } from "@/lib/data";
import { listModels, type ModelInfo } from "@/lib/models";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
// the gateway reads the same variable: with credits off a zero balance does not stop requests
const CREDITS = ["true", "1", "yes", "on"].includes((process.env.CREDITS_ENABLED ?? "").toLowerCase());

export default async function Overview({ searchParams }: PageProps<"/dashboard">) {
  const [{ welcome }, balance, usage, models] = await Promise.all([
    searchParams,
    getBalance(),
    usageSummary(30),
    listModels(),
  ]);
  const defaultModel = models?.find((m) => m.default)?.name;

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
        <h2 className="font-semibold">Quick start</h2>
        <p className="mt-1 text-sm text-muted">
          Create a key on the{" "}
          <Link href="/dashboard/keys" className="text-fg underline underline-offset-4">
            API keys
          </Link>{" "}
          page, export it as <code className="font-mono">BASAL_KEY</code> and send a decision.
        </p>
        <QuickStart apiUrl={API_URL} models={models?.map((m) => m.name) ?? []} defaultModel={defaultModel} />
        <p className="mt-3 text-xs text-muted">
          The first request after a quiet period can take longer while the model starts. Question types, options and the
          response format follow the{" "}
          <a href="https://github.com/rkinas/basal#api" className="underline underline-offset-4">
            basal API
          </a>
          .
        </p>
      </Card>

      <Models models={models} />
    </div>
  );
}

const price = (micro: number) => `$${(micro / 1_000_000).toFixed(micro % 10_000 === 0 ? 2 : 4)}`;

function Models({ models }: { models: ModelInfo[] | null }) {
  return (
    <Card className="overflow-x-auto">
      <div className="px-5 pt-5">
        <h2 className="font-semibold">Models</h2>
        <p className="mt-1 text-sm text-muted">
          Pick one with <code className="font-mono">&quot;model&quot;</code> in the request; without it the default
          model answers. A branch is one question, or one label of a <code className="font-mono">multi</code> question.
          Only successful requests are billed.
        </p>
      </div>
      {models === null ? (
        <p className="px-5 py-4 text-sm text-danger">The gateway at {API_URL} cannot be reached.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-5 py-2 font-medium">Model</th>
              <th className="px-5 py-2 text-right font-medium">Per 1M input tokens</th>
              <th className="px-5 py-2 text-right font-medium">Per 1k branches</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.name} className="border-b border-line last:border-0">
                <td className="px-5 py-2 font-mono text-xs">
                  {m.name}
                  {m.default && (
                    <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 font-sans text-accent">default</span>
                  )}
                </td>
                {m.pricing ? (
                  <>
                    <td className="px-5 py-2 text-right tabular-nums">{price(m.pricing.per_million_input_tokens)}</td>
                    <td className="px-5 py-2 text-right tabular-nums">{price(m.pricing.per_thousand_branches)}</td>
                  </>
                ) : (
                  <td colSpan={2} className="px-5 py-2 text-right text-muted">
                    free
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
