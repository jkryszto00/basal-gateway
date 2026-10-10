import { NextResponse } from "next/server";

// Security headers, set per request at runtime (not in next.config, which is frozen at build time) so one Docker
// image follows its instance's settings, e.g. HSTS only when BETTER_AUTH_URL is HTTPS.
const dev = process.env.NODE_ENV !== "production";
const https = (process.env.BETTER_AUTH_URL ?? "").startsWith("https://");
const TURNSTILE = "https://challenges.cloudflare.com";

// Content Security Policy: our own origin, plus the Turnstile widget. Next.js inlines its bootstrap scripts, so
// scripts need 'unsafe-inline' (and 'unsafe-eval' for the dev server). form-action also lets sign in redirect to
// GitHub and Google.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""} ${TURNSTILE}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  `frame-src ${TURNSTILE}`,
  "frame-ancestors 'none'",
  "form-action 'self' https://github.com https://accounts.google.com",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const HEADERS: [string, string][] = [
  ["Content-Security-Policy", csp],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  // only over HTTPS, or browsers would pin a plain-HTTP setup to HTTPS
  ...(https ? [["Strict-Transport-Security", "max-age=63072000; includeSubDomains"] as [string, string]] : []),
];

export function proxy() {
  const res = NextResponse.next();
  for (const [k, v] of HEADERS) res.headers.set(k, v);
  return res;
}

export const config = {
  // pages and API routes; built assets do not need them
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
