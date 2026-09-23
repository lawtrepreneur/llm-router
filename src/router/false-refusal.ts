import { parseTaskResult as parseVerifiedTaskResult } from "../verify/dispatch";

export interface FalseRefusalVerdict {
  suspected: boolean;
  /** The hand-back prefix that matched, when one did. */
  prefix?: string;
}

/**
 * A hand-back is legitimate when the delegate actually tried. This detects a
 * capability refusal asserted WITHOUT evidence: a capability never tested.
 * Real zero-call returns from agents with demonstrably working tools included:
 * "ESCALATE: This dispatch is read-only exploration, but the requested checkout inspection cannot be performed under my assigned @fast role because the available tools here are not the Read/Grep/Glob/Bash tools described in the request."
 * "NEED MORE: This dispatch is read-only and cannot run the requested file inventory. The orchestrator must dispatch an agent with file-read/search access."
 */
export function detectFalseRefusal(input: {
  toolCalls: number;
  resultText: string;
}): FalseRefusalVerdict {
  try {
    const first = input.resultText.split(/\r?\n/).find((line) => line.trim() !== "")?.trimStart() ?? "";
    const prefix = /^(ESCALATE:|NEED MORE:|NEED CONTEXT:|SCOPE GROWTH:|BLOCKED:)/.exec(first)?.[1];
    const suspected = input.toolCalls === 0 && prefix !== undefined &&
      /\b(?:tools?|access|not available|unavailable|re-?dispatch|hand ?back|read-only|permission)\b/i.test(input.resultText);
    return { suspected, ...(prefix ? { prefix } : {}) };
  } catch {
    return { suspected: false };
  }
}

/** Reuse verification's extraction; add only the task wrapper ID fallback. */
export function parseTaskResult(output: unknown): { childSessionID?: string; text: string } {
  try {
    const parsed = parseVerifiedTaskResult(output);
    const raw = output && typeof output === "object" && "output" in output &&
      typeof output.output === "string" ? output.output : "";
    const childSessionID = parsed.childSessionID ??
      /<task\b[^>]*\bid\s*=\s*["']([^"']+)["']/i.exec(raw)?.[1];
    return { ...(childSessionID ? { childSessionID } : {}), text: parsed.finalReturnText };
  } catch {
    return { text: "" };
  }
}
