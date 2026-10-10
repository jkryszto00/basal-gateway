import "server-only";
import { headers } from "next/headers";

// The header the platform in front of the app sets to the visitor's IP: cf-connecting-ip behind Cloudflare. Only
// trust it when the origin cannot be reached around that proxy, otherwise a client can send any value.
const IP_HEADER = (process.env.CLIENT_IP_HEADER ?? "x-forwarded-for").toLowerCase();

export async function clientIp(): Promise<string | null> {
  const value = (await headers()).get(IP_HEADER);
  return value?.split(",")[0]?.trim() || null;
}
