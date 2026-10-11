import type { z } from "zod";
import { type UpstreamConfig, upstreamConfig } from "./env";

export type UpstreamResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "timeout" }
  | { kind: "network"; error: string }
  /** every server of the model is at its maxInFlight */
  | { kind: "busy" };

/** Consecutive failures that take a server out of rotation, and for how long. */
const FAILURES_TO_OPEN = 3;
const OPEN_MS = 30_000;

/** One inference server speaking the basal API (basal-serve or basal-rs: own GPU, Modal, RunPod, ...). */
export class Server {
  private inFlight = 0;
  private failures = 0;
  private openUntil = 0;

  constructor(readonly cfg: UpstreamConfig) {}

  /** In-process backpressure: basal-serve queues without limit, so the gateway stops at maxInFlight. */
  tryAcquire(): boolean {
    if (this.inFlight >= this.cfg.maxInFlight) return false;
    this.inFlight++;
    return true;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /** Circuit breaker: after FAILURES_TO_OPEN failures in a row the server is tried last for OPEN_MS. */
  healthy(now = Date.now()): boolean {
    return now >= this.openUntil;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure(now = Date.now()): void {
    if (++this.failures >= FAILURES_TO_OPEN) this.openUntil = now + OPEN_MS;
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

/** Worth trying the next server: it did not answer, or failed on its side. A 4xx is the request's fault. */
const failedOver = (r: UpstreamResult) =>
  r.kind === "network" || r.kind === "timeout" || (r.kind === "ok" && r.status >= 500);

/**
 * A public model and its servers, in order of preference. A request goes to the first healthy server with room;
 * a full one overflows to the next, a failing one (unreachable, timeout, 5xx or 529) fails over to the next.
 * The first server sets the model's request format and body limit.
 */
export class Upstream {
  constructor(
    readonly model: string,
    readonly servers: Server[],
  ) {}

  get api() {
    return this.servers[0]!.cfg.api;
  }

  get maxBodyBytes() {
    return this.servers[0]!.cfg.maxBodyBytes;
  }

  get meta() {
    return this.servers[0]!.cfg.meta;
  }

  async decide(body: unknown): Promise<UpstreamResult> {
    const now = Date.now();
    const order = [...this.servers.filter((s) => s.healthy(now)), ...this.servers.filter((s) => !s.healthy(now))];
    let last: UpstreamResult = { kind: "busy" };
    for (const [i, server] of order.entries()) {
      if (!server.tryAcquire()) continue; // full: overflow to the next
      try {
        const result = await server.decide(body);
        if (!failedOver(result)) {
          server.recordSuccess();
          return result;
        }
        server.recordFailure();
        last = result;
        if (i < order.length - 1)
          console.warn(`upstream ${this.model} #${this.servers.indexOf(server)} failed, trying the next`);
      } finally {
        server.release();
      }
    }
    return last;
  }
}

type ConfigInput = z.input<typeof upstreamConfig>;

/** Model name -> its servers (one config, or a list in order of preference), validated with their defaults. */
export function createUpstreams(config: Record<string, ConfigInput | ConfigInput[]>): Map<string, Upstream> {
  return new Map(
    Object.entries(config).map(([model, cfg]) => [
      model,
      new Upstream(
        model,
        (Array.isArray(cfg) ? cfg : [cfg]).map((c) => new Server(upstreamConfig.parse(c))),
      ),
    ]),
  );
}
