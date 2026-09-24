import { describe, expect, it } from "vitest";
import { loadConfig, validateConfig } from "../../src/router/config";

// Hook behaviour is covered with the other task before-hook tests in
// test/integration/session-lifecycle.test.ts, which owns the plugin harness.
describe("taskPromptRepair config", () => {
  it.each([undefined, true, false])("accepts %s", (value) => {
    expect(() => validateConfig({ ...loadConfig(), taskPromptRepair: value })).not.toThrow();
  });
  it.each([null, 0, "false", {}, []])("rejects %j", (value) => {
    expect(() => validateConfig({ ...loadConfig(), taskPromptRepair: value })).toThrow("tiers.json: 'taskPromptRepair' must be a boolean");
  });
});
