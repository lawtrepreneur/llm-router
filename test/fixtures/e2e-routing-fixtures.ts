/**
 * test/fixtures/e2e-routing-fixtures.ts
 *
 * Issue #10 — executable composer-level fixture corpus.
 *
 * Every fixture is secret-free, has a stable ID, and is passed directly to
 * composeToDecision() in test/unit/e2e-routing-fixtures.test.ts.
 *
 * Scope:
 *   - composer-representable cases only (pure deterministic policy)
 *   - no classifier calls, no adapter/transport, no subprocess, no live model
 *
 * Cases deferred to later integration work (adapter/execution gate):
 *   - classifier timeout / transport failure
 *   - verification failure
 *   - OpenCode ≡ Hermes adapter equivalence
 *   - off / shadow / live rollout modes
 *   - receipt storage / replay CLI
 */

import {
  SCHEMA_VERSION,
  type CandidateRegistry,
  type CompositeEvidence,
} from "../../src/contract/routing-composer";
import type { RoutingRequest } from "../../src/contract/routing-decision";

// ---------------------------------------------------------------------------
// Fixture interface
// ---------------------------------------------------------------------------

export interface E2ERoutingFixture {
  /** Stable cross-session ID. */
  id: `FX-${string}`;
  /** Fixture family from #10 spec. */
  family:
    | "planning"
    | "execution"
    | "mixed-phase"
    | "specialty-match"
    | "specialty-miss"
    | "low-confidence"
    | "malformed-evidence"
    | "unknown-candidate"
    | "unavailable-candidate"
    | "permission-denial"
    | "no-eligible-candidate"
    | "high-risk-downgrade"
    | "determinism";
  request: RoutingRequest;
  evidence: CompositeEvidence;
  registry: CandidateRegistry;
  expected: {
    /** Tier of choice.tier, or null when no choice is made. */
    selectedTier: "fast" | "medium" | "heavy" | null;
    /** decision.fallback?.action, or "none" when no fallback. */
    fallbackAction: "escalate" | "none";
    /** Partial match against decision.fallback?.reason when provided. */
    fallbackReasonPattern?: RegExp;
    /** choice.tier must never equal "fast". */
    neverFast?: boolean;
  };
  riskLevel: "low" | "medium" | "high";
  rationale: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SV = SCHEMA_VERSION;

function scalar(value: "low" | "medium" | "high", confidence = 0.9) {
  return { value, confidence, probabilities: [1.0] as readonly number[], reason: "fixture", version: SV } as const;
}

function specialty(value: "none" | "registered" | "unknown", tier?: string, confidence = 0.9) {
  return { value, tier, confidence, probabilities: [1.0] as readonly number[], reason: "fixture", version: SV } as const;
}

function gate3(
  fast: boolean, medium: boolean, heavy: boolean,
  confidence = 0.9,
) {
  return {
    gates: { "fast-1": fast, "medium-1": medium, "heavy-1": heavy },
    confidence,
    probabilities: [0.33, 0.34, 0.33] as readonly number[],
    reason: "fixture",
    version: SV,
  } as const;
}

function phaseEv(value: "planning" | "execution" | "mixed", confidence = 0.9) {
  return { value, confidence, probabilities: [1.0] as readonly number[], reason: "fixture", version: SV } as const;
}

/** Calibration block required by the validator. candidateProbabilities must sum to 1.0. */
function cal3(top: "fast-1" | "medium-1" | "heavy-1" = "medium-1") {
  const probs =
    top === "fast-1"  ? { "fast-1": 0.8, "medium-1": 0.1, "heavy-1": 0.1 } :
    top === "heavy-1" ? { "fast-1": 0.1, "medium-1": 0.1, "heavy-1": 0.8 } :
                        { "fast-1": 0.1, "medium-1": 0.8, "heavy-1": 0.1 };
  return { classifierVersion: "fx-v1", calibrationVersion: "fx-v1", temperature: 1.0, candidateProbabilities: probs, calibratedConfidence: 0.8 } as const;
}

// ---------------------------------------------------------------------------
// Standard three-tier registry
// ---------------------------------------------------------------------------

export const STANDARD_REGISTRY: CandidateRegistry = {
  schemaVersion: SV,
  tiers: ["fast", "medium", "heavy"],
  candidates: {
    "fast-1":   { id: "fast-1",   tier: "fast"   },
    "medium-1": { id: "medium-1", tier: "medium" },
    "heavy-1":  { id: "heavy-1",  tier: "heavy"  },
  },
};

// ---------------------------------------------------------------------------
// Fixture corpus
// ---------------------------------------------------------------------------

export const E2E_FIXTURES: E2ERoutingFixture[] = [

  // ---- FX-001: low complexity → fast -----------------------------------------
  {
    id: "FX-001",
    family: "execution",
    request: { prompt: "Show the contents of tsconfig.json without editing it." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("low"),
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("fast-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: { selectedTier: "fast", fallbackAction: "none" },
    riskLevel: "low",
    rationale: "Low complexity, no risk, all open → fast.",
  },

  // ---- FX-002: medium complexity → medium ------------------------------------
  {
    id: "FX-002",
    family: "execution",
    request: { prompt: "Implement a validation check in an existing request handler." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("medium"),
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("medium-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: { selectedTier: "medium", fallbackAction: "none" },
    riskLevel: "medium",
    rationale: "Medium complexity → medium tier.",
  },

  // ---- FX-003: high complexity → heavy ---------------------------------------
  {
    id: "FX-003",
    family: "execution",
    request: { prompt: "Redesign the authentication layer to support multi-tenant OIDC." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("high"),
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("heavy-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: { selectedTier: "heavy", fallbackAction: "none" },
    riskLevel: "medium",
    rationale: "High complexity → heavy tier.",
  },

  // ---- FX-004: high risk, low complexity → risk floor raises to heavy -------
  {
    id: "FX-004",
    family: "high-risk-downgrade",
    request: { prompt: "Delete all rows from the production payments table." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("low"),
      risk: scalar("high"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("heavy-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: { selectedTier: "heavy", fallbackAction: "none", neverFast: true },
    riskLevel: "high",
    rationale: "High-risk floor overrides low complexity; never fast.",
  },

  // ---- FX-005: high complexity, low risk → complexity dominates -------------
  {
    id: "FX-005",
    family: "execution",
    request: { prompt: "Migrate the billing service schema across two databases with rollback." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("high"),
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("heavy-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: { selectedTier: "heavy", fallbackAction: "none" },
    riskLevel: "low",
    rationale: "Complexity is the binding signal; low risk does not reduce the tier.",
  },

  // ---- FX-006: mixed phase → at-least-medium floor --------------------------
  {
    id: "FX-006",
    family: "mixed-phase",
    request: { prompt: "First plan, then implement and test a cache invalidation change." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("low"),
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("medium-1"),
      phase: phaseEv("mixed"),
    },
    registry: STANDARD_REGISTRY,
    expected: { selectedTier: "medium", fallbackAction: "none" },
    riskLevel: "low",
    rationale: "Mixed phase forces floor of medium regardless of low complexity.",
  },

  // ---- FX-007: registered specialty with tier floor -------------------------
  {
    id: "FX-007",
    family: "specialty-match",
    request: { prompt: "Audit the authentication boundary for privilege escalation." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("low"),
      risk: scalar("high"),
      specialty: specialty("registered", "heavy"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("heavy-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: { selectedTier: "heavy", fallbackAction: "none", neverFast: true },
    riskLevel: "high",
    rationale: "Registered specialty maps to heavy; risk floor also applies.",
  },

  // ---- FX-008: planning phase, low complexity → fast (complexity governs) --
  {
    id: "FX-008",
    family: "planning",
    request: { prompt: "Plan a rollout sequence for a new notification service." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("low"),
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("fast-1"),
      phase: phaseEv("planning"),
    },
    registry: STANDARD_REGISTRY,
    expected: { selectedTier: "fast", fallbackAction: "none" },
    riskLevel: "low",
    rationale: "Planning + low complexity/risk → fast (not hard-coded; driven by evidence).",
  },

  // ---- FX-009: planning phase, high complexity → heavy ----------------------
  {
    id: "FX-009",
    family: "planning",
    request: { prompt: "Plan a full cloud migration architecture across three regions." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("high"),
      risk: scalar("medium"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("heavy-1"),
      phase: phaseEv("planning"),
    },
    registry: STANDARD_REGISTRY,
    expected: { selectedTier: "heavy", fallbackAction: "none" },
    riskLevel: "medium",
    rationale: "Planning phase does not short-circuit to fast when complexity is high.",
  },

  // ---- FX-010: low confidence → escalate ------------------------------------
  {
    id: "FX-010",
    family: "low-confidence",
    request: { prompt: "Make the service better." },
    evidence: {
      schemaVersion: SV,
      complexity: {
        value: "medium",
        confidence: 0.65,   // below EXECUTION_CONFIDENCE (0.7)
        probabilities: [1.0] as readonly number[],
        reason: "ambiguous",
        version: SV,
      },
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("medium-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: {
      selectedTier: null,
      fallbackAction: "escalate",
      fallbackReasonPattern: /confidence.*below execution threshold/,
    },
    riskLevel: "medium",
    rationale: "Confidence below 0.7 threshold forces escalation.",
  },

  // ---- FX-011: non-finite probability value ---------------------------------
  {
    id: "FX-011",
    family: "malformed-evidence",
    request: { prompt: "Implement a small feature." },
    evidence: {
      schemaVersion: SV,
      complexity: {
        value: "medium",
        confidence: 0.9,
        probabilities: [NaN] as unknown as readonly number[],
        reason: "fixture",
        version: SV,
      },
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("medium-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: {
      selectedTier: null,
      fallbackAction: "escalate",
      fallbackReasonPattern: /complexity.*probabilities contain a value outside \[0,1\]/,
    },
    riskLevel: "medium",
    rationale: "Non-finite probability fails validation → no choice.",
  },

  // ---- FX-012: probability out of range [0,1] -------------------------------
  {
    id: "FX-012",
    family: "malformed-evidence",
    request: { prompt: "Add a health endpoint." },
    evidence: {
      schemaVersion: SV,
      complexity: {
        value: "low",
        confidence: 0.9,
        probabilities: [1.5] as unknown as readonly number[],
        reason: "fixture",
        version: SV,
      },
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("fast-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: {
      selectedTier: null,
      fallbackAction: "escalate",
      fallbackReasonPattern: /complexity.*probabilities contain a value outside \[0,1\]/,
    },
    riskLevel: "low",
    rationale: "Out-of-range probability fails validation → no choice.",
  },

  // ---- FX-013: unknown specialty (no tier) → escalate ----------------------
  {
    id: "FX-013",
    family: "specialty-miss",
    request: { prompt: "Review a database migration for regulatory retention requirements." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("medium"),
      risk: scalar("medium"),
      specialty: specialty("unknown"),   // unknown + no tier
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("medium-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: {
      selectedTier: null,
      fallbackAction: "escalate",
      fallbackReasonPattern: /specialty|unknown/i,
    },
    riskLevel: "high",
    rationale: "Unknown specialty without a tier → escalate.",
  },

  // ---- FX-013B: unknown-candidate family (gate names an undeclared candidate) -
  {
    id: "FX-013B",
    family: "unknown-candidate",
    request: { prompt: "Route a code review when a gate references a candidate the registry does not declare." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("medium"),
      risk: scalar("low"),
      specialty: specialty("none"),
      // availability gates include "ghost-1" which is NOT in the registry.
      // validateRegistry emits: "availability evidence contains unknown candidate 'ghost-1'"
      availability: {
        gates: { "fast-1": true, "medium-1": true, "heavy-1": true, "ghost-1": false },
        confidence: 0.9,
        probabilities: [0.25, 0.25, 0.25, 0.25] as unknown as readonly number[],
        reason: "fixture",
        version: SV,
      },
      permission: gate3(true, true, true),
      calibration: cal3("medium-1"),
    },
    // Valid schemaVersion; registry declares every registered candidate but the gate
    // carries a candidate id absent from it. validateRegistry rejects the mismatch before any choice.
    registry: {
      schemaVersion: SV,
      tiers: ["fast", "medium", "heavy"],
      candidates: {
        "fast-1":   { id: "fast-1",   tier: "fast"   },
        "medium-1": { id: "medium-1", tier: "medium" },
        "heavy-1":  { id: "heavy-1",  tier: "heavy"  },
      },
    },
    expected: {
      selectedTier: null,
      fallbackAction: "escalate",
      // Actual composer error: "availability evidence contains unknown candidate 'ghost-1'"
      fallbackReasonPattern: /availability evidence contains unknown candidate 'ghost-1'/,
    },
    riskLevel: "medium",
    rationale: "Gate references an undeclared candidate → gate/registry unknown-candidate validation fails → no choice.",
  },

  // ---- FX-014: target tier unavailable → no eligible at/above target -------
  {
    id: "FX-014",
    family: "unavailable-candidate",
    request: { prompt: "Run a performance diagnosis while the heavy worker is offline." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("high"),
      risk: scalar("medium"),
      specialty: specialty("none"),
      availability: gate3(true, false, false),  // only fast available
      permission: gate3(true, true, true),
      calibration: cal3("heavy-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: {
      selectedTier: null,
      fallbackAction: "escalate",
      fallbackReasonPattern: /no eligible candidate.*unavailable/,
    },
    riskLevel: "medium",
    rationale: "High-complexity needs heavy but only fast is available → escalate.",
  },

  // ---- FX-015: permission denied all candidates → escalate ------------------
  {
    id: "FX-015",
    family: "permission-denial",
    request: { prompt: "Apply a production config change without production-write permission." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("high"),
      risk: scalar("high"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(false, false, false),  // all denied
      calibration: cal3("heavy-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: {
      selectedTier: null,
      fallbackAction: "escalate",
      fallbackReasonPattern: /no eligible candidate.*unauthorized/,
      neverFast: true,
    },
    riskLevel: "high",
    rationale: "No candidate passes permission gate → escalate.",
  },

  // ---- FX-016: all candidates unavailable + unauthorized → escalate ---------
  {
    id: "FX-016",
    family: "no-eligible-candidate",
    request: { prompt: "Execute a multi-region deployment." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("high"),
      risk: scalar("high"),
      specialty: specialty("none"),
      availability: gate3(false, false, false),
      permission: gate3(false, false, false),
      calibration: cal3("heavy-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: {
      selectedTier: null,
      fallbackAction: "escalate",
      fallbackReasonPattern: /no eligible candidate.*unavailable.*unauthorized/,
      neverFast: true,
    },
    riskLevel: "high",
    rationale: "Zero eligible candidates → escalate.",
  },

  // ---- FX-017: determinism --------------------------------------------------
  {
    id: "FX-017",
    family: "determinism",
    request: { prompt: "Refactor the session manager to use dependency injection." },
    evidence: {
      schemaVersion: SV,
      complexity: scalar("medium"),
      risk: scalar("low"),
      specialty: specialty("none"),
      availability: gate3(true, true, true),
      permission: gate3(true, true, true),
      calibration: cal3("medium-1"),
    },
    registry: STANDARD_REGISTRY,
    expected: { selectedTier: "medium", fallbackAction: "none" },
    riskLevel: "medium",
    rationale: "Run twice with fixed timestamp; decisions must deep-equal.",
  },
];

// ---------------------------------------------------------------------------
// Coverage helpers (consumed by test assertions)
// ---------------------------------------------------------------------------

export const REQUIRED_FAMILIES: ReadonlySet<E2ERoutingFixture["family"]> = new Set([
  "planning",
  "execution",
  "mixed-phase",
  "specialty-match",
  "specialty-miss",
  "low-confidence",
  "malformed-evidence",
  "unknown-candidate",
  "unavailable-candidate",
  "permission-denial",
  "no-eligible-candidate",
  "high-risk-downgrade",
  "determinism",
]);

/** Families deferred to adapter/execution integration work. */
export const DEFERRED_FAMILIES = [
  "classifier-timeout",
  "transport-failure",
  "verification-failure",
  "opencode-hermes-equivalence",
  "off-shadow-live-rollout",
] as const;
