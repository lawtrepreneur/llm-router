/**
 * test/unit/policy.test.ts
 *
 * Policy tests covering:
 *   1. Lane routing correctness — for each (mode × taskKind), the resolved
 *      tier and capOverride match the contract in src/contract/lane-matrix.ts.
 *   2. Phase taxonomy consistency — caps, permissions, and prompt styles are
 *      internally consistent and match tiers.json defaults.
 *   3. Escalation schema round-trip — validate → resolve → validate produces
 *      the same policy as a direct resolve.
 *   4. DispatchRequest / DispatchResult schema validation — valid and invalid
 *      shapes produce the expected error lists.
 *   5. Fail-up rules — unverifiable never escalates; pass always accepts; fail
 *      enters the ladder.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Lane matrix
// ---------------------------------------------------------------------------

import {
  LANE_MATRIX,
  resolveLane,
  classifyTaskKind,
  taskKindsForTier,
  FAST_TASK_KINDS,
  MEDIUM_TASK_KINDS,
  HEAVY_TASK_KINDS,
  type ModeName,
  type TaskKind,
  type TierName,
} from "../../src/contract/lane-matrix";

// ---------------------------------------------------------------------------
// Phase taxonomy
// ---------------------------------------------------------------------------

import {
  PHASE_TAXONOMY,
  isToolKindPermitted,
  resolveDispatchCap,
} from "../../src/contract/phase-taxonomy";

// ---------------------------------------------------------------------------
// Escalate schema
// ---------------------------------------------------------------------------

import {
  validateEscalatePolicy,
  resolveEscalatePolicy,
  DEFAULT_ESCALATE_POLICY,
  ESCALATABLE_OUTCOMES,
  NON_ESCALATABLE_OUTCOMES,
} from "../../src/contract/escalate-schema";

// ---------------------------------------------------------------------------
// Dispatch schema
// ---------------------------------------------------------------------------

import {
  validateDispatchRequest,
  validateDispatchResult,
} from "../../src/contract/dispatch-schema";

// ---------------------------------------------------------------------------
// Ladder (implementation) — for fail-up rule tests
// ---------------------------------------------------------------------------

import {
  newLadderState,
  recordAttempt,
  nextAction,
  advance,
} from "../../src/escalate/ladder";
import type { EscalatePolicy, LadderVerdict } from "../../src/escalate/ladder";

// ===========================================================================
// 1. Lane routing correctness
// ===========================================================================

describe("lane matrix — resolveLane", () => {
  const modes: ModeName[] = ["normal", "budget", "quality", "deep"];

  it("every (mode, taskKind) resolves without throwing", () => {
    const allKinds = [
      ...FAST_TASK_KINDS,
      ...MEDIUM_TASK_KINDS,
      ...HEAVY_TASK_KINDS,
    ] as TaskKind[];
    for (const mode of modes) {
      for (const kind of allKinds) {
        expect(() => resolveLane(mode, kind)).not.toThrow();
        const lane = resolveLane(mode, kind);
        expect(["fast", "medium", "heavy"]).toContain(lane.tier);
      }
    }
  });

  // ---- normal mode ----
  describe("normal mode", () => {
    it("fast tasks → fast", () => {
      for (const kind of FAST_TASK_KINDS) {
        expect(resolveLane("normal", kind as TaskKind).tier).toBe("fast");
      }
    });
    it("medium tasks → medium (default)", () => {
      for (const kind of MEDIUM_TASK_KINDS) {
        expect(resolveLane("normal", kind as TaskKind).tier).toBe("medium");
      }
    });
    it("heavy tasks → heavy", () => {
      for (const kind of HEAVY_TASK_KINDS) {
        expect(resolveLane("normal", kind as TaskKind).tier).toBe("heavy");
      }
    });
    it("fast tasks with direct-allowed flag set", () => {
      const readTasks = ["search", "grep", "read", "ls", "count", "exists-check"] as TaskKind[];
      for (const kind of readTasks) {
        expect(resolveLane("normal", kind).directAllowed).toBe(true);
      }
    });
    it("no capOverride on normal mode tasks (uses tier default)", () => {
      for (const kind of MEDIUM_TASK_KINDS) {
        const lane = resolveLane("normal", kind as TaskKind);
        expect(lane.capOverride).toBeUndefined();
      }
    });
  });

  // ---- budget mode ----
  describe("budget mode", () => {
    it("defaultTier is fast", () => {
      expect(LANE_MATRIX.budget.defaultTier).toBe("fast");
    });
    it("fast tasks → fast with cap:5", () => {
      for (const kind of FAST_TASK_KINDS) {
        const lane = resolveLane("budget", kind as TaskKind);
        expect(lane.tier).toBe("fast");
        expect(lane.capOverride).toBe(5);
      }
    });
    it("medium tasks → medium with cap:2", () => {
      for (const kind of MEDIUM_TASK_KINDS) {
        const lane = resolveLane("budget", kind as TaskKind);
        expect(lane.tier).toBe("medium");
        expect(lane.capOverride).toBe(2);
      }
    });
    it("heavy tasks → heavy with cap:2", () => {
      for (const kind of HEAVY_TASK_KINDS) {
        const lane = resolveLane("budget", kind as TaskKind);
        expect(lane.tier).toBe("heavy");
        expect(lane.capOverride).toBe(2);
      }
    });
  });

  // ---- quality mode ----
  describe("quality mode", () => {
    it("defaultTier is medium", () => {
      expect(LANE_MATRIX.quality.defaultTier).toBe("medium");
    });
    it("trivial single-tool read ops stay fast", () => {
      const trivial = ["search", "grep", "read", "git-info", "ls", "count", "exists-check"] as TaskKind[];
      for (const kind of trivial) {
        expect(resolveLane("quality", kind).tier).toBe("fast");
      }
    });
    it("medium tasks → medium with cap:null (CAP:none)", () => {
      for (const kind of MEDIUM_TASK_KINDS) {
        const lane = resolveLane("quality", kind as TaskKind);
        expect(lane.tier).toBe("medium");
        expect(lane.capOverride).toBeNull();
      }
    });
    it("heavy tasks → heavy with cap:null", () => {
      for (const kind of HEAVY_TASK_KINDS) {
        const lane = resolveLane("quality", kind as TaskKind);
        expect(lane.tier).toBe("heavy");
        expect(lane.capOverride).toBeNull();
      }
    });
  });

  // ---- deep mode ----
  describe("deep mode", () => {
    it("defaultTier is heavy", () => {
      expect(LANE_MATRIX.deep.defaultTier).toBe("heavy");
    });
    it("trivial reads stay fast", () => {
      const trivial = ["search", "grep", "read", "git-info", "ls", "count", "exists-check"] as TaskKind[];
      for (const kind of trivial) {
        expect(resolveLane("deep", kind).tier).toBe("fast");
      }
    });
    it("medium tasks → medium (baseline cap, no override)", () => {
      for (const kind of MEDIUM_TASK_KINDS) {
        const lane = resolveLane("deep", kind as TaskKind);
        expect(lane.tier).toBe("medium");
        expect(lane.capOverride).toBeUndefined();
      }
    });
    it("heavy tasks → heavy with cap:null", () => {
      for (const kind of HEAVY_TASK_KINDS) {
        const lane = resolveLane("deep", kind as TaskKind);
        expect(lane.tier).toBe("heavy");
        expect(lane.capOverride).toBeNull();
      }
    });
  });
});

describe("classifyTaskKind", () => {
  it("fast kinds → fast", () => {
    for (const kind of FAST_TASK_KINDS) {
      expect(classifyTaskKind(kind)).toBe("fast");
    }
  });
  it("medium kinds → medium", () => {
    for (const kind of MEDIUM_TASK_KINDS) {
      expect(classifyTaskKind(kind)).toBe("medium");
    }
  });
  it("heavy kinds → heavy", () => {
    for (const kind of HEAVY_TASK_KINDS) {
      expect(classifyTaskKind(kind)).toBe("heavy");
    }
  });
  it("unknown kind → undefined", () => {
    expect(classifyTaskKind("make-coffee")).toBeUndefined();
  });
});

describe("taskKindsForTier", () => {
  it("returns the correct frozen arrays", () => {
    expect(taskKindsForTier("fast")).toEqual(FAST_TASK_KINDS);
    expect(taskKindsForTier("medium")).toEqual(MEDIUM_TASK_KINDS);
    expect(taskKindsForTier("heavy")).toEqual(HEAVY_TASK_KINDS);
  });
});

// ===========================================================================
// 2. Phase taxonomy consistency
// ===========================================================================

describe("phase taxonomy", () => {
  it("all three phases are defined", () => {
    expect(PHASE_TAXONOMY.fast).toBeDefined();
    expect(PHASE_TAXONOMY.medium).toBeDefined();
    expect(PHASE_TAXONOMY.heavy).toBeDefined();
  });

  it("fast phase: read-only, no mutations", () => {
    expect(PHASE_TAXONOMY.fast.mayMutate).toBe(false);
    expect(isToolKindPermitted("fast", "read")).toBe(true);
    expect(isToolKindPermitted("fast", "mutation")).toBe(false);
    expect(isToolKindPermitted("fast", "finish")).toBe(true);
  });

  it("medium phase: may mutate", () => {
    expect(PHASE_TAXONOMY.medium.mayMutate).toBe(true);
    expect(isToolKindPermitted("medium", "read")).toBe(true);
    expect(isToolKindPermitted("medium", "mutation")).toBe(true);
  });

  it("heavy phase: may mutate", () => {
    expect(PHASE_TAXONOMY.heavy.mayMutate).toBe(true);
    expect(isToolKindPermitted("heavy", "mutation")).toBe(true);
  });

  it("caps match tiers.json tierCaps defaults", () => {
    // From tiers.json: "tierCaps": { "fast": 8, "medium": 5, "heavy": 3 }
    expect(PHASE_TAXONOMY.fast.defaultReadCap).toBe(8);
    expect(PHASE_TAXONOMY.medium.defaultReadCap).toBe(5);
    expect(PHASE_TAXONOMY.heavy.defaultReadCap).toBe(3);
  });

  describe("resolveDispatchCap", () => {
    it("normal mode uses phase default caps", () => {
      expect(resolveDispatchCap("fast", "normal")).toBe(8);
      expect(resolveDispatchCap("medium", "normal")).toBe(5);
      expect(resolveDispatchCap("heavy", "normal")).toBe(3);
    });
    it("budget mode: fast=5, medium/heavy=2", () => {
      expect(resolveDispatchCap("fast", "budget")).toBe(5);
      expect(resolveDispatchCap("medium", "budget")).toBe(2);
      expect(resolveDispatchCap("heavy", "budget")).toBe(2);
    });
    it("quality mode: medium and heavy get cap:null", () => {
      expect(resolveDispatchCap("medium", "quality")).toBeNull();
      expect(resolveDispatchCap("heavy", "quality")).toBeNull();
      expect(resolveDispatchCap("fast", "quality")).toBe(8);
    });
    it("deep mode: heavy gets cap:null, others keep defaults", () => {
      expect(resolveDispatchCap("heavy", "deep")).toBeNull();
      expect(resolveDispatchCap("medium", "deep")).toBe(5);
      expect(resolveDispatchCap("fast", "deep")).toBe(8);
    });
  });

  it("each phase has at least one return protocol prefix", () => {
    for (const phase of ["fast", "medium", "heavy"] as const) {
      expect(PHASE_TAXONOMY[phase].returnProtocol.length).toBeGreaterThan(0);
    }
  });

  it("each phase has at least one escalation condition", () => {
    for (const phase of ["fast", "medium", "heavy"] as const) {
      expect(PHASE_TAXONOMY[phase].escalationConditions.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// 3. Escalate schema round-trip
// ===========================================================================

describe("escalate schema validation", () => {
  it("default policy validates clean", () => {
    expect(validateEscalatePolicy(DEFAULT_ESCALATE_POLICY)).toEqual([]);
  });

  it("valid minimal policy validates clean", () => {
    expect(validateEscalatePolicy({ ladder: ["fast", "heavy"] })).toEqual([]);
  });

  it("non-object → error", () => {
    expect(validateEscalatePolicy("string")).not.toHaveLength(0);
    expect(validateEscalatePolicy(null)).not.toHaveLength(0);
    expect(validateEscalatePolicy([])).not.toHaveLength(0);
  });

  it("empty ladder array → error", () => {
    const errs = validateEscalatePolicy({ ladder: [] });
    expect(errs.some((e) => e.includes("ladder"))).toBe(true);
  });

  it("non-string ladder item → error", () => {
    const errs = validateEscalatePolicy({ ladder: ["fast", 42] });
    expect(errs.some((e) => e.includes("ladder"))).toBe(true);
  });

  it("maxTotalAttempts < 1 → error", () => {
    const errs = validateEscalatePolicy({ maxTotalAttempts: 0 });
    expect(errs.some((e) => e.includes("maxTotalAttempts"))).toBe(true);
  });

  it("negative maxAttemptsPerTier → error", () => {
    const errs = validateEscalatePolicy({ maxAttemptsPerTier: -1 });
    expect(errs.some((e) => e.includes("maxAttemptsPerTier"))).toBe(true);
  });

  it("costCeiling.multiple <= 0 → error", () => {
    const errs = validateEscalatePolicy({ costCeiling: { multiple: 0 } });
    expect(errs.some((e) => e.includes("multiple"))).toBe(true);
  });

  it("floorTier: null is valid", () => {
    expect(validateEscalatePolicy({ floorTier: null })).toEqual([]);
  });

  it("floorTier: number → error", () => {
    const errs = validateEscalatePolicy({ floorTier: 42 });
    expect(errs.some((e) => e.includes("floorTier"))).toBe(true);
  });
});

describe("resolveEscalatePolicy", () => {
  it("undefined input → defaults", () => {
    expect(resolveEscalatePolicy(undefined)).toEqual(DEFAULT_ESCALATE_POLICY);
  });

  it("empty object → defaults", () => {
    expect(resolveEscalatePolicy({})).toEqual(DEFAULT_ESCALATE_POLICY);
  });

  it("costCeiling.multiple alias resolved", () => {
    const p = resolveEscalatePolicy({ costCeiling: { multiple: 8 } });
    expect(p.costMultiple).toBe(8);
  });

  it("explicit costMultiple wins over costCeiling.multiple", () => {
    const p = resolveEscalatePolicy({ costMultiple: 3, costCeiling: { multiple: 8 } });
    expect(p.costMultiple).toBe(3);
  });

  it("ladder override respected", () => {
    const p = resolveEscalatePolicy({ ladder: ["fast", "heavy"] });
    expect(p.ladder).toEqual(["fast", "heavy"]);
  });

  it("resolved policy validates clean", () => {
    const raw = {
      ladder: ["fast", "medium", "heavy"],
      floorTier: "fast",
      maxAttemptsPerTier: 2,
      maxTotalAttempts: 6,
      costCeiling: { multiple: 3 },
    };
    const p = resolveEscalatePolicy(raw);
    expect(validateEscalatePolicy(p)).toEqual([]);
  });
});

describe("ESCALATABLE / NON_ESCALATABLE outcomes", () => {
  it("fail is escalatable", () => {
    expect(ESCALATABLE_OUTCOMES.has("fail")).toBe(true);
    expect(ESCALATABLE_OUTCOMES.has("pass")).toBe(false);
    expect(ESCALATABLE_OUTCOMES.has("unverifiable")).toBe(false);
  });
  it("pass and unverifiable are non-escalatable", () => {
    expect(NON_ESCALATABLE_OUTCOMES.has("pass")).toBe(true);
    expect(NON_ESCALATABLE_OUTCOMES.has("unverifiable")).toBe(true);
    expect(NON_ESCALATABLE_OUTCOMES.has("fail")).toBe(false);
  });
});

// ===========================================================================
// 4. DispatchRequest / DispatchResult schema validation
// ===========================================================================

describe("validateDispatchRequest", () => {
  it("valid with prompt only", () => {
    expect(validateDispatchRequest({ prompt: "do the thing" })).toEqual([]);
  });
  it("valid with description only", () => {
    expect(validateDispatchRequest({ description: "do the thing" })).toEqual([]);
  });
  it("valid with both prompt and description", () => {
    expect(
      validateDispatchRequest({ prompt: "do it", description: "also do it" }),
    ).toEqual([]);
  });
  it("missing both prompt and description → error", () => {
    const errs = validateDispatchRequest({});
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain("prompt");
  });
  it("whitespace-only prompt → treated as absent", () => {
    const errs = validateDispatchRequest({ prompt: "   " });
    expect(errs.length).toBeGreaterThan(0);
  });
  it("non-object → error", () => {
    expect(validateDispatchRequest("string")).not.toHaveLength(0);
    expect(validateDispatchRequest(null)).not.toHaveLength(0);
    expect(validateDispatchRequest(42)).not.toHaveLength(0);
  });
  it("valid optional fields", () => {
    expect(
      validateDispatchRequest({
        prompt: "x",
        tier: "heavy",
        acceptance: "[acceptance]\ncriteria: ok\n[/acceptance]",
        cwd: "/tmp",
        steps: 50,
      }),
    ).toEqual([]);
  });
  it("non-string tier → error", () => {
    const errs = validateDispatchRequest({ prompt: "x", tier: 42 });
    expect(errs.some((e) => e.includes("tier"))).toBe(true);
  });
  it("steps: 0 → error", () => {
    const errs = validateDispatchRequest({ prompt: "x", steps: 0 });
    expect(errs.some((e) => e.includes("steps"))).toBe(true);
  });
  it("steps: non-integer → error", () => {
    const errs = validateDispatchRequest({ prompt: "x", steps: 1.5 });
    expect(errs.some((e) => e.includes("steps"))).toBe(true);
  });
});

describe("validateDispatchResult", () => {
  it("valid accepted result without verdict", () => {
    expect(validateDispatchResult({ status: "accepted", text: "all good" })).toEqual([]);
  });
  it("valid accepted result with verdict", () => {
    expect(
      validateDispatchResult({
        status: "accepted",
        text: "done",
        tier: "medium",
        verdict: {
          pass: true,
          outcome: "pass",
          method: "deterministic",
          reasons: [],
        },
      }),
    ).toEqual([]);
  });
  it("valid unmet result", () => {
    expect(
      validateDispatchResult({
        status: "unmet",
        text: "failed",
        verdict: {
          pass: false,
          outcome: "fail",
          method: "deterministic",
          reasons: ["tests failed"],
        },
      }),
    ).toEqual([]);
  });
  it("valid unverifiable result", () => {
    expect(
      validateDispatchResult({
        status: "unverifiable",
        text: "could not verify",
        verdict: {
          pass: false,
          outcome: "unverifiable",
          method: "none",
          reasons: ["no test command"],
        },
      }),
    ).toEqual([]);
  });
  it("valid error result", () => {
    expect(
      validateDispatchResult({ status: "error", text: "", error: "timed out" }),
    ).toEqual([]);
  });
  it("unknown status → error", () => {
    const errs = validateDispatchResult({ status: "bogus", text: "" });
    expect(errs.some((e) => e.includes("status"))).toBe(true);
  });
  it("missing text → error", () => {
    const errs = validateDispatchResult({ status: "accepted" });
    expect(errs.some((e) => e.includes("text"))).toBe(true);
  });
  it("non-object → error", () => {
    expect(validateDispatchResult(null)).not.toHaveLength(0);
    expect(validateDispatchResult("string")).not.toHaveLength(0);
  });
  it("verdict with wrong pass type → error", () => {
    const errs = validateDispatchResult({
      status: "accepted",
      text: "x",
      verdict: { pass: "yes", outcome: "pass", method: "deterministic", reasons: [] },
    });
    expect(errs.some((e) => e.includes("pass"))).toBe(true);
  });
  it("verdict with unknown outcome → error", () => {
    const errs = validateDispatchResult({
      status: "accepted",
      text: "x",
      verdict: { pass: true, outcome: "maybe", method: "deterministic", reasons: [] },
    });
    expect(errs.some((e) => e.includes("outcome"))).toBe(true);
  });
  it("verdict without reasons array → error", () => {
    const errs = validateDispatchResult({
      status: "accepted",
      text: "x",
      verdict: { pass: true, outcome: "pass", method: "deterministic", reasons: "none" },
    });
    expect(errs.some((e) => e.includes("reasons"))).toBe(true);
  });
});

// ===========================================================================
// 5. Fail-up rules — ladder.ts implementation
// ===========================================================================

describe("fail-up rules (ladder.ts)", () => {
  const policy: EscalatePolicy = {
    ladder: ["fast", "medium", "heavy"],
    floorTier: null,
    maxAttemptsPerTier: 1,
    maxTotalAttempts: 4,
    costMultiple: 4,
  };

  function makeState(tier = "fast") {
    return newLadderState(tier, policy);
  }

  // RULE 1: unverifiable → give_up
  it("Rule 1: unverifiable never escalates", () => {
    const state = recordAttempt(makeState("fast"), 1);
    const action = nextAction(state, { pass: false, outcome: "unverifiable" }, policy);
    expect(action.action).toBe("give_up");
    expect(action.reason).toContain("verification unavailable");
  });

  it("Rule 1: unverifiable even at fast tier (not escalated to medium)", () => {
    const state = recordAttempt(makeState("fast"), 1);
    const action = nextAction(state, { pass: false, outcome: "unverifiable" }, policy);
    expect(action.action).toBe("give_up");
    // Specifically NOT "escalate"
    expect(action.action).not.toBe("escalate");
  });

  // RULE 2: pass → accept
  it("Rule 2: pass always accepts", () => {
    const state = recordAttempt(makeState("fast"), 1);
    const action = nextAction(state, { pass: true, outcome: "pass" }, policy);
    expect(action.action).toBe("accept");
  });

  it("Rule 2: pass accepts even at heavy (last tier)", () => {
    const state = recordAttempt(makeState("heavy"), 100);
    const action = nextAction(state, { pass: true, outcome: "pass" }, policy);
    expect(action.action).toBe("accept");
  });

  // RULE 3: fail enters ladder
  it("Rule 3: fail with retries remaining → retry", () => {
    const p2: EscalatePolicy = { ...policy, maxAttemptsPerTier: 2 };
    const state = recordAttempt(newLadderState("fast", p2), 1);
    const action = nextAction(state, { pass: false, outcome: "fail", reasons: ["x"] }, p2);
    expect(action.action).toBe("retry");
    expect(action.tier).toBe("fast");
  });

  it("Rule 3: fail with no retries remaining → escalate to medium", () => {
    let state = newLadderState("fast", policy);
    state = recordAttempt(state, 1);
    state = { ...state, attemptsThisTier: 1 }; // maxAttemptsPerTier=1 so exhausted
    const action = nextAction(state, { pass: false, outcome: "fail" }, policy);
    expect(action.action).toBe("escalate");
    expect(action.tier).toBe("medium");
  });

  // RULE 4: cost ceiling
  it("Rule 4: cost ceiling terminates with give_up", () => {
    let state = newLadderState("fast", policy);
    state = recordAttempt(state, 100); // first attempt costs 100
    state = recordAttempt(state, 500); // cumulative = 600 > 100 * 4 = 400
    const action = nextAction(state, { pass: false, outcome: "fail" }, policy);
    expect(action.action).toBe("give_up");
    expect(action.reason).toContain("cost");
  });

  // RULE 5: max total attempts
  it("Rule 5: maxTotalAttempts hard ceiling", () => {
    const p: EscalatePolicy = { ...policy, maxTotalAttempts: 2 };
    let state = newLadderState("fast", p);
    state = recordAttempt(state, 1);
    state = recordAttempt(state, 1);
    // totalAttempts = 2 >= maxTotalAttempts = 2
    const action = nextAction(state, { pass: false, outcome: "fail" }, p);
    expect(action.action).toBe("give_up");
    expect(action.reason).toContain("max total attempts");
  });

  // RULE 7: no higher tier
  it("Rule 7: give_up at top of ladder", () => {
    let state = newLadderState("heavy", policy);
    state = recordAttempt(state, 1);
    state = { ...state, attemptsThisTier: 1 }; // maxAttemptsPerTier=1 exhausted
    const action = nextAction(state, { pass: false, outcome: "fail" }, policy);
    expect(action.action).toBe("give_up");
    expect(action.reason).toContain("no higher tier");
  });

  // Full ladder walk
  it("full ladder walk: fast fail → medium fail → heavy pass", () => {
    let state = newLadderState("fast", policy);
    const failVerdict: LadderVerdict = { pass: false, outcome: "fail", reasons: ["tests failed"] };
    const passVerdict: LadderVerdict = { pass: true, outcome: "pass" };

    // fast attempt
    state = recordAttempt(state, 1);
    state = { ...state, attemptsThisTier: 1 };
    let action = nextAction(state, failVerdict, policy);
    expect(action.action).toBe("escalate");
    expect(action.tier).toBe("medium");
    state = advance(state, action);
    expect(state.currentTier).toBe("medium");
    expect(state.escalations).toBe(1);

    // medium attempt
    state = recordAttempt(state, 2);
    state = { ...state, attemptsThisTier: 1 };
    action = nextAction(state, failVerdict, policy);
    expect(action.action).toBe("escalate");
    expect(action.tier).toBe("heavy");
    state = advance(state, action);
    expect(state.currentTier).toBe("heavy");
    expect(state.escalations).toBe(2);

    // heavy attempt — pass
    state = recordAttempt(state, 10);
    action = nextAction(state, passVerdict, policy);
    expect(action.action).toBe("accept");
  });

  // null verdict treated as fail
  it("null verdict → enters retry/escalate (treated as fail)", () => {
    let state = newLadderState("fast", policy);
    state = recordAttempt(state, 1);
    const action = nextAction(state, null, policy);
    // With maxAttemptsPerTier=1 and attemptsThisTier=0, should retry or escalate
    // (not accept, not give_up-unverifiable, not give_up-max)
    expect(["retry", "escalate"]).toContain(action.action);
  });
});
