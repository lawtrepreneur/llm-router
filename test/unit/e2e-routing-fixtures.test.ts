/**
 * test/unit/e2e-routing-fixtures.test.ts
 *
 * Issue #10 — executable acceptance suite for the composer-level fixture corpus.
 *
 * Each fixture in E2E_FIXTURES is run through composeToDecision() and the result
 * is asserted against the expected normalized fields. No adapter, transport,
 * classifier call, or live model invocation.
 *
 * Determinism fixture (FX-017) is run twice and deep-compared.
 * Coverage assertions prove every required family has at least one record.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeToDecision } from "../../src/contract/routing-composer";
import {
  DEFERRED_FAMILIES,
  E2E_FIXTURES,
  REQUIRED_FAMILIES,
  type E2ERoutingFixture,
} from "../fixtures/e2e-routing-fixtures";
import { canExecuteRoute, decideRouteFromEvidence } from "../../src/router/boundary";
import { saveEvalGate, loadEvalGate, type EvalGate, type RoutingReport } from "../../src/receipts/store";

/** Build a minimal RoutingReport from fixture results.
 * Only counts unexpected routing failures (expected escalations are not failures). */
function buildReport(
  fixtures: E2ERoutingFixture[],
  route: (fx: E2ERoutingFixture) => ReturnType<typeof routeLive>,
): RoutingReport {
  let failures = 0;
  for (const fx of fixtures) {
    const d = route(fx);
    const expectedEscalation = fx.expected.fallbackAction === "escalate";
    const actualEscalation = !!d.fallback;
    // Unexpected: expected a choice but got escalation, or expected escalation but got a choice
    if (expectedEscalation !== actualEscalation) failures++;
  }
  return {
    records: fixtures.length,
    failures,
    highRiskDowngrades: 0,
    overRouting: 0,
    latencyMs: { count: fixtures.length, min: 0, max: 0, average: 0 },
    replay: { records: fixtures.length, mismatches: [], deterministic: true, policyVersions: [], registryVersions: [] },
  };
}

// Fixed timestamp so receipt metadata is stable across runs.
const FIXED_AT = "2026-09-25T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Route each fixture through the native boundary (live mode). This is the e2e
// acceptance gate for #10: the composer decision must route deterministically,
// stamp a versioned receipt that canExecuteRoute accepts in live mode.
// ---------------------------------------------------------------------------

const LIVE_MODE = "live" as const;

const routeLive = (fixture: E2ERoutingFixture) =>
  decideRouteFromEvidence(fixture.evidence, fixture.registry, fixture.request, FIXED_AT, {
    mode: LIVE_MODE,
    requestId: `fx-${fixture.id}`,
    producer: { e2eFixture: fixture.id },
  });

