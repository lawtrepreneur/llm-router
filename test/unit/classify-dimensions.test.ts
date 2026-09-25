/**
 * test/unit/classify-dimensions.test.ts
 *
 * Skeleton test harness for the independent-dimension classifier (#12).
 *
 * STATUS: skeleton — tests are pending until #12 ships the dimension schema
 * and composer. The coverage-matrix assertions below document every fixture
 * family that must eventually be green; they fail loudly on import errors
 * or missing exports, giving early signal if the #12 contract drifts from
 * what the fixtures expect.
 *
 * What will be tested here (not yet implemented):
 *   - Each dimension (complexity, risk, specialty, availability, permission,
 *     phase) classifies independently — adding a question for one dimension
 *     does not change the result for any other dimension on the same input.
 *   - Deterministic composer: same fixture input + registry version → same
 *     RoutingDecision without calling a model.
 *   - Every fixture family from docs/plans/e2e-fixture-spec.md (FX-001–FX-017)
 *     produces the expected normalized tier and fallback action.
 *   - High-risk downgrade gate: neverFast fixtures NEVER resolve to "fast".
 *
 * Blocked on: #12 exports from src/classifier/dimensions.ts and
 *             src/router/composer.ts (not yet created).
 */

import { describe, it, expect } from "vitest";
import {
  ALL_FIXTURES,
  NEVER_FAST_FIXTURES,
  PLANNING_FIXTURES,
  EXECUTION_FIXTURES,
  DESTRUCTIVE_FIXTURES,
  SECURITY_FIXTURES,
  LEGAL_FIXTURES,
  CREDENTIALS_FIXTURES,
  VISION_FIXTURES,
} from "../fixtures/routing-fixtures";

// ---------------------------------------------------------------------------
// Coverage-matrix assertions — these pass now and guard fixture completeness.
// ---------------------------------------------------------------------------

describe("fixture corpus coverage", () => {
  it("has at least 15 fixtures total (e2e-fixture-spec minimum)", () => {
    expect(ALL_FIXTURES.length).toBeGreaterThanOrEqual(15);
  });

  it("has at least one fixture for every neverFast family", () => {
    const neverFastFamilies = new Set(NEVER_FAST_FIXTURES.map((f) => f.label));
    // These families must always be represented:
    const requiredFamilies = [
      "destructive",
      "security",
      "legal",
      "credentials",
      "vision",
    ] as const;
    for (const family of requiredFamilies) {
      expect(neverFastFamilies.has(family), `family "${family}" absent from neverFast corpus`).toBe(true);
    }
  });

  it("no neverFast fixture has expectTier fast", () => {
    for (const f of NEVER_FAST_FIXTURES) {
      expect(f.expectTier, `${f.text.slice(0, 60)} expectTier must not be fast`).not.toBe("fast");
    }
  });

  it("all planning fixtures expect fast tier", () => {
    for (const f of PLANNING_FIXTURES) {
      expect(f.expectTier, `planning fixture should expect fast: ${f.text.slice(0, 60)}`).toBe("fast");
    }
  });

  it("all execution fixtures expect medium or heavy tier", () => {
    for (const f of EXECUTION_FIXTURES) {
      expect(
        ["medium", "heavy"],
        `execution fixture must be medium or heavy: ${f.text.slice(0, 60)}`,
      ).toContain(f.expectTier);
    }
  });

  it("all destructive/security/legal/credentials/vision fixtures expect heavy", () => {
    const highRisk = [
      ...DESTRUCTIVE_FIXTURES,
      ...SECURITY_FIXTURES,
      ...LEGAL_FIXTURES,
      ...CREDENTIALS_FIXTURES,
      ...VISION_FIXTURES,
    ];
    for (const f of highRisk) {
      expect(f.expectTier, `${f.label} fixture must expect heavy: ${f.text.slice(0, 60)}`).toBe("heavy");
    }
  });
});

// ---------------------------------------------------------------------------
// Dimension independence — pending #12
// ---------------------------------------------------------------------------

describe.skip("dimension independence (pending #12)", () => {
  // Will import from src/classifier/dimensions.ts once #12 ships.
  // Verify: scoring complexity alone does not change risk result for the
  // same input state. One test per dimension pair.
  it.todo("complexity result is independent of risk question order");
  it.todo("risk result is independent of specialty question order");
  it.todo("specialty result is independent of availability question order");
  it.todo("availability result is independent of permission question order");
  it.todo("phase result is independent of complexity question order");
});

// ---------------------------------------------------------------------------
// Deterministic composer — pending #12
// ---------------------------------------------------------------------------

describe.skip("deterministic composer (pending #12)", () => {
  // Will import from src/router/composer.ts once #12 ships.
  it.todo("same fixture + registry version → identical RoutingDecision without model call");
  it.todo("FX-001 planning short-circuit → tier=fast, fallback=none");
  it.todo("FX-008 low-confidence → tier=medium, fallback=escalate/low-confidence");
  it.todo("FX-013 permission-denied → tier=STOP, fallback=stop/permission-denied");
  it.todo("FX-017 high-risk downgrade attempt → tier=heavy, fallback=stop/downgrade-blocked");
  it.todo("FX-014 classifier timeout → tier=heavy, fallback=escalate/classifier-timeout");
  it.todo("all NEVER_FAST_FIXTURES resolve to medium or heavy");
});

// ---------------------------------------------------------------------------
// Equivalence gate placeholder — pending #7 + #12
// ---------------------------------------------------------------------------

describe.skip("OpenCode ≡ Hermes equivalence gate (pending #7 + #12)", () => {
  // Same fixture run through OC adapter and Hermes adapter must produce:
  //   phase, riskBand, confidenceBand, selectedTier, fallbackAction,
  //   fallbackReasonClass all equal.
  // Adapter-specific envelope fields are excluded from comparison.
  it.todo("FX-001 produces equivalent normalized decision in OC and Hermes");
  it.todo("FX-013 produces equivalent STOP in OC and Hermes");
  it.todo("FX-017 produces equivalent downgrade-blocked in OC and Hermes");
});
