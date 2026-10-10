import type { DecisionUsage } from "./request";

/** Money is kept as integer micro-USD (1 USD = 1_000_000) everywhere: ledger, usage, Redis balance. */
export const MICRO = 1_000_000;

export type ModelPrice = {
  /** micro-USD per 1M input tokens */
  inputPerMTok: number;
  /** micro-USD per 1k branches (one per question, one per label of a `multi`) */
  perKBranch: number;
};

/**
 * Default prices of the basal-1.5 models by public model name, roughly in line with their size; a model in UPSTREAMS
 * can set its own "pricing". With these, a 300-token state and one question costs ~$0.035 per 1k decisions on 4.5B.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "basal-1.5-mini": { inputPerMTok: 20_000, perKBranch: 10_000 },
  "basal-1.5": { inputPerMTok: 50_000, perKBranch: 20_000 },
  "basal-1.5-4.5B": { inputPerMTok: 50_000, perKBranch: 20_000 },
  "basal-1.5-max": { inputPerMTok: 120_000, perKBranch: 40_000 },
};

/** A model without a price is served for free; its usage is still recorded. */
export const FREE: ModelPrice = { inputPerMTok: 0, perKBranch: 0 };

export function costMicroUsd(price: ModelPrice, usage: Pick<DecisionUsage, "input_tokens" | "branches">): number {
  return Math.ceil((usage.input_tokens * price.inputPerMTok) / 1e6 + (usage.branches * price.perKBranch) / 1e3);
}

export function formatUsd(micro: number | bigint, digits = 4): string {
  return `$${(Number(micro) / MICRO).toFixed(digits)}`;
}
