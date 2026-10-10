import { redirect } from "next/navigation";
import { resendVerification } from "@/app/actions";
import { EmailForm } from "@/components/auth-form";
import { Logo } from "@/components/logo";
import { Card } from "@/components/ui";
import { getOptionalUser } from "@/lib/auth";

// Landing page of the confirmation link: Better Auth verifies the token, signs the user in and redirects here,
// or appends ?error=TOKEN_EXPIRED / INVALID_TOKEN.
export default async function VerifyPage({ searchParams }: PageProps<"/verify">) {
  const { error } = await searchParams;
  if (!error) redirect((await getOptionalUser()) ? "/dashboard?welcome=1" : "/login?verified=1");
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="mb-8">
        <Logo />
      </div>
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold">{error === "TOKEN_EXPIRED" ? "Link expired" : "Link not valid"}</h1>
        <p className="mb-6 mt-1 text-sm text-muted">
          {error === "TOKEN_EXPIRED"
            ? "Confirmation links work for 24 hours. Enter your email and we will send a new one."
            : "This confirmation link is broken or was already used. Enter your email and we will send a new one."}
        </p>
        <EmailForm action={resendVerification} submit="Send a new link" />
      </Card>
    </main>
  );
}
