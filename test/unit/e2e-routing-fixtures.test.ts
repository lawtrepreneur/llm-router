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

import { describe, expect, it } from "vitest";
import { composeToDecision } from "../../src/contract/routing-composer";
import {
  DEFERRED_FAMILIES,
  E2E_FIXTURES,
  REQUIRED_FAMILIES,
  type E2ERoutingFixture,
} from "../fixtures/e2e-routing-fixtures";

// Fixed timestamp so receipt metadata is stable across runs.
const FIXED_AT = "2026-09-25T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Per-fixture acceptance
// ---------------------------------------------------------------------------

describe.each(E2E_FIXTURES.map(f => ({ id: f.id, fixture: f })))("$id", ({ fixture }: { fixture: E2ERoutingFixture }) => {
  it("composer decision matches expected outcome", () => {
    const decision = composeToDecision(
      fixture.evidence,
      fixture.registry,
      fixture.request,
      FIXED_AT,
    );

    const actualTier = decision.choice?.tier ?? null;
    const actualAction = decision.fallback?.action ?? "none";

    expect(actualTier).toBe(fixture.expected.selectedTier);
    expect(actualAction).toBe(fixture.expected.fallbackAction);

    if (fixture.expected.fallbackReasonPattern !== undefined) {
      expect(decision.fallback?.reason ?? decision.reason).toMatch(
        fixture.expected.fallbackReasonPattern,
      );
    }

    if (fixture.expected.neverFast) {
      expect(decision.choice?.tier).not.toBe("fast");
    }
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
