import { describe, expect, it } from "vitest";
import { buildDispatchHeader } from "../../src/router/dispatch-header";
import { validateConfig } from "../../src/router/config";

const input = { tier: "fast", cap: 8, projectDirectory: "D:\\git\\opencode-model-router" };
const expected = `[router] You are @fast. Execute this dispatch yourself; do not route it to another tier, and do not ask to be re-dispatched.

Working directory: D:\\git\\opencode-model-router. You are already there — do not ask permission to read or write inside it.

Tool names mentioned in this dispatch are descriptive and vary by provider; your own tool schema is the authority on what you can do. Never refuse or hand back work because a named tool looks unfamiliar or missing — attempt it, and if you cannot finish, name the specific step that failed.

An empty result is a result. Search tools honour .gitignore, so a "no matches" answer inside an ignored path means the filter applied, not that your tools are broken; use a shell ripgrep with --no-ignore there before concluding anything is absent.

Read-only budget: 8 calls. The runtime appends [cap: N/MAX] and [⚠ REDUNDANT] to results. Reading a different region of a file you have already opened is NOT a redundant read.

A hand-back with zero tool calls is recorded as a false refusal.`;

describe("buildDispatchHeader", () => {
  it("renders the full numeric-cap header without a trailing newline", () => {
    expect(buildDispatchHeader(input)).toBe(expected);
    expect(buildDispatchHeader(input).endsWith("\n")).toBe(false);
  });

  it("renders the uncapped variant", () => {
    expect(buildDispatchHeader({ ...input, cap: "none" })).toBe(
      expected.replace("Read-only budget: 8 calls.", "Read-only budget: uncapped for this dispatch."),
    );
  });

  it.each([undefined, ""])("omits the whole cwd paragraph for %s", (projectDirectory) => {
    expect(buildDispatchHeader({ ...input, projectDirectory })).toBe(
      expected.split("\n\n").filter((paragraph) => !paragraph.startsWith("Working directory:")).join("\n\n"),
    );
  });

  it.each(["fast", "medium", "heavy", "custom"])("identifies @%s without provider-specific tool names", (tier) => {
    const header = buildDispatchHeader({ ...input, tier });
    expect(header.startsWith(`[router] You are @${tier}.`)).toBe(true);
    expect(header).not.toMatch(/\b(?:Grep|Glob|Bash)\b/);
    expect(header).not.toMatch(/\bRead\b(?!-only budget)/);
  });
});

describe("dispatchHeader config validation", () => {
  const base = { activePreset: "test", presets: { test: { fast: { model: "test/model" } } }, rules: [], defaultTier: "fast" };
  it.each([undefined, true, false])("accepts %s", (dispatchHeader) => {
    expect(validateConfig({ ...base, dispatchHeader }).dispatchHeader).toBe(dispatchHeader);
  });
  it.each([null, 0, "false", {}, []])("rejects %j", (dispatchHeader) => {
    expect(() => validateConfig({ ...base, dispatchHeader })).toThrow("tiers.json: 'dispatchHeader' must be a boolean");
  });
});
