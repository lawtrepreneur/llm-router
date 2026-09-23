import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Model } from "@opencode-ai/sdk";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, loadConfig } from "../../src/router/config";
import { getActiveTiers } from "../../src/router/protocol";
import * as sessions from "../../src/router/sessions";
import { buildDispatchHeader } from "../../src/router/dispatch-header";

/**
 * Regression coverage for the child-session leak.
 *
 * The plugin creates backend sessions for the producer (one per ladder attempt)
 * and for the grader. Before the fix these were created with no `parentID` and
 * were never aborted or deleted, so every delegation left permanent top-level
 * sessions in the OpenCode TUI — happy path included, and one extra per retry.
 *
 * These tests drive the real `delegate` tool against a mocked client and assert
 * the full lifecycle: parented on creation, aborted and deleted on every exit
 * path including when `session.prompt` rejects.
 */

const ORCHESTRATOR_SID = "orchestrator-session";

interface Harness {
  ctx: Record<string, unknown>;
  createdIDs: string[];
  createOptions: any[];
  graderIDs: string[];
  aborted: string[];
  deleted: string[];
  getSession: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  graderPromptRejects?: boolean;
  graderPass?: boolean;
  producerPromptRejects?: boolean;
  parentID?: string;
  sessionGetRejects?: boolean;
  sessionGetError?: boolean;
} = {}): Harness {
  const createdIDs: string[] = [];
  const createOptions: any[] = [];
  const graderIDs: string[] = [];
  const aborted: string[] = [];
  const deleted: string[] = [];
  let counter = 0;
  const getSession = vi.fn(async () => {
    if (opts.sessionGetRejects) throw new Error("session lookup failure");
    if (opts.sessionGetError) return { data: undefined, error: { message: "not found" } };
    return { data: { parentID: opts.parentID } };
  });

  const client = {
    session: {
      get: getSession,
      create: async (options: any) => {
        counter += 1;
        const id = `sess-${counter}`;
        createdIDs.push(id);
        createOptions.push(options);
        return { data: { id } };
      },
      prompt: async (request: any) => {
        // dispatchGrader is the only caller that sets `system`.
        const isGrader = request?.body?.system !== undefined;
        if (isGrader) {
          graderIDs.push(request?.path?.id);
          if (opts.graderPromptRejects) {
            throw new Error("grader transport failure");
          }
          const pass = opts.graderPass ?? true;
          return {
            data: {
              parts: [
                {
                  type: "text",
                  text: JSON.stringify({
                    pass,
                    reasons: pass ? [] : ["criterion not evidenced"],
                  }),
                },
              ],
            },
          };
        }
        if (opts.producerPromptRejects) {
          throw new Error("producer transport failure");
        }
        return { data: { parts: [{ type: "text", text: "producer output" }] } };
      },
      abort: async (options: any) => {
        aborted.push(options?.path?.id);
        return true;
      },
      delete: async (options: any) => {
        deleted.push(options?.path?.id);
        return true;
      },
    },
  };

  const ctx = {
    directory: process.cwd(),
    worktree: process.cwd(),
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: client as any,
  };

  return { ctx, createdIDs, createOptions, graderIDs, aborted, deleted, getSession };
}

async function runDelegate(
  h: Harness,
  ...toolCtxArg: [{ sessionID?: string } | undefined] | []
): Promise<string> {
  const hooks: any = await ModelRouterPlugin(h.ctx as any);
  const toolCtx = toolCtxArg.length > 0 ? toolCtxArg[0] : { sessionID: ORCHESTRATOR_SID };
  return hooks.tool.delegate.execute(
    {
      task: "do the thing",
      tier: "fast",
      acceptance: "[acceptance]\ncriteria: the thing is done\n[/acceptance]",
    },
    toolCtx,
  );
}

