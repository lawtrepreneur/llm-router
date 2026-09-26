/**
 * test/unit/hermes-wiring.test.ts
 *
 * Issue #7 — Hermes dispatch wiring (pure eligibility) + cross-adapter
 * fixture equivalence. No real Hermes process is spawned.
 */
import { describe, it, expect } from "vitest";
import { shouldHermes, shouldIntercept, type RouterConfigLike } from "../../src/adapter/wiring";
import { E2E_FIXTURES } from "../fixtures/e2e-routing-fixtures";
import { decideRouteFromEvidence } from "../../src/router/boundary";

const baseCfg = (mode: "off" | "shadow" | "live"): RouterConfigLike => ({
  opencodeAdapter: { mode: "off" as const, tiers: [], allowedAgents: [], binary: "", args: [], timeoutMs: 1000, tierAgents: {} },
  hermesAdapter: {
    mode,
    tiers: ["fast", "medium", "heavy"],
    allowedAgents: ["developer-cloud"],
  },
});

describe("shouldHermes", () => {
  it("is off by default (no hermesAdapter)", () => {
    expect(shouldHermes({}, "medium", "developer-cloud")).toBe("off");
  });

  it("intercepts configured tier for allowed agent", () => {
    expect(shouldHermes(baseCfg("live"), "medium", "developer-cloud")).toBe("live");
  });

  it("rejects unconfigured tiers", () => {
    expect(shouldHermes(baseCfg("live"), "micro", "developer-cloud")).toBe("off");
  });

  it("rejects unallowed agents (fail-closed)", () => {
    expect(shouldHermes(baseCfg("live"), "medium", "random-agent")).toBe("off");
  });

  it("rejects grader sessions", () => {
    expect(shouldHermes(baseCfg("live"), "medium", "developer-cloud", { isGrader: true })).toBe("off");
  });

  it("shadow mode returns shadow", () => {
    expect(shouldHermes(baseCfg("shadow"), "fast", "developer-cloud")).toBe("shadow");
  });

  it("does not intercept when opencode adapter already owns dispatch (caller-side rule)", () => {
    // Caller skips hermes when shouldIntercept returns live; here we only
    // assert shouldHermes itself is orthogonal.
    const ocLive = { opencodeAdapter: { mode: "live" as const, tiers: ["medium"], allowedAgents: ["developer-cloud"], binary: "", args: [], timeoutMs: 1000, tierAgents: {} } };
    expect(shouldIntercept(ocLive as any, "medium", "developer-cloud")).toBe("live");
    expect(shouldHermes(ocLive, "medium", "developer-cloud")).toBe("off");
  });
});

describe("cross-adapter fixture equivalence", () => {
  it("Hermes runner consumes the same RoutingDecision OpenCode would", () => {
    for (const fx of E2E_FIXTURES) {
      const decision = decideRouteFromEvidence(
        fx.evidence,
        { candidates: [] } as any,
        { prompt: fx.id },
      );
      // Decision shape is adapter-agnostic: choice + receipt exist regardless
      // of transport. Hermes wiring reads only tier eligibility from it.
      const tier = decision.choice?.tier;
      expect(typeof tier === "string" || tier === undefined).toBe(true);
      if (decision.choice) {
        expect(shouldHermes(baseCfg("live"), tier!, "developer-cloud")).toBe("live");
      }
    }
  });
});
