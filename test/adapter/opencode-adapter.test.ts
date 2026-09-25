import { describe, expect, it } from "vitest";
import { effectiveAdapterMode, shouldIntercept } from "../../src/adapter/wiring";
import {
  OpenCodeAdapterError,
  isOcChild,
  runOpenCode,
  OC_CHILD_ENV,
} from "../../src/adapter/opencode";
import { DEFAULT_OPENCODE_ADAPTER } from "../../src/router/config";

describe("effectiveAdapterMode", () => {
  it("returns off when no adapter config", () => {
    expect(effectiveAdapterMode({})).toBe("off");
  });

  it("passes shadow and live through", () => {
    expect(effectiveAdapterMode({ opencodeAdapter: { ...DEFAULT_OPENCODE_ADAPTER, mode: "shadow" } })).toBe("shadow");
    expect(effectiveAdapterMode({ opencodeAdapter: { ...DEFAULT_OPENCODE_ADAPTER, mode: "live" } })).toBe("live");
  });
});

describe("recursion guard", () => {
  const original = process.env[OC_CHILD_ENV];
  const setChild = () => { process.env[OC_CHILD_ENV] = "1"; };
  const clearChild = () => {
    if (original === undefined) delete process.env[OC_CHILD_ENV];
    else process.env[OC_CHILD_ENV] = original;
  };

  it("isOcChild true when env set", () => {
    setChild();
    try {
      expect(isOcChild()).toBe(true);
      expect(effectiveAdapterMode({ opencodeAdapter: { ...DEFAULT_OPENCODE_ADAPTER, mode: "live" } })).toBe("off");
      expect(shouldIntercept({ opencodeAdapter: { ...DEFAULT_OPENCODE_ADAPTER, mode: "live" } }, "medium", "developer-cloud")).toBe("off");
    } finally {
      clearChild();
    }
  });

  it("runOpenCode refuses to spawn inside a child", async () => {
    setChild();
    try {
      await expect(
        runOpenCode({ binary: "true", args: [], timeoutMs: 1000 }, "hi", process.cwd()),
      ).rejects.toThrow(OpenCodeAdapterError);
    } finally {
      clearChild();
    }
  });
});

describe("shouldIntercept", () => {
  const cfg = {
    opencodeAdapter: {
      ...DEFAULT_OPENCODE_ADAPTER,
      mode: "live" as const,
      tiers: ["medium"],
      allowedAgents: ["developer-cloud"],
    },
  };

  it("intercepts allowed agent on allowed tier", () => {
    expect(shouldIntercept(cfg, "medium", "developer-cloud")).toBe("live");
  });

  it("does not intercept unlisted tier", () => {
    expect(shouldIntercept(cfg, "fast", "developer-cloud")).toBe("off");
  });

  it("does not intercept unlisted agent (fail-closed)", () => {
    expect(shouldIntercept(cfg, "medium", "writer-std")).toBe("off");
    expect(shouldIntercept(cfg, "medium", undefined)).toBe("off");
  });

  it("empty allowedAgents blocks everyone", () => {
    expect(
      shouldIntercept(
        { opencodeAdapter: { ...DEFAULT_OPENCODE_ADAPTER, mode: "live", tiers: ["medium"], allowedAgents: [] } },
        "medium",
        "developer-cloud",
      ),
    ).toBe("off");
  });
});

describe("runOpenCode (real spawn)", () => {
  it("passes the configured child agent before the prompt", async () => {
    let argv: string[] | undefined;
    await runOpenCode(
      { binary: "opencode", args: ["run", "--auto"], timeoutMs: 5000 },
      "inspect this",
      process.cwd(),
      {
        exec: (async (_binary: string, args: readonly string[]) => {
          argv = [...args];
          return { stdout: "ok", stderr: "" };
        }) as any,
      },
      "task-std",
    );
    expect(argv).toEqual(["run", "--auto", "--agent", "task-std", "inspect this"]);
  });

  it("runs a trivial binary and returns stdout", async () => {
    const r = await runOpenCode(
        { binary: "echo", args: [], timeoutMs: 5000 },
        "hello",
        process.cwd(),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("rejects non-zero exit", async () => {
    await expect(runOpenCode(
      { binary: "sh", args: ["-c", "echo boom >&2; exit 3"], timeoutMs: 5000 },
      "",
      process.cwd(),
    )).rejects.toMatchObject({ reason: "exit" });
  });

  it("times out", async () => {
    await expect(
      runOpenCode(
        // prompt is appended as an argument, so the shell form keeps the
        // command sleeping regardless of what the prompt is.
        { binary: "sh", args: ["-c", "sleep 5"], timeoutMs: 100 },
        "",
        process.cwd(),
      ),
    ).rejects.toMatchObject({ reason: "timeout" });
  }, 5000);
});
