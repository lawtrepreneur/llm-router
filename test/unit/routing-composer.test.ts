/**
 * test/unit/routing-composer.test.ts
 *
 * Focused composer tests for issue #12.
 * Covers every required case: each dimension alone, conflict resolution,
 * availability/permission filtering, mixed phase, malformed/unknown/nonfinite
 * evidence, determinism, and fail-up behaviour.
 *
 * Only tests the pure deterministic surface (composeToDecision / compose).
 * No classifier calls, no subprocess, no I/O.
 */

import { describe, it, expect } from "vitest";
import {
  compose,
  composeToDecision,
  hasProbabilityDisagreement,
  phaseFloor,
  validateEvidence,
  EXECUTION_CONFIDENCE,
  SCHEMA_VERSION,
  type CandidateRegistry,
  type CompositeEvidence,
} from "../../src/contract/routing-composer";
import { canExecuteRoute, decideRouteFromEvidence } from "../../src/router/boundary";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function gates(ids: string[], allow: boolean): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, allow]));
}

/** Minimal valid ScalarComposite */
function scalar(value: "low" | "medium" | "high", confidence = 0.9) {
  return { value, confidence, probabilities: [0.1, 0.8, 0.1], reason: "test", version: SCHEMA_VERSION };
}

/** Minimal valid GateComposite */
function gate(gateMap: Record<string, boolean>, confidence = 0.9) {
  const probabilities = Object.keys(gateMap).length === 1 ? [1] : [0.1, 0.8, 0.1];
  return { gates: gateMap, confidence, probabilities, reason: "test", version: SCHEMA_VERSION };
}

/** Valid specialty evidence */
function specialty(value: "none" | "registered" | "unknown", tier?: string, confidence = 0.9) {
  return { value, tier, confidence, probabilities: [0.1, 0.8, 0.1], reason: "test", version: SCHEMA_VERSION };
}

/** Fully valid evidence for all 5 required dimensions */
function validEvidence(overrides: Partial<CompositeEvidence> = {}): CompositeEvidence {
  const ids = ["fast-1", "medium-1", "heavy-1"];
  return {
    schemaVersion: SCHEMA_VERSION,
    complexity: scalar("medium"),
    risk: scalar("low"),
    specialty: specialty("none"),
    availability: gate(gates(ids, true)),
    permission: gate(gates(ids, true)),
    calibration: {
      classifierVersion: "fixture-classifier-v1",
      calibrationVersion: "fixture-calibration-v1",
      temperature: 1,
      calibratedConfidence: 0.9,
      candidateProbabilities: { "fast-1": 0.1, "medium-1": 0.8, "heavy-1": 0.1 },
    },
    ...overrides,
  };
}

/** Registry with one candidate per tier */
const threeRegistry: CandidateRegistry = {
  schemaVersion: SCHEMA_VERSION,
  tiers: ["fast", "medium", "heavy"],
  candidates: {
    "fast-1":   { id: "fast-1",   tier: "fast" },
    "medium-1": { id: "medium-1", tier: "medium" },
    "heavy-1":  { id: "heavy-1",  tier: "heavy" },
  },
};

/** Registry with only a heavy candidate */
const heavyOnlyRegistry: CandidateRegistry = {
  schemaVersion: SCHEMA_VERSION,
  tiers: ["heavy"],
  candidates: {
    "heavy-1": { id: "heavy-1", tier: "heavy" },
  },
};

/** Registry with only a fast candidate */
const fastOnlyRegistry: CandidateRegistry = {
  schemaVersion: SCHEMA_VERSION,
  tiers: ["fast"],
  candidates: {
    "fast-1": { id: "fast-1", tier: "fast" },
  },
};

// ---------------------------------------------------------------------------
// 1. Each dimension alone
// ---------------------------------------------------------------------------

