/**
 * src/policy/jev.ts — portable Jev decision policy.
 *
 * Ported from:
 *   davila7/claude-code-templates
 *   cli-tool/components/mods/productivity/jev-model-router/hooks/policy.ts
 *   MIT License — https://github.com/davila7/claude-code-templates/blob/main/LICENSE
 *
 * PORTABLE SUBSET ONLY. No transport, no hook wiring, no external Jev API.
 * This module is PURE: no Node fs/os/path imports, no network, no SDK.
 *
 * What is here:
 *   - Decision / PolicyConfig / Routing types
 *   - readDecision()       — parse both TypeSafe and Gateway response shapes
 *   - route()              — asymmetric confidence gates (upgrade ≠ downgrade bar)
 *   - rankOf()             — map a model-id string to a tier rank
 *   - effortLevel()        — rubric score → Effort label
 *   - effortRank()         — Effort label → ladder rank
 *   - pendingDecisions()   — single-slot decision store (prompt-turn sequencing)
 *   - diagnosePendingDecision() — timeout diagnostic string
 *
 * What is NOT here (transport / UI / OC-specific):
 *   - requestBody, requestHeaders, endpoint, selectProvider
 *   - describeDecision, describeSetup, describeStatus
 *   - requestModelId (alias resolution)
 *   - Provider, DEFAULT_BASE_URL, DEFAULT_MODEL
 *   - TIER_CRITERIA, questions()
 */

// ---------------------------------------------------------------------------
// Tier + Effort
// ---------------------------------------------------------------------------

export type Tier = "fast" | "balanced" | "deep";

/** The reasoning levels a turn can ask for, cheapest first. */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORT_ORDER)[number];

export const TIER_ORDER: readonly Tier[] = ["fast", "balanced", "deep"];

export interface Tiers {
  fast: string;
  balanced: string;
  deep: string;
}

// ---------------------------------------------------------------------------
// Decision — what the classification backend returns
// ---------------------------------------------------------------------------

export interface Decision {
  tier: Tier;
  /** Confidence in the tier, or null when the backend reported none. */
  confidence: number | null;
  /** P(true) that carrying out the task itself is costly or final. */
  risky: number | null;
  /** 0..3 along the effort rubric, or null when absent. */
  effort: number | null;
  /** Confidence in the effort, or null when the backend reported none. */
  effortConfidence: number | null;
}

// ---------------------------------------------------------------------------
// PolicyConfig
// ---------------------------------------------------------------------------

export interface PolicyConfig {
  tiers: Tiers;
  /**
   * How sure the decision must be to spend more (bigger model, more
   * reasoning). Being wrong here costs money, so the bar is low.
   */
  minUpgradeConfidence: number;
  /**
   * How sure it must be to spend less. Being wrong here means a task
   * handled by too small a model, so the bar is high.
   */
  minDowngradeConfidence: number;
}

// ---------------------------------------------------------------------------
// Routing — output of route()
// ---------------------------------------------------------------------------

export interface Routing {
  /** The model to run on, or null to leave the request as-is. */
  model: string | null;
  /** The reasoning level to ask for, or null to leave it as-is. */
  effort: Effort | null;
  /** Why, for the log line. */
  reason: string;
}

const NOTHING: Routing = { model: null, effort: null, reason: "no decision" };

// ---------------------------------------------------------------------------
// readDecision — parse TypeSafe and Gateway response shapes
// ---------------------------------------------------------------------------

function isTier(value: unknown): value is Tier {
  return value === "fast" || value === "balanced" || value === "deep";
}

/**
 * Derive the confidence from one answer field.
 *
 * TypeSafe reports `confidence` directly; the Gateway does not — it is
 * derived from the highest probability of an optional distribution.
 * Missing confidence reads as null, not as a trusted number.
 */
