import "server-only";

// Cloudflare Turnstile on sign up, optional: without TURNSTILE_SECRET_KEY there is no widget and no check.
// Cloudflare's test keys (always pass): site 1x00000000000000000000AA, secret 1x0000000000000000000000000000000AA.
const SECRET = process.env.TURNSTILE_SECRET_KEY;
export const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY;

export async function verifyTurnstile(token: FormDataEntryValue | null, ip: string | null): Promise<boolean> {
  if (!SECRET) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: SECRET, response: token });
  if (ip) body.set("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5_000),
    });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!data.success) console.warn("[turnstile] rejected", data["error-codes"]);
    return data.success === true;
  } catch (e) {
    console.error("[turnstile] siteverify failed", e); // fail closed: no sign up without a verified challenge
    return false;
  }
}
