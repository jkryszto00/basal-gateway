import Link from "next/link";
import { QuickStart } from "@/components/quick-start";
import { Card, Stat } from "@/components/ui";
import { requireOrg } from "@/lib/auth";
import { monthUsage, myInvitations, usageSummary } from "@/lib/data";
import { listModels, type ModelInfo } from "@/lib/models";

const API_URL = process.env.GATEWAY_PUBLIC_URL ?? "http://localhost:8787";

export default async function Overview({ searchParams }: PageProps<"/dashboard">) {
  const [{ welcome, joined }, { org }, usage, models, invitations, month] = await Promise.all([
    searchParams,
    requireOrg(),
    usageSummary(30),
    listModels(),
    myInvitations(),
    monthUsage(),
  ]);
  const defaultModel = models?.find((m) => m.default)?.name;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-sm text-muted">{org.name}, last 30 days.</p>
      </div>

      {joined !== undefined && (
        <p role="status" className="rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
          You joined {org.name}. Its API keys and usage are below; switch organizations at the top.
        </p>
      )}

      {invitations.map((i) => (
        <p
          key={i.id}
          className="flex items-center justify-between gap-3 rounded-md border border-line bg-card p-3 text-sm"
        >
          <span>
            You are invited to <strong>{i.organization}</strong> as {i.role === "admin" ? "an" : "a"}{" "}
            {i.role ?? "member"}.
          </span>
          <Link href={`/invitations/${i.id}`} className="shrink-0 text-fg underline underline-offset-4">
            View invitation
          </Link>
        </p>
      ))}

      {welcome !== undefined && (
        <p role="status" className="rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
          Your account is ready. Create an API key to send your first request.
        </p>
      )}

      {(month.requestQuota || month.tokenQuota) && (
        <Card className="space-y-3 p-5">
          <h2 className="font-semibold">This month</h2>
          {month.requestQuota && <Meter label="Requests" used={month.requests} quota={month.requestQuota} />}
          {month.tokenQuota && <Meter label="Input tokens" used={month.tokens} quota={month.tokenQuota} />}
          <p className="text-xs text-muted">The monthly quota renews on the 1st (UTC); past it the API answers 429.</p>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Requests"
          value={usage.requests.toLocaleString("en")}
          hint={`${usage.decisions.toLocaleString("en")} decisions`}
        />
        <Stat label="Input tokens" value={usage.inputTokens.toLocaleString("en")} hint="sent to the models" />
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

function Models({ models }: { models: ModelInfo[] | null }) {
  return (
    <Card className="overflow-x-auto">
      <div className="px-5 pt-5">
        <h2 className="font-semibold">Models</h2>
        <p className="mt-1 text-sm text-muted">
          Pick one with <code className="font-mono">&quot;model&quot;</code> in the request; without it the default
          model answers.
        </p>
      </div>
      {models === null ? (
        <p className="px-5 py-4 text-sm text-danger">The gateway at {API_URL} cannot be reached.</p>
      ) : (
        <ul className="mt-3">
          {models.map((m) => (
            <li key={m.name} className="border-t border-line px-5 py-2 font-mono text-xs">
              {m.name}
              {m.default && (
                <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 font-sans text-accent">default</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Meter({ label, used, quota }: { label: string; used: number; quota: number }) {
  const share = Math.min(1, used / quota);
  return (
    <div className="space-y-1 text-sm">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums text-muted">
          {used.toLocaleString("en")} / {quota.toLocaleString("en")}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-line">
        <div
          className={`h-full ${share >= 1 ? "bg-danger" : share >= 0.8 ? "bg-yellow-500" : "bg-accent"}`}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}
