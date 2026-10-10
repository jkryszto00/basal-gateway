import Link from "next/link";
import { requestPasswordReset } from "@/app/actions";
import { EmailForm } from "@/components/auth-form";

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="text-lg font-semibold">Reset your password</h1>
      <p className="mb-6 mt-1 text-sm text-muted">We will email you a link to choose a new password.</p>
      <EmailForm action={requestPasswordReset} submit="Send reset link" />
      <p className="mt-4 text-center text-sm text-muted">
        <Link href="/login" className="text-fg underline underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
