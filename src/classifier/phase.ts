/**
 * src/classifier/phase.ts — phase detection and planning short-circuit.
 *
 * Taxonomy lives here (router repo), not in tool-system1. Uses existing
 * lane-matrix and phase-taxonomy contracts from src/contract/.
 *
 * PURE: no Node fs/os/path, no network, no SDK.
 */

import {
  classifyTaskKind,
  LANE_MATRIX,
  resolveLane,
  type ModeName,
  type TaskKind,
  type TierName,
} from "../contract/lane-matrix";

// ---------------------------------------------------------------------------
// Planning short-circuit
// ---------------------------------------------------------------------------

/**
 * Task text patterns that signal a planning / meta task, not an executable
 * implementation or lookup task. These short-circuit before any model call.
 *
 * Matched case-insensitively against the full task text.
 */
const PLANNING_PATTERNS: RegExp[] = [
  /\bplan\b/i,
  /\bdesign\b/i,
  /\bspec\b/i,
  /\bspecification\b/i,
  /\broadmap\b/i,
  /\barchitecture\b/i,
  /\bblueprint\b/i,
  /\bpropose\b/i,
  /\bsketch\b/i,
  /\bbrainstorm\b/i,
  /\bdiscuss\b/i,
  /\bhow should\b/i,
  /\bwhat.{0,20}approach\b/i,
  /\bwhat.{0,20}best way\b/i,
];

