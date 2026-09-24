/**
 * src/contract/escalate-schema.ts
 *
 * Machine-readable contract for the escalation policy (fail-up ladder).
 * Provides typed constants, defaults, the canonical validator, and field
 * semantics as inline JSDoc.
 *
 * PURE: no imports from Node fs/os/path, no network, no SDK.
 */

// ---------------------------------------------------------------------------
// EscalatePolicy — the typed contract
// ---------------------------------------------------------------------------

/**
 * Controls how the router escalates a failed delegation to a higher tier.
 *
 * Source of truth: ladder.ts:EscalatePolicy.
 * This module adds defaults, validator, and semantic commentary.
 *
 * Key rule: `unverifiable` outcome NEVER triggers escalation.
 *           Only concrete `fail` verdicts enter the retry/escalate loop.
 *           See docs/FAIL_UP_RULES.md for rationale.
 */
export interface EscalatePolicySchema {
  /**
   * Ordered tier names from cheapest to most expensive.
   * A delegation starts at `floorTier` (or the producer's tier, whichever
   * is higher) and escalates upward along this list.
   *
   * Default: ["fast", "medium", "heavy"]
   * Constraint: must be a non-empty array of non-empty strings.
   */
  ladder: string[];

  /**
   * Minimum tier to use when verifying a delegation.
   * A fast-tier producer will still be verified by at least the floor tier.
   * null (default) means no floor — the first ladder entry is used.
   */
  floorTier: string | null;

  /**
   * Maximum number of retry attempts on the same tier before escalating.
   * 0 means "no retries: escalate or give_up immediately on first failure".
   * 1 (default) means "one attempt, then escalate".
   *
   * Constraint: non-negative integer.
   */
  maxAttemptsPerTier: number;

  /**
   * Hard ceiling on total attempts across ALL tiers (retries + escalations).
   * When reached, the ladder terminates with give_up regardless of tier position.
   *
   * Default: 4
   * Constraint: integer >= 1 (at least one attempt must be allowed).
   */
  maxTotalAttempts: number;

  /**
   * Optional cost ceiling expressed as a multiple of the FIRST attempt's cost.
   * When cumulative cost exceeds firstAttemptCost * costMultiple, the ladder
   * terminates with give_up even if attempts remain.
   *
   * null (default) means no cost ceiling.
   * Constraint: number > 0 when set.
   */
  costMultiple: number | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_ESCALATE_POLICY: EscalatePolicySchema = {
  ladder: ["fast", "medium", "heavy"],
  floorTier: null,
  maxAttemptsPerTier: 1,
  maxTotalAttempts: 4,
  costMultiple: 4,
};

// ---------------------------------------------------------------------------
// LadderAction — the four terminal/non-terminal actions
// ---------------------------------------------------------------------------

/**
 * Decision returned by nextAction() at each ladder step.
 *
 * Terminal:     accept, give_up
 * Non-terminal: retry, escalate
 */
export type LadderActionKind = "accept" | "retry" | "escalate" | "give_up";

/**
 * Reasons a give_up action is produced (informational — not an error code).
 *
 * All of these EXCEPT "fail-max-attempts" / "fail-cost-ceiling" are
 * non-escalatable: paying more cannot fix them.
 */
export type GiveUpReason =
  | "verification-unavailable"   // outcome === "unverifiable" — NEVER escalated
  | "max-total-attempts"         // totalAttempts >= maxTotalAttempts
  | "cost-ceiling-exceeded"      // cumulativeCost > firstCost * costMultiple
  | "no-higher-tier"             // already at the top of the ladder
  | "unknown";                   // defensive fallthrough

// ---------------------------------------------------------------------------
// Fail-up semantics constants
// ---------------------------------------------------------------------------

/**
 * The ONLY verdict outcomes that trigger retry / escalate.
 * Anything else (pass, unverifiable) terminates the ladder immediately.
 *
 * This is the machine-readable expression of the key rule stated in JSDoc on
 * EscalatePolicySchema: unverifiable is NEVER escalated.
 */
export const ESCALATABLE_OUTCOMES = new Set<string>(["fail"]);

/**
 * Verdict outcomes that terminate the ladder without escalation.
 * "unverifiable" is present here deliberately: it means the verifier could
 * not run, which is not evidence the producer failed. Dispatching again at a
 * higher tier cannot repair a broken or absent verifier.
 */
export const NON_ESCALATABLE_OUTCOMES = new Set<string>(["pass", "unverifiable"]);

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate a raw escalate config block (from tiers.json enforcement.escalate).
 * Returns a list of validation errors (empty = valid). Does not throw.
 */
export function validateEscalatePolicy(raw: unknown): string[] {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["EscalatePolicy must be a non-null object"];
  }
  const p = raw as Record<string, unknown>;

