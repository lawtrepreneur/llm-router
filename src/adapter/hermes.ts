/**
 * src/adapter/hermes.ts — Hermes-as-a-worker adapter.
 *
 * Thin transport: invokes the Hermes one-shot CLI and returns the raw result.
 * Mirrors opencode.ts: impure execution isolated here; recursion guarded at
 * process level via HERMES_CHILD_ENV.
 *
 * IMPURE: child_process. Kept isolated so callers stay testable by injecting
 * a fake run function.
 */
import { execFile } from "node:child_process";


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
  /** Injectable exec for tests. Falls back to the hermes CLI runner when omitted. */
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
// Default CLI runner
// ---------------------------------------------------------------------------

const HERMES_BINARY = "/home/romeshh/.local/bin/hermes";

/**
 * Default one-shot Hermes runner: `hermes chat --quiet --oneshot --in <cwd>
 * -q <prompt>`. Uses the shared opencode execFileAsync-style spawn so timeouts
 * and buffer caps behave identically.
 */
async function hermesCliExec(
  _target: string,
  prompt: string,
  options: { timeoutMs: number; env: NodeJS.ProcessEnv; cwd: string },
): Promise<{ payload: string }> {
  const { stdout } = await execFile(
    HERMES_BINARY,
    ["chat", "--quiet", "--oneshot", "--in", options.cwd, "-q", prompt],
    {
      timeout: options.timeoutMs,
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    },
  ) as unknown as { stdout: string };
  return { payload: stdout };
}

// ---------------------------------------------------------------------------
// runHermes
// ---------------------------------------------------------------------------

/**
 * Invoke the Hermes handoff with a normalized prompt and return the raw
 * result. Recursion is prevented via the HERMES_CHILD_ENV guard.
 */
export async function runHermes(
  cfg: Pick<HermesAdapterConfig, "timeoutMs">,
  prompt: string,
  cwd: string,
  deps: HermesRunDeps = {},
  _agent?: string,
): Promise<HermesRunResult> {
  if (isHermesChild()) {
    throw new HermesAdapterError(
      "recursion",
      "refusing to invoke Hermes from inside a Hermes adapter child",
    );
  }

  const startedAt = deps.now?.() ?? Date.now();
  const childEnv = { ...process.env, HERMES_HOME: "/home/romeshh/.hermes", [HERMES_CHILD_ENV]: "1" };
  try {
    const { payload } = deps.exec
      ? await deps.exec(prompt, prompt, { timeoutMs: cfg.timeoutMs, env: childEnv })
      : await hermesCliExec(prompt, prompt, { timeoutMs: cfg.timeoutMs, env: childEnv, cwd });
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