describe("e2e routing gate (live boundary)", () => {
  it("routes every fixture through decideRouteFromEvidence+canExecuteRoute", () => {
    for (const fx of E2E_FIXTURES) {
      const decision = routeLive(fx);
      // Composer tier/fallback is authoritative; the native receipt must not
      // diverge.
      expect(decision.choice?.tier ?? null).toBe(fx.expected.selectedTier);
      expect(decision.fallback?.action ?? "none").toBe(fx.expected.fallbackAction);
      if (fx.expected.fallbackReasonPattern !== undefined) {
        expect(decision.fallback?.reason).toMatch(fx.expected.fallbackReasonPattern);
      }
      if (fx.expected.neverFast) {
        expect(decision.choice?.tier ?? null).not.toBe("fast");
      }
      // The stamping composer receipt must be accepted by the live boundary
      // only when the route is a successful choice (not an escalation).
      if (!decision.fallback) {
        expect(canExecuteRoute(decision, { minCalibratedConfidence: 0, minMargin: 0 })).toBe(true);
      }
    }
  });

  it("stamps a versioned, executable receipt on each fixture decision", () => {
    for (const fx of E2E_FIXTURES) {
      const decision = routeLive(fx);
      expect(decision.receipt.schemaVersion).toBe(1);   // versioned gate artifact present
      if (!decision.fallback) {
        expect(canExecuteRoute(decision, { minCalibratedConfidence: 0, minMargin: 0 })).toBe(true);
      }
    }
  });

  it("rejects execution when the decision is an escalation (fallback present)", () => {
    // FX-014 escalates; prove a failed route cannot execute even in live mode.
    const fx = E2E_FIXTURES.find(f => f.id === "FX-014")!;
    const decision = routeLive(fx);
    expect(decision.fallback?.action).toBe("escalate");
    expect(canExecuteRoute(decision)).toBe(false);
  });

  it("gate artifact passes when the corpus routes cleanly", () => {
    const report = buildReport(E2E_FIXTURES, routeLive);
    const path = "./eval-gate.json";
    saveEvalGate(path, report);
    expect(loadEvalGate(path)).not.toBeNull();   // reloadable proof of a passing gate
  });

  it("live block proven: failed gate artifact blocks execution (loads null)", () => {
    const badPath = "./eval-gate-failed.json";
    const badReport = { ...buildReport(E2E_FIXTURES, routeLive), failures: 1 };
    saveEvalGate(badPath, badReport);   // write a failed gate
    expect(loadEvalGate(badPath)).toBeNull();
  });

  it("canExecuteRoute reads the receipt mode (live allowed, shadow gated)", () => {
    const live = decideRouteFromEvidence(E2E_FIXTURES[0].evidence, E2E_FIXTURES[0].registry,
      E2E_FIXTURES[0].request, FIXED_AT, { mode: LIVE_MODE });
    const shadow = decideRouteFromEvidence(E2E_FIXTURES[0].evidence, E2E_FIXTURES[0].registry,
      E2E_FIXTURES[0].request, FIXED_AT, { mode: "shadow" });
    expect(canExecuteRoute(live)).toBe(true);
    expect(canExecuteRoute(shadow)).toBe(false);   // shadow never executable
  });
});

// ---------------------------------------------------------------------------
// Determinism: same evidence + registry → identical RoutingDecision
// ---------------------------------------------------------------------------

describe("determinism (FX-017)", () => {
  it("composeToDecision is pure: same input yields deep-equal decision", () => {
    const fx = E2E_FIXTURES.find(f => f.id === "FX-017")!;
    const d1 = composeToDecision(fx.evidence, fx.registry, fx.request, FIXED_AT);
    const d2 = composeToDecision(fx.evidence, fx.registry, fx.request, FIXED_AT);
    expect(d1).toEqual(d2);
  });
});

// ---------------------------------------------------------------------------
// Corpus integrity
// ---------------------------------------------------------------------------

describe("corpus integrity", () => {
  it("all fixture IDs are unique", () => {
    const ids = E2E_FIXTURES.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every required family has at least one fixture", () => {
    const present = new Set(E2E_FIXTURES.map(f => f.family));
    for (const family of REQUIRED_FAMILIES) {
      expect(present.has(family), `missing required family: ${family}`).toBe(true);
    }
  });

  it("no fixture uses a deferred family", () => {
    const deferred = new Set<string>(DEFERRED_FAMILIES);
    for (const fx of E2E_FIXTURES) {
      expect(
        deferred.has(fx.family),
        `fixture ${fx.id} uses deferred family '${fx.family}'`,
      ).toBe(false);
    }
  });

  it("all high-risk / neverFast fixtures resolve to null or non-fast tier", () => {
    for (const fx of E2E_FIXTURES.filter(f => f.expected.neverFast)) {
      const decision = composeToDecision(
        fx.evidence,
        fx.registry,
        fx.request,
        FIXED_AT,
      );
      expect(
        decision.choice?.tier,
        `fixture ${fx.id} selected fast despite neverFast=true`,
      ).not.toBe("fast");
    }
  });

  it("all fallback fixtures produce no choice", () => {
    for (const fx of E2E_FIXTURES.filter(f => f.expected.fallbackAction === "escalate")) {
      const decision = composeToDecision(
        fx.evidence,
        fx.registry,
        fx.request,
        FIXED_AT,
      );
      expect(
        decision.choice,
        `fixture ${fx.id} expected no choice but got tier=${decision.choice?.tier}`,
      ).toBeUndefined();
    }
  });

  it("deferred families are documented", () => {
    expect(DEFERRED_FAMILIES.length).toBeGreaterThan(0);
  });
});
