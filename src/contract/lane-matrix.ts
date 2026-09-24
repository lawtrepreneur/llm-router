/**
 * src/contract/lane-matrix.ts
 *
 * The lane matrix: for every (mode × taskKind) combination, declares:
 *   - which tier to use by default
 *   - what the tier cap override is (if any)
 *   - whether direct execution (no delegation) is permitted
 *
 * This is the machine-readable version of the string rules in tiers.json
 * `modes[name].overrideRules`. The rules there are authoritative for prose;
 * this module is authoritative for tests.
 *
 * PURE: no imports from Node fs/os/path, no network, no SDK.
 */

// ---------------------------------------------------------------------------
// Task kinds (canonical names from tiers.json taskPatterns)
// ---------------------------------------------------------------------------

/** Fast-tier task kinds: read-only, no file writes. */
export const FAST_TASK_KINDS = [
  "search",
  "grep",
  "read",
  "git-info",
  "ls",
  "lookup-docs/types",
  "count",
  "exists-check",
  "rename",
] as const;

/** Medium-tier task kinds: implementation, edits, tests. */
export const MEDIUM_TASK_KINDS = [
  "impl-feature",
  "refactor",
  "write-tests",
  "bugfix(≤2)",
  "edit-logic",
  "code-review",
  "build-fix",
  "create-file",
  "db-migrate",
  "api-endpoint",
  "config-update",
] as const;

/** Heavy-tier task kinds: architecture, deep debugging, security. */
export const HEAVY_TASK_KINDS = [
  "arch-design",
  "debug(≥3fail)",
  "sec-audit",
  "destructive-operation",
  "legal-compliance",
  "perf-opt",
  "migrate-strategy",
  "multi-system-integration",
  "tradeoff-analysis",
  "rca",
] as const;

export type FastTaskKind = (typeof FAST_TASK_KINDS)[number];
export type MediumTaskKind = (typeof MEDIUM_TASK_KINDS)[number];
export type HeavyTaskKind = (typeof HEAVY_TASK_KINDS)[number];
export type TaskKind = FastTaskKind | MediumTaskKind | HeavyTaskKind;

/** Canonical tier names. */
export type TierName = "fast" | "medium" | "heavy";

/** Canonical mode names (from tiers.json modes). */
export type ModeName = "normal" | "budget" | "quality" | "deep";

// ---------------------------------------------------------------------------
// Lane entry
// ---------------------------------------------------------------------------

/**
 * One cell in the lane matrix: the routing decision for a given
 * (mode, taskKind) combination.
 */
export interface LaneEntry {
  /** Tier the router should use for this task in this mode. */
  tier: TierName;
  /**
   * Read-only cap directive override.
   * undefined = use the tier's default cap (8/5/3).
   * null = CAP:none (requires reason: line in dispatch).
   * number = explicit cap.
   */
  capOverride?: number | null;
  /**
   * When true the orchestrator may handle this task directly (without
   * delegation) by spending from its own read-only allowance.
   * Only applies to single read-only calls.
   */
  directAllowed?: boolean;
}

// ---------------------------------------------------------------------------
// Mode definitions
// ---------------------------------------------------------------------------

/**
 * Per-mode routing rules, expressed as a typed structure.
 *
 * These mirror the prose `overrideRules` in tiers.json modes. When the two
 * disagree, the prose is normative; update this file to match.
 */
