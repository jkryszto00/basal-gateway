import "server-only";
import { notFound } from "next/navigation";
import { type CurrentUser, requireUser } from "./auth";

// Instance admins: ADMIN_EMAILS=ana@acme.com,@acme.com (an entry starting with @ covers a whole domain). They see the
// admin page; everyone else gets a 404 there.
const ADMINS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function isInstanceAdmin(email: string): boolean {
  const address = email.toLowerCase();
  return ADMINS.some((a) => (a.startsWith("@") ? address.endsWith(a) : address === a));
}

export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!isInstanceAdmin(user.email)) notFound();
  return user;
}
