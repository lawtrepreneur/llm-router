/**
 * src/adapter/hermes.ts — Hermes-as-a-worker adapter stub.
 *
 * Thin adapter that will translate a normalized RoutingDecision into a
 * Hermes hermes-handoff invocation. Mirrors the shape of opencode.ts:
 * impure execution is isolated here; wiring.ts holds pure mode/eligibility
 * decisions; boundary.ts produces the normalized decision that this adapter
 * consumes.
 *
 * STATUS: stub — not yet implemented. Blocked on:
 *   - #12 (independent dimension schema + RoutingDecision extension)
 *   - Hermes hermes-handoff contract (external; see docs/plans/hermes-adapter-map.md)
 *
 * IMPURE: will use Node child_process or hermes-handoff SDK. Kept isolated so
 * callers stay testable by injecting a fake run function.
 */

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class HermesAdapterError extends Error {
  readonly reason:
    | "recursion"
    | "disabled"
    | "timeout"
    | "spawn"
    | "exit"
    | "handoff";
  readonly cause?: Error;
  constructor(
    reason: HermesAdapterError["reason"],
    message: string,
    cause?: Error,
  ) {
    super(`[hermes-adapter] ${message}`);
    this.name = "HermesAdapterError";
    this.reason = reason;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Recursion guard
// ---------------------------------------------------------------------------

/** Env var set when a Hermes child was launched by the adapter. Presence ⇒ recursion. */
export const HERMES_CHILD_ENV = "MODEL_ROUTER_HERMES_CHILD";

/** True when the current process is itself an adapter-spawned Hermes child. */
export function isHermesChild(): boolean {
  return process.env[HERMES_CHILD_ENV] === "1";
}

// ---------------------------------------------------------------------------
// Run result / deps
// ---------------------------------------------------------------------------

export interface HermesRunResult {
  /** Raw handoff response payload. */
  payload: string;
  /** Milliseconds the invocation took. */
  durationMs: number;
}

export interface HermesRunDeps {
  /** Injectable exec for tests. No default until handoff contract is known. */
  exec?: (
    target: string,
    prompt: string,
    options: { timeoutMs: number; env: NodeJS.ProcessEnv },
  ) => Promise<{ payload: string }>;
  /** Injectable clock for tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Config (mirrors OpenCodeAdapterConfig shape — exact fields TBD on #12)
// ---------------------------------------------------------------------------

export interface HermesAdapterConfig {
  /** Adapter mode. Default: "off". */
  mode: "off" | "shadow" | "live";
  /** Tiers this adapter intercepts. */
  tiers: string[];
  /** Allowed originating agents. Fail-closed: empty = nobody. */
  allowedAgents: string[];
  /** Timeout ms for each handoff call. Default 30 000. */
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// runHermes — stub, not yet implemented
// ---------------------------------------------------------------------------

/**
 * Invoke the Hermes handoff with a normalized prompt and return the raw
 * result. Recursion is prevented via the HERMES_CHILD_ENV guard.
 *
 * NOT IMPLEMENTED — see file-level STATUS comment.
 * Signature is final; body will be filled in after #12 + Hermes contract land.
 */
export async function runHermes(
  cfg: Pick<HermesAdapterConfig, "timeoutMs">,
  prompt: string,
  _cwd: string,
  deps: HermesRunDeps = {},
  _agent?: string,
): Promise<HermesRunResult> {
  if (isHermesChild()) {
    throw new HermesAdapterError(
      "recursion",
      "refusing to invoke Hermes from inside a Hermes adapter child",
    );
  }

  if (!deps.exec) {
    // ponytail: deliberate NotImplemented until #12 + handoff contract land.
    throw new HermesAdapterError(
      "handoff",
      "HermesRunDeps.exec is required — Hermes handoff contract not yet defined (blocked on #12)",
    );
  }

  const startedAt = deps.now?.() ?? Date.now();
  try {
    const { payload } = await deps.exec(prompt, prompt, {
      timeoutMs: cfg.timeoutMs,
      env: { ...process.env, [HERMES_CHILD_ENV]: "1" },
    });
    const durationMs = (deps.now?.() ?? Date.now()) - startedAt;
    return { payload, durationMs };
  } catch (err: any) {
    const durationMs = (deps.now?.() ?? Date.now()) - startedAt;
    if (err?.killed || err?.signal === "SIGTERM") {
      throw new HermesAdapterError(
        "timeout",
        `Hermes handoff exceeded ${cfg.timeoutMs}ms`,
        err,
      );
    }
    if (typeof err?.code === "number") {
      throw new HermesAdapterError(
        "exit",
        `Hermes handoff exited ${err.code}: ${String(err.message ?? "no output").trim()}`,
        err,
      );
    }
    throw new HermesAdapterError(
      "spawn",
      `failed to invoke Hermes handoff: ${err?.message ?? String(err)}`,
      err,
    );
  }
}
