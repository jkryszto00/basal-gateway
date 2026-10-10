import { describe, expect, it } from "bun:test";
import { costMicroUsd, decisionRequest, MODELS } from "./index";
import { generateApiKey, hashApiKey, looksLikeApiKey } from "./keys";

const ok = {
  state: "Klient: nie mogę zalogować się do bankowości.",
  questions: { dept: { type: "choice", instructions: "Dział?", criteria: { cards: "Karty", online: "Bankowość" } } },
};

describe("decisionRequest", () => {
  it("accepts a valid request and keeps unknown fields", () => {
    const r = decisionRequest.parse({ ...ok, facts: "auto", extra: 1 });
    expect(r.extra).toBe(1);
    expect(r.questions.dept?.type).toBe("choice");
  });

  it("defaults the question type to choice", () => {
    const r = decisionRequest.parse({ state: "x", questions: { q: { criteria: ["a", "b"] } } });
    expect(r.questions.q?.type).toBe("choice");
  });

  it("allows noul without criteria", () => {
    expect(decisionRequest.safeParse({ state: "x", questions: { q: { type: "noul" } } }).success).toBe(true);
  });

  it("rejects too few or too many options", () => {
    expect(decisionRequest.safeParse({ state: "x", questions: { q: { criteria: ["a"] } } }).success).toBe(false);
    const many = Array.from({ length: 11 }, (_, i) => `o${i}`);
    expect(decisionRequest.safeParse({ state: "x", questions: { q: { criteria: many } } }).success).toBe(false);
  });

  it("rejects missing state, no questions and oversized state", () => {
    expect(decisionRequest.safeParse({ questions: ok.questions }).success).toBe(false);
    expect(decisionRequest.safeParse({ state: "x", questions: {} }).success).toBe(false);
    expect(decisionRequest.safeParse({ ...ok, state: "x".repeat(40_000) }).success).toBe(false);
  });
});

describe("pricing", () => {
  it("charges input tokens and branches in micro-USD, rounded up", () => {
    expect(costMicroUsd(MODELS["basal-1.5"]!, { input_tokens: 300, branches: 1 })).toBe(35);
    expect(costMicroUsd(MODELS["basal-1.5"]!, { input_tokens: 1, branches: 0 })).toBe(1);
    expect(costMicroUsd(MODELS["basal-1.5"]!, { input_tokens: 0, branches: 0 })).toBe(0);
  });
});

describe("api keys", () => {
  it("generates keys whose hash matches and that are recognised", () => {
    const { key, hash, prefix } = generateApiKey();
    expect(looksLikeApiKey(key)).toBe(true);
    expect(hashApiKey(key)).toBe(hash);
    expect(key.startsWith(prefix)).toBe(true);
    expect(looksLikeApiKey("sk-other")).toBe(false);
  });
});
