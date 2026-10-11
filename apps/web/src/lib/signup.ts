import "server-only";
import { hasPendingInvitation } from "@basal/admin";
import { db } from "./db";

// Who may create an account:
//   open (default)  anyone, or with SIGNUP_ALLOWED_DOMAINS=acme.com,acme.pl only addresses at those domains
//   invite          only addresses with a pending invitation: from an instance admin (admin page or CLI) or to an
//                   organization; relies on email confirmation to prove the address
//   closed          nobody; accounts come from the admin page or CLI
// The same rule applies to email sign up and to GitHub / Google.
const mode = (process.env.SIGNUP_MODE ?? "open").toLowerCase();
if (!["open", "invite", "closed"].includes(mode)) throw new Error(`SIGNUP_MODE "${mode}": open, invite or closed`);
export const SIGNUP_MODE = mode as "open" | "invite" | "closed";
export const SIGNUP_OPEN = SIGNUP_MODE !== "closed";

export const SIGNUP_DOMAINS: readonly string[] = (process.env.SIGNUP_ALLOWED_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
  .filter(Boolean);

/** Whether a new account may be created for this address. */
export async function signupAllowed(email: string): Promise<boolean> {
  if (SIGNUP_MODE === "closed") return false;
  if (SIGNUP_MODE === "invite") return hasPendingInvitation(db, email);
  if (SIGNUP_DOMAINS.length === 0) return true;
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return SIGNUP_DOMAINS.includes(domain);
}

export function signupRefusal(): string {
  if (SIGNUP_MODE === "invite") return "Sign up is by invitation, and there is none for this address.";
  if (SIGNUP_MODE === "closed") return "Sign up is closed. Ask an administrator for an account.";
  return `Sign up is limited to addresses at ${SIGNUP_DOMAINS.join(", ")}.`;
}
