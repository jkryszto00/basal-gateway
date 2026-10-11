import { eq, invitation, organization, user as users } from "@basal/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import { acceptInvitation, rejectInvitation } from "@/app/org-actions";
import { Logo } from "@/components/logo";
import { Button, Card } from "@/components/ui";
import { getOptionalUser } from "@/lib/auth";
import { db } from "@/lib/db";

// Link from the invitation email. Signed out: sign in first and come back here.
export default async function InvitationPage({ params, searchParams }: PageProps<"/invitations/[id]">) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const user = await getOptionalUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invitations/${id}`)}`);

  const [inv] = await db
    .select({
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      organization: organization.name,
      inviter: users.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .innerJoin(users, eq(users.id, invitation.inviterId))
    .where(eq(invitation.id, id));

  const problem = !inv
    ? "This invitation does not exist."
    : inv.status !== "pending"
      ? `This invitation was already ${inv.status}.`
      : inv.expiresAt < new Date()
        ? "This invitation has expired. Ask for a new one."
        : inv.email !== user.email.toLowerCase()
          ? `This invitation is for ${inv.email}, and you are signed in as ${user.email}.`
          : error
            ? "We could not accept the invitation. Try again."
            : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="mb-8">
        <Logo />
      </div>
      <Card className="w-full max-w-sm space-y-4 p-6">
        {problem || !inv ? (
          <>
            <h1 className="text-lg font-semibold">Invitation</h1>
            <p className="text-sm text-muted">{problem}</p>
            <Link href="/dashboard" className="text-sm text-fg underline underline-offset-4">
              Go to the dashboard
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">Join {inv.organization}</h1>
            <p className="text-sm text-muted">
              {inv.inviter} invited you as {inv.role === "admin" ? "an" : "a"} {inv.role ?? "member"}: you will use its
              API keys and see its usage.
            </p>
            <div className="flex gap-2">
              <form action={acceptInvitation} className="flex-1">
                <input type="hidden" name="invitationId" value={id} />
                <Button type="submit" className="w-full">
                  Accept
                </Button>
              </form>
              <form action={rejectInvitation}>
                <input type="hidden" name="invitationId" value={id} />
                <Button type="submit" variant="ghost">
                  Decline
                </Button>
              </form>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
