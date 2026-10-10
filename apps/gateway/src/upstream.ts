import type { UpstreamConfig } from "./env";

export type UpstreamResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "timeout" }
  | { kind: "network"; error: string };

/** One inference server speaking the basal API (basal-serve or basal-rs: own GPU, Modal, RunPod, ...). */
export class Upstream {
  private inFlight = 0;

  constructor(
    readonly model: string,
    private readonly cfg: UpstreamConfig,
  ) {}

  /** In-process backpressure: basal-serve queues without limit, so the gateway refuses past maxInFlight. */
  tryAcquire(): boolean {
    if (this.inFlight >= this.cfg.maxInFlight) return false;
    this.inFlight++;
    return true;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  get load(): number {
    return this.inFlight;
  }

  async decide(body: unknown): Promise<UpstreamResult> {
    try {
      // fetch follows Modal's 303 "still running" redirects (one per 150 s) on its own
      const res = await fetch(new URL("/v1/systemone", this.cfg.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON error page from a proxy: keep the text
      }
      return { kind: "ok", status: res.status, body: parsed };
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") return { kind: "timeout" };
      return { kind: "network", error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export function createUpstreams(config: Record<string, UpstreamConfig>): Map<string, Upstream> {
  return new Map(Object.entries(config).map(([model, cfg]) => [model, new Upstream(model, cfg)]));
}
