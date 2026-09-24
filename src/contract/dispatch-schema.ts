/**
 * src/contract/dispatch-schema.ts
 *
 * Machine-readable contract for the delegate/task dispatch boundary.
 * These types describe the stdin/stdout (tool arg/result) shapes and can be
 * used to validate inputs and outputs at the plugin boundary.
 *
 * PURE: no imports from Node fs/os/path, no network, no SDK.
 */

// ---------------------------------------------------------------------------
// DoDBlock — inline acceptance criteria (embedded in a dispatch prompt)
// ---------------------------------------------------------------------------

/**
 * A check item inside an [acceptance] block.
 *
 * Syntax inside [acceptance] … [/acceptance]:
 *   check: <kind> [key="value" ...]
 *   criteria: <natural-language sentence>
 *   deliverable: <file path or signal>
 *   kind: deterministic | checker | none
 */
export type CheckKind =
  | "run"
  | "fileExists"
  | "schemaMatch"
  | "testsPass"
  | "buildPasses"
  | "lintClean";

export interface DoDCheck {
  kind: CheckKind;
  /** Shell command to run (run / testsPass / buildPasses / lintClean). */
  command?: string;
  /** Expected substring in stdout (run only). */
  expect?: string;
  /** File path (fileExists / schemaMatch). */
  path?: string;
  /** Inline JSON or a path to a JSON schema file (schemaMatch). */
  schema?: string;
}

export type DoDKind = "deterministic" | "checker" | "none";
export type DoDSource = "explicit" | "inferred" | "annotation" | "none";

/** Parsed Definition of Done (acceptance criteria). */
export interface DoDBlock {
  kind: DoDKind;
  checks: DoDCheck[];
  criteria: string[];
  deliverable: string | null;
  source: DoDSource;
}

// ---------------------------------------------------------------------------
// DispatchRequest — input to the delegate / task tool
// ---------------------------------------------------------------------------

/**
 * Input shape for a single delegation call.
 *
 * The delegate tool accepts these fields (extra fields are ignored).
 * The `prompt` field is the primary work description; `acceptance` is the
 * optional [acceptance] block that overrides inference.
 *
 * Stable contract: adding new optional fields is backwards-compatible.
 * Removing fields or changing required fields is a breaking change.
 */
export interface DispatchRequest {
  /**
   * The task description / instructions for the producer agent.
   * Required when `description` is absent; one of the two must be non-empty.
   */
  prompt?: string;

  /**
   * Short task description (opencode task tool alias for prompt).
   * Required when `prompt` is absent.
   */
  description?: string;

  /**
   * Target tier override. When absent, the router uses its default-tier
   * logic (mode → defaultTier → taskPatterns matching).
   * Values: "fast" | "medium" | "heavy" (or any tier name defined in tiers.json).
   */
  tier?: string;

  /**
   * Optional inline [acceptance] block (without the outer [acceptance] tags).
   * When present this is parsed before the prompt body; an explicit block in
   * the prompt is still honoured as a fallback when this field is absent.
   */
  acceptance?: string;

  /**
   * Working directory for the producer session.
   * Defaults to the router's own working directory when absent.
   */
  cwd?: string;

  /**
   * Producer session step budget.
   * When absent the tier's configured `steps` value is used.
   */
  steps?: number;
}

// ---------------------------------------------------------------------------
// DispatchResult — output from the delegate / task tool
// ---------------------------------------------------------------------------

/**
 * Status of a completed delegation.
 *
 * - "accepted"  — the producer finished and the gate accepted the output.
 * - "unmet"     — producer finished but the gate did not accept it
 *                 (escalation may follow).
 * - "unverifiable" — the gate could not determine pass/fail (not a failure;
 *                    see FAIL_UP_RULES.md for the no-escalation rule).
 * - "error"     — the delegation call itself failed (timeout, hard error).
 */
export type DispatchStatus = "accepted" | "unmet" | "unverifiable" | "error";

/**
 * Acceptance verdict carried in a "accepted" or "unmet" result.
 * Mirrors the internal Verdict type but without runtime-only fields.
 */
