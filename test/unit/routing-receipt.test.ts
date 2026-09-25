import { describe, expect, it } from "vitest";
import { calibrationMetrics } from "../../src/contract/routing-metrics";
import { validateRoutingReceipt } from "../../src/contract/routing-receipt";
import { composeToDecision, SCHEMA_VERSION, type CandidateRegistry, type CompositeEvidence } from "../../src/contract/routing-composer";
import { canExecuteRoute } from "../../src/router/boundary";

const registry: CandidateRegistry = {
  schemaVersion: SCHEMA_VERSION,
  tiers: ["fast", "medium", "heavy"],
  candidates: {
    fast: { id: "fast", tier: "fast" },
    medium: { id: "medium", tier: "medium" },
    heavy: { id: "heavy", tier: "heavy" },
  },
};
const scalar = (value: "low" | "medium" | "high" | "none") => ({ value, confidence: 0.9, probabilities: [0.1, 0.8, 0.1], reason: "fixture", version: 1 });
const gate = () => ({ gates: { fast: true, medium: true, heavy: true }, confidence: 0.9, probabilities: [0.1, 0.8, 0.1], reason: "fixture", version: 1 });
const evidence: CompositeEvidence = {
  schemaVersion: SCHEMA_VERSION,
  complexity: scalar("medium"),
  risk: scalar("low"),
  specialty: scalar("none"),
  availability: gate(),
  permission: gate(),
  calibration: {
    classifierVersion: "fixture-1",
    calibrationVersion: "cal-1",
    temperature: 1,
    calibratedConfidence: 0.9,
    candidateProbabilities: { fast: 0.1, medium: 0.8, heavy: 0.1 },
  },
};

describe("versioned routing receipt", () => {
  it("validates calibrated, versioned evidence and enforces both promotion thresholds", () => {
    const decision = composeToDecision(evidence, registry);
    expect(validateRoutingReceipt(decision.receipt)).toEqual([]);
    expect(canExecuteRoute(decision)).toBe(true);
    expect(canExecuteRoute(decision, { minMargin: 0.8 })).toBe(false);
    expect(canExecuteRoute(decision, { minCalibratedConfidence: 0.95 })).toBe(false);
  });

  it("rejects inconsistent probabilities and malformed receipt hashes", () => {
    const decision = composeToDecision(evidence, registry);
    expect(validateRoutingReceipt({ ...decision.receipt, schemaHash: "wrong" })).toContain("receipt schemaHash mismatch");
    expect(canExecuteRoute({ ...decision, receipt: { ...decision.receipt, candidateProbabilities: { fast: 0.2, medium: 0.8, heavy: 0.1 } } })).toBe(false);
  });

  it("emits Brier, ECE and AURC deterministically on labelled fixtures", () => {
    const fixture = { observations: [{ probability: 0.9, label: 1 }, { probability: 0.1, label: 0 }] };
    const first = calibrationMetrics(fixture);
    expect(calibrationMetrics(fixture)).toEqual(first);
    expect(first.brier).toBeCloseTo(0.01);
    expect(first.aurc).toBe(1);
  });
});
