/**
 * src/contract/routing-composer.ts
 *
 * The deterministic routing composer: turns per-dimension evidence answers and a
 * typed candidate registry into a NORMALIZED RoutingDecision (a single chosen
 * tier), or an explicit upward FALLBACK / STOP.
 *
 * This is the shared composition surface that sits ABOVE src/router/boundary.ts.
 * Kept pure: no Node fs/os/path, no network, no subprocess, no SDK. Determinism
 * is enforced by design — same evidence + registry always yields the same
 * outcome (records iterate in insertion order; candidates are ordered by id).
 *
 * Resolution order (every stage runs even on failure; only the final decision
 * stops):
 *   1. validate shape          — schemaVersion present, every required dimension
 *                                carries a finite confidence & probabilities
 *   2. filter eligible candidates (available=true AND permitted=true)
 *   3. compute target tier     — max(complexity, risk floor, specialty tier, mixed=>medium)
 *   4. select                  — lowest eligible candidate at/above target
 *   5. fail upward             — invalid/unknown/uncertain(conf<.7)/probability
 *                                disagreement/no eligible candidate => escalate,
 *                                NEVER select a lower tier.
 */

import type { RoutingChoice, RoutingDecision, RoutingFallback, RoutingRequest } from "./routing-decision";

/** Composer contract version. Every evidence record is validated against this. */
export const SCHEMA_VERSION = 1;

/** Confidence below which we refuse to execute a choice. */
export const EXECUTION_CONFIDENCE = 0.7;

// ---------------------------------------------------------------------------
// Evidence dimensions & values — the six typed dimensions
// ---------------------------------------------------------------------------

export type ComplexityLevel = "low" | "medium" | "high";
export type RiskLevel = "low" | "medium" | "high";
export type SpecialtyLevel = "none" | "registered" | "unknown";
export type Phase = "planning" | "execution" | "mixed";

/** The six evidence dimensions. */
export type EvidenceDimension =
  | "complexity"
  | "risk"
  | "specialty"
  | "availability"
  | "permission"
  | "phase";

// ---------------------------------------------------------------------------
// Raw evidence shapes — each dimension carries its own versioned metadata.
// ---------------------------------------------------------------------------

/** Metadata carried by every evidence record. `version` is the per-record schema version. */
export interface EvidenceMeta {
  /** Finite confidence in [0,1]. Absent when this record was not resolved. */
  version: number;
  confidence?: number;
  probabilities?: readonly number[];
  reason: string;
  unavailableReason?: string;
}

/** A scalar level dimension (complexity/risk). `value` is always present on a real answer. */
export interface ScalarComposite extends EvidenceMeta {
  value: ComplexityLevel | RiskLevel;
}

/** The specialty answer — names one of the three levels, with an optional specialist tier slot. */
export interface SpecialtyComposite extends EvidenceMeta {
  value: SpecialtyLevel;
  tier?: string;
}

/** Candidate-keyed availability/permission booleans (keyed by registry id). */
export interface GateComposite extends EvidenceMeta {
  gates: Record<string, boolean>; // keyed by candidateRegistryEntry.id
}

/** The optional-phase answer — absent when not supplied. */
export type PhaseValue = Phase;
export interface PhaseComposite extends EvidenceMeta {
  value: PhaseValue;
}

/** What the producer supplies. */
export interface CompositeEvidence {
  schemaVersion: number;
  complexity?: ScalarComposite;
  risk?: ScalarComposite;
  specialty?: SpecialtyComposite;
  availability?: GateComposite;
  permission?: GateComposite;
  phase?: PhaseComposite;
}

// ---------------------------------------------------------------------------
// Candidate registry
// ---------------------------------------------------------------------------

/** A candidate slot in the registry. */
export interface RegistryEntry {
  id: string; // stable identifier / spec key
  tier: "fast" | "medium" | "heavy";
  ready?: boolean; // default true when omitted
}

