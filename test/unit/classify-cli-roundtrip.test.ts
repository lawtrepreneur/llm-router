/**
 * test/unit/classify-cli-roundtrip.test.ts
 *
 * Issue #5 — CLI round-trip test target ("CLI from #4").
 *
 * Spawns the real classifier CLI (src/classifier/cli.ts) through the local
 * package runner and pipes JSONL fixture lines on stdin. Asserts:
 *   1. One JSON result line per input line.
 *   2. NeverFast fixtures never come back with tier "fast" (promotion gate
 *      at the process boundary, not just in-process).
 *   3. Tier and task kind match fixture expectations.
 *
 * Gated behind RUN_CLASSIFIER_CLI=1 because it spawns a real Node process
 * (still local and deterministic — no network).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { NEVER_FAST_FIXTURES, ALL_FIXTURES } from "../fixtures/routing-fixtures";

const RUN = process.env.RUN_CLASSIFIER_CLI === "1";
const d = RUN ? describe : describe.skip;
const CLI = path.resolve(__dirname, "../../src/classifier/cli.ts");

function runCli(lines: string[]) {
  return spawnSync("pnpm", ["exec", "tsx", CLI], {
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    timeout: 30_000,
  });
}

d("classifier CLI round-trip (JSONL stdin → stdout)", () => {
  it(
    "every fixture line returns one matching result",
    () => {
      const input = ALL_FIXTURES.map((f) =>
        JSON.stringify({ text: f.text, mode: "normal" }),
      );
      const res = runCli(input);
      expect(res.status).toBe(0);

      const outLines = res.stdout.trim().split("\n").filter(Boolean);
      expect(outLines.length).toBe(ALL_FIXTURES.length);
      for (const [index, line] of outLines.entries()) {
        const obj = JSON.parse(line);
        const fixture = ALL_FIXTURES[index];
        expect(obj.status).toBe("accepted");
        expect(obj.tier).toBe(fixture.expectTier);
        if (fixture.taskKind) {
          expect(obj.text).toContain(`task-kind:${fixture.taskKind}`);
        }
      }
    },
    60_000,
  );

  it("PROMOTION GATE at the process boundary: high-risk fixtures never return tier=fast", () => {
    const input = NEVER_FAST_FIXTURES.map((f) =>
      JSON.stringify({ text: f.text, mode: "budget" }),
    );
    const res = runCli(input);
    expect(res.status).toBe(0);

    const outLines = res.stdout.trim().split("\n").filter(Boolean);
    expect(outLines.length).toBe(NEVER_FAST_FIXTURES.length);
    for (const line of outLines) {
      const obj = JSON.parse(line);
      expect(obj.tier).not.toBe("fast");
    }
  }, 60_000);

  it("planning fixture short-circuits with planning:short-circuit summary", () => {
    const res = runCli([
      JSON.stringify({ text: "Sketch a roadmap for the payments team" }),
    ]);
    expect(res.status).toBe(0);
    const obj = JSON.parse(res.stdout.trim());
    expect(obj.status).toBe("accepted");
    expect(obj.text).toBe("planning:short-circuit");
  }, 60_000);

  it("mode is honoured end-to-end", () => {
    const res = runCli([
      JSON.stringify({ text: "Route this unmatched request", mode: "budget" }),
    ]);
    const obj = JSON.parse(res.stdout.trim());
    expect(obj.tier).toBe("fast");
  }, 60_000);
});
