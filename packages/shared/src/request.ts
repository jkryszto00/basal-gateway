import { z } from "zod";

// Limits checked before a request reaches a GPU. basal itself accepts 2..10 options per question.
export const LIMITS = {
  maxQuestions: 16,
  minOptions: 2,
  maxOptions: 10,
  maxStateChars: 32_000, // ~8k tokens; long documents take GPU time
} as const;

export const QUESTION_TYPES = ["choice", "noul", "score", "multi", "act"] as const;

const criteria = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]);

// Unknown fields (option_keys, evidence, costs, threshold, ...) pass through to basal-serve unchanged.
const question = z
  .looseObject({
    type: z.enum(QUESTION_TYPES).default("choice"),
    instructions: z.unknown().optional(),
    criteria: criteria.optional(),
    levels: criteria.optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type === "noul") return; // yes/no: criteria optional ({"true": ..., "false": ...})
    const c = q.criteria ?? q.levels;
    const n = c === undefined ? 0 : Array.isArray(c) ? c.length : Object.keys(c).length;
    if (n < LIMITS.minOptions || n > LIMITS.maxOptions) {
      ctx.addIssue({
        code: "custom",
        message: `${q.type} needs ${LIMITS.minOptions}..${LIMITS.maxOptions} options in criteria, got ${n}`,
        path: ["criteria"],
      });
    }
  });

export const decisionRequest = z
  .looseObject({
    model: z.string().optional(),
    state: z.unknown().refine((s) => s !== undefined && s !== null && s !== "", "state is required"),
    questions: z
      .record(z.string(), question)
      .refine((qs) => Object.keys(qs).length >= 1, "at least one question")
      .refine((qs) => Object.keys(qs).length <= LIMITS.maxQuestions, `at most ${LIMITS.maxQuestions} questions`),
    facts: z.enum(["off", "auto"]).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.state === undefined || r.state === null) return; // already reported by the state refinement
    const chars = typeof r.state === "string" ? r.state.length : (JSON.stringify(r.state)?.length ?? 0);
    if (chars > LIMITS.maxStateChars) {
      ctx.addIssue({ code: "custom", message: `state is ${chars} chars, limit ${LIMITS.maxStateChars}`, path: ["state"] });
    }
  });

export type DecisionRequest = z.infer<typeof decisionRequest>;

/** The `usage` block the gateway returns and records. */
export const decisionUsage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  questions: z.number().int().nonnegative(),
  branches: z.number().int().nonnegative(),
  latency_ms: z.number().nonnegative(),
});

export type DecisionUsage = z.infer<typeof decisionUsage>;

/**
 * `usage` as inference servers return it: basal-1.5 servers report every field, basal-1.0 servers only the token
 * counts (and basal-rs adds latency_ms).
 */
export const serverUsage = decisionUsage.partial({ output_tokens: true, questions: true, branches: true, latency_ms: true });

/** One branch per question, one per label of a `multi` question (what basal-1.5 servers report). */
export function countBranches(questions: DecisionRequest["questions"]): number {
  return Object.values(questions).reduce((n, q) => {
    if (q.type !== "multi") return n + 1;
    const labels = q.criteria ?? q.levels;
    return n + (Array.isArray(labels) ? labels.length : Object.keys(labels ?? {}).length);
  }, 0);
}

/** Fills in what a basal-1.0 server leaves out: questions and branches from the request, latency as measured. */
export function completeUsage(
  usage: z.infer<typeof serverUsage>,
  request: Pick<DecisionRequest, "questions">,
  measuredLatencyMs: number,
): DecisionUsage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens ?? 0,
    questions: usage.questions ?? Object.keys(request.questions).length,
    branches: usage.branches ?? countBranches(request.questions),
    latency_ms: usage.latency_ms ?? Math.round(measuredLatencyMs * 100) / 100,
  };
}