function confidenceOf(answer: Record<string, unknown>): number | null {
  if (typeof answer.confidence === "number") return answer.confidence;
  const probabilities = answer.probabilities as Record<string, number> | undefined;
  const values = probabilities ? Object.values(probabilities) : [];
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * Parse a classification response from either backend.
 *
 * TypeSafe's own API reports `confidence` per answer and `noul` for yes/no.
 * The Gateway reports neither: confidence comes from an optional distribution,
 * and yes/no arrives as `probability`. Both shapes are handled.
 *
 * Returns null (never throws) on malformed input or unrecognised tier.
 */
export function readDecision(responseText: string): Decision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return null;
  }
  const answers = (parsed as { answers?: Record<string, Record<string, unknown>> }).answers;
  if (!answers) return null;

  const tierAnswer = answers.tier;
  if (!tierAnswer || !isTier(tierAnswer.choice)) return null;

  const effortAnswer = answers.effort;
  const riskyAnswer = answers.risky;
  const risky =
    typeof riskyAnswer?.noul === "number"
      ? riskyAnswer.noul
      : typeof riskyAnswer?.probability === "number"
        ? riskyAnswer.probability
        : null;

  return {
    tier: tierAnswer.choice,
    confidence: confidenceOf(tierAnswer),
    effort: typeof effortAnswer?.score === "number" ? effortAnswer.score : null,
    effortConfidence: effortAnswer ? confidenceOf(effortAnswer) : null,
    risky,
  };
}

// ---------------------------------------------------------------------------
// rankOf — map model-id string to tier rank
// ---------------------------------------------------------------------------

/**
 * Where a model id sits on the tier ladder, by matching against the configured
 * tier names first and then family words.
 *
 * Returns null when no match; callers treat an unrecognised id as an upgrade
 * (the gentler threshold), never guessing at the direction.
 */
export function rankOf(model: string, tiers: Tiers): number | null {
  const lowered = model.toLowerCase();
  for (let i = 0; i < TIER_ORDER.length; i++) {
    const tier = TIER_ORDER[i] as Tier;
    const configured = tiers[tier].toLowerCase();
    if (configured && lowered.includes(configured)) return i;
  }
  if (lowered.includes("haiku")) return 0;
  if (lowered.includes("sonnet")) return 1;
  if (lowered.includes("opus")) return 2;
  return null;
}

// ---------------------------------------------------------------------------
// effortLevel / effortRank
// ---------------------------------------------------------------------------

/** Map a rubric score (0..3) to a reasoning-level label. */
export function effortLevel(score: number): Effort {
  const index = Math.min(EFFORT_ORDER.length - 1, Math.max(0, Math.round(score)));
  return EFFORT_ORDER[index] as Effort;
}

/**
 * Where a reasoning level sits on the ladder, or null when unrecognised.
 * `"max"` is above every rung the rubric can produce.
 */
export function effortRank(effort: string | number | undefined): number | null {
  if (typeof effort !== "string") return null;
  if (effort === "max") return EFFORT_ORDER.length;
  const index = EFFORT_ORDER.indexOf(effort as Effort);
  return index === -1 ? null : index;
}

// ---------------------------------------------------------------------------
// route — asymmetric confidence gate
// ---------------------------------------------------------------------------

/**
 * Whether a change of rank passes its threshold.
 *
 * Upgrade bar < downgrade bar: the two mistakes do not cost the same.
 * A backend that reports no confidence clears the upgrade bar but never the
 * downgrade one — spending less on an unmeasured hunch is the bad trade.
 */
function allowed(
  wanted: number,
  current: number | null,
  confidence: number | null,
  config: PolicyConfig,
): boolean {
  if (current !== null && wanted === current) return false;
  const isDowngrade = current !== null && wanted < current;
  const bar = isDowngrade ? config.minDowngradeConfidence : config.minUpgradeConfidence;
  if (confidence === null) return !isDowngrade;
  return confidence >= bar;
}

/**
 * Turn a decision into a model and a reasoning level, either of which may be
 * null to leave the request as-is.
 *
 * Risk > 0.7 forces the deep tier and at least `high` reasoning, bypassing
 * confidence thresholds — this is the one case that is not a confidence
 * question.
 */
