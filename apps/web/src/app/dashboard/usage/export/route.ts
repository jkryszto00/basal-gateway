import { aggregateUsage, parseUsageRange, usageEventsInRange } from "@basal/db";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";

// CSV of the active organization's usage: daily totals per model and key, or every request.
//   ?period=this-month|last-month|last-30-days  or  ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive)
//   &detail=daily|requests

const iso = (d: Date) => d.toISOString().slice(0, 10);

function period(name: string | null, now = new Date()): { from: string; to: string } | null {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (name === "last-month")
    return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
  if (name === "last-30-days") return { from: iso(new Date(now.getTime() - 29 * 86_400_000)), to: iso(now) };
  if (name === "this-month") return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(now) };
  return null;
}

function csv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    const s =
      v === null || v === undefined
        ? ""
        : v instanceof Date
          ? v.toISOString()
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

export async function GET(req: Request) {
  const { org } = await requireOrg();
  const params = new URL(req.url).searchParams;
  const named = period(params.get("period"));
  const range = parseUsageRange(named?.from ?? params.get("from"), named?.to ?? params.get("to"));
  if ("error" in range) return new Response(`${range.error}\n`, { status: 400 });
  const scope = { organizationId: org.id, ...range };
  const detail = params.get("detail") === "requests" ? "requests" : "daily";

  const body =
    detail === "requests"
      ? csv(await usageEventsInRange(db, scope), [
          "time",
          "model",
          "key",
          "keyPrefix",
          "member",
          "inputTokens",
          "questions",
          "branches",
          "latencyMs",
          "id",
          "details",
        ])
      : csv(await aggregateUsage(db, scope, ["day", "model", "key"]), [
          "day",
          "model",
          "key",
          "keyPrefix",
          "requests",
          "decisions",
          "branches",
          "inputTokens",
        ]);
  const last = new Date(range.to.getTime() - 1);
  const name = `usage-${org.slug}-${iso(range.from)}-${iso(last)}-${detail}.csv`;
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}
