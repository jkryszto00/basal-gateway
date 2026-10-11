import { listOrgs, listSignupInvitations, listUsers, monthUsageByOrg } from "@basal/admin";
import { adminAccount, adminRevokeInvitation } from "@/app/admin-actions";
import { CreateUserForm, DeleteUserForm, InviteForm, QuotaForm } from "@/components/admin-forms";
import { Button, Card } from "@/components/ui";
import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { SIGNUP_MODE } from "@/lib/signup";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "–");
const n = (v: number) => v.toLocaleString("en");

function AccountAction({ email, action, label }: { email: string; action: string; label: string }) {
  return (
    <form action={adminAccount}>
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="action" value={action} />
      <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
        {label}
      </Button>
    </form>
  );
}

export default async function Admin() {
  const admin = await requireAdmin();
  const ctx = { db, redis };
  const [users, invitations, orgs, month] = await Promise.all([
    listUsers(ctx),
    listSignupInvitations(ctx),
    listOrgs(ctx),
    monthUsageByOrg(ctx),
  ]);
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Admin</h1>
        <p className="text-sm text-muted">
          This instance: {users.length} accounts, {orgs.length} organizations. Sign up is <strong>{SIGNUP_MODE}</strong>{" "}
          (SIGNUP_MODE).
        </p>
      </div>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Accounts</h2>
          <p className="text-sm text-muted">
            Create an account with a confirmed email (works whatever the sign up mode); its password is shown once.
          </p>
        </div>
        <CreateUserForm />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="py-2 pr-3 font-medium">Email</th>
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Orgs</th>
                <th className="py-2 pr-3 font-medium">Created</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.email === admin.email.toLowerCase();
                return (
                  <tr key={u.email} className="border-b border-line align-top last:border-0">
                    <td className="py-2 pr-3">{u.email}</td>
                    <td className="py-2 pr-3 text-muted">{u.name}</td>
                    <td className="py-2 pr-3 text-xs">
                      {u.disabled ? (
                        <span className="text-danger">disabled</span>
                      ) : u.verified ? (
                        "active"
                      ) : (
                        <span className="text-muted">unconfirmed</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{u.organizations}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-muted">{day(u.created)}</td>
                    <td className="py-2">
                      {!self && (
                        <div className="flex flex-wrap items-start justify-end gap-1">
                          {!u.verified && <AccountAction email={u.email} action="verify" label="Confirm email" />}
                          {u.disabled ? (
                            <AccountAction email={u.email} action="enable" label="Enable" />
                          ) : (
                            <AccountAction email={u.email} action="disable" label="Disable" />
                          )}
                          <DeleteUserForm email={u.email} />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Sign up invitations</h2>
          <p className="text-sm text-muted">
            With SIGNUP_MODE=invite, only invited addresses (and those invited to an organization) can sign up. The
            invitation is emailed and expires in 14 days.
          </p>
        </div>
        <InviteForm />
        {invitations.length > 0 && (
          <ul className="divide-y divide-line rounded-md border border-line text-sm">
            {invitations.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span>
                  {i.email} <span className="text-muted">· until {day(i.expires)}</span>
                </span>
                <form action={adminRevokeInvitation}>
                  <input type="hidden" name="id" value={i.id} />
                  <Button variant="ghost" className="px-2 py-1 text-xs">
                    Revoke
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Organizations</h2>
          <p className="text-sm text-muted">
            This month&apos;s usage and the monthly quota (UTC month; empty or 0: the default from ORG_MONTHLY_*).
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="py-2 pr-3 font-medium">Organization</th>
                <th className="py-2 pr-3 font-medium">Members</th>
                <th className="py-2 pr-3 font-medium">Keys</th>
                <th className="py-2 pr-3 text-right font-medium">Requests</th>
                <th className="py-2 pr-3 text-right font-medium">Input tokens</th>
                <th className="py-2 font-medium">Monthly quota</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => {
                const used = month.get(o.id) ?? { requests: 0, tokens: 0 };
                return (
                  <tr key={o.id} className="border-b border-line align-top last:border-0">
                    <td className="py-2 pr-3">
                      {o.name}
                      {o.personal && <span className="ml-1 text-xs text-muted">personal</span>}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{o.members}</td>
                    <td className="py-2 pr-3 tabular-nums">{o.keys}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{n(used.requests)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{n(used.tokens)}</td>
                    <td className="py-2">
                      <QuotaForm organizationId={o.id} requests={o.monthlyRequests} tokens={o.monthlyTokens} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
