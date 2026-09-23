import { describe, it, expect, vi } from "vitest";
import { accept, unverifiableGateResult, type Artefact, type GateDeps } from "../../src/verify/gate";
import { normalizeDoD, type Check } from "../../src/verify/dod";
import { nextAction, newLadderState } from "../../src/escalate/ladder";
import { graderTimeoutMs, RouterTimeoutError } from "../../src/verify/timeout";
import { validateConfig } from "../../src/router/config";

const artefact: Artefact = { changedFiles: [], finalReturnText: "done", declaredOutputs: [], producerSessionID: "producer", producerTier: "medium" };
const policy = { ladder: ["fast", "medium", "heavy"], maxAttemptsPerTier: 0, maxTotalAttempts: 4 };
function deps(): GateDeps {
  return {
    deterministic: { cwd: "/ws", fs: { fileExists: async () => false, readFile: async () => "{}" }, exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) },
    checker: { dispatchGrader: async () => { throw new RouterTimeoutError("grader prompt", 180000); } },
  };
}
function dod(checks: Check[]) {
  return normalizeDoD({ kind: "deterministic", checks, criteria: checks.length ? [] : ["correct"], deliverable: null, source: "explicit" });
}
const blocked: Check = { kind: "run", command: "git stash list" };

describe("unverifiable acceptance", () => {
  it("a later gate timeout cannot erase a completed failure", async () => {
    const d = deps();
    const failures: string[] = [];
    d.deterministic.onFailure = reason => failures.push(reason);
    await accept({ dod: dod([{ kind: "fileExists", path: "missing" }]) }, artefact, d);
    expect(failures).toHaveLength(1);
    const r = unverifiableGateResult("verification gate timed out", "explicit", false, failures);
    expect(r.accepted).toBe(false);
    expect(r.verdict.outcome).toBe("fail");
    expect(r.verdict.caveats).toEqual(["verification gate timed out"]);
    expect(nextAction(newLadderState("medium", policy), r.verdict, policy).action).toBe("escalate");
  });
  it("accepts an all-unverifiable result with the complete caveat list, without running refused commands", async () => {
    const d = deps();
    const r = await accept({ dod: dod([blocked, { kind: "buildPasses" }]) }, artefact, d);
    expect(r.accepted).toBe(true);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.caveats).toEqual(["command not allowlisted: git stash list", "buildPasses: no build script or root tsconfig.json"]);
    expect(d.deterministic.exec).not.toHaveBeenCalled();
    expect(nextAction(newLadderState("medium", policy), { ...r.verdict, pass: r.accepted }, policy).action).toBe("accept");
  });
  it.each([false, true])("only genuine failure rejects and escalates, including mixed checks (%s)", async (mixed) => {
    const r = await accept({ dod: dod([...(mixed ? [blocked] : []), { kind: "fileExists", path: "missing" }]) }, artefact, deps());
    expect(r.accepted).toBe(false);
    expect(r.verdict.outcome).toBe("fail");
    expect(nextAction(newLadderState("medium", policy), r.verdict, policy).action).toBe("escalate");
    if (mixed) expect(r.verdict.caveats).toEqual(["command not allowlisted: git stash list"]);
  });
  it.each([false, true])("grader timeout never escalates (strict=%s)", async (strictUnverifiable) => {
    const r = await accept({ dod: dod([]) }, artefact, { ...deps(), strictUnverifiable });
    expect(r.accepted).toBe(!strictUnverifiable);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.caveats?.[0]).toContain("grader prompt timed out after 180000ms");
    expect(nextAction(newLadderState("medium", policy), { ...r.verdict, pass: r.accepted }, policy).action).toBe(strictUnverifiable ? "give_up" : "accept");
  });
  it("strict mode rejects refused checks", async () => {
    const r = await accept({ dod: dod([blocked]) }, artefact, { ...deps(), strictUnverifiable: true });
    expect(r.accepted).toBe(false);
    expect(r.verdict.outcome).toBe("unverifiable");
  });
  it.each([
    [true, true, "npm run build"],
    [false, true, "npx tsc --noEmit"],
    [false, false, null],
  ] as const)("build probe script=%s tsconfig=%s", async (build, tsconfig, command) => {
    const d = deps();
    d.deterministic.fs = {
      fileExists: async p => p.endsWith("package.json") ? build : tsconfig,
      readFile: async () => JSON.stringify({ scripts: { build: "tsc" } }),
    };
    const r = await accept({ dod: dod([{ kind: "buildPasses" }]) }, artefact, d);
    expect(r.accepted).toBe(true);
    if (command) {
      expect(r.verdict.outcome).toBe("pass");
      expect(d.deterministic.exec).toHaveBeenCalledWith(command, { cwd: "/ws", timeoutMs: 120000 });
    } else {
      expect(r.verdict.outcome).toBe("unverifiable");
      expect(d.deterministic.exec).not.toHaveBeenCalled();
    }
  });
  it.each(["fileExists", "schemaMatch"] as const)("%s cannot resolve a relative path with no working directory", async kind => {
    const d = deps();
    d.deterministic.cwd = "";
    const r = await accept({ dod: dod([{ kind, path: "out.json", schema: "{}" }]) }, artefact, d);
    expect(r.accepted).toBe(true);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.caveats?.[0]).toContain("working directory");
  });
  it.each([["fast", 60000], ["medium", 180000], ["heavy", 600000], ["custom", 600000]] as const)("%s timeout defaults to %s and explicit override wins", (tier, ms) => {
    expect(graderTimeoutMs(tier)).toBe(ms);
    expect(graderTimeoutMs(tier, 1234)).toBe(1234);
  });
  it("validates strictUnverifiable via validateConfig", () => {
    const cfg = { activePreset: "a", presets: { a: { fast: { model: "p/m" } } }, rules: [], defaultTier: "fast" };
    expect(() => validateConfig({ ...cfg, enforcement: { verify: { strictUnverifiable: "yes" } } })).toThrow("strictUnverifiable must be a boolean");
    expect(validateConfig({ ...cfg, enforcement: { verify: { strictUnverifiable: true } } }).enforcement?.verify?.strictUnverifiable).toBe(true);
  });
});
