import { describe, expect, it } from "bun:test";
import { decisionUsage } from "@basal/shared";
import { handle } from "./mock";

const post = (body: unknown) =>
  handle(new Request("http://mock/v1/basal", { method: "POST", body: JSON.stringify(body) }));

const request = {
  state: "Order #1042 arrived damaged.",
  questions: {
    intent: { type: "choice", criteria: { refund: "Refund", replace: "Replacement" } },
    urgent: { type: "noul" },
    tags: { type: "multi", criteria: ["a", "b", "c"] },
  },
};

describe("mock basal server", () => {
  it("answers every question with a usage block the gateway accepts", async () => {
    const res = await post(request);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { answers: Record<string, { type: string }>; usage: unknown };
    expect(Object.keys(out.answers)).toEqual(["intent", "urgent", "tags"]);
    const usage = decisionUsage.parse(out.usage);
    expect(usage).toMatchObject({ questions: 3, branches: 5 }); // 1 + 1 + 3 multi labels
  });

  it("is deterministic", async () => {
    const a = (await (await post(request)).json()) as { answers: unknown };
    const b = (await (await post(request)).json()) as { answers: unknown };
    expect(a.answers).toEqual(b.answers);
  });

  it("simulates errors on request", async () => {
    expect((await post({ ...request, state: "mock:422" })).status).toBe(422);
    expect((await post({ ...request, state: "mock:529" })).status).toBe(529);
    expect((await post({ ...request, state: "mock:500" })).status).toBe(500);
    expect((await post({ state: "x", questions: { q: { criteria: ["only"] } } })).status).toBe(422);
  });
});
