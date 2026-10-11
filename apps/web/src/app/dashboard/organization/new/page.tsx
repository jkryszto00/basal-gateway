import { NewOrganizationForm } from "@/components/org-forms";
import { Card } from "@/components/ui";

export default function NewOrganization() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">New organization</h1>
        <p className="text-sm text-muted">
          A shared place for a team or a client: its own API keys, limits and usage, and members you invite.
        </p>
      </div>
      <Card className="p-5">
        <NewOrganizationForm />
      </Card>
    </div>
  );
}
