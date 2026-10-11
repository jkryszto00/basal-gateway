import Link from "next/link";
import { cancelInvitation, removeMember, updateMemberRole } from "@/app/org-actions";
import { DeleteOrganizationForm, InviteForm, LeaveForm, RenameForm } from "@/components/org-forms";
import { Button, Card, inputClass } from "@/components/ui";
import { canManage, requireOrg } from "@/lib/auth";
import { orgInvitations, orgMembers } from "@/lib/data";

const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function Organization() {
  const [{ user, org }, members, invitations] = await Promise.all([requireOrg(), orgMembers(), orgInvitations()]);
  const manage = canManage(org);
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">
          {org.name}
          {org.personal && <span className="ml-2 text-sm font-normal text-muted">personal</span>}
        </h1>
        <p className="text-sm text-muted">
          {org.personal ? (
            <>
              Your own keys and usage. To work with a team or a client,{" "}
              <Link href="/dashboard/organization/new" className="text-fg underline underline-offset-4">
                create an organization
              </Link>
              .
            </>
          ) : (
            `You are ${org.role === "admin" ? "an" : "a"} ${org.role}. API keys, limits and usage are shared by its members.`
          )}
        </p>
      </div>

      {manage && (
        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Name</h2>
          <RenameForm name={org.name} />
        </Card>
      )}

      {!org.personal && (
        <Card className="overflow-x-auto">
          <h2 className="px-4 pt-4 font-semibold">Members</h2>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Joined</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const self = m.userId === user.id;
                return (
                  <tr key={m.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      {m.name}
                      {self && <span className="ml-1 text-xs text-muted">(you)</span>}
                    </td>
                    <td className="px-4 py-2 text-muted">{m.email}</td>
                    <td className="px-4 py-2">
                      {manage && !self ? (
                        <form action={updateMemberRole} className="flex items-center gap-1">
                          <input type="hidden" name="memberId" value={m.id} />
                          <select
                            name="role"
                            defaultValue={m.role}
                            aria-label={`Role of ${m.email}`}
                            className={`${inputClass} w-auto py-1`}
                          >
                            <option value="member">member</option>
                            <option value="admin">admin</option>
                            {org.role === "owner" && <option value="owner">owner</option>}
                          </select>
                          <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                            Save
                          </Button>
                        </form>
                      ) : (
                        m.role
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-muted">{day(m.joined)}</td>
                    <td className="px-4 py-2 text-right">
                      {manage && !self && (
                        <form action={removeMember}>
                          <input type="hidden" name="memberId" value={m.id} />
                          <Button variant="danger" className="px-2 py-1 text-xs">
                            Remove
                          </Button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {!org.personal && manage && (
        <Card className="space-y-4 p-5">
          <div>
            <h2 className="font-semibold">Invite</h2>
            <p className="text-sm text-muted">
              They get an email with a link; the invitation is accepted from an account with that address and expires in
              7 days. Admins manage members and keys, members create keys and see usage.
            </p>
          </div>
          <InviteForm canInviteOwners={org.role === "owner"} />
          {invitations.length > 0 && (
            <ul className="divide-y divide-line rounded-md border border-line text-sm">
              {invitations.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span>
                    {i.email}{" "}
                    <span className="text-muted">
                      · {i.role ?? "member"} · until {day(i.expiresAt)}
                    </span>
                  </span>
                  <form action={cancelInvitation}>
                    <input type="hidden" name="invitationId" value={i.id} />
                    <Button variant="ghost" className="px-2 py-1 text-xs">
                      Cancel
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {!org.personal && (
        <Card className="space-y-4 border-danger/40 p-5">
          <h2 className="font-semibold text-danger">Leave or delete</h2>
          <p className="text-sm text-muted">
            Leaving keeps the organization, its keys and usage for the other members. Deleting removes it with its API
            keys (they stop working at once) and its usage; only owners can, and it cannot be undone.
          </p>
          <LeaveForm />
          {org.role === "owner" && <DeleteOrganizationForm name={org.name} />}
        </Card>
      )}
    </div>
  );
}