describe("complexity dimension alone", () => {
  it("low complexity → fast candidate selected", () => {
    const d = composeToDecision(validEvidence({ complexity: scalar("low") }), threeRegistry);
    expect(d.choice?.tier).toBe("fast");
    expect(d.fallback).toBeUndefined();
  });

  it("medium complexity → medium candidate selected", () => {
    const d = composeToDecision(validEvidence({ complexity: scalar("medium") }), threeRegistry);
    expect(d.choice?.tier).toBe("medium");
  });

  it("high complexity → heavy candidate selected", () => {
    const d = composeToDecision(validEvidence({ complexity: scalar("high") }), threeRegistry);
    expect(d.choice?.tier).toBe("heavy");
  });
});

describe("risk dimension alone", () => {
  it("low risk with low complexity → fast", () => {
    const d = composeToDecision(validEvidence({ complexity: scalar("low"), risk: scalar("low") }), threeRegistry);
    expect(d.choice?.tier).toBe("fast");
  });

  it("medium risk floors to medium", () => {
    const d = composeToDecision(validEvidence({ complexity: scalar("low"), risk: scalar("medium") }), threeRegistry);
    expect(d.choice?.tier).toBe("medium");
  });

  it("high risk floors to heavy", () => {
    const d = composeToDecision(validEvidence({ complexity: scalar("low"), risk: scalar("high") }), threeRegistry);
    expect(d.choice?.tier).toBe("heavy");
  });
});

describe("specialty dimension alone", () => {
  it("specialty=none has no floor effect", () => {
    const d = composeToDecision(validEvidence({ specialty: specialty("none") }), threeRegistry);
    expect(d.choice).toBeDefined();
  });

  it("specialty=registered with heavy tier floor → heavy", () => {
    const d = composeToDecision(
      validEvidence({ complexity: scalar("low"), specialty: specialty("registered", "heavy") }),
      threeRegistry,
    );
    expect(d.choice?.tier).toBe("heavy");
  });

  it("specialty=registered with fast tier floor → at least fast", () => {
    const d = composeToDecision(
      validEvidence({ complexity: scalar("low"), specialty: specialty("registered", "fast") }),
      threeRegistry,
    );
    expect(d.choice?.tier).toBe("fast");
  });
});

describe("availability dimension alone", () => {
  it("all unavailable → fail upward, no choice", () => {
    const ev = validEvidence({
      availability: gate(gates(["fast-1", "medium-1", "heavy-1"], false)),
    });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
    expect(d.fallback ?? d.reason).toBeTruthy();
  });

  it("only heavy available → heavy selected even when complexity=low", () => {
    const ev = validEvidence({
      complexity: scalar("low"),
      availability: gate({ "fast-1": false, "medium-1": false, "heavy-1": true }),
    });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice?.tier).toBe("heavy");
  });
});

describe("permission dimension alone", () => {
  it("all unauthorized → fail upward, no choice", () => {
    const ev = validEvidence({
      permission: gate(gates(["fast-1", "medium-1", "heavy-1"], false)),
    });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
  });

  it("only heavy permitted → heavy selected", () => {
    const ev = validEvidence({
      complexity: scalar("low"),
      permission: gate({ "fast-1": false, "medium-1": false, "heavy-1": true }),
    });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice?.tier).toBe("heavy");
  });
});

describe("phase dimension alone", () => {
  it("phase=planning → no extra floor", () => {
    const ev = validEvidence({ phase: { value: "planning", version: SCHEMA_VERSION, confidence: 0.9, probabilities: [1], reason: "test" } });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeDefined();
  });

  it("phase=execution → no extra floor (no mixed rule)", () => {
    const ev = validEvidence({ complexity: scalar("low"), phase: { value: "execution", version: SCHEMA_VERSION, confidence: 0.9, probabilities: [1], reason: "test" } });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice?.tier).toBe("fast");
  });
});

// ---------------------------------------------------------------------------
// 2. Mixed phase
// ---------------------------------------------------------------------------