describe("child session lifecycle", () => {
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    const dir = join(tmpdir(), `oc-mr-session-lifecycle-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    invalidateConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
  });

  describe("task dispatch headers", () => {
    it.each(["subagent_type", "subagentType"])("prepends using %s and is idempotent", async (field) => {
      const cfg = loadConfig();
      cfg.tierCaps = { ...cfg.tierCaps, fast: 11 };
      const h = makeHarness();
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      const output = { args: { [field]: "fast", prompt: "Do the work" } };
      const call = { tool: "task", sessionID: ORCHESTRATOR_SID, callID: "dispatch" };
      await hooks["tool.execute.before"]!(call, output);
      const expected = buildDispatchHeader({ tier: "fast", cap: 11, projectDirectory: process.cwd() }) + "\n\n---\n\nDo the work";
      expect(output.args.prompt).toBe(expected);
      await hooks["tool.execute.before"]!(call, output);
      expect(output.args.prompt).toBe(expected);
    });

    it.each([
      { tool: "read", args: { subagent_type: "fast", prompt: "original" } },
      { tool: "task", args: { subagent_type: "unknown", prompt: "original" } },
      { tool: "task", args: { prompt: "original" } },
      { tool: "task", args: { subagent_type: "toString", prompt: "original" } },
      { tool: "task", args: { subagent_type: "fast", prompt: 42 } },
      { tool: "task", args: null },
      { tool: "task", args: { subagent_type: "fast", prompt: "[router] You are @fast. Existing header" } },
    ])("leaves unsupported or already-prefixed calls unchanged: %j", async ({ tool, args }) => {
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args };
      const before = structuredClone(output);
      await hooks["tool.execute.before"]!({ tool, sessionID: ORCHESTRATOR_SID, callID: "dispatch" }, output);
      expect(output).toEqual(before);
    });

    it("can be disabled by config", async () => {
      loadConfig().dispatchHeader = false;
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: { subagent_type: "fast", prompt: "original" } };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: ORCHESTRATOR_SID, callID: "dispatch" }, output);
      expect(output.args.prompt).toBe("original");
    });

    it.each(["fast", "custom"])("resolves default cap for %s", async (tier) => {
      const cfg = loadConfig();
      cfg.tierCaps = undefined;
      getActiveTiers(cfg).custom = { model: "test/model" };
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: { subagent_type: tier, prompt: "original" } };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: ORCHESTRATOR_SID, callID: "dispatch" }, output);
      expect(output.args.prompt).toContain(`Read-only budget: ${sessions.DEFAULT_TIER_CAPS[tier] ?? 5} calls.`);
    });

    it("does not throw if dispatch args cannot be mutated", async () => {
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: Object.freeze({ subagent_type: "fast", prompt: "original" }) };
      await expect(hooks["tool.execute.before"]!({ tool: "task", sessionID: ORCHESTRATOR_SID, callID: "dispatch" }, output)).resolves.toBeUndefined();
      expect(output.args.prompt).toBe("original");
    });
  });

  // -------------------------------------------------------------------------
  // parentID
  // -------------------------------------------------------------------------

  describe("system transform session resolver", () => {
    const model: Model = {
      id: "test-model",
      providerID: "test-provider",
      api: { id: "test-model", url: "http://localhost", npm: "test" },
      name: "Test model",
      capabilities: {
        temperature: true, reasoning: false, attachment: false, toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1000, output: 100 },
      status: "active",
      options: {},
      headers: {},
    };

    it("skips an unknown child before session.created and marks it as a subagent", async () => {
      const storeSpy = vi.spyOn(sessions, "createSessionStore");
      const h = makeHarness({ parentID: ORCHESTRATOR_SID });
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      const output = { system: [] as string[] };

      await hooks["experimental.chat.system.transform"]!({ sessionID: "child", model }, output);

      expect(output.system).toEqual([]);
      expect(storeSpy.mock.results[0].value.isSubagent("child")).toBe(true);
      expect(h.getSession).toHaveBeenCalledWith({ path: { id: "child" } });
    });

    it("injects exactly one entry for an unknown root", async () => {
      const h = makeHarness();
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      const output = { system: [] as string[] };

      await hooks["experimental.chat.system.transform"]!({ sessionID: "root", model }, output);

      expect(output.system).toHaveLength(1);
    });

    it.each([true, false])("filters global instructions only for children (child=%s)", async (child) => {
      const h = makeHarness({ parentID: child ? ORCHESTRATOR_SID : undefined });
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      const global = "Instructions from: C:\\Users\\user\\CLAUDE.md\nOrchestrate";
      const output = { system: ["provider", global] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: "instructions", model }, output);
      if (child) {
        expect(output.system).toEqual(["provider"]);
      } else {
        expect(output.system).toHaveLength(3);
        expect(output.system.slice(0, 2)).toEqual(["provider", global]);
        expect(output.system[2]).toContain("fast");
      }
    });

    it.each([undefined, ORCHESTRATOR_SID])("looks up each session once (parentID=%s)", async (parentID) => {
      const h = makeHarness({ parentID });
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      for (let i = 0; i < 2; i++) {
        const output = { system: [] as string[] };
        await hooks["experimental.chat.system.transform"]!({ sessionID: "session", model }, output);
        expect(output.system).toHaveLength(parentID ? 0 : 1);
      }
      expect(h.getSession).toHaveBeenCalledTimes(1);
    });

    it.each(["rejection", "error response"])("throttles %s for 30s, then recovers without memoising root", async (failure) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const store = sessions.createSessionStore();
      vi.spyOn(sessions, "createSessionStore").mockReturnValue(store);
      const opts = { sessionGetRejects: failure === "rejection", sessionGetError: failure === "error response", parentID: ORCHESTRATOR_SID };
      const h = makeHarness(opts);
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      for (let i = 0; i < 2; i++) {
        now = i * 29_999;
        const output = { system: [] as string[] };
        await expect(hooks["experimental.chat.system.transform"]!({ sessionID: "root", model }, output)).resolves.toBeUndefined();
        expect(output.system).toHaveLength(1);
        expect(store.isSubagent("root")).toBe(false);
      }
      expect(h.getSession).toHaveBeenCalledTimes(1);
      opts.sessionGetRejects = false;
      opts.sessionGetError = false;
      now = 30_000;
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: "root", model }, output);
      expect(output.system).toEqual([]);
      expect(store.isSubagent("root")).toBe(true);
      expect(h.getSession).toHaveBeenCalledTimes(2);
    });

    it("re-marks a memoised child after idle eviction", async () => {
      const store = sessions.createSessionStore();
      vi.spyOn(sessions, "createSessionStore").mockReturnValue(store);
      const h = makeHarness({ parentID: ORCHESTRATOR_SID });
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      await hooks["experimental.chat.system.transform"]!({ sessionID: "child", model }, { system: [] });
      store.sweep(Date.now(), 0);
      expect(store.isSubagent("child")).toBe(false);
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: "child", model }, output);
      expect(store.isSubagent("child")).toBe(true);
      expect(output.system).toEqual([]);
      expect(h.getSession).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("evicts deleted session memo, failure stamp and store (failed=%s)", async (sessionGetError) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = sessions.createSessionStore();
      vi.spyOn(sessions, "createSessionStore").mockReturnValue(store);
      const opts = { sessionGetError, parentID: undefined as string | undefined };
      const h = makeHarness(opts);
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      await hooks["experimental.chat.system.transform"]!({ sessionID: "deleted", model }, { system: [] });
      store.registerProducerSession("deleted", "fast", loadConfig());
      // The SDK declares properties.info: Session; only id is consumed here.
      const eventHook = hooks.event as (input: { event: { type: "session.deleted"; properties: { info: { id: string } } } }) => Promise<void>;
      await eventHook({ event: { type: "session.deleted", properties: { info: { id: "deleted" } } } });
      expect(store.isSubagent("deleted")).toBe(false);
      expect(store.getTier("deleted")).toBeNull();
      opts.sessionGetError = false;
      opts.parentID = ORCHESTRATOR_SID;
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: "deleted", model }, output);
      expect(output.system).toEqual([]);
      expect(h.getSession).toHaveBeenCalledTimes(2);
    });

    it("bounds failed lookups to 500 sessions with oldest-first eviction", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(Date, "now").mockReturnValue(0);
      const h = makeHarness({ sessionGetError: true });
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      const transform = hooks["experimental.chat.system.transform"]!;
      for (let i = 0; i <= 500; i++) {
        await transform({ sessionID: `failed-${i}`, model }, { system: [] });
      }
      await transform({ sessionID: "failed-1", model }, { system: [] });
      expect(h.getSession).toHaveBeenCalledTimes(501);
      await transform({ sessionID: "failed-0", model }, { system: [] });
      expect(h.getSession).toHaveBeenCalledTimes(502);
    });
  });

  it("emits both steps and legacy maxSteps for every tier agent", async () => {
    const h = makeHarness();
    const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
    const config: { agent: Record<string, { steps?: number; maxSteps?: number }> } = { agent: {} };
    await hooks.config!(config);
    for (const [name, tier] of Object.entries(getActiveTiers(loadConfig()))) {
      expect(config.agent[name]).toHaveProperty("steps", tier.steps);
      expect(config.agent[name]).toHaveProperty("maxSteps", tier.steps);
    }
  });

  it("creates every child session with the orchestrator as parentID", async () => {
    const h = makeHarness({ graderPass: true });
    await runDelegate(h);

    expect(h.createOptions.length).toBeGreaterThan(0);
    for (const options of h.createOptions) {
      expect(options?.body?.parentID).toBe(ORCHESTRATOR_SID);
    }
  });

  it("creates a grader session, not just a producer session", async () => {
    const h = makeHarness({ graderPass: true });
    await runDelegate(h);

    expect(h.graderIDs.length).toBeGreaterThan(0);
    // Grader sessions are also parented.
    for (const options of h.createOptions) {
      expect(options?.body?.parentID).toBe(ORCHESTRATOR_SID);
    }
  });

  it("omits parentID when no orchestrator session is available", async () => {
    const h = makeHarness({ graderPass: true });
    await runDelegate(h, undefined);

    expect(h.createOptions.length).toBeGreaterThan(0);
    for (const options of h.createOptions) {
      expect(options?.body?.parentID).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // abort + delete on the happy path
  // -------------------------------------------------------------------------

  it("aborts and deletes every session it created", async () => {
    const h = makeHarness({ graderPass: true });
    await runDelegate(h);

    expect(h.createdIDs.length).toBeGreaterThan(0);
    for (const id of h.createdIDs) {
      expect(h.aborted, `session never aborted: ${id}`).toContain(id);
      expect(h.deleted, `session never deleted: ${id}`).toContain(id);
    }
  });

  // -------------------------------------------------------------------------
  // abort + delete when prompt rejects
  // -------------------------------------------------------------------------

  it("aborts and deletes the grader session when session.prompt rejects", async () => {
    const h = makeHarness({ graderPromptRejects: true });
    await runDelegate(h);

    expect(h.graderIDs.length).toBeGreaterThan(0);
    for (const id of h.graderIDs) {
      expect(h.aborted, `grader session never aborted: ${id}`).toContain(id);
      expect(h.deleted, `grader session never deleted: ${id}`).toContain(id);
    }
  });

  it("aborts and deletes the producer session when session.prompt rejects", async () => {
    const h = makeHarness({ producerPromptRejects: true, graderPass: true });
    await runDelegate(h);

    const producerIDs = h.createdIDs.filter((id) => !h.graderIDs.includes(id));
    expect(producerIDs.length).toBeGreaterThan(0);
    for (const id of producerIDs) {
      expect(h.aborted, `producer session never aborted: ${id}`).toContain(id);
      expect(h.deleted, `producer session never deleted: ${id}`).toContain(id);
    }
  });

  // -------------------------------------------------------------------------
  // every ladder iteration cleans up its own session
  // -------------------------------------------------------------------------

  it("cleans up each ladder retry's producer session, not just the last", async () => {
    // A failing grader verdict drives the escalation ladder, so the delegate
    // loop creates a fresh producer session per attempt.
    const h = makeHarness({ graderPass: false });
    await runDelegate(h);

    const producerIDs = h.createdIDs.filter((id) => !h.graderIDs.includes(id));
    expect(
      producerIDs.length,
      "expected the ladder to retry and create more than one producer session",
    ).toBeGreaterThan(1);

    for (const id of producerIDs) {
      expect(h.aborted, `retry producer session never aborted: ${id}`).toContain(id);
      expect(h.deleted, `retry producer session never deleted: ${id}`).toContain(id);
    }
  });

  it("leaves no created session undisposed across a full retry ladder", async () => {
    const h = makeHarness({ graderPass: false });
    await runDelegate(h);

    const undisposed = h.createdIDs.filter(
      (id) => !h.aborted.includes(id) || !h.deleted.includes(id),
    );
    expect(undisposed, `leaked sessions: ${undisposed.join(", ")}`).toEqual([]);
  });
});
