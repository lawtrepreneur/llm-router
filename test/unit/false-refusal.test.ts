import { describe, expect, it } from "vitest";
import { detectFalseRefusal, parseTaskResult } from "../../src/router/false-refusal";
import { createTrajectoryStore } from "../../src/telemetry/trajectory";
import { loadConfig, validateConfig } from "../../src/router/config";

describe("false refusal", () => {
  it.each(["ESCALATE:", "NEED MORE:", "NEED CONTEXT:", "SCOPE GROWTH:", "BLOCKED:"])("detects %s only without evidence", (prefix) => {
    const resultText = `${prefix} Tools are unavailable`;
    expect(detectFalseRefusal({ toolCalls: 0, resultText })).toEqual({ suspected: true, prefix });
    expect(detectFalseRefusal({ toolCalls: 1, resultText }).suspected).toBe(false);
  });
  it.each(["DONE: no tools needed", "ESCALATE: this requires an architectural decision about the storage layer", "", "Some context\nESCALATE: tools unavailable"])("does not flag %j", (resultText) => {
    expect(detectFalseRefusal({ toolCalls: 0, resultText }).suspected).toBe(false);
  });
  it("ignores leading blanks and whitespace", () => {
    expect(detectFalseRefusal({ toolCalls: 0, resultText: "\n  \n  BLOCKED: Need PERMISSION" }).suspected).toBe(true);
  });
  it.each(["tool", "tools", "access", "not available", "unavailable", "re-dispatch", "redispatch", "hand back", "handback", "read-only", "permission"])("recognises %s", (complaint) => {
    expect(detectFalseRefusal({ toolCalls: 0, resultText: `BLOCKED: ${complaint}` }).suspected).toBe(true);
  });
});

describe("task result adapter", () => {
  const output = '<task id="wrapper" state="completed"><task_result>ESCALATE: tools unavailable</task_result></task>';
  it("prefers metadata and unwraps the result", () => {
    expect(parseTaskResult({ output, metadata: { sessionId: "metadata" } })).toEqual({ childSessionID: "metadata", text: "ESCALATE: tools unavailable" });
  });
  it("falls back to wrapper ID", () => {
    expect(parseTaskResult({ output })).toEqual({ childSessionID: "wrapper", text: "ESCALATE: tools unavailable" });
  });
  it("passes raw output through", () => {
    expect(parseTaskResult({ output: "raw text" })).toEqual({ text: "raw text" });
  });
  it.each([undefined, null, 42, "garbage", {}, { output: false }, { metadata: 42 }])("tolerates %j", (value) => {
    expect(parseTaskResult(value)).toEqual({ text: "" });
  });
  it("tolerates throwing getters", () => {
    expect(parseTaskResult({ get output() { throw new Error("bad getter"); } })).toEqual({ text: "" });
  });
});

describe("trajectory refusal accounting", () => {
  it("counts events and refusals independently and expires them together", () => {
    let now = 0;
    const store = createTrajectoryStore({ now: () => now });
    expect(store.toolCallCount("unknown")).toBe(0);
    store.recordToolEvent("child", { tool: "read", readOnly: true });
    store.recordToolEvent("child", { tool: "edit", readOnly: false });
    store.recordFalseRefusal("child");
    expect(store.toolCallCount("child")).toBe(2);
    expect(store.get("child")?.falseRefusalCount).toBe(1);
    store.recordFalseRefusal("child");
    expect(store.get("child")?.falseRefusalCount).toBe(2);
    now = 10;
    store.sweep(now, 10);
    expect(store.toolCallCount("child")).toBe(0);
    expect(store.get("child")).toBeUndefined();
  });
});

describe("falseRefusalDetection config", () => {
  it.each([undefined, true, false])("accepts %s", (value) => {
    expect(() => validateConfig({ ...loadConfig(), falseRefusalDetection: value })).not.toThrow();
  });
  it.each([null, "false", 0, {}])("rejects %j", (value) => {
    expect(() => validateConfig({ ...loadConfig(), falseRefusalDetection: value })).toThrow("'falseRefusalDetection' must be a boolean");
  });
});