  if (p.ladder !== undefined) {
    if (
      !Array.isArray(p.ladder) ||
      p.ladder.length === 0 ||
      !p.ladder.every((s: unknown) => typeof s === "string" && s.length > 0)
    ) {
      errors.push("EscalatePolicy: 'ladder' must be a non-empty array of non-empty strings");
    }
  }

  if (p.floorTier !== undefined && p.floorTier !== null && typeof p.floorTier !== "string") {
    errors.push("EscalatePolicy: 'floorTier' must be a string or null");
  }

  if (p.maxAttemptsPerTier !== undefined) {
    if (
      typeof p.maxAttemptsPerTier !== "number" ||
      !Number.isInteger(p.maxAttemptsPerTier) ||
      p.maxAttemptsPerTier < 0
    ) {
      errors.push("EscalatePolicy: 'maxAttemptsPerTier' must be a non-negative integer");
    }
  }

  if (p.maxTotalAttempts !== undefined) {
    if (
      typeof p.maxTotalAttempts !== "number" ||
      !Number.isInteger(p.maxTotalAttempts) ||
      p.maxTotalAttempts < 1
    ) {
      errors.push("EscalatePolicy: 'maxTotalAttempts' must be an integer >= 1");
    }
  }

  if (p.costMultiple !== undefined && p.costMultiple !== null) {
    if (typeof p.costMultiple !== "number" || p.costMultiple <= 0) {
      errors.push("EscalatePolicy: 'costMultiple' must be a number > 0 or null");
    }
  }

  // costCeiling.multiple alias (tiers.json uses this shape)
  if (p.costCeiling !== undefined && typeof p.costCeiling === "object" && p.costCeiling !== null) {
    const cc = p.costCeiling as Record<string, unknown>;
    if (cc.multiple !== undefined && (typeof cc.multiple !== "number" || cc.multiple <= 0)) {
      errors.push("EscalatePolicy: 'costCeiling.multiple' must be a number > 0");
    }
  }

  return errors;
}

/**
 * Resolve raw tiers.json enforcement.escalate config to a normalized
 * EscalatePolicySchema, filling defaults for absent fields.
 */
export function resolveEscalatePolicy(
  raw: Record<string, unknown> | undefined,
): EscalatePolicySchema {
  if (!raw) return { ...DEFAULT_ESCALATE_POLICY };

  const ladder = Array.isArray(raw.ladder) ? (raw.ladder as string[]) : DEFAULT_ESCALATE_POLICY.ladder;

  const floorTier =
    raw.floorTier === null || raw.floorTier === undefined
      ? null
      : typeof raw.floorTier === "string"
        ? raw.floorTier
        : null;

  const maxAttemptsPerTier =
    typeof raw.maxAttemptsPerTier === "number"
      ? raw.maxAttemptsPerTier
      : DEFAULT_ESCALATE_POLICY.maxAttemptsPerTier;

  const maxTotalAttempts =
    typeof raw.maxTotalAttempts === "number"
      ? raw.maxTotalAttempts
      : DEFAULT_ESCALATE_POLICY.maxTotalAttempts;

  // Support both raw.costMultiple and raw.costCeiling.multiple
  let costMultiple: number | null = DEFAULT_ESCALATE_POLICY.costMultiple;
  if (raw.costMultiple !== undefined && raw.costMultiple !== null) {
    costMultiple = typeof raw.costMultiple === "number" ? raw.costMultiple : costMultiple;
  } else if (
    raw.costCeiling !== undefined &&
    typeof raw.costCeiling === "object" &&
    raw.costCeiling !== null
  ) {
    const cc = raw.costCeiling as Record<string, unknown>;
    if (typeof cc.multiple === "number") costMultiple = cc.multiple;
  }

  return { ladder, floorTier, maxAttemptsPerTier, maxTotalAttempts, costMultiple };
}
