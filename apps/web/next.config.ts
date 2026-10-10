import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// one .env at the repo root for every app (variables already set in the environment win)
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

// No cacheComponents: every dashboard page is per-user and dynamic, so the classic request-time rendering is simpler.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // self-contained server for the Docker image; traced from the monorepo root to include workspace packages
  output: "standalone",
  outputFileTracingRoot: join(process.cwd(), "../.."),
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
