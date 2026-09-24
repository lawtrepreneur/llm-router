/**
 * src/classifier/adapter.ts — tool-system1 subprocess adapter.
 *
 * Calls the Python tool-system1 package (Score / Choice / Noul) as subprocesses.
 * tool-system1 is Python-only; there is no Node binding. Each call spawns a
 * fresh process, passes state + question on stdin or as CLI flags, reads the
 * JSON receipt from stdout.
 *
 * All errors raise AdapterError — callers decide retry, escalation, or fallback.
 *
 * IMPURE: uses Node child_process (execFile). Kept isolated here so
 * phase.ts and cli.ts stay testable without mocking processes.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AdapterError extends Error {
  readonly primitive: string;
  readonly cause?: Error;
  constructor(primitive: string, message: string, cause?: Error) {
    super(`[${primitive}] ${message}`);
    this.name = "AdapterError";
    this.primitive = primitive;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AdapterConfig {
  /**
   * Python interpreter to use. Defaults to the TOOL_SYSTEM1_PYTHON env var,
   * then "python3".
   */
  python?: string;
  /**
   * Absolute path to tool-system1 repo root. Defaults to TOOL_SYSTEM1_PATH
   * env var. When absent, invokes `python -m tool_system1` expecting the
   * package to be installed in the active environment.
   */
  repoPath?: string;
  /** Timeout in ms for each subprocess call. Default 30 000. */
  timeoutMs?: number;
}

function resolveConfig(cfg: AdapterConfig = {}): Required<AdapterConfig> {
  return {
    python: cfg.python ?? process.env.TOOL_SYSTEM1_PYTHON ?? "python3",
    repoPath: cfg.repoPath ?? process.env.TOOL_SYSTEM1_PATH ?? "",
    timeoutMs: cfg.timeoutMs ?? 30_000,
  };
}

// ---------------------------------------------------------------------------
// Low-level subprocess runner
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runPython(
  python: string,
  args: string[],
  options: { cwd?: string; stdinData?: string; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = require("node:child_process").spawn(python, args, {
      cwd: options.cwd || undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        child.kill("SIGTERM");
        resolve({ stdout, stderr, exitCode: -1 });
      }
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    if (options.stdinData !== undefined) {
      child.stdin.write(options.stdinData, "utf8");
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.on("close", (code: number | null) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      }
    });

    child.on("error", (err: Error) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + "\n" + err.message, exitCode: -2 });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export interface ScoreLevel {
  index: number;
  description: string;
}

export interface ScoreReceipt {
  receipt_id: string;
  primitive: string;
  primitive_version: string;
  score: number;
  confidence: number;
  probabilities: number[];
  legend: Array<{ index: string; description: string }>;
  question: string;
  state_hash: string;
  failure: string | null;
}

/**
 * Call tool-system1 Score CLI.
 *
 * Invokes: python -m tool_system1.score_cli --question Q --level I:D ... --logit-bias JSON
 * Logit bias must be provided by the caller — this adapter does not call an LLM.
 */
export async function callScore(
  question: string,
  levels: ScoreLevel[],
  logitBias: Record<string, number>,
  cfg: AdapterConfig = {},
): Promise<ScoreReceipt> {
  const config = resolveConfig(cfg);
  const levelArgs: string[] = [];
  for (const level of levels) {
    levelArgs.push("--level", `${level.index}:${level.description}`);
  }
  const args = [
    "-m",
    "tool_system1.score_cli",
    "--question",
    question,
    ...levelArgs,
    "--logit-bias",
    JSON.stringify(logitBias),
  ];

  const result = await runPython(config.python, args, {
    cwd: config.repoPath || undefined,
    timeoutMs: config.timeoutMs,
  });

  if (result.exitCode !== 0) {
    let detail = result.stderr.trim();
    try {
      const errJson = JSON.parse(result.stderr.trim());
      detail = `${errJson.error}: ${errJson.message}`;
    } catch { /* keep raw */ }
    throw new AdapterError("Score", `exit ${result.exitCode}: ${detail}`);
  }

  try {
    return JSON.parse(result.stdout.trim()) as ScoreReceipt;
  } catch (err) {
    throw new AdapterError("Score", "could not parse receipt JSON", err as Error);
  }
}

// ---------------------------------------------------------------------------
// Choice
// ---------------------------------------------------------------------------

export interface ChoiceOption {
  id: string;
  description: string;
}

export interface ChoiceReceipt {
  receipt_id: string;
  primitive_version: string;
  choice: string;
  letter: string;
  probabilities: number[];
  option_ids: string[];
  question: string;
  state_hash: string;
  margin: number;
  entropy: number;
  failure: string | null;
}

/**
 * Call tool-system1 Choice.
 *
 * Invokes: python -m tool_system1 with JSON on stdin following the
 * ChoiceRequest shape.
 *
 * State carries the context the model reasons over. Question is the
 * routing question. Options are the declared routing choices.
 */
export async function callChoice(
  state: Record<string, unknown>,
  question: string,
  options: ChoiceOption[],
  cfg: AdapterConfig = {},
): Promise<ChoiceReceipt> {
  const config = resolveConfig(cfg);

  const payload = JSON.stringify({
    primitive: "Choice",
    state,
    question,
    options,
  });

  const args = ["-m", "tool_system1"];
  const result = await runPython(config.python, args, {
    cwd: config.repoPath || undefined,
    stdinData: payload,
    timeoutMs: config.timeoutMs,
  });

  if (result.exitCode !== 0) {
    let detail = result.stderr.trim();
    try {
      const errJson = JSON.parse(result.stderr.trim());
      detail = `${errJson.error}: ${errJson.message}`;
    } catch { /* keep raw */ }
    throw new AdapterError("Choice", `exit ${result.exitCode}: ${detail}`);
  }

  try {
    return JSON.parse(result.stdout.trim()) as ChoiceReceipt;
  } catch (err) {
    throw new AdapterError("Choice", "could not parse receipt JSON", err as Error);
  }
}

// ---------------------------------------------------------------------------
// Noul
// ---------------------------------------------------------------------------

export interface NoulReceipt {
  receipt_id: string;
  primitive_version: string;
  question: string;
  proposition: string;
  state_hash: string;
  noul: boolean;
  p_true: number;
  p_false: number;
  failure: string | null;
}

/**
 * Call tool-system1 Noul.
 *
 * Invokes: python -m tool_system1 with JSON on stdin following the
 * Noul Request shape.
 */
export async function callNoul(
  state: Record<string, unknown>,
  question: string,
  proposition: string,
  cfg: AdapterConfig = {},
): Promise<NoulReceipt> {
  const config = resolveConfig(cfg);

  const payload = JSON.stringify({
    primitive: "Noul",
    state,
    question,
    proposition,
  });

  const args = ["-m", "tool_system1"];
  const result = await runPython(config.python, args, {
    cwd: config.repoPath || undefined,
    stdinData: payload,
    timeoutMs: config.timeoutMs,
  });

  if (result.exitCode !== 0) {
    let detail = result.stderr.trim();
    try {
      const errJson = JSON.parse(result.stderr.trim());
      detail = `${errJson.error}: ${errJson.message}`;
    } catch { /* keep raw */ }
    throw new AdapterError("Noul", `exit ${result.exitCode}: ${detail}`);
  }

  try {
    return JSON.parse(result.stdout.trim()) as NoulReceipt;
  } catch (err) {
    throw new AdapterError("Noul", "could not parse receipt JSON", err as Error);
  }
}
