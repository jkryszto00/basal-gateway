import { Button, Card, inputClass } from "@/components/ui";
import { recentUsage, usageByModel } from "@/lib/data";

export default async function UsagePage() {
  const [byModel, rows] = await Promise.all([usageByModel(30), recentUsage(100)]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Usage</h1>
        <p className="text-sm text-muted">Successful requests; rejected and failed ones are not recorded.</p>
      </div>

      <Card className="p-4">
        <form action="/dashboard/usage/export" method="get" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">Export CSV</span>
          <select name="period" defaultValue="this-month" aria-label="Period" className={`${inputClass} w-auto py-1`}>
            <option value="this-month">This month</option>
            <option value="last-month">Last month</option>
            <option value="last-30-days">Last 30 days</option>
          </select>
          <select name="detail" defaultValue="daily" aria-label="Detail" className={`${inputClass} w-auto py-1`}>
            <option value="daily">Daily totals per model and key</option>
            <option value="requests">Every request</option>
          </select>
          <Button type="submit" variant="ghost" className="py-1">
            Download
          </Button>
          <span className="text-xs text-muted">
            Also over the API: <code className="font-mono">GET /v1/usage</code> with any of the organization&apos;s
            keys.
          </span>
        </form>
      </Card>

      <Card className="overflow-x-auto">
        <h2 className="px-4 pt-4 text-sm font-semibold">By model, last 30 days</h2>
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-4 py-2 text-right font-medium">Requests</th>
              <th className="px-4 py-2 text-right font-medium">Decisions</th>
              <th className="px-4 py-2 text-right font-medium">Input tokens</th>
              <th className="px-4 py-2 text-right font-medium">Latency p50</th>
            </tr>
          </thead>
          <tbody className="font-mono text-xs">
            {byModel.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center font-sans text-sm text-muted">
                  No requests in the last 30 days.
                </td>
              </tr>
            )}
            {byModel.map((m) => (
              <tr key={m.model} className="border-b border-line last:border-0">
                <td className="px-4 py-2">{m.model}</td>
                <td className="px-4 py-2 text-right tabular-nums">{m.requests.toLocaleString("en")}</td>
                <td className="px-4 py-2 text-right tabular-nums">{m.decisions.toLocaleString("en")}</td>
                <td className="px-4 py-2 text-right tabular-nums">{m.inputTokens.toLocaleString("en")}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {m.p50 === null ? "–" : `${Math.round(m.p50)} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <h2 className="text-sm font-semibold">Last 100 requests</h2>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">Time (UTC)</th>
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-4 py-2 font-medium">Key</th>
              <th className="px-4 py-2 text-right font-medium">Tokens</th>
              <th className="px-4 py-2 text-right font-medium">Questions</th>
              <th className="px-4 py-2 text-right font-medium">Latency</th>
            </tr>
          </thead>
          <tbody className="font-mono text-xs">
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center font-sans text-sm text-muted">
                  No requests yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-muted">{r.createdAt.toISOString().slice(0, 19).replace("T", " ")}</td>
                <td className="px-4 py-2">{r.model}</td>
                <td className="px-4 py-2 font-sans">{r.keyName ?? "deleted"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r.inputTokens}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r.questions}</td>
                <td className="px-4 py-2 text-right tabular-nums">{Math.round(r.latency)} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
