import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// one .env at the repo root for every app (variables already set in the environment win)
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

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

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // only when the dashboard is served over HTTPS (BETTER_AUTH_URL), or browsers would pin a plain-HTTP dev setup
  ...(https ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

// No cacheComponents: every dashboard page is per-user and dynamic, so the classic request-time rendering is simpler.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
  transpilePackages: ["@basal/db", "@basal/shared"], // workspace packages ship TypeScript source
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