/** Return true when the task text matches a planning short-circuit pattern. */
export function isPlanningTask(text: string): boolean {
  return PLANNING_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// ClassifiedPhase — result of detect()
// ---------------------------------------------------------------------------

export type PhaseSource = "planning-short-circuit" | "task-kind" | "default";

export interface ClassifiedPhase {
  /** Resolved tier name. */
  tier: TierName;
  /** How the tier was determined. */
  source: PhaseSource;
  /**
   * The canonical task kind matched from lane-matrix, when source is
   * "task-kind". Null otherwise.
   */
  taskKind: TaskKind | null;
  /**
   * Whether direct execution (no subagent delegation) is allowed.
   * Only meaningful for fast-tier single read-only calls.
   */
  directAllowed: boolean;
}

// ---------------------------------------------------------------------------
// Word-boundary keyword list for task-kind matching
// ---------------------------------------------------------------------------

const KIND_KEYWORDS: Array<{ kind: TaskKind; patterns: RegExp[] }> = [
  // Explicit safety signals win before planning and generic review terms.
  { kind: "sec-audit", patterns: [/\bsecurity\b/i, /\bvulnerab/i, /\bauthenticat/i, /\bauthoriz/i, /\bauthoris/i, /\b(?:sql\s+injection|xss|csrf)\b/i, /\bprivilege\s+escalat/i, /\bexploit\b/i, /\bmalware\b/i, /\b(?:api[_ -]?key|access[_ -]?token|password|secret|credential)s?\b.{0,30}\b(?:rotate|replace|revoke|expose|leak|store|encrypt|decrypt)/i, /\b(?:rotate|replace|revoke|expose|leak|store|encrypt|decrypt)\b.{0,30}\b(?:api[_ -]?key|access[_ -]?token|password|secret|credential)s?\b/i] },
  { kind: "destructive-operation", patterns: [/\brm\s+-rf\b/i, /\bdrop(?:\s+\w+){0,4}\s+(?:table|database)\b/i, /\btruncate\s+table\b/i, /\bgit\s+reset\s+--hard\b/i, /\bgit\s+push\s+--force\b/i, /\bforce[- ]push\b/i, /\b(?:delete|remove|wipe|destroy)\b.{0,40}\b(?:all|production|database|data|files|records)\b/i] },
  { kind: "legal-compliance", patterns: [/\b(?:gdpr|ccpa|hipaa|sox|legal|compliance|statutory|regulatory)\b/i] },
  { kind: "rca", patterns: [/\broot.cause\s+analysis\b/i, /\bpostmortem\b/i] },
  {
    kind: "debug(≥3fail)",
    patterns: [/\b(?:debug|diagnose|trace)\b(?=[\s\S]*(?:\b[3-9]\s+(?:failed\s+)?attempts?\b|\b[3-9]\s+failures?\b|\b(?:three|repeated|multiple)\s+(?:failed\s+)?attempts?\b))/i],
  },
  { kind: "migrate-strategy", patterns: [/\bmigration\s+strategy\b/i, /\bupgrade\s+plan\b/i] },
  { kind: "multi-system-integration", patterns: [/\bmulti[- ]system\b/i, /\bcross[- ]service\b/i, /\b(?:integrat(?:e|ion)|connect)\b.{0,60}\b(?:services?|systems?|applications?|platforms?|gateway|pipeline)\b/i] },
  { kind: "arch-design", patterns: [/\barchitect\b/i] },
  { kind: "perf-opt", patterns: [/\bperformance\b/i, /\boptimize\b/i, /\blatency\b/i] },
  { kind: "tradeoff-analysis", patterns: [/\btradeoff\b/i, /\bcompare\b/i, /\bversus\b/i] },
  { kind: "build-fix", patterns: [/\bbuild\s+fail\b/i, /\bcompile\b/i, /\btypecheck\b/i] },
  { kind: "config-update", patterns: [/\bconfig\b/i, /\benv\b/i, /\bsetting\b/i] },
  { kind: "create-file", patterns: [/\bcreate.{0,40}file\b/i, /\bnew\s+file\b/i] },
  { kind: "impl-feature", patterns: [/\bimplement\b/i, /\badd.{0,20}feature\b/i, /\bbuild\b/i] },
  { kind: "refactor", patterns: [/\brefactor\b/i, /\bclean.{0,10}up\b/i, /\brestructure\b/i] },
  { kind: "write-tests", patterns: [/\btest\b/i, /\bspec\b/i, /\bunit\b/i] },
  { kind: "bugfix(≤2)", patterns: [/\bfix\b/i, /\bbug\b/i, /\bregression\b/i] },
  { kind: "edit-logic", patterns: [/\bedit\b/i, /\bupdate logic\b/i, /\bchange\b/i] },
  { kind: "code-review", patterns: [/\breview\b/i, /\baudit\b/i, /\bcheck\b/i] },
  { kind: "db-migrate", patterns: [/\bmigrat/i, /\bschema\b/i, /\bdatabase\b/i] },
  { kind: "api-endpoint", patterns: [/\bendpoint\b/i, /\bapi\s+route\b/i, /\bhandler\b/i] },
  { kind: "search", patterns: [/\bsearch\b/i, /\bfind\b/i, /\blook.{0,10}up\b/i] },
  { kind: "grep", patterns: [/\bgrep\b/i] },
  { kind: "read", patterns: [/\bread\b/i, /\bshow me\b/i, /\bwhat.{0,20}content\b/i] },
  { kind: "git-info", patterns: [/\bgit\b/i, /\bcommit\b/i, /\bbranch\b/i, /\bblame\b/i] },
  { kind: "ls", patterns: [/\blist\b/i, /\bls\b/i, /\bdirectory\b/i] },
  { kind: "lookup-docs/types", patterns: [/\bdocs?\b/i, /\bdocumentation\b/i, /\btype\s+def\b/i, /\binterface\b/i] },
  { kind: "count", patterns: [/\bcount\b/i, /\bhow many\b/i] },
  { kind: "exists-check", patterns: [/\bexists?\b/i, /\bdoes.{0,20}exist\b/i] },
  { kind: "rename", patterns: [/\brename\b/i, /\bmove\b/i] },
];

/**
 * Extract the first matching task kind from text via keyword patterns.
 * Returns null when nothing matches.
 */
function matchTaskKind(text: string): TaskKind | null {
  for (const { kind, patterns } of KIND_KEYWORDS) {
    if (patterns.some((p) => p.test(text))) return kind;
  }
  return null;
}

const EXPLICIT_RISK_KINDS = new Set<TaskKind>([
  "sec-audit",
  "destructive-operation",
  "legal-compliance",
  "rca",
  "migrate-strategy",
]);

// ---------------------------------------------------------------------------
// detect — main entry point
// ---------------------------------------------------------------------------

// Tier promotion order — used by the promote-only override rule below.
const TIER_ORDER: TierName[] = ["fast", "medium", "heavy"];

/**
 * Apply a caller tierOverride as PROMOTE-ONLY: the result is the override
 * tier when it is heavier than the lane tier, otherwise the lane tier.
 * A caller flag can never route a task to a lighter tier than its lane
 * dictates (issue #5 gate).
 */
function applyOverride(laneTier: TierName, override?: string): TierName {
  const o = override as TierName | undefined;
  return o && TIER_ORDER.indexOf(o) > TIER_ORDER.indexOf(laneTier)
    ? o
    : laneTier;
}

/**
 * Classify a task text into a routing phase.
 *
 * Resolution order:
 *   1. Explicit safety-risk match → lane-matrix lookup.
 *   2. Planning short-circuit → fast, no model call needed.
 *   3. Task-kind keyword match → lane-matrix lookup for the given mode.
 *   4. Default tier for the mode.
 *
 * `mode` defaults to "normal" when absent.
 */
export function detect(
  text: string,
  options: { mode?: ModeName; tierOverride?: string } = {},
): ClassifiedPhase {
  const mode = options.mode ?? "normal";

  // Explicit security, destructive, legal, RCA, and migration signals must
  // not escape to fast through the planning shortcut.
  const taskKind = matchTaskKind(text);
  if (taskKind && EXPLICIT_RISK_KINDS.has(taskKind)) {
    const lane = resolveLane(mode, taskKind);
    return {
      tier: applyOverride(lane.tier, options.tierOverride),
      source: "task-kind",
      taskKind,
      directAllowed: lane.directAllowed ?? false,
    };
  }

  // 2. Planning remains cheap unless it has an explicit safety-risk signal.
  if (isPlanningTask(text) && !options.tierOverride) {
    return {
      tier: "fast",
      source: "planning-short-circuit",
      taskKind: null,
      directAllowed: true,
    };
  }

  // 3. Remaining task-kind match.
  if (taskKind) {
    const lane = resolveLane(mode, taskKind);
    return {
      tier: applyOverride(lane.tier, options.tierOverride),
      source: "task-kind",
      taskKind,
      directAllowed: lane.directAllowed ?? false,
    };
  }

  // 4. Default for mode
  const defaultTier = LANE_MATRIX[mode].defaultTier;
  return {
    tier: applyOverride(defaultTier, options.tierOverride),
    source: "default",
    taskKind: null,
    directAllowed: false,
  };
}

// ---------------------------------------------------------------------------
// Re-export lane helpers for callers that need them
// ---------------------------------------------------------------------------
export { classifyTaskKind, resolveLane };
export type { ModeName, TaskKind, TierName };
