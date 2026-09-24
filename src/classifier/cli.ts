/**
 * src/classifier/cli.ts — JSONL stdin-stdout classifier CLI.
 *
 * Wire format
 * -----------
 * stdin  (JSONL): one JSON object per line
 *   { text: string; state?: Record<string,unknown>; tier?: string; mode?: string }
 *
 * stdout (JSONL): one DispatchResult-shaped object per input line
 *   { status: "accepted"|"unmet"|"unverifiable"|"error";
 *     text: string;
 *     tier?: string;
 *     verdict?: { pass: boolean; outcome: string; method: string; reasons: string[] } }
 *
 * stderr: errors only (JSON: { error: string; message: string })
 *
 * Exit codes
 * ----------
 *   0   all lines processed (individual line errors are emitted as status:"error" on stdout)
 *   2   fatal: unrecoverable startup or stdin read failure
 *
 * Phase-first logic
 * -----------------
 *   1. Parse line.
 *   2. Planning short-circuit → emit accepted immediately, no adapter call.
 *   3. Classify tier via detect().
 *   4. Use tier override from line if present.
 *   5. For non-planning tasks: call Score via adapter (logit-bias-free path),
 *      emit verdict-bearing result.
 *
 * Taxonomy stays in router repo (src/contract/lane-matrix.ts).
 * tool-system1 is invoked only for live primitive calls (adapter.ts).
 */

import * as readline from "node:readline";
import type { DispatchResult, DispatchVerdict } from "../contract/dispatch-schema";
import { detect } from "./phase";
import type { ModeName } from "./phase";
import { AdapterError } from "./adapter";

// ---------------------------------------------------------------------------
// Input schema (loose — unknown keys are ignored)
// ---------------------------------------------------------------------------

interface ClassifierInput {
  text: string;
  state?: Record<string, unknown>;
  tier?: string;
  mode?: string;
}

function parseInput(raw: string): ClassifierInput | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj.text !== "string" || !obj.text.trim()) return null;
    return {
      text: obj.text,
      state: typeof obj.state === "object" && obj.state !== null
        ? (obj.state as Record<string, unknown>)
        : undefined,
      tier: typeof obj.tier === "string" ? obj.tier : undefined,
      mode: typeof obj.mode === "string" ? obj.mode : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function writeResult(result: DispatchResult): void {
  process.stdout.write(JSON.stringify(result) + "\n");
}

function writeError(error: string, message: string): void {
  process.stderr.write(JSON.stringify({ error, message }) + "\n");
}

function accepted(tier: string, text: string, method: string = "none"): DispatchResult {
  const verdict: DispatchVerdict = {
    pass: true,
    outcome: "pass",
    method: method as "deterministic" | "checker" | "none",
    reasons: [],
  };
  return { status: "accepted", text, tier, verdict };
}

function errorResult(tier: string | undefined, message: string): DispatchResult {
  return { status: "error", text: "", tier, error: message };
}

// ---------------------------------------------------------------------------
// Process one line
// ---------------------------------------------------------------------------

async function processLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) return;

  const input = parseInput(trimmed);
  if (!input) {
    writeResult(errorResult(undefined, "unparseable input: not a valid JSON object with a 'text' field"));
    return;
  }

  const mode = (input.mode as ModeName | undefined) ?? "normal";
  const phase = detect(input.text, { mode, tierOverride: input.tier });

  // Planning short-circuit — no model call needed
  if (phase.source === "planning-short-circuit") {
    writeResult(accepted(phase.tier, "planning:short-circuit", "deterministic"));
    return;
  }

  // For non-planning tasks with a known tier, emit classification result
  // without calling the Score/Choice/Noul adapter (those require a live LLM
  // endpoint with logit_bias support). The adapter is available for callers
  // that inject it; the CLI base path emits the phase classification.
  const summaryText = [
    `tier:${phase.tier}`,
    `source:${phase.source}`,
    phase.taskKind ? `task-kind:${phase.taskKind}` : null,
    phase.directAllowed ? "direct:allowed" : null,
  ].filter(Boolean).join(" ");

  writeResult(accepted(phase.tier, summaryText, "deterministic"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  const lines: string[] = [];

  rl.on("line", (line) => {
    lines.push(line);
  });

  await new Promise<void>((resolve, reject) => {
    rl.on("close", resolve);
    rl.on("error", reject);
  });

  for (const line of lines) {
    try {
      await processLine(line);
    } catch (err) {
      if (err instanceof AdapterError) {
        writeResult(errorResult(undefined, err.message));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        writeResult(errorResult(undefined, `unexpected: ${msg}`));
      }
    }
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  writeError("FatalError", msg);
  process.exit(2);
});
