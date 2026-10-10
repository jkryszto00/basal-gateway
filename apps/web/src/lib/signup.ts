import "server-only";

// Who may create an account. SIGNUP_MODE=closed: nobody (accounts come from the admin CLI); open (default): anyone,
// or with SIGNUP_ALLOWED_DOMAINS=acme.com,acme.pl only addresses at those domains (email and GitHub / Google alike).
const mode = (process.env.SIGNUP_MODE ?? "open").toLowerCase();
if (mode !== "open" && mode !== "closed") throw new Error(`SIGNUP_MODE "${mode}": open or closed`);
export const SIGNUP_OPEN = mode === "open";

const DOMAINS = (process.env.SIGNUP_ALLOWED_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
  .filter(Boolean);

export const SIGNUP_DOMAINS: readonly string[] = DOMAINS;

/** Whether a new account may be created for this address. */
export function signupAllowed(email: string): boolean {
  if (!SIGNUP_OPEN) return false;
  if (DOMAINS.length === 0) return true;
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return DOMAINS.includes(domain);
}
