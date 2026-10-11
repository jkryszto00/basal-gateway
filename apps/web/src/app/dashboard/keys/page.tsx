import { revokeKey } from "@/app/actions";
import { CreateKeyForm } from "@/components/create-key-form";
import { Button, Card } from "@/components/ui";
import { canManage, requireOrg } from "@/lib/auth";
import { listKeys } from "@/lib/data";

// the gateway reads the same variables with the same defaults (one .env for every app)
const ACCOUNT = {
  rpm: Number(process.env.ORG_RPM_LIMIT ?? 120),
  concurrency: Number(process.env.ORG_CONCURRENCY_LIMIT ?? 16),
  daily: Number(process.env.ORG_DAILY_REQUESTS ?? 0), // 0: no daily limit
};

const date = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "never");

export default async function KeysPage() {
  const [{ user, org }, keys] = await Promise.all([requireOrg(), listKeys()]);
  const manage = canManage(org);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">API keys</h1>
        <p className="text-sm text-muted">
          Keys of {org.name}. Send as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>. Revoked keys
          stop working immediately.
        </p>
        <p className="mt-1 text-sm text-muted">
          Each key has its own limits below; all keys of the organization together are limited to {ACCOUNT.rpm} requests
          per minute and {ACCOUNT.concurrency} parallel requests
          {ACCOUNT.daily > 0 && `, and to ${ACCOUNT.daily} requests per day (resets at 00:00 UTC)`}.
        </p>
      </div>

      <Card className="p-5">
        <CreateKeyForm />
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Key</th>
              <th className="px-4 py-2 font-medium">Created by</th>
              <th className="px-4 py-2 font-medium">Limits</th>
              <th className="px-4 py-2 font-medium">Created</th>
              <th className="px-4 py-2 font-medium">Last used</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted">
                  No keys yet.
                </td>
              </tr>
            )}
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2">{k.name}</td>
                <td className="px-4 py-2 font-mono text-xs">{k.prefix}…</td>
                <td className="px-4 py-2 text-xs text-muted">{k.creator ?? "former member"}</td>
                <td className="px-4 py-2 text-xs text-muted">
                  {k.rpmLimit}/min · {k.concurrencyLimit} parallel
                  {k.monthlyRequests && ` · ${k.monthlyRequests.toLocaleString("en")} req/month`}
                  {k.monthlyTokens && ` · ${k.monthlyTokens.toLocaleString("en")} tokens/month`}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-muted">{date(k.createdAt)}</td>
                <td className="px-4 py-2 font-mono text-xs text-muted">{date(k.lastUsedAt)}</td>
                <td className="px-4 py-2 text-right">
                  {(manage || k.createdBy === user.id) && (
                    <form action={revokeKey}>
                      <input type="hidden" name="id" value={k.id} />
                      <Button variant="danger" className="px-2 py-1 text-xs">
                        Revoke
                      </Button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
