/**
 * test/integration/receipts-shadow-wiring.test.ts
 *
 * Phase 4: proves enforcement.deciderShadow=true attaches a decider shadow
 * observation to persisted routing receipts, and that the default (off)
 * leaves receipts untouched. Decider HTTP is stubbed at global fetch; the
 * receipts dir points at a temp dir.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import { parseLines } from "../../src/receipts/store";

function writeOverrides(home: string, config: Record<string, unknown>): void {
  const p = path.join(home, ".config/opencode/opencode-model-router.overrides.jsonc");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config), "utf-8");
}

function makeCtx(dir: string) {
  return {
    directory: dir,
    worktree: dir,
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: {
      session: {
        create: async () => ({ data: { id: "sess_p1" } }),
        abort: async () => ({}),
        delete: async () => ({}),
        prompt: async () => ({ data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] } }),
        get: async () => ({ data: { agent: "developer-cloud" } }),
      },
    },
  } as any;
}

async function bootPlugin(dir: string) {
  const hooks: any = await ModelRouterPlugin(makeCtx(dir));
  await hooks["chat.message"]({ sessionID: "orchestrator-session", agent: "developer-cloud" }, {});
  return hooks;
}

function deciderResponse(fast = false) {
  const probabilities = fast ? [0.7, 0.2, 0.1] : [0.2, 0.7, 0.1];
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ logprobs: { content: [{ top_logprobs: [
      { token: "A", logprob: Math.log(probabilities[0]) },
      { token: "B", logprob: Math.log(probabilities[1]) },
      { token: "C", logprob: Math.log(probabilities[2]) },
    ] } ] } } ] }),
  } as unknown as Response;
}

const CASES = [
  { name: "emits agreeing shadowClassifier", flag: true, fast: false, expectField: true, disagreement: false },
  { name: "emits disagreeing shadowClassifier", flag: true, fast: true, expectField: true, disagreement: true },
  { name: "omits shadowClassifier by default", flag: undefined, fast: false, expectField: false, disagreement: false },
];

describe("receipts shadow wiring (Phase 4)", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedReceiptsDir: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedHome !== undefined) process.env.HOME = savedHome;
    if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
    if (savedReceiptsDir !== undefined) process.env.MODEL_ROUTER_RECEIPTS_DIR = savedReceiptsDir;
    else delete process.env.MODEL_ROUTER_RECEIPTS_DIR;
    invalidateConfigCache();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const tc of CASES) {
    it(tc.name, async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrr-shadow-"));
      savedHome = process.env.HOME;
      savedUserProfile = process.env.USERPROFILE;
      savedReceiptsDir = process.env.MODEL_ROUTER_RECEIPTS_DIR;
      process.env.HOME = dir;
      process.env.USERPROFILE = dir;
      process.env.MODEL_ROUTER_RECEIPTS_DIR = path.join(dir, "receipts");
      writeOverrides(dir, {
        experimental: { verifiedDelegateTool: true },
        ...(tc.flag !== undefined ? { enforcement: { deciderShadow: tc.flag } } : {}),
      });
      invalidateConfigCache();
      vi.stubGlobal("fetch", vi.fn(async () => deciderResponse(tc.fast)));

      const hooks = await bootPlugin(dir);
      await hooks.tool.delegate.execute(
        { task: "do the thing [acceptance]\ncriteria: it exists\n[/acceptance]", tier: "medium" },
        { sessionID: "orchestrator-session" },
      );

      const text = fs.readFileSync(path.join(dir, "receipts", "routing-receipts.jsonl"), "utf-8");
      const { records, rejected } = parseLines(text);
      expect(rejected).toBe(0);
      expect(records.length).toBeGreaterThan(0);
      if (tc.expectField) {
        expect(records[0].shadowClassifier).toBeDefined();
        expect(records[0].shadowClassifier!.disagreement).toBe(tc.disagreement);
        expect(records[0].shadowClassifier!.probabilities).toHaveLength(3);
      } else {
        expect(records[0].shadowClassifier).toBeUndefined();
      }
    });
  }
});