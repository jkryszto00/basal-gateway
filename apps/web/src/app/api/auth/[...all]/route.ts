import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

const handler = toNextJsHandler(auth);

// Only the links we email and the GitHub / Google redirects are served over HTTP. Sign up, sign in and password
// resets go through server actions, which check Turnstile and our rate limits; exposing Better Auth's POST endpoints
// would let a script skip both.
const PUBLIC = [
  /^\/api\/auth\/verify-email$/,
  /^\/api\/auth\/reset-password\/[^/]+$/,
  /^\/api\/auth\/callback\/(github|google)$/,
];

export function GET(req: Request) {
  const { pathname } = new URL(req.url);
  if (!PUBLIC.some((p) => p.test(pathname))) return new Response("Not Found", { status: 404 });
  return handler.GET(req);
}