export interface ModeDefinition {
  /** Default tier when no taskKind-level override applies. */
  defaultTier: TierName;
  /** Human description (mirrors tiers.json). */
  description: string;
  /**
   * Task-kind overrides. When a task kind is absent from this map, the
   * `defaultTier` applies.
   */
  taskOverrides: Partial<Record<TaskKind, LaneEntry>>;
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export const LANE_MATRIX: Record<ModeName, ModeDefinition> = {
  // -------------------------------------------------------------------------
  // normal — balanced quality and cost
  // -------------------------------------------------------------------------
  normal: {
    defaultTier: "medium",
    description: "Balanced quality and cost — delegates based on task complexity",
    taskOverrides: {
      // Fast tasks go to fast, with default cap
      search:              { tier: "fast", directAllowed: true },
      grep:                { tier: "fast", directAllowed: true },
      read:                { tier: "fast", directAllowed: true },
      "git-info":          { tier: "fast", directAllowed: true },
      ls:                  { tier: "fast", directAllowed: true },
      "lookup-docs/types": { tier: "fast" },
      count:               { tier: "fast", directAllowed: true },
      "exists-check":      { tier: "fast", directAllowed: true },
      rename:              { tier: "fast" },
      // Heavy tasks go to heavy
      "arch-design":                { tier: "heavy" },
      "debug(≥3fail)":              { tier: "heavy" },
      "sec-audit":                  { tier: "heavy" },
      "destructive-operation":      { tier: "heavy" },
      "legal-compliance":           { tier: "heavy" },
      "perf-opt":                   { tier: "heavy" },
      "migrate-strategy":           { tier: "heavy" },
      "multi-system-integration":   { tier: "heavy" },
      "tradeoff-analysis":          { tier: "heavy" },
      rca:                          { tier: "heavy" },
    },
  },

  // -------------------------------------------------------------------------
  // budget — aggressive cost savings
  // -------------------------------------------------------------------------
  budget: {
    defaultTier: "fast",
    description: "Aggressive cost savings — defaults to cheapest tier, escalates only when needed",
    taskOverrides: {
      // All fast tasks: fast with tighter cap (5)
      search:              { tier: "fast", capOverride: 5, directAllowed: true },
      grep:                { tier: "fast", capOverride: 5, directAllowed: true },
      read:                { tier: "fast", capOverride: 5, directAllowed: true },
      "git-info":          { tier: "fast", capOverride: 5, directAllowed: true },
      ls:                  { tier: "fast", capOverride: 5, directAllowed: true },
      "lookup-docs/types": { tier: "fast", capOverride: 5 },
      count:               { tier: "fast", capOverride: 5, directAllowed: true },
      "exists-check":      { tier: "fast", capOverride: 5, directAllowed: true },
      rename:              { tier: "fast", capOverride: 5 },
      // Medium tasks: medium with cap:2
      "impl-feature":  { tier: "medium", capOverride: 2 },
      refactor:        { tier: "medium", capOverride: 2 },
      "write-tests":   { tier: "medium", capOverride: 2 },
      "bugfix(≤2)":    { tier: "medium", capOverride: 2 },
      "edit-logic":    { tier: "medium", capOverride: 2 },
      "code-review":   { tier: "medium", capOverride: 2 },
      "build-fix":     { tier: "medium", capOverride: 2 },
      "create-file":   { tier: "medium", capOverride: 2 },
      "db-migrate":    { tier: "medium", capOverride: 2 },
      "api-endpoint":  { tier: "medium", capOverride: 2 },
      "config-update": { tier: "medium", capOverride: 2 },
      // Heavy tasks: heavy only after 2+ medium failures, cap:2
      "arch-design":              { tier: "heavy", capOverride: 2 },
      "debug(≥3fail)":            { tier: "heavy", capOverride: 2 },
      "sec-audit":                { tier: "heavy", capOverride: 2 },
      "destructive-operation":    { tier: "heavy", capOverride: 2 },
      "legal-compliance":         { tier: "heavy", capOverride: 2 },
      "perf-opt":                 { tier: "heavy", capOverride: 2 },
      "migrate-strategy":         { tier: "heavy", capOverride: 2 },
      "multi-system-integration": { tier: "heavy", capOverride: 2 },
      "tradeoff-analysis":        { tier: "heavy", capOverride: 2 },
      rca:                        { tier: "heavy", capOverride: 2 },
    },
  },

  // -------------------------------------------------------------------------
  // quality — quality-first, stronger models more liberally
  // -------------------------------------------------------------------------
  quality: {
    defaultTier: "medium",
    description: "Quality-first — uses stronger models more liberally for better results",
    taskOverrides: {
      // Trivial single-tool fast ops stay fast; everything else goes medium+
      search:  { tier: "fast", directAllowed: true },
      grep:    { tier: "fast", directAllowed: true },
      read:    { tier: "fast", directAllowed: true },
      "git-info":     { tier: "fast", directAllowed: true },
      ls:             { tier: "fast", directAllowed: true },
      "lookup-docs/types": { tier: "medium" },
      count:          { tier: "fast", directAllowed: true },
      "exists-check": { tier: "fast", directAllowed: true },
      rename:         { tier: "medium" },
      // Medium tasks: medium, cap:none (CAP:none with reason line)
      "impl-feature":  { tier: "medium", capOverride: null },
      refactor:        { tier: "medium", capOverride: null },
      "write-tests":   { tier: "medium", capOverride: null },
      "bugfix(≤2)":    { tier: "medium", capOverride: null },
      "edit-logic":    { tier: "medium", capOverride: null },
      "code-review":   { tier: "medium", capOverride: null },
      "build-fix":     { tier: "medium", capOverride: null },
      "create-file":   { tier: "medium", capOverride: null },
      "db-migrate":    { tier: "medium", capOverride: null },
      "api-endpoint":  { tier: "medium", capOverride: null },
      "config-update": { tier: "medium", capOverride: null },
      // Heavy tasks: heavy, cap:none
      "arch-design":              { tier: "heavy", capOverride: null },
      "debug(≥3fail)":            { tier: "heavy", capOverride: null },
      "sec-audit":                { tier: "heavy", capOverride: null },
      "destructive-operation":    { tier: "heavy", capOverride: null },
      "legal-compliance":         { tier: "heavy", capOverride: null },
      "perf-opt":                 { tier: "heavy", capOverride: null },
      "migrate-strategy":         { tier: "heavy", capOverride: null },
      "multi-system-integration": { tier: "heavy", capOverride: null },
      "tradeoff-analysis":        { tier: "heavy", capOverride: null },
      rca:                        { tier: "heavy", capOverride: null },
    },
  },

  // -------------------------------------------------------------------------
  // deep — heavy-first for architecture/debug
  // -------------------------------------------------------------------------
  deep: {
    defaultTier: "heavy",
    description: "Deep analysis mode — prioritizes thorough architecture/debug work with long heavy runs",
    taskOverrides: {
      // Trivial one-off lookups: direct or fast, baseline caps
      search:         { tier: "fast", directAllowed: true },
      grep:           { tier: "fast", directAllowed: true },
      read:           { tier: "fast", directAllowed: true },
      "git-info":     { tier: "fast", directAllowed: true },
      ls:             { tier: "fast", directAllowed: true },
      "lookup-docs/types": { tier: "fast" },
      count:          { tier: "fast", directAllowed: true },
      "exists-check": { tier: "fast", directAllowed: true },
      rename:         { tier: "medium" },
      // Medium tasks: medium, cap:5 (baseline)
      "impl-feature":  { tier: "medium" },
      refactor:        { tier: "medium" },
      "write-tests":   { tier: "medium" },
      "bugfix(≤2)":    { tier: "medium" },
      "edit-logic":    { tier: "medium" },
      "code-review":   { tier: "medium" },
      "build-fix":     { tier: "medium" },
      "create-file":   { tier: "medium" },
      "db-migrate":    { tier: "medium" },
      "api-endpoint":  { tier: "medium" },
      "config-update": { tier: "medium" },
      // Heavy tasks: heavy, cap:none (with reason line)
      "arch-design":              { tier: "heavy", capOverride: null },
      "debug(≥3fail)":            { tier: "heavy", capOverride: null },
      "sec-audit":                { tier: "heavy", capOverride: null },
      "destructive-operation":    { tier: "heavy", capOverride: null },
      "legal-compliance":         { tier: "heavy", capOverride: null },
      "perf-opt":                 { tier: "heavy", capOverride: null },
      "migrate-strategy":         { tier: "heavy", capOverride: null },
      "multi-system-integration": { tier: "heavy", capOverride: null },
      "tradeoff-analysis":        { tier: "heavy", capOverride: null },
      rca:                        { tier: "heavy", capOverride: null },
    },
  },
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Resolve which tier to use for a (mode, taskKind) combination.
 * Falls back to the mode's defaultTier when the task kind is absent.
 */
export function resolveLane(
  mode: ModeName,
  taskKind: TaskKind,
): LaneEntry {
  const def = LANE_MATRIX[mode];
  return def.taskOverrides[taskKind] ?? { tier: def.defaultTier };
}

/**
 * Classify a task kind string into its canonical tier group.
 * Returns undefined when the kind is not in the known set.
 */
export function classifyTaskKind(kind: string): TierName | undefined {
  if ((FAST_TASK_KINDS as readonly string[]).includes(kind)) return "fast";
  if ((MEDIUM_TASK_KINDS as readonly string[]).includes(kind)) return "medium";
  if ((HEAVY_TASK_KINDS as readonly string[]).includes(kind)) return "heavy";
  return undefined;
}

/**
 * All task kinds for a given canonical tier group.
 */
export function taskKindsForTier(tier: TierName): readonly string[] {
  if (tier === "fast") return FAST_TASK_KINDS;
  if (tier === "medium") return MEDIUM_TASK_KINDS;
  return HEAVY_TASK_KINDS;
}
