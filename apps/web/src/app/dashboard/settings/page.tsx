import { DeleteAccountForm, PasswordForm } from "@/components/settings-forms";
import { Card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { signInMethods } from "@/lib/data";

const METHOD_NAMES: Record<string, string> = { credential: "Email and password", github: "GitHub", google: "Google" };

export default async function Settings() {
  const [user, methods] = await Promise.all([requireUser(), signInMethods()]);
  const hasPassword = methods.includes("credential");
  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      <Card className="p-5">
        <h2 className="font-semibold">Account</h2>
        <dl className="mt-3 grid max-w-md grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Name</dt>
          <dd>{user.name}</dd>
          <dt className="text-muted">Email</dt>
          <dd>{user.email}</dd>
          <dt className="text-muted">Sign in with</dt>
          <dd>{methods.map((m) => METHOD_NAMES[m] ?? m).join(", ")}</dd>
        </dl>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold">{hasPassword ? "Change password" : "Set a password"}</h2>
        <p className="mb-4 mt-1 text-sm text-muted">
          {hasPassword
            ? "Changing the password signs out your other devices. API keys keep working."
            : "Your account uses GitHub or Google. Set a password to also sign in with your email."}
        </p>
        <PasswordForm hasPassword={hasPassword} />
      </Card>

      <Card className="border-danger/40 p-5">
        <h2 className="font-semibold text-danger">Delete account</h2>
        <p className="mb-4 mt-1 text-sm text-muted">
          Deletes your account with your personal organization and the organizations only you belong to, their API keys
          and usage, right away. API keys stop working immediately. This cannot be undone.
          {!hasPassword && " If you signed in more than a day ago, sign in again first."}
        </p>
        <DeleteAccountForm email={user.email} hasPassword={hasPassword} />
      </Card>
    </div>
  );
}