/** Ordered tiers, cheapest → heaviest. Must stay monotonic for fail-up. */
export type TierName = "fast" | "medium" | "heavy";
export const TIER_ORDER: readonly TierName[] = ["fast", "medium", "heavy"];

export interface CandidateRegistry {
  schemaVersion: number;
  tiers: readonly TierName[]; // declaration order, used only as documentation of the ladder
  candidates: Record<string, RegistryEntry>; // keyed by id
}

// ---------------------------------------------------------------------------
// Composer outcome types
// ---------------------------------------------------------------------------

export type ComposerReason =
  | "invalid"               // shape/version/finite failed validation
  | "not-enough-evidence"   // a required dimension lacked a finite answer
  | "uncertain"             // confidence < 0.7 on the deciding signal
  | "unknown-specialty"     // specialty unknown with no usable tier
  | "probability-disagreement" // probability distribution disagreed across signals
  | "no-eligible-candidate";

export interface ComposerOutcome {
  /** Present when a normalized tier was chosen; absent → escalate upstream. */
  tier?: TierName;
  reason: ComposerReason;
}

/** Structured policy override applied by a non-classifier stage (audit surface). */
export interface PolicyOverride {
  /** Which stage produced the override. */
  stage: "specialty" | "phase-mixed";
  /** Tier the policy forced as a floor; absent = informational only. */
  tier?: TierName;
  reason: string;
}

