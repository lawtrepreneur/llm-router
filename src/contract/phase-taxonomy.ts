/**
 * src/contract/phase-taxonomy.ts
 *
 * Machine-readable phase taxonomy: the three tiers as named phases with
 * their allowed tool kinds, read-only caps, prompt style, and escalation
 * conditions.
 *
 * "Phase" and "tier" are the same concept; "phase" is used here to emphasise
 * the behavioural contract rather than the model assignment.
 *
 * PURE: no imports from Node fs/os/path, no network, no SDK.
 */

// ---------------------------------------------------------------------------
// Tool kinds allowed per phase
// ---------------------------------------------------------------------------

/**
 * A tool kind classification (mirrors guard.ts GuardKind).
 *
 * - "read"     — read-only: grep, glob, ls, read, git-show, etc.
 * - "mutation" — writes: write, edit, patch, multiedit, bash (with edits)
 * - "finish"   — terminal: finish, return, task_complete
 * - "other"    — tool calls that are neither reads nor mutations (API calls, etc.)
 *
 * self_script is deliberately absent: it is a guard block, not a phase-level
 * permission.
 */
export type ToolKindPermission = "read" | "mutation" | "finish" | "other";

// ---------------------------------------------------------------------------
// Phase definition
// ---------------------------------------------------------------------------

export interface PhaseDefinition {
  /** Canonical name ("fast" | "medium" | "heavy"). */
  name: "fast" | "medium" | "heavy";

  /** One-line description of the phase's purpose. */
  purpose: string;

  /** Ordered tool kind permissions. Absent kinds are implicitly denied. */
  allowedToolKinds: ToolKindPermission[];

  /**
   * Default read-only cap for this phase (max read/glob/grep calls before
   * the runtime requires a producing action or a finish).
   * Source: tiers.json tierCaps.
   */
  defaultReadCap: number;

  /**
   * Whether this phase may make file mutations (write/edit/patch).
   * Derived from allowedToolKinds for convenience.
   */
  mayMutate: boolean;

  /**
   * Dispatch cap defaults injected into the dispatch prompt.
   * The orchestrator includes `CAP:<n>` in the dispatch when sending to this
   * phase. null = CAP:none (deep/quality modes only, requires a reason line).
   */
  dispatchCap: number | null;

  /**
   * Consecutive non-producing calls ceiling before the guard fires.
   * Source: tiers.json enforcement.guard.readDraftCap.
   */
  readDraftCap: number;

  /**
   * Maximum same-operation retries before the guard fires.
   * Source: tiers.json enforcement.guard.sameOpRetryCap.
   */
  sameOpRetryCap: number;

  /**
   * Prompt style hint. "prescriptive" = enumerated stop conditions; "auto"
   * = goal-oriented for strong models.
   */
  promptStyle: "prescriptive" | "goal-oriented" | "auto";

  /**
   * Conditions under which this phase escalates to the next tier.
   * Informational, not enforced by this module.
   */
  escalationConditions: string[];

  /**
   * Return protocol prefix the agent MUST use as its first line.
   */
  returnProtocol: string[];
}

// ---------------------------------------------------------------------------
// The taxonomy
// ---------------------------------------------------------------------------

export const PHASE_TAXONOMY: Record<"fast" | "medium" | "heavy", PhaseDefinition> = {
  fast: {
    name: "fast",
    purpose: "Read-only exploration: search, grep, read, ls, lookup, doc-lookup, type-check, count, exists-check, git-info.",
    allowedToolKinds: ["read", "finish", "other"],
    defaultReadCap: 8,
    mayMutate: false,
    dispatchCap: 8,
    readDraftCap: 3,
    sameOpRetryCap: 1,
    promptStyle: "prescriptive",
    escalationConditions: [
      "task requires writes or edits → return NEED MORE or ESCALATE",
      "scope exceeds read-only work → ESCALATE",
    ],
    returnProtocol: [
      "DONE: [one-line summary] — dispatch fully satisfied",
      "NEED MORE: [specific ask] — orchestrator dispatches another targeted round",
      "ESCALATE: [reason] — hand back for orchestrator decision",
    ],
  },

  medium: {
    name: "medium",
    purpose: "Implementation: write/edit code, refactor, write tests, fix bugs (≤2 failures), build-fix, create files, config changes, API endpoints.",
    allowedToolKinds: ["read", "mutation", "finish", "other"],
    defaultReadCap: 5,
    mayMutate: true,
    dispatchCap: 5,
    readDraftCap: 3,
    sameOpRetryCap: 1,
    promptStyle: "prescriptive",
    escalationConditions: [
      "2+ consecutive failures on same issue → stop, report to orchestrator",
      "scope grew beyond implementation (architectural decision needed) → ESCALATE",
      "task requires @fast pre-exploration → NEED CONTEXT",
    ],
    returnProtocol: [
      "DONE: [summary of edits + verification] — implementation complete",
      "NEED CONTEXT: [specific ask] — orchestrator dispatches @fast and re-invokes",
      "ESCALATE: [reason] — scope grew beyond implementation",
    ],
  },

  heavy: {
    name: "heavy",
    purpose: "Architecture decisions, security review, perf optimization, complex debugging (invoked after ≥2 prior failures), multi-system tradeoffs, migration strategy, root-cause analysis.",
    allowedToolKinds: ["read", "mutation", "finish", "other"],
    defaultReadCap: 3,
    mayMutate: true,
    dispatchCap: 3,
    readDraftCap: 3,
    sameOpRetryCap: 1,
    promptStyle: "prescriptive",
    escalationConditions: [
      "insufficient context for analysis → SCOPE GROWTH (prefer @fast pre-exploration)",
      "decision requires information not in context → ESCALATE",
    ],
    returnProtocol: [
      "DONE: [structured analysis] — request fully satisfied",
      "SCOPE GROWTH: prefer @fast pre-exploration of [specific files/patterns/areas]",
      "ESCALATE: [reason] — hand back for orchestrator decision",
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true when the given tool kind is permitted in the given phase. */
export function isToolKindPermitted(
  phase: "fast" | "medium" | "heavy",
  kind: ToolKindPermission,
): boolean {
  return PHASE_TAXONOMY[phase].allowedToolKinds.includes(kind);
}

/**
 * Returns the default dispatch cap for the given phase and mode.
 * In quality/deep modes for medium/heavy, the cap is null (CAP:none).
 * In budget mode, caps are tighter (see lane-matrix.ts for per-task overrides).
 */
export function resolveDispatchCap(
  phase: "fast" | "medium" | "heavy",
  mode: "normal" | "budget" | "quality" | "deep",
): number | null {
  if (mode === "quality" && (phase === "medium" || phase === "heavy")) return null;
  if (mode === "deep" && phase === "heavy") return null;
  if (mode === "budget") {
    if (phase === "fast") return 5;
    return 2;
  }
  return PHASE_TAXONOMY[phase].dispatchCap;
}
