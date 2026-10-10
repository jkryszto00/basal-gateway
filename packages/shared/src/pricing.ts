import type { DecisionUsage } from "./request";

/** Money is kept as integer micro-USD (1 USD = 1_000_000) everywhere: ledger, usage, Redis balance. */
export const MICRO = 1_000_000;

export type ModelPrice = {
  /** micro-USD per 1M input tokens */
  inputPerMTok: number;
  /** micro-USD per 1k branches (one per question, one per label of a `multi`) */
  perKBranch: number;
};

// Placeholder prices: a 300-token state with one question costs ~$0.035 per 1k decisions.
export const MODELS: Record<string, ModelPrice> = {
  "basal-1.5": { inputPerMTok: 50_000, perKBranch: 20_000 },
};

export const DEFAULT_MODEL = "basal-1.5";

export function costMicroUsd(price: ModelPrice, usage: Pick<DecisionUsage, "input_tokens" | "branches">): number {
  return Math.ceil((usage.input_tokens * price.inputPerMTok) / 1e6 + (usage.branches * price.perKBranch) / 1e3);
}

export function formatUsd(micro: number | bigint, digits = 4): string {
  return `$${(Number(micro) / MICRO).toFixed(digits)}`;
}
