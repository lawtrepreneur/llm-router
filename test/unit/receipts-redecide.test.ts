import { describe, expect, it } from "vitest";
import { reDecideReceipts, type RoutingRecord, type EvidenceReDecider } from "../../src/receipts/store";

const base = {
  kind: "routing" as const, version: 1 as const, id: "r1", timestamp: "1970-01-01T00:00:00.000Z",
  intendedTarget: "fast", actualTarget: "fast", escalation: { occurred: false, count: 0 },
  verification: { status: "passed" as const }, latencyMs: 1, outcome: "accepted" as const,
  policyVersion: "p1", registryVersion: "reg1", adapterMode: "live" as const,
  evidence: { complexity: { value: "low", confidence: 0.9 }, risk: { value: "low", confidence: 0.9 } },
  candidates: ["fast", "medium", "heavy"],
};

// Fake pure policy: re-decides from the same inputs, deterministically.
const reDecider: EvidenceReDecider = (evidence, candidates) => {
  // Policy stub: lowest tier covering the complexity level.
  const level = (evidence as Record<string, { value?: string }>).complexity?.value;
  const tier = level === "low" ? "fast" : level === "medium" ? "medium" : "heavy";
  return candidates.includes(tier) ? tier : "escalated";
};

describe("reDecideReceipts (issue #13)", () => {
  it("detects mismatches when policy changes the re-decided target", () => {
    const samePolicy = reDecideReceipts([base as RoutingRecord], reDecider);
    expect(samePolicy.mismatches).toBe(0);

    // A different policy: always force heavy.
    const stricter: EvidenceReDecider = (_e, candidates) => (candidates.includes("heavy") ? "heavy" : "escalated");
    const changed = reDecideReceipts([base as RoutingRecord], stricter);
    expect(changed.mismatches).toBe(1);
    expect(changed.diffs[0].mismatch).toBe(true);
    expect(changed.diffs[0].originalIntendedTarget).toBe("fast");
    expect(changed.diffs[0].reDecidedTarget).toBe("heavy");
  });

  it("is deterministic — identical inputs yield identical output", () => {
    const a = reDecideReceipts([{ ...base, id: "x" } as RoutingRecord], reDecider);
    const b = reDecideReceipts([{ ...base, id: "x" } as RoutingRecord], reDecider);
    expect(a).toEqual(b);
  });

  it("records without evidence get reDecidedTarget null and no mismatch", () => {
    const { evidence: _e, candidates: _c, ...noEvidence } = base;
    const result = reDecideReceipts([noEvidence as RoutingRecord], reDecider);
    expect(result.mismatches).toBe(0);
    expect(result.diffs[0].reDecidedTarget).toBeNull();
  });
});
