import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// one .env at the repo root for every app (variables already set in the environment win)
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

// No cacheComponents: every dashboard page is per-user and dynamic, so the classic request-time rendering is simpler.
const nextConfig: NextConfig = {
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
