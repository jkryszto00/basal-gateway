import { describe, expect, it } from "bun:test";
import { completeUsage, countBranches, decisionRequest } from "./index";
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

describe("api keys", () => {
  it("generates keys whose hash matches and that are recognised", () => {
    const { key, hash, prefix } = generateApiKey();
    expect(looksLikeApiKey(key)).toBe(true);
    expect(hashApiKey(key)).toBe(hash);
    expect(key.startsWith(prefix)).toBe(true);
    expect(looksLikeApiKey("sk-other")).toBe(false);
  });
});

describe("usage of basal-1.0 servers", () => {
  const questions = decisionRequest.parse({
    state: "x",
    questions: { a: { criteria: ["x", "y"] }, b: { type: "multi", criteria: ["p", "q", "r", "s"] } },
  }).questions;

  it("counts one branch per question and per multi label", () => {
    expect(countBranches(questions)).toBe(5);
  });

  it("keeps what the server reports and fills in the rest", () => {
    expect(completeUsage({ input_tokens: 10 }, { questions }, 12.345)).toEqual({
      input_tokens: 10,
      output_tokens: 0,
      questions: 2,
      branches: 5,
      latency_ms: 12.35,
    });
    const full = { input_tokens: 10, output_tokens: 0, questions: 9, branches: 9, latency_ms: 1 };
    expect(completeUsage(full, { questions }, 99)).toEqual(full);
  });
});
