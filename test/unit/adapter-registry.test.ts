import { describe, it, expect, beforeEach } from "vitest";
import { adapterRegistry, registerAdapter, rollBackAdapters } from "../../src/adapter/registry";
import { readState } from "../../src/router/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "registry-test-"));
  process.env.HOME = tmpHome;
  adapterRegistry.length = 0;
});

describe("registerAdapter / rollBackAdapters", () => {
  it("rolls back single adapter to off", () => {
    registerAdapter({ name: "opencode", modeKey: "opencodeAdapterMode" });
    const switched = rollBackAdapters();
    expect(switched).toEqual(["opencode"]);
    const state = readState();
    expect(state.opencodeAdapterMode).toBe("off");
  });

  it("rolls back multiple adapters generically", () => {
    registerAdapter({ name: "opencode", modeKey: "opencodeAdapterMode" });
    registerAdapter({ name: "hermes", modeKey: "opencodeAdapterMode" });
    const switched = rollBackAdapters();
    expect(switched).toEqual(["opencode", "hermes"]);
  });

  it("is idempotent: rollback twice stays off", () => {
    registerAdapter({ name: "opencode", modeKey: "opencodeAdapterMode" });
    rollBackAdapters();
    rollBackAdapters();
    const state = readState();
    expect(state.opencodeAdapterMode).toBe("off");
  });
});
