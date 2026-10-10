// A stand-in for a basal inference server (basal-rs / basal-serve): same endpoints and response shape, made-up
// but deterministic answers, no GPU. For developing and testing the gateway and the dashboard, never for real use.

type Question = { type?: string; criteria?: unknown; levels?: unknown };
type Body = { model?: string; state?: unknown; questions?: Record<string, Question> };

const MODELS = ["basal-1.5-mini", "basal-1.5-4.5B", "basal-1.5-max"];

/** Stable pseudo-random number in [0, 1) from a string, so the same request always gets the same answer. */
function unit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

function optionKeys(q: Question): string[] {
  const c = q.criteria ?? q.levels;
  if (Array.isArray(c)) return c.map((_, i) => String(i));
  if (c && typeof c === "object") return Object.keys(c);
  return [];
}

/** Probabilities over `keys` that sum to 1, peaked on one of them. */
function distribution(keys: string[], seed: string): Record<string, number> {
  const top = Math.floor(unit(seed) * keys.length);
  const peak = 0.6 + unit(`${seed}:peak`) * 0.35;
  const rest = (1 - peak) / Math.max(1, keys.length - 1);
  return Object.fromEntries(keys.map((k, i) => [k, Number((i === top ? peak : rest).toFixed(4))]));
}

function answer(name: string, q: Question, seed: string) {
  const type = q.type ?? "choice";
  const s = `${seed}:${name}`;
  if (type === "noul") {
    const p = Number((0.05 + unit(s) * 0.9).toFixed(4));
    return {
      type,
      noul: p,
      probabilities: { true: p, false: Number((1 - p).toFixed(4)) },
      confidence: Math.max(p, 1 - p),
    };
  }
  const keys = optionKeys(q);
  if (type === "multi") {
    const labels = Object.fromEntries(keys.map((k) => [k, Number(unit(`${s}:${k}`).toFixed(4))]));
    return { type, labels, selected: keys.filter((k) => labels[k]! >= 0.5) };
  }
  const probabilities = distribution(keys, s);
  const best = keys.reduce((a, b) => (probabilities[b]! > probabilities[a]! ? b : a), keys[0]!);
  const confidence = probabilities[best]!;
  if (type === "score") {
    const score = keys.reduce((sum, k, i) => sum + i * probabilities[k]!, 0);
    return { type, score: Number(score.toFixed(4)), probabilities, confidence };
  }
  if (type === "act") return { type, act: best, probabilities, confidence };
  return { type, choice: best, probabilities, confidence };
}

/** basal's usage: tokens roughly from the text, one branch per question and per multi label. */
function usage(body: Body, latencyMs: number) {
  const questions = Object.values(body.questions ?? {});
  const text = JSON.stringify(body.state ?? "") + JSON.stringify(body.questions ?? {});
  const branches = questions.reduce((n, q) => n + (q.type === "multi" ? optionKeys(q).length : 1), 0);
  return {
    input_tokens: Math.ceil(text.length / 4) * Math.max(1, branches),
    output_tokens: 0,
    questions: questions.length,
    branches,
    latency_ms: Number(latencyMs.toFixed(2)),
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Special states to exercise the gateway's error paths: "mock:422" (rejected by the model), "mock:529" (server
 * overloaded), "mock:500" (inference failure), "mock:slow:<ms>" (answers after a delay).
 */
export async function handle(req: Request): Promise<Response> {
  const t0 = performance.now();
  const { pathname } = new URL(req.url);
  if (req.method === "GET" && pathname === "/health") return json({ status: "ok", mock: true });
  if (req.method === "GET" && pathname === "/v1/models") return json({ models: MODELS.map((id) => ({ id })) });
  if (req.method !== "POST" || (pathname !== "/v1/systemone" && pathname !== "/v1/basal"))
    return json({ error: "not found" }, 404);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const state = typeof body.state === "string" ? body.state : "";
  if (state === "mock:422") return json({ error: "option letters are not single tokens" }, 422);
  if (state === "mock:529") return json({ error: "overloaded" }, 529);
  if (state === "mock:500") return json({ error: "inference failed: CUDA out of memory" }, 500);
  const slow = /^mock:slow:(\d+)$/.exec(state);
  if (slow) await Bun.sleep(Math.min(Number(slow[1]), 600_000));

  const questions = body.questions ?? {};
  if (!Object.keys(questions).length) return json({ error: "no questions" }, 422);
  for (const [name, q] of Object.entries(questions)) {
    const n = optionKeys(q).length;
    if ((q.type ?? "choice") !== "noul" && (n < 2 || n > 10)) return json({ error: `${name}: 2..10 options` }, 422);
  }
  const seed = JSON.stringify(body.state);
  return json({
    model: body.model ?? MODELS[1],
    answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, answer(name, q, seed)])),
    usage: usage(body, performance.now() - t0),
  });
}
