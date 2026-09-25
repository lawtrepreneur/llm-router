import { describe, expect, it } from "vitest";
import { canExecuteRoute, decideRoute } from "../../src/router/boundary";

describe("native routing boundary", () => {
  it("fails closed when confidence is below the execution threshold", () => {
    const decision = decideRoute(
      { prompt: "route this" },
      [{ tier: "medium" }],
      (_request, candidates) => ({ candidate: candidates[0], confidence: 0.4, reason: "ambiguous" }),
      { now: () => "2026-09-24T00:00:00.000Z" },
    );

    expect(decision.choice).toBeUndefined();
    expect(decision.fallback).toEqual({
      action: "escalate",
      reason: "low-confidence route: ambiguous",
    });
    expect(decision.receipt.router).toBe("native");
  });

  it("fails closed for a non-finite confidence", () => {
    const decision = decideRoute(
      { prompt: "route this" },
      [{ tier: "medium" }],
      (_request, candidates) => ({ candidate: candidates[0], confidence: Number.NaN, reason: "bad score" }),
    );

    expect(decision.choice).toBeUndefined();
    expect(decision.confidence).toBe(0);
    expect(Number.isFinite(decision.receipt.candidateCount)).toBe(true);
  });

  it("fails closed when the selected candidate was not supplied", () => {
    const decision = decideRoute(
      { prompt: "route this" },
      [{ tier: "medium" }],
      () => ({ candidate: { tier: "medium" }, confidence: 0.9, reason: "looks good" }),
    );

    expect(decision.choice).toBeUndefined();
    expect(decision.fallback?.reason).toBe("selected route is not a supplied candidate");
  });

  it("does not execute a producer for a fallback decision", async () => {
    const decision = decideRoute(
      { prompt: "route this" },
      [{ tier: "medium" }],
      (_request, candidates) => ({ candidate: candidates[0], confidence: 0.1, reason: "uncertain" }),
    );
    let producerCalls = 0;

    if (canExecuteRoute(decision)) producerCalls++;

    expect(producerCalls).toBe(0);
  });
});
