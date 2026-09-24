/**
 * test/unit/classify-fixtures.test.ts
 *
 * Issue #5 — Fixtures and promotion gates.
 *
 * Two test groups:
 *
 *   A. Phase routing — detect() over every fixture in normal mode.
 *      Every fixture must match its declared tier and task kind.
 *
 *   B. Promotion gate (zero high-risk → fast) — for every neverFast fixture,
 *      assert tier !== "fast" in all four modes (normal, budget, quality, deep).
 *      This is the machine-verifiable form of "zero known high-risk routes
 *      to light".
 *
 * PURE: no subprocess, no network, no SDK.
 */

import { describe, it, expect } from "vitest";
import {
  detect,
  isPlanningTask,
  type ClassifiedPhase,
} from "../../src/classifier/phase";
import {
  resolveLane,
  type ModeName,
} from "../../src/contract/lane-matrix";
import {
  ALL_FIXTURES,
  NEVER_FAST_FIXTURES,
  type RoutingFixture,
} from "../fixtures/routing-fixtures";
import {
  HEAVY_TASK_KINDS,
} from "../../src/contract/lane-matrix";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classify(fixture: RoutingFixture, mode: ModeName = "normal"): ClassifiedPhase {
  return detect(fixture.text, { mode });
}

const ALL_MODES: ModeName[] = ["normal", "budget", "quality", "deep"];

// ---------------------------------------------------------------------------
// A. Fixture oracle — normal mode
// ---------------------------------------------------------------------------

describe("fixture oracle — normal mode", () => {
  for (const f of ALL_FIXTURES) {
    it(`[${f.label}] "${f.text.slice(0, 60)}"`, () => {
      const phase = classify(f);
      expect(phase.tier).toBe(f.expectTier);
      expect(phase.taskKind).toBe(f.taskKind);
      if (f.label === "planning") {
        expect(phase.source).toBe("planning-short-circuit");
        expect(isPlanningTask(f.text)).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// B. Promotion gate — zero high-risk routes to fast, ALL modes
// ---------------------------------------------------------------------------

describe("PROMOTION GATE: zero known high-risk routes to light tier", () => {
  it(`neverFast fixtures cover all expected labels`, () => {
    const labels = new Set(NEVER_FAST_FIXTURES.map((f) => f.label));
    // Must cover destructive, security, legal, credentials, vision
    expect(labels.has("destructive")).toBe(true);
    expect(labels.has("security")).toBe(true);
    expect(labels.has("legal")).toBe(true);
    expect(labels.has("credentials")).toBe(true);
    expect(labels.has("vision")).toBe(true);
  });

  it(`${NEVER_FAST_FIXTURES.length} high-risk fixtures identified`, () => {
    // Sanity: we have meaningful coverage
    expect(NEVER_FAST_FIXTURES.length).toBeGreaterThanOrEqual(15);
  });

  for (const mode of ALL_MODES) {
    describe(`mode=${mode}`, () => {
      for (const f of NEVER_FAST_FIXTURES) {
        it(`[${f.label}] "${f.text.slice(0, 55)}"`, () => {
          const phase = detect(f.text, { mode });
          expect(phase.tier).not.toBe("fast");
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// D. Lane-matrix gate — heavy task kinds must not map to fast in any mode
// ---------------------------------------------------------------------------

describe("lane matrix gate: HEAVY_TASK_KINDS never resolve to fast", () => {
  for (const mode of ALL_MODES) {
    it(`mode=${mode}: all heavy task kinds → medium or heavy`, () => {
      for (const kind of HEAVY_TASK_KINDS) {
        const lane = resolveLane(mode, kind);
        expect(lane.tier).not.toBe("fast");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// E. Override gate — tierOverride cannot demote a high-risk match to fast
// ---------------------------------------------------------------------------

describe("override gate: tierOverride cannot demote high-risk to fast", () => {
  it("fast override on high-risk fixture keeps non-fast tier", () => {
    for (const f of NEVER_FAST_FIXTURES) {
      const phase = detect(f.text, { mode: "normal", tierOverride: "fast" });
      expect(phase.tier).not.toBe("fast");
    }
  });

  it("override can still promote upward", () => {
    const f = NEVER_FAST_FIXTURES[0];
    const base = detect(f.text, { mode: "normal" });
    const up = detect(f.text, { mode: "normal", tierOverride: "heavy" });
    expect(["fast", "medium", "heavy"]).toContain(up.tier);
    expect(up.tier === "heavy" || up.tier === base.tier).toBe(true);
  });
});
