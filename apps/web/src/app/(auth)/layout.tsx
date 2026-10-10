import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { Card } from "@/components/ui";
import { getOptionalUser } from "@/lib/auth";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  if (await getOptionalUser()) redirect("/dashboard");
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="mb-8">
        <Logo />
      </div>
      <Card className="w-full max-w-sm p-6">{children}</Card>
    </main>
  );
}