export interface DispatchVerdict {
  pass: boolean;
  outcome: "pass" | "fail" | "unverifiable";
  method: "deterministic" | "checker" | "none";
  reasons: string[];
  caveats?: string[];
  notes?: string[];
  evidence?: string;
}

/**
 * Output shape of a single delegation call.
 *
 * The `text` field always contains the raw text returned by the producer.
 * The `verdict` field is present whenever acceptance-checking ran (i.e.
 * whenever enforcement is advisory or enforced and a checkable DoD exists).
 * It is absent for trivial bypass, "off" mode, or delegations to the
 * built-in task tool when verification is disabled.
 */
export interface DispatchResult {
  status: DispatchStatus;
  /** Producer's final return text (unwrapped from <task_result> tags). */
  text: string;
  /** Acceptance gate verdict (absent when verification was skipped). */
  verdict?: DispatchVerdict;
  /** Which tier the result came from (after escalation, may differ from request). */
  tier?: string;
  /** Error detail (present when status === "error"). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Validation helpers — lightweight, no ajv dependency
// ---------------------------------------------------------------------------

/**
 * Narrow-validate a DispatchRequest. Returns a list of validation errors
 * (empty array means valid). Does not throw.
 */
export function validateDispatchRequest(r: unknown): string[] {
  const errors: string[] = [];
  if (typeof r !== "object" || r === null || Array.isArray(r)) {
    return ["DispatchRequest must be a non-null object"];
  }
  const req = r as Record<string, unknown>;

  const hasPrompt = typeof req.prompt === "string" && req.prompt.trim().length > 0;
  const hasDesc = typeof req.description === "string" && req.description.trim().length > 0;
  if (!hasPrompt && !hasDesc) {
    errors.push("DispatchRequest: at least one of 'prompt' or 'description' must be a non-empty string");
  }
  if (req.tier !== undefined && typeof req.tier !== "string") {
    errors.push("DispatchRequest: 'tier' must be a string");
  }
  if (req.acceptance !== undefined && typeof req.acceptance !== "string") {
    errors.push("DispatchRequest: 'acceptance' must be a string");
  }
  if (req.cwd !== undefined && typeof req.cwd !== "string") {
    errors.push("DispatchRequest: 'cwd' must be a string");
  }
  if (req.steps !== undefined) {
    if (typeof req.steps !== "number" || !Number.isInteger(req.steps) || req.steps < 1) {
      errors.push("DispatchRequest: 'steps' must be a positive integer");
    }
  }
  return errors;
}

const VALID_STATUSES = new Set<DispatchStatus>(["accepted", "unmet", "unverifiable", "error"]);

/**
 * Narrow-validate a DispatchResult. Returns a list of validation errors.
 */
export function validateDispatchResult(r: unknown): string[] {
  const errors: string[] = [];
  if (typeof r !== "object" || r === null || Array.isArray(r)) {
    return ["DispatchResult must be a non-null object"];
  }
  const res = r as Record<string, unknown>;

  if (!VALID_STATUSES.has(res.status as DispatchStatus)) {
    errors.push(`DispatchResult: 'status' must be one of ${[...VALID_STATUSES].join("|")}`);
  }
  if (typeof res.text !== "string") {
    errors.push("DispatchResult: 'text' must be a string");
  }
  if (res.tier !== undefined && typeof res.tier !== "string") {
    errors.push("DispatchResult: 'tier' must be a string");
  }
  if (res.error !== undefined && typeof res.error !== "string") {
    errors.push("DispatchResult: 'error' must be a string");
  }
  if (res.verdict !== undefined) {
    const v = res.verdict as Record<string, unknown>;
    if (typeof v.pass !== "boolean") {
      errors.push("DispatchResult.verdict: 'pass' must be a boolean");
    }
    if (!["pass", "fail", "unverifiable"].includes(v.outcome as string)) {
      errors.push("DispatchResult.verdict: 'outcome' must be pass|fail|unverifiable");
    }
    if (!["deterministic", "checker", "none"].includes(v.method as string)) {
      errors.push("DispatchResult.verdict: 'method' must be deterministic|checker|none");
    }
    if (!Array.isArray(v.reasons)) {
      errors.push("DispatchResult.verdict: 'reasons' must be an array");
    }
  }
  return errors;
}
