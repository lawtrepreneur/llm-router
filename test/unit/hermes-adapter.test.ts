/**
 * test/unit/hermes-adapter.test.ts
 *
 * Issue #7 — Hermes transport adapter.
 *
 * All invocations go through an injected runner; no real Hermes process is
 * spawned in tests. Jev is explicitly not consulted anywhere in this path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HERMES_CHILD_ENV,
  HermesAdapterError,
  isHermesChild,
  runHermes,
  type HermesRunDeps,
} from "../../src/adapter/hermes";

const CFG = { timeoutMs: 5000 };
const CWD = "/tmp/hermes-adapter-test";

const fakeExec = (payload: string, ms = 5): HermesRunDeps => ({
  exec: async () => {
    await new Promise(r => setTimeout(r, ms));
    return { payload };
  },
  now: undefined,
});

beforeEach(() => {
  delete process.env[HERMES_CHILD_ENV];
});

afterEach(() => {
  delete process.env[HERMES_CHILD_ENV];
});

describe("runHermes", () => {
  it("returns payload and duration on success", async () => {
    const deps = fakeExec("HERMES_OK");
    const result = await runHermes(CFG, "do the thing", CWD, deps);
    expect(result.payload).toBe("HERMES_OK");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes child env guard into exec options", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    await runHermes(CFG, "x", CWD, {
      exec: async (_t, _p, opts) => {
        seenEnv = opts.env;
        return { payload: "ok" };
      },
    });
    expect(seenEnv?.[HERMES_CHILD_ENV]).toBe("1");
    expect(seenEnv?.HERMES_HOME).toBe("/home/romeshh/.hermes");
  });

  it("throws recursion error when already a Hermes child", async () => {
    process.env[HERMES_CHILD_ENV] = "1";
    await expect(
      runHermes(CFG, "x", CWD, fakeExec("nope")),
    ).rejects.toMatchObject({ reason: "recursion" });
  });

  it("maps timeout (killed) to reason timeout", async () => {
    const err: any = new Error("timeout");
    err.killed = true;
    err.signal = "SIGTERM";
    await expect(
      runHermes(CFG, "x", CWD, { exec: async () => { throw err; } }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("maps numeric exit code to reason exit", async () => {
    const err: any = new Error("boom");
    err.code = 2;
    await expect(
      runHermes(CFG, "x", CWD, { exec: async () => { throw err; } }),
    ).rejects.toMatchObject({ reason: "exit" });
  });

  it("maps other errors to reason spawn", async () => {
    await expect(
      runHermes(CFG, "x", CWD, { exec: async () => { throw new Error("enoent-ish"); } }),
    ).rejects.toMatchObject({ reason: "spawn" });
  });

  it("uses injected clock for duration when provided", async () => {
    let t = 1000;
    const deps: HermesRunDeps = {
      exec: async () => ({ payload: "ok" }),
      now: () => (t += 250),
    };
    const result = await runHermes(CFG, "x", CWD, deps);
    expect(result.durationMs).toBe(250);
  });
});
