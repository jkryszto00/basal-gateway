import "server-only";

export type ModelInfo = { name: string; default: boolean };

// The gateway is the source of truth for models (UPSTREAMS); GATEWAY_INTERNAL_URL when the dashboard
// reaches it on another address than the public one.
const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_PUBLIC_URL ?? "http://localhost:8787";

/** The gateway's models, or null when it cannot be reached. */
export async function listModels(): Promise<ModelInfo[] | null> {
  try {
    const res = await fetch(new URL("/v1/models", GATEWAY), {
      signal: AbortSignal.timeout(3_000),
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return ((await res.json()) as { models: ModelInfo[] }).models;
  } catch {
    return null;
  }
}
