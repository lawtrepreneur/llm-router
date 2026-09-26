import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDeciderPrompt, callDecider, DeciderError, parseDeciderLogprobs } from "../../src/classifier/decider.js";

const tierQ = { question: "Which model tier should handle this task?", options: ["fast", "medium", "heavy"] };

afterEach(() => vi.unstubAllGlobals());

function okResponse(top: { token: string; logprob: number }[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ text: "A", logprobs: { content: [{ token: "A", top_logprobs: top }] } }] }),
  } as unknown as Response;
}

describe("buildDeciderPrompt", () => {
  it("single question layout", () => {
    const p = buildDeciderPrompt("Fix a bug.", [tierQ]);
    expect(p).toBe("Context:\nFix a bug.\n\nQuestion: Which model tier should handle this task?\nOptions:\n(A) fast\n(B) medium\n(C) heavy\nAnswer: (");
  });
  it("multi-question layout", () => {
    const p = buildDeciderPrompt("Task.", [
      tierQ,
      { question: "Needs live data?", options: ["no", "yes"] },
    ]);
    expect(p).toContain("Question 1: ");
    expect(p).toContain("Question 2: ");
    expect(p).toContain("\nAnswer 1: (\nAnswer 2: (");
  });
  it("rejects empty task text", () => {
    expect(() => buildDeciderPrompt("  ", [tierQ])).toThrow(DeciderError);
  });
  it("rejects <2 options", () => {
    expect(() => buildDeciderPrompt("t", [{ question: "q", options: ["only"] }])).toThrow(DeciderError);
  });
});

describe("parseDeciderLogprobs", () => {
  it("softmax aligns with options order and sums to 1", () => {
    const a = parseDeciderLogprobs({ choices: [{ logprobs: { content: [{ top_logprobs: [
      { token: "A", logprob: Math.log(0.6) },
      { token: "B", logprob: Math.log(0.3) },
      { token: "C", logprob: Math.log(0.1) },
    ] }] } }] }, [tierQ])[0];
    expect(a.choice).toBe("fast");
    expect(a.probabilities[0]).toBeCloseTo(0.6);
    expect(a.probabilities.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });
  it("unseen option letters get probability 0", () => {
    const a = parseDeciderLogprobs({ choices: [{ logprobs: { content: [{ top_logprobs: [
      { token: "B", logprob: Math.log(1) },
    ] }] } }] }, [tierQ])[0];
    expect(a.probabilities).toEqual([0, 1, 0]);
    expect(a.choice).toBe("medium");
  });
  it("no letter tokens -> DeciderError", () => {
    expect(() => parseDeciderLogprobs({ choices: [{ logprobs: { content: [{ top_logprobs: [{ token: "1", logprob: -1 }] }] } }] }, [tierQ])).toThrow(DeciderError);
  });
  it("malformed shape -> DeciderError", () => {
    expect(() => parseDeciderLogprobs({}, [tierQ])).toThrow(DeciderError);
    expect(() => parseDeciderLogprobs({ choices: [] }, [tierQ])).toThrow(DeciderError);
  });
});

describe("callDecider", () => {
  it("happy path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([
      { token: "A", logprob: Math.log(0.5) },
      { token: "B", logprob: Math.log(0.4) },
      { token: "C", logprob: Math.log(0.1) },
    ])));
    const answers = await callDecider("Fix a bug.", [tierQ]);
    expect(answers).toHaveLength(1);
    expect(answers[0].choice).toBe("fast");
    expect(answers[0].probabilities.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });
  it("HTTP 500 -> DeciderError with status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 } as Response)));
    await expect(callDecider("t", [tierQ])).rejects.toThrow(/HTTP 500/);
  });
  it("malformed JSON -> DeciderError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } } as unknown as Response)));
    await expect(callDecider("t", [tierQ])).rejects.toThrow(DeciderError);
  });
  it("fetch rejection -> DeciderError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(callDecider("t", [tierQ])).rejects.toThrow(DeciderError);
  });
  it("abort/timeout -> DeciderError timeout", async () => {
    const e = new Error("aborted"); e.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn(async () => { throw e; }));
    await expect(callDecider("t", [tierQ])).rejects.toThrow(/timeout/);
  });
});
