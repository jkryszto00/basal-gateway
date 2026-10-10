import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth-form";

// the token is in the URL: do not hand it to other sites in the Referer header
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token, error } = await searchParams;
  if (typeof token !== "string" || error)
    return (
      <>
        <h1 className="text-lg font-semibold">Link expired</h1>
        <p className="mb-6 mt-1 text-sm text-muted">This reset link has expired or was already used.</p>
        <Link href="/forgot-password" className="text-sm text-fg underline underline-offset-4">
          Ask for a new link
        </Link>
      </>
    );
  return (
    <>
      <h1 className="mb-6 text-lg font-semibold">Choose a new password</h1>
      <ResetPasswordForm token={token} />
    </>
  );
}