/** The explanation, split into two visibly separate sections. */
export interface Explanation {
  /** Summary of what each evidence dimension answered (verbatim-ish). */
  evidenceSummary: Array<{ dimension: EvidenceDimension; detail: string }>;
  /** Policy overrides that raised the tier above the raw classifier signal. */
  policyOverrides: readonly PolicyOverride[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate a raw evidence composite against schema version + finiteness rules. */
export function validateEvidence(evidence: unknown): string[] {
  const errors: string[] = [];
  if (typeof evidence !== "object" || evidence === null) {
    return ["composer evidence must be a non-null object"];
  }

  const root = evidence as Record<string, unknown>;
  if (root.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`composer evidence: schemaVersion ${String(root.schemaVersion)} != required ${SCHEMA_VERSION}`);
  }
  for (const required of ["complexity", "risk", "specialty", "availability", "permission"] as const) {
    if (!(required in root)) errors.push(`composer evidence: required dimension '${required}' is missing`);
  }

  for (const [dimension, raw] of Object.entries(evidence as Record<string, unknown>)) {
    if (dimension === "schemaVersion") {
      if (raw !== SCHEMA_VERSION) errors.push(`composer evidence: schemaVersion ${String(raw)} != required ${SCHEMA_VERSION}`);
      continue;
    }
    if (!(EVIDENCE_DIMENSIONS as readonly string[]).includes(dimension)) {
      errors.push(`composer evidence: '${dimension}' is not a known dimension`);
      continue;
    }
    const rec = raw as Record<string, unknown>;

    // Unknown dimension shapes must be objects, not primitives.
    if (typeof raw !== "object" || raw === null) {
      errors.push(`composer evidence: '${dimension}' must be an object`);
      continue;
    }

    // Per-record schema version must match the composer contract version.
    const v = rec.version as number | undefined;
    if (v !== SCHEMA_VERSION) {
    errors.push(`composer evidence: '${dimension}' schemaVersion ${v} != required ${SCHEMA_VERSION}`);
    }

    // confidence must be a finite number within [0,1].
    const conf = rec.confidence as number | undefined;
    if (typeof conf !== "number" || !Number.isFinite(conf)) {
      errors.push(`composer evidence: '${dimension}' confidence must be a finite number`);
    } else if (conf < 0 || conf > 1) {
      errors.push(`composer evidence: '${dimension}' confidence ${conf} is outside [0,1]`);
    }

    // probabilities must be present and every element finite within [0,1].
    const probs: unknown = rec.probabilities;
    if (probs !== undefined) {
      if (!Array.isArray(probs) || probs.length === 0) {
        errors.push(`composer evidence: '${dimension}' probabilities must be a non-empty array`);
      } else {
        for (const p of probs) {
          if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
            errors.push(`composer evidence: '${dimension}' probabilities contain a value outside [0,1]`);
            break;
          }
        }
        if (probs.some(p => typeof p !== "number" || !Number.isFinite(p))) {
          // Already reported above; avoid arithmetic on malformed values.
        } else {
          const total = probs.reduce((sum, p) => sum + (p as number), 0);
          if (total < 0.99 || total > 1.01) errors.push(`composer evidence: '${dimension}' probabilities must sum to 1`);
        }
      }
    }

    // reason must be a non-empty string (always present on a real answer).
    if (typeof rec.reason !== "string" || rec.reason.length === 0) {
      errors.push(`composer evidence: '${dimension}' reason must be a non-empty string`);
    }

    if (dimension === "complexity" && !["low", "medium", "high"].includes(String(rec.value))) errors.push("composer evidence: unknown complexity answer");
    if (dimension === "risk" && !["low", "medium", "high"].includes(String(rec.value))) errors.push("composer evidence: unknown risk answer");
    if (dimension === "specialty" && !["none", "registered", "unknown"].includes(String(rec.value))) errors.push("composer evidence: unknown specialty answer");
    if (dimension === "specialty" && rec.value === "registered" && !["fast", "medium", "heavy"].includes(String(rec.tier))) errors.push("composer evidence: registered specialty requires known tier");
    if (dimension === "phase" && !["planning", "execution", "mixed"].includes(String(rec.value))) errors.push("composer evidence: unknown phase answer");
    if (dimension === "availability" || dimension === "permission") {
      const gates = rec.gates;
      if (typeof gates !== "object" || gates === null || Array.isArray(gates) || Object.values(gates).some(v => typeof v !== "boolean")) {
        errors.push(`composer evidence: '${dimension}' gates must be candidate-keyed booleans`);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Normalized shape & resolution
// ---------------------------------------------------------------------------

/** One unified dimension slice (confidence/probabilities/reason/value/tier/gates). */
interface NormalizedDim extends EvidenceMeta {
  value?: ComplexityLevel | RiskLevel | SpecialtyLevel;
  tier?: string;
}

/** Gate-shaped slice — candidate-keyed availability/permission booleans. */
interface NormalizedGate extends EvidenceMeta {
  gates: Record<string, boolean>;
}

export interface NormalizedEvidence {
  complexity?: NormalizedDim;
  risk?: NormalizedDim;
  specialty?: NormalizedDim;
  availability?: NormalizedGate;
  permission?: NormalizedGate;
  phase?: PhaseComposite;
}

/** Map a raw dimension record to its normalized slice, never throwing. */
function normalize(evidence: CompositeEvidence): NormalizedEvidence {
  const out: NormalizedEvidence = {};
  if (typeof evidence !== "object" || evidence === null) return out;
  if (evidence.complexity) out.complexity = scalarSlice(evidence.complexity);
  if (evidence.risk) out.risk = scalarSlice(evidence.risk);
  if (evidence.specialty) out.specialty = specialtySlice(evidence.specialty);
  if (evidence.availability) out.availability = { ...evidence.availability };
  if (evidence.permission) out.permission = { ...evidence.permission };
  if (evidence.phase) out.phase = { ...evidence.phase };
  return out;
}

/** Read confidence/probabilities/reason from a scalar composite record. */
function scalarSlice(raw: ScalarComposite): NormalizedDim {
  const value = raw.value as NormalizedDim["value"];
  const shape: NormalizedDim = { ...raw, reason: raw.reason };
  return { ...shape, value };
}

/** Specialty carries a level plus an optional named specialist tier slot. */
function specialtySlice(raw: SpecialtyComposite): NormalizedDim {
  const value = raw.value as NormalizedDim["value"];
  const shape: NormalizedDim = { ...raw, reason: raw.reason, tier: (raw.tier ?? undefined) as NormalizedDim["tier"] };
  return { ...shape, value };
}

function hasConfidence(dim?: NormalizedDim | NormalizedGate): boolean {
  if (!dim) return false;
  const c = (dim as NormalizedDim).confidence;
  return typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1;
}

// ---------------------------------------------------------------------------
// Target computation (gates/floors)
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** Map a scalar level to its tier. low→fast, medium→medium, high→heavy. */
function levelToTier(level: ComplexityLevel | RiskLevel): TierName {
  const rank = LEVEL_RANK[level];
  return rank >= 0 ? TIER_ORDER[rank] : "medium";
}

/** The phase "mixed" widens the target to at least medium; planning/execution don't. */
export function phaseFloor(phase?: PhaseComposite): TierName | undefined {
  return phase?.value === "mixed" ? "medium" : undefined;
}

/** A registered specialist with a mapped tier name floors the target at that tier. */
function specialtyFloor(specialty: NormalizedDim): TierName | undefined {
  if (specialty.value !== "registered") return undefined;
  return mapSpecialtyTier(specialty.tier);
}

/** Map an optional specialist tier name to a canonical tier. Unknown → no floor. */
function mapSpecialtyTier(tier?: string): TierName | undefined {
  const byName: Record<string, TierName> = { fast: "fast", medium: "medium", heavy: "heavy" };
  return tier !== undefined && Object.prototype.hasOwnProperty.call(byName, tier) ? byName[tier] : undefined;
}

// ---------------------------------------------------------------------------
// Eligibility filtering
// ---------------------------------------------------------------------------

/** Return the ids removed as unavailable or unauthorized, per evidence. */
export interface FilterResult {
  /** ids removed by availability gates (available=false). */
  unavailable: string[];
  /** ids removed by permission gates (permitted=false). */
  unauthorized: string[];
}

function filterRegistry(
  registry: CandidateRegistry,
  availabilityGates: Record<string, boolean>,
  permissionGates: Record<string, boolean>,
): FilterResult {
  const unavailable: string[] = [];
  const unauthorized: string[] = [];

  for (const id of Object.keys(registry.candidates)) {
    const avail = availabilityGates[id] === true;
    if (!avail) {
      unavailable.push(id);
      continue;
    }
    // permission must be an explicit allow — absence is treated as unauthorized.
    const permitted = permissionGates[id] === true;
    if (!permitted) {
      unauthorized.push(id);
      continue;
    }
  }

  return { unavailable, unauthorized };
}

function validateRegistry(registry: CandidateRegistry, evidence: CompositeEvidence): string[] {
  const errors: string[] = [];
  if (typeof registry !== "object" || registry === null || typeof registry.candidates !== "object" || registry.candidates === null) {
    return ["candidate registry must be an object with candidate entries"];
  }
  if (typeof evidence !== "object" || evidence === null) return errors;
  if (registry.schemaVersion !== SCHEMA_VERSION) errors.push("candidate registry schemaVersion is invalid");
  if (!Array.isArray(registry.tiers) || registry.tiers.some(t => !TIER_ORDER.includes(t))) errors.push("candidate registry tiers are invalid");
  const ids = Object.keys(registry.candidates ?? {});
  const entries = Object.values(registry.candidates ?? {});
  if (new Set(ids).size !== ids.length) errors.push("candidate registry IDs are duplicated");
  for (const [key, entry] of Object.entries(registry.candidates ?? {})) {
    if (!entry || key !== entry.id || !TIER_ORDER.includes(entry.tier)) errors.push(`candidate registry entry '${key}' has invalid identity or tier`);
  }
  for (const dimension of ["availability", "permission"] as const) {
    const gates = evidence[dimension]?.gates;
    for (const id of ids) if (!gates || typeof gates[id] !== "boolean") errors.push(`${dimension} evidence missing boolean gate for '${id}'`);
    for (const id of Object.keys(gates ?? {})) if (!ids.includes(id)) errors.push(`${dimension} evidence contains unknown candidate '${id}'`);
    const probabilities = evidence[dimension]?.probabilities;
    if (probabilities && probabilities.length !== ids.length) errors.push(`${dimension} probability vector length must match candidate count`);
  }
  return errors;
}

/** Bucket the kept ids by their registry tier. */
function eligibleByTier(registry: CandidateRegistry, ids: string[]): Record<TierName, string[]> {
  const remaining: Record<TierName, string[]> = { fast: [], medium: [], heavy: [] };
  for (const id of ids) {
    const entry = registry.candidates[id];
    if (!entry) continue;
    remaining[entry.tier].push(id);
  }
  return remaining;
}

// ---------------------------------------------------------------------------
// Probability disagreement detection
// ---------------------------------------------------------------------------

/** True when availability & permission distributions disagree on the top candidate. */
export function hasProbabilityDisagreement(evidence: NormalizedEvidence): boolean {
  const A = evidence.availability?.probabilities ?? [];
  const P = evidence.permission?.probabilities ?? [];
  if (!A.length || !P.length) return false; // a missing distribution cannot disagree
  const top = (probs: readonly number[]): string | null => {
    let best = -1;
    for (let i = 0; i < probs.length; i++) if (probs[i] > best) best = probs[i];
    return Object.keys(evidence.availability!.gates).sort(idOrder).find((_, i) => probs[i] === best) ?? null;
  };
  return top(A)! !== top(P)!;
}

// ---------------------------------------------------------------------------
// Pure composer entry point
// ---------------------------------------------------------------------------

/** Pure composer entry point — returns a full RoutingDecision. */
export function compose(evidence: CompositeEvidence, registry: CandidateRegistry): RoutingDecision {
  return composeToDecision(evidence, registry);
}

/**
 * Build the full RoutingDecision. Returns a fallback decision (no choice) when
 * we cannot decide safely — never inventing a lower tier than policy allows.
 */
export function composeToDecision(
  evidence: CompositeEvidence,
  registry: CandidateRegistry,
  request?: RoutingRequest | undefined,
  decidedAt = "1970-01-01T00:00:00.000Z",
): RoutingDecision {
  const req = request ?? { prompt: "" };

  // ---- normalize (silently drops unknown shapes) --------------------
  const norm = normalize(evidence);

  // Validate complete input before composition; no malformed evidence can
  // become a lower-tier choice.
  const errors = [...validateEvidence(evidence), ...validateRegistry(registry, evidence)];
  if (errors.length > 0) {
    return failDecision(
      "invalid",
      evidence,
      registry,
      req,
      explanationFrom(norm, []),
      { reason: errors.sort().join("; ") },
    );
  }

  // All required evidence must clear the same execution-confidence threshold.
  const requiredOk =
    hasConfidence(norm.complexity) &&
    hasConfidence(norm.risk) &&
    hasConfidence(norm.specialty) &&
    hasConfidence(norm.availability) &&
    hasConfidence(norm.permission);

  if (!requiredOk) {
    return failDecision(
      "not-enough-evidence",
      evidence,
      registry,
      req,
      explanationFrom(norm, []),
      { reason: "one or more required evidence dimensions lack a finite confidence answer" },
    );
  }

  // Eligibility is resolved before policy floors; absent/false gates cannot
  // later be bypassed by a tier choice.
  const { unavailable, unauthorized } = filterRegistry(registry, norm.availability?.gates ?? {}, norm.permission?.gates ?? {});

  // ---- uncertainty gate -------------------------------------------
  const weakDimension = (["complexity", "risk", "specialty", "availability", "permission"] as const)
    .find(d => (norm[d] as NormalizedDim | NormalizedGate | undefined)?.confidence! < EXECUTION_CONFIDENCE);
  const phaseWeak = norm.phase !== undefined && norm.phase.confidence! < EXECUTION_CONFIDENCE;
  if (weakDimension || phaseWeak) {
    const confidence = weakDimension ? (norm[weakDimension] as NormalizedDim | NormalizedGate).confidence : norm.phase?.confidence;
    return failDecision(
      "uncertain",
      evidence,
      registry,
      req,
      explanationFrom(norm, []),
      { reason: `confidence ${String(confidence)} below execution threshold ${EXECUTION_CONFIDENCE}` },
    );
  }

  // ---- probability disagreement ------------------------------------
  if (hasProbabilityDisagreement(norm)) {
    return failDecision(
      "probability-disagreement",
      evidence,
      registry,
      req,
      explanationFrom(norm, []),
      { reason: "availability/permission probability distributions disagree — widen, do not collapse" },
    );
  }

  // ---- specialty resolution (escapes unknown before selection) -----
  if (norm.specialty?.value === "unknown") {
    return failDecision(
      "unknown-specialty",
      evidence,
      registry,
      req,
      explanationFrom(norm, []),
      { reason: "specialist specialty is 'unknown' and no concrete tier could be trusted — escalate" },
    );
  }
  if (norm.specialty?.value === "registered" && !mapSpecialtyTier(norm.specialty.tier)) {
    return failDecision("unknown-specialty", evidence, registry, req, explanationFrom(norm, []), { reason: "registered specialty lacks a known tier — escalate" });
  }


  // ---- compute target = max(complexity, risk floor, specialty tier, mixed=>medium) --
  let rank = Math.max(
    tierRank(levelToTier((norm.complexity?.value ?? "medium") as ComplexityLevel)),
    tierRank(levelToTier((norm.risk?.value ?? "medium") as RiskLevel)),
    tierRank(phaseFloor(norm.phase) ?? "fast"),
  );
  const sp = norm.specialty ? specialtyFloor(norm.specialty) : undefined;
  if (sp) rank = Math.max(rank, tierRank(sp));
  const target = TIER_ORDER[rank] as TierName;

  // Policy overrides recorded for the explanation.
  const overrides: PolicyOverride[] = [];
  if (sp) overrides.push({ stage: "specialty", tier: sp, reason: "registered specialist tier used as a floor" });
  if (norm.phase?.value === "mixed") overrides.push({ stage: "phase-mixed", tier: "medium", reason: "mixed phase widened the target to at least medium" });

  // ---- select lowest eligible candidate at/above target ------------
  const eligibleIds: string[] = [];
  for (const id of Object.keys(registry.candidates)) {
    if ((unavailable.includes(id) || unauthorized.includes(id))) continue;
    eligibleIds.push(id);
  }

  for (const tier of TIER_ORDER) {
    if (tierRank(tier) < tierRank(target)) continue;
    const candidatesForTier = eligibleByTier(registry, eligibleIds)[tier] as string[] | undefined;
    if (!candidatesForTier || candidatesForTier.length === 0) continue;

    const sorted = candidatesForTier.slice().sort(idOrder);
    const chosenId = sorted[0];
    const entry = registry.candidates[chosenId];
    return okDecision({ ...req }, norm, tierRank(target), tier, chosenId, entry!, overrides, registry, decidedAt);
  }

  // No eligible candidate at/above target → escalate.
  return failDecision(
    "no-eligible-candidate",
    evidence,
    registry,
    req,
    explanationFrom(norm, overrides),
    { reason: `no eligible candidate: unavailable [${unavailable.join(", ")}], unauthorized [${unauthorized.join(", ")}]` },
  );
}

// ---------------------------------------------------------------------------
// Internal decision builders & helpers
// ---------------------------------------------------------------------------

function failDecision(
  reason: ComposerReason,
  evidence: CompositeEvidence,
  registry: CandidateRegistry,
  req: RoutingRequest,
  explanation: Explanation,
  info: { reason: string; fallback?: RoutingFallback },
): RoutingDecision {
  const fallback = info.fallback ?? { action: "escalate", tier: "heavy", reason: info.reason };
  return buildDecision(evidence, registry, req, { reason: info.reason }, explanation, { ...info, fallback });
}

function okDecision(
  req: RoutingRequest,
  norm: NormalizedEvidence,
  _targetRank: number,
  tier: TierName,
  chosenId: string,
  entry: RegistryEntry,
  overrides: PolicyOverride[],
  registry: CandidateRegistry,
  decidedAt: string,
): RoutingDecision {
  const conf = typeof norm.complexity?.confidence === "number" ? norm.complexity.confidence : 0;
  return buildDecision(
    {} as CompositeEvidence,
    registry,
    req,
    { tier, confidence: conf, reason: `lowest eligible candidate ${chosenId} (${entry.tier}) at/above target tier`, metadata: { id: chosenId } },
    explanationFrom(norm, overrides),
    undefined,
    decidedAt,
  );
}

interface DecisionParts {
  tier?: TierName;
  confidence?: number;
  reason: string;
  metadata?: Record<string, unknown>;
}

function buildDecision(
  _evidence: CompositeEvidence | undefined,
  registry: CandidateRegistry | undefined,
  req: RoutingRequest,
  parts: DecisionParts,
  explanation: Explanation,
  info?: { reason: string; fallback?: RoutingFallback },
  decidedAt = "1970-01-01T00:00:00.000Z",
): RoutingDecision {
  const candidates: RoutingDecision["candidates"] = registry ? Object.keys(registry.candidates).sort(idOrder).map(id => ({
    ...registry.candidates[id],
    metadata: { id: registry.candidates[id].id },
  })) : [];
  const selected = parts.tier
    ? candidates.find(candidate => candidate.metadata?.id === parts.metadata?.id)
    : undefined;
  if (selected && parts.confidence !== undefined) selected.confidence = parts.confidence;
  const decision: RoutingDecision = {
    request: req,
    candidates,
    choice: selected as RoutingChoice | undefined,
    confidence: parts.confidence ?? 0,
    reason: parts.reason,
    fallback: parts.tier ? undefined : info?.fallback,
    receipt: {
      requestId: req.context?.requestId as string | undefined,
      router: "composer",
      decidedAt,
      mode: "live",
      confidence: parts.confidence ?? 0,
      reason: info?.reason ?? parts.reason,
      candidateCount: registry ? Object.keys(registry.candidates).length : 0,
      fallback: parts.tier ? undefined : info?.fallback,
    },
  };
  decision.explanation = explanation;
  return decision;
}

function tierRank(tier: TierName): number {
  return TIER_ORDER.indexOf(tier);
}

/** Deterministic, stable candidate ordering (ascending by id). */
function idOrder(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Describe one evidence dimension for the explanation summary. */
export function descriptionOf(dimension: EvidenceDimension, norm: NormalizedEvidence): string {
  switch (dimension) {
    case "complexity":
    case "risk": {
      const ev = norm[dimension];
      return `${ev?.value ?? "unresolved"} (conf ${ev?.confidence ?? "?"})`;
    }
    case "specialty": {
      const ev = norm.specialty;
      return `${ev?.value ?? "none"}${ev?.tier ? ` / ${ev.tier}` : ""} (conf ${ev?.confidence ?? "?"})`;
    }
    case "availability":
    case "permission": {
      const gates = norm[dimension]?.gates ?? {};
      return Object.keys(gates).filter((id) => gates[id]).join(", ") || "none eligible";
    }
    case "phase":
      return norm.phase ? `${norm.phase.value} (conf ${norm.phase.confidence ?? "?"})` : "unspecified";
    default:
      return "unspecified";
  }
}

function explanationFrom(norm: NormalizedEvidence, overrides: PolicyOverride[]): Explanation {
  const summary = EVIDENCE_DIMENSIONS.map((d) => ({ dimension: d, detail: descriptionOf(d, norm) }));
  return { evidenceSummary: summary, policyOverrides: overrides };
}

/** All known evidence dimensions (availability/permission are gate-keyed, phase is optional). */
export const EVIDENCE_DIMENSIONS: readonly EvidenceDimension[] = [
  "complexity",
  "risk",
  "specialty",
  "availability",
  "permission",
  "phase",
];
