import { formatUsd } from "@basal/shared";
import { Card } from "@/components/ui";
import { recentUsage } from "@/lib/data";

export default async function UsagePage() {
  const rows = await recentUsage(100);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Usage</h1>
        <p className="text-sm text-muted">Last 100 billed requests. Rejected and failed requests are not billed.</p>
      </div>
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
              <th className="px-4 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="font-mono text-xs">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center font-sans text-sm text-muted">
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
                <td className="px-4 py-2 text-right tabular-nums">{formatUsd(r.cost, 6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