export function route(
  decision: Decision | null,
  current: { model: string; effort?: string | number },
  config: PolicyConfig,
): Routing {
  if (!decision) return NOTHING;

  let tier = decision.tier;
  let effortScore = decision.effort;
  let forced = false;

  if (decision.risky !== null && decision.risky > 0.7) {
    tier = "deep";
    effortScore = Math.max(effortScore ?? 0, 2);
    forced = true;
  }

  const wantedTier = TIER_ORDER.indexOf(tier);
  const currentTier = rankOf(current.model, config.tiers);
  const wantedModel = config.tiers[tier];

  const model =
    wantedModel &&
    wantedModel !== current.model &&
    (forced || allowed(wantedTier, currentTier, decision.confidence, config))
      ? wantedModel
      : null;

  let effort: Effort | null = null;
  if (effortScore !== null) {
    const currentRank = effortRank(current.effort);
    let wantedRank = EFFORT_ORDER.indexOf(effortLevel(effortScore));

    // Risk raises the floor; it must never lower one.
    if (forced && currentRank !== null) wantedRank = Math.max(wantedRank, currentRank);

    // A numeric effort is the caller's own scale, not this ladder; leave it.
    const comparable = typeof current.effort !== "number";
    const wanted = EFFORT_ORDER[Math.min(EFFORT_ORDER.length - 1, wantedRank)] as Effort;
    if (
      comparable &&
      wantedRank !== currentRank &&
      (forced || allowed(wantedRank, currentRank, decision.effortConfidence, config))
    ) {
      effort = wanted;
    }
  }

  const said =
    decision.confidence === null
      ? "confidence n/d"
      : `confidence ${decision.confidence.toFixed(2)}`;

  if (!model && !effort) {
    const wantedEffort = effortScore === null ? null : effortLevel(effortScore);
    const kept = `${current.model}${current.effort === undefined ? "" : `/${current.effort}`}`;
    const wanted = `${wantedModel}${wantedEffort ? `/${wantedEffort}` : ""}`;
    return { model: null, effort: null, reason: `kept ${kept}, wanted ${wanted} (${said})` };
  }

  return { model, effort, reason: forced ? `${tier}, forced by risk` : `${tier} (${said})` };
}

// ---------------------------------------------------------------------------
// pendingDecisions — single-slot prompt-to-turn sequencing
// ---------------------------------------------------------------------------

/**
 * Holds a prompt's classification until the turn that reads it starts.
 *
 * When more than one prompt is waiting, `take` returns null: running a turn on
 * another prompt's decision is a worse outcome than not routing at all.
 */
export function pendingDecisions(): {
  put(decision: Decision | null): void;
  take(): Decision | null;
} {
  let held: Decision | null = null;
  let waiting = 0;

  return {
    put(decision) {
      waiting += 1;
      held = waiting === 1 ? decision : null;
    },
    take() {
      const decision = waiting === 1 ? held : null;
      held = null;
      waiting = 0;
      return decision;
    },
  };
}

// ---------------------------------------------------------------------------
// diagnosePendingDecision — timeout diagnostic
// ---------------------------------------------------------------------------

/**
 * Human-readable timeout diagnostic for a pending classification.
 *
 * Surfaces whether the classification is still in-flight (elapsed < budget),
 * has overrun (elapsed >= budget), or was never started (elapsedMs is null).
 *
 * Intended for log lines when a turn starts but the decision slot is empty.
 */
export function diagnosePendingDecision(
  elapsedMs: number | null,
  budgetMs: number,
): string {
  if (elapsedMs === null) return "classification not started";
  if (elapsedMs < budgetMs) {
    return `classification in-flight (${Math.round(elapsedMs)}ms / ${budgetMs}ms budget)`;
  }
  return `classification timed out after ${Math.round(elapsedMs)}ms (budget ${budgetMs}ms)`;
}