describe("mixed phase", () => {
  it("mixed phase floors target to at least medium", () => {
    const ev = validEvidence({
      complexity: scalar("low"),
      risk: scalar("low"),
      phase: { value: "mixed", version: SCHEMA_VERSION, confidence: 0.9, probabilities: [1], reason: "test" },
    });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice?.tier).toBe("medium");
    const override = d.explanation?.policyOverrides.find((o) => o.stage === "phase-mixed");
    expect(override).toBeDefined();
  });

  it("mixed phase does not downgrade a high-complexity result", () => {
    const ev = validEvidence({
      complexity: scalar("high"),
      phase: { value: "mixed", version: SCHEMA_VERSION, confidence: 0.9, probabilities: [1], reason: "test" },
    });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice?.tier).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------
// 3. Low complexity / high risk (risk floor wins)
// ---------------------------------------------------------------------------

describe("low complexity / high risk", () => {
  it("risk floor overrides complexity → heavy selected", () => {
    const d = composeToDecision(
      validEvidence({ complexity: scalar("low"), risk: scalar("high") }),
      threeRegistry,
    );
    expect(d.choice?.tier).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------
// 4. High complexity / low risk (complexity wins)
// ---------------------------------------------------------------------------

describe("high complexity / low risk", () => {
  it("complexity drives tier → heavy selected", () => {
    const d = composeToDecision(
      validEvidence({ complexity: scalar("high"), risk: scalar("low") }),
      threeRegistry,
    );
    expect(d.choice?.tier).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------
// 5. Specialty unavailable → fail upward
// ---------------------------------------------------------------------------

describe("specialty=unknown → fail upward", () => {
  it("unknown specialty produces no choice", () => {
    const d = composeToDecision(
      validEvidence({ specialty: specialty("unknown") }),
      threeRegistry,
    );
    expect(d.choice).toBeUndefined();
    expect(d.reason).toMatch(/unknown/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Permission denied → fail upward, never select lower tier
// ---------------------------------------------------------------------------

describe("permission denied → fail upward, no downgrade", () => {
  it("denying all permissions produces no choice", () => {
    const ev = validEvidence({
      permission: gate(gates(["fast-1", "medium-1", "heavy-1"], false)),
    });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
  });

  it("denying only fast/medium forces heavy, not lower", () => {
    const ev = validEvidence({
      complexity: scalar("low"),
      permission: gate({ "fast-1": false, "medium-1": false, "heavy-1": true }),
    });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice?.tier).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------
// 7. Malformed / unknown / non-finite evidence → fail upward
// ---------------------------------------------------------------------------

describe("malformed evidence → fail upward", () => {
  it("null root evidence → explicit escalation, no throw", () => {
    const d = composeToDecision(null as unknown as CompositeEvidence, threeRegistry);
    expect(d.choice).toBeUndefined();
    expect(d.fallback?.action).toBe("escalate");
  });

  it("non-finite confidence → no choice", () => {
    const ev = {
      complexity: { value: "medium", confidence: NaN, reason: "test", version: SCHEMA_VERSION },
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate(gates(["fast-1"], true)),
      permission: gate(gates(["fast-1"], true)),
    } as unknown as CompositeEvidence;
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
  });

  it("Infinity confidence → no choice", () => {
    const ev = {
      complexity: { value: "medium", confidence: Infinity, reason: "test", version: SCHEMA_VERSION },
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate(gates(["fast-1"], true)),
      permission: gate(gates(["fast-1"], true)),
    } as unknown as CompositeEvidence;
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
  });

  it("missing required dimension (risk absent) → no choice", () => {
    const ev = {
      complexity: scalar("medium"),
      specialty: specialty("none"),
      availability: gate(gates(["fast-1"], true)),
      permission: gate(gates(["fast-1"], true)),
    } as unknown as CompositeEvidence;
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
  });

  it("non-object dimension → no choice", () => {
    const d = composeToDecision({ complexity: "bad" as unknown, risk: scalar("low") } as unknown as CompositeEvidence, threeRegistry);
    expect(d.choice).toBeUndefined();
  });

  it("unknown specialty value blocks selection", () => {
    const ev = validEvidence({ specialty: specialty("unknown") });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
  });

  it("specialty registered with unknown tier name → fail upward", () => {
    const ev = validEvidence({
      complexity: scalar("low"),
      specialty: specialty("registered", "nonexistent-tier"),
    });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
    expect(d.fallback?.action).toBe("escalate");
  });

  it("specialty registered without tier → fail upward", () => {
    const ev = validEvidence({ specialty: specialty("registered") });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
    expect(d.fallback?.tier).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------
// 8. validateEvidence standalone
// ---------------------------------------------------------------------------

describe("validateEvidence", () => {
  it("returns no errors for valid evidence", () => {
    const ev = validEvidence();
    expect(validateEvidence(ev)).toHaveLength(0);
  });

  it("rejects non-object", () => {
    expect(validateEvidence(null)).not.toHaveLength(0);
    expect(validateEvidence("string")).not.toHaveLength(0);
  });

  it("rejects unknown dimension keys", () => {
    const ev = { ...validEvidence(), extraDim: { value: "x", confidence: 0.9, reason: "r" } };
    expect(validateEvidence(ev)).not.toHaveLength(0);
  });

  it("rejects non-finite probability values", () => {
    const ev = validEvidence({
      complexity: { value: "low", confidence: 0.9, reason: "r", version: SCHEMA_VERSION, probabilities: [NaN] as unknown as readonly number[] },
    });
    expect(validateEvidence(ev)).not.toHaveLength(0);
  });

  it("rejects probability values outside [0,1]", () => {
    const ev = validEvidence({
      complexity: { value: "low", confidence: 0.9, reason: "r", version: SCHEMA_VERSION, probabilities: [1.5] as unknown as readonly number[] },
    });
    expect(validateEvidence(ev)).not.toHaveLength(0);
  });

  it("rejects non-array probability payload without throwing", () => {
    const ev = validEvidence({
      complexity: { value: "low", confidence: 0.9, reason: "r", version: SCHEMA_VERSION, probabilities: { low: 1 } as unknown as readonly number[] },
    });
    expect(validateEvidence(ev)).not.toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Determinism — same input/registry → identical normalized decision
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same evidence + registry → same choice every call", () => {
    const ev = validEvidence({ complexity: scalar("medium") });
    const d1 = composeToDecision(ev, threeRegistry);
    const d2 = composeToDecision(ev, threeRegistry);
    expect(d1).toEqual(d2);
  });

  it("compose() is an alias and returns the same tier", () => {
    const ev = validEvidence({ complexity: scalar("high") });
    const d1 = compose(ev, threeRegistry);
    const d2 = composeToDecision(ev, threeRegistry);
    expect(d1.choice?.tier).toBe(d2.choice?.tier);
  });
});

// ---------------------------------------------------------------------------
// 10. Low-confidence fail-closed (preserve existing canExecuteRoute behaviour)
// ---------------------------------------------------------------------------

describe("low-confidence fail-closed", () => {
  it("complexity confidence below 0.7 → no choice", () => {
    const ev = validEvidence({
      complexity: scalar("high", EXECUTION_CONFIDENCE - 0.01),
    });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
    expect(d.reason).toMatch(/confidence|uncertain/i);
    expect(d.fallback?.action).toBe("escalate");
    expect(d.receipt.fallback?.action).toBe("escalate");
  });

  it("low-confidence risk, specialty, availability, permission, or phase → no choice", () => {
    const cases: CompositeEvidence[] = [
      validEvidence({ risk: scalar("low", 0.69) }),
      validEvidence({ specialty: specialty("none", undefined, 0.69) }),
      validEvidence({ availability: gate(gates(["fast-1", "medium-1", "heavy-1"], true), 0.69) }),
      validEvidence({ permission: gate(gates(["fast-1", "medium-1", "heavy-1"], true), 0.69) }),
      validEvidence({ phase: { value: "mixed", version: SCHEMA_VERSION, confidence: 0.69, probabilities: [1], reason: "test" } }),
    ];
    for (const ev of cases) {
      const d = composeToDecision(ev, threeRegistry);
      expect(d.choice).toBeUndefined();
      expect(d.fallback?.action).toBe("escalate");
    }
  });

  it("complexity confidence at exactly 0.7 → choice made", () => {
    const ev = validEvidence({ complexity: scalar("medium", EXECUTION_CONFIDENCE) });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeDefined();
  });

  it("complexity confidence of 1.0 → choice made", () => {
    const ev = validEvidence({ complexity: scalar("medium", 1.0) });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Missing target tier escalates upward (no downward substitution)
// ---------------------------------------------------------------------------

describe("missing target tier escalates, no downward substitution", () => {
  it("high complexity + only fast candidate available → fail upward (not fast)", () => {
    const ev = validEvidence({
      complexity: scalar("high"),
      availability: gate({ "fast-1": true }),
      permission: gate({ "fast-1": true }),
    });
    const reg: CandidateRegistry = {
      schemaVersion: SCHEMA_VERSION,
      tiers: ["fast"],
      candidates: { "fast-1": { id: "fast-1", tier: "fast" } },
    };
    const d = composeToDecision(ev, reg);
    expect(d.choice).toBeUndefined();
  });

  it("medium complexity + only heavy available → heavy selected (not downgraded to fast)", () => {
    const ev = validEvidence({
      complexity: scalar("medium"),
      availability: gate({ "heavy-1": true }),
      permission: gate({ "heavy-1": true }),
      calibration: { ...validEvidence().calibration!, candidateProbabilities: { "heavy-1": 1 } },
    });
    const d = composeToDecision(ev, heavyOnlyRegistry);
    expect(d.choice?.tier).toBe("heavy");
  });

  it("missing explicit permission gate cannot select candidate", () => {
    const ev = validEvidence({ permission: gate({ "fast-1": true }) });
    const d = composeToDecision(ev, threeRegistry);
    expect(d.choice).toBeUndefined();
    expect(d.fallback?.action).toBe("escalate");
  });

  it("low complexity + only fast available → fast selected (correct, not escalated)", () => {
    const ev = validEvidence({
      complexity: scalar("low"),
      availability: gate({ "fast-1": true }),
      permission: gate({ "fast-1": true }),
      calibration: { ...validEvidence().calibration!, candidateProbabilities: { "fast-1": 1 } },
    });
    const d = composeToDecision(ev, fastOnlyRegistry);
    expect(d.choice?.tier).toBe("fast");
  });
});

// ---------------------------------------------------------------------------
// 12. hasProbabilityDisagreement helper
// ---------------------------------------------------------------------------

describe("hasProbabilityDisagreement", () => {
  it("returns false when no distributions", () => {
    expect(hasProbabilityDisagreement({})).toBe(false);
  });

  it("returns false when only one distribution present", () => {
    const norm = {
      availability: {
        version: SCHEMA_VERSION,
        gates: { "fast-1": true, "medium-1": false },
        confidence: 0.9,
        reason: "test",
        probabilities: [0.9, 0.1] as unknown as readonly number[],
      },
    };
    expect(hasProbabilityDisagreement(norm)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. phaseFloor helper
// ---------------------------------------------------------------------------

describe("phaseFloor", () => {
  it("undefined → undefined", () => expect(phaseFloor(undefined)).toBeUndefined());
  it("planning → undefined (no floor)", () => {
    expect(phaseFloor({ value: "planning", version: SCHEMA_VERSION, confidence: 0.9, reason: "r" })).toBeUndefined();
  });
  it("execution → undefined (no floor)", () => {
    expect(phaseFloor({ value: "execution", version: SCHEMA_VERSION, confidence: 0.9, reason: "r" })).toBeUndefined();
  });
  it("mixed → medium floor", () => {
    expect(phaseFloor({ value: "mixed", version: SCHEMA_VERSION, confidence: 0.9, reason: "r" })).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// 14. Explanation separates evidence from policy
// ---------------------------------------------------------------------------

describe("explanation structure", () => {
  it("explanation has evidenceSummary and policyOverrides", () => {
    const d = composeToDecision(validEvidence(), threeRegistry);
    expect(d.explanation?.evidenceSummary).toBeInstanceOf(Array);
    expect(d.explanation?.policyOverrides).toBeInstanceOf(Array);
  });

  it("specialty floor override appears in policyOverrides, not evidenceSummary", () => {
    const ev = validEvidence({ complexity: scalar("low"), specialty: specialty("registered", "heavy") });
    const d = composeToDecision(ev, threeRegistry);
    const override = d.explanation?.policyOverrides.find((o) => o.stage === "specialty");
    expect(override).toBeDefined();
    expect(override?.tier).toBe("heavy");
    // evidenceSummary has a specialty entry but it describes the raw signal, not the policy
    const evidenceEntry = d.explanation?.evidenceSummary.find((e) => e.dimension === "specialty");
    expect(evidenceEntry?.detail).not.toMatch(/floor/i);
  });

  it("mixed-phase override appears in policyOverrides", () => {
    const ev = validEvidence({
      complexity: scalar("low"),
      phase: { value: "mixed", version: SCHEMA_VERSION, confidence: 0.9, probabilities: [1], reason: "test" },
    });
    const d = composeToDecision(ev, threeRegistry);
    const override = d.explanation?.policyOverrides.find((o) => o.stage === "phase-mixed");
    expect(override).toBeDefined();
  });
});

describe("normalized candidate receipt", () => {
  it("preserves selected identity and stable candidate order in serializable decision", () => {
    const decision = composeToDecision(validEvidence(), threeRegistry);
    expect(decision.candidates.map(c => c.metadata?.id)).toEqual(["fast-1", "heavy-1", "medium-1"]);
    expect(decision.choice?.metadata?.id).toBe("medium-1");
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });

  it("selected candidate remains exact candidate object accepted by native boundary", () => {
    const decision = decideRouteFromEvidence(validEvidence(), threeRegistry);
    expect(decision.candidates).toContain(decision.choice);
    expect(canExecuteRoute(decision)).toBe(true);
  });
});

describe("probability disagreement", () => {
  it("different top candidate across availability and permission fails upward", () => {
    const evidence = validEvidence({
      availability: {
        ...gate(gates(["fast-1", "medium-1", "heavy-1"], true)),
        probabilities: [0.8, 0.1, 0.1],
      },
      permission: {
        ...gate(gates(["fast-1", "medium-1", "heavy-1"], true)),
        probabilities: [0.1, 0.1, 0.8],
      },
    });
    const decision = composeToDecision(evidence, threeRegistry);
    expect(decision.choice).toBeUndefined();
    expect(decision.fallback?.action).toBe("escalate");
    expect(decision.reason).toMatch(/disagree/i);
    expect(decision.explanation?.policyOverrides).toHaveLength(0);
  });
});

describe("phase validation and explicit fallback", () => {
  it("rejects unsupported phase, bad version, and non-finite confidence", () => {
    const invalid: CompositeEvidence[] = [
      validEvidence({ phase: { value: "later" as "mixed", version: SCHEMA_VERSION, confidence: 0.9, probabilities: [1], reason: "bad" } }),
      validEvidence({ phase: { value: "mixed", version: 2, confidence: 0.9, probabilities: [1], reason: "bad" } }),
      validEvidence({ phase: { value: "mixed", version: SCHEMA_VERSION, confidence: Infinity, probabilities: [1], reason: "bad" } }),
    ];
    for (const ev of invalid) {
      const decision = composeToDecision(ev, threeRegistry);
      expect(decision.choice).toBeUndefined();
      expect(decision.fallback?.action).toBe("escalate");
    }
  });

  it("decision timestamp is supplied or deterministic", () => {
    const ev = validEvidence();
    expect(composeToDecision(ev, threeRegistry).receipt.decidedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(composeToDecision(ev, threeRegistry, undefined, "2026-01-01T00:00:00.000Z").receipt.decidedAt)
      .toBe("2026-01-01T00:00:00.000Z");
  });
});
