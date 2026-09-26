import { describe, expect, it } from "vitest";
import { shadowAgreement, shadowArgmax, shadowCalibration, shadowLatency, SHADOW_TIER_ORDER } from "../../src/contract/shadow-metrics.js";
import type { RoutingRecord } from "../../src/receipts/store.js";

function rec(sc: RoutingRecord["shadowClassifier"], actual = "medium"): RoutingRecord {
  return {
    kind: "routing", version: 1, id: "r1", timestamp: "t", intendedTarget: actual, actualTarget: actual,
    escalation: { occurred: false, count: 0 }, verification: { status: "passed" }, latencyMs: 1,
    outcome: "accepted", policyVersion: "p", registryVersion: "r", adapterMode: "shadow", ...(sc ? { shadowClassifier: sc } : {}),
  } as RoutingRecord;
}

describe("shadowArgmax", () => {
  it("picks max aligned to tier order", () => {
    expect(shadowArgmax([0.2, 0.7, 0.1])).toBe("medium");
    expect(shadowArgmax([0.9, 0.05, 0.05])).toBe("fast");
  });
  it("null on wrong length / invalid entries", () => {
    expect(shadowArgmax([0.5, 0.5])).toBeNull();
    expect(shadowArgmax([NaN, 0.5, 0.5])).toBeNull();
  });
});

describe("shadowAgreement", () => {
  it("counts agreement and disagreement cells", () => {
    const m = shadowAgreement([
      rec({ probabilities: [0.8, 0.1, 0.1], disagreement: false, latencyMs: 70 }, "fast"),
      rec({ probabilities: [0.1, 0.8, 0.1], disagreement: true, latencyMs: 80 }, "fast"),
      rec({ unavailable: true, disagreement: false, error: "timeout", latencyMs: 5000 }, "heavy"),
      rec(undefined), // no shadow field
    ]);
    expect(m.total).toBe(3);
    expect(m.observations).toBe(2);
    expect(m.disagreements).toBe(1);
    expect(m.unavailable).toBe(1);
    expect(m.matrix.fast.fast).toBe(1);
    expect(m.matrix.fast.medium).toBe(1);
  });
});

describe("shadowCalibration", () => {
  it("brier over one-hot native labels", () => {
    const m = shadowCalibration([
      rec({ probabilities: [0.9, 0.05, 0.05], disagreement: false, latencyMs: 1 }, "fast"),
      rec({ probabilities: [0.1, 0.8, 0.1], disagreement: true, latencyMs: 1 }, "fast"),
    ]);
    expect(m).not.toBeNull();
    // native=fast: obs1 p=0.9 label=1; obs2 p=0.1 label=0 → brier = ((0.1)^2+(0.1)^2)/2 = 0.01
    expect(m!.brier).toBeCloseTo(0.01);
  });
  it("null when nothing usable", () => {
    expect(shadowCalibration([rec(undefined)])).toBeNull();
    expect(shadowCalibration([rec({ unavailable: true, disagreement: false, latencyMs: 1 })])).toBeNull();
  });
});

describe("shadowLatency", () => {
  it("p50/p95 over usable observations only", () => {
    const l = shadowLatency([
      rec({ probabilities: [1, 0, 0], disagreement: false, latencyMs: 60 }),
      rec({ probabilities: [1, 0, 0], disagreement: false, latencyMs: 80 }),
      rec({ probabilities: [1, 0, 0], disagreement: false, latencyMs: 100 }),
      rec({ unavailable: true, disagreement: false, latencyMs: 9999 }),
    ]);
    expect(l.count).toBe(3);
    expect(l.p50).toBe(80);
    expect(l.p95).toBe(100);
  });
  it("zero when none", () => {
    expect(shadowLatency([rec(undefined)])).toEqual({ count: 0, p50: 0, p95: 0 });
  });
});
