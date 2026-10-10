import { DEFAULT_PRICES, FREE, type ModelPrice } from "@basal/shared";
import type { z } from "zod";
import { type UpstreamConfig, upstreamConfig } from "./env";

export type UpstreamResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "timeout" }
  | { kind: "network"; error: string };

/** One inference server speaking the basal API (basal-serve or basal-rs: own GPU, Modal, RunPod, ...). */
export class Upstream {
  private inFlight = 0;
  /** what a request to this model costs: its own pricing, else the default price list, else nothing */
  readonly price: ModelPrice;
  readonly priced: boolean;

  constructor(
    readonly model: string,
    private readonly cfg: UpstreamConfig,
  ) {
    const price = cfg.pricing ?? DEFAULT_PRICES[model];
    this.price = price ?? FREE;
    this.priced = price !== undefined;
  }

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
      const res = await fetch(new URL(this.cfg.path, this.cfg.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
        },
        body: JSON.stringify(this.cfg.model ? { ...(body as object), model: this.cfg.model } : body),
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

/** Model name -> upstream; each config is validated and gets its defaults (path, maxInFlight, timeoutMs). */
export function createUpstreams(config: Record<string, z.input<typeof upstreamConfig>>): Map<string, Upstream> {
  return new Map(Object.entries(config).map(([model, cfg]) => [model, new Upstream(model, upstreamConfig.parse(cfg))]));
}
