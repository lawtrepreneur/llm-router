/**
 * test/unit/jev-policy.test.ts
 *
 * Portable Jev policy mechanics — ported from:
 *   davila7/claude-code-templates
 *   cli-tool/components/mods/productivity/jev-model-router/tests/policy.test.ts
 *   MIT License — https://github.com/davila7/claude-code-templates/blob/main/LICENSE
 *
 * Transport, UI helpers, and OC hook wiring are NOT tested here.
 */

import { describe, expect, it } from "vitest";
import {
  diagnosePendingDecision,
  effortLevel,
  effortRank,
  pendingDecisions,
  rankOf,
  readDecision,
  route,
} from "../../src/policy/jev";
import type { Decision, PolicyConfig } from "../../src/policy/jev";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: PolicyConfig = {
  tiers: { fast: "haiku", balanced: "sonnet", deep: "opus" },
  minUpgradeConfidence: 0.3,
  minDowngradeConfidence: 0.6,
};

function gatewayAnswer(
  tier: string,
  probabilities?: Record<string, number>,
  risky = 0.01,
  effort = 1.4,
): string {
  return JSON.stringify({
    answers: {
      tier: {
        type: "choice",
        choice: tier,
        ...(probabilities ? { probabilities } : {}),
      },
      effort: { type: "score", score: effort, probabilities: { "1": 0.9 } },
      risky: { type: "boolean", probability: risky },
    },
    usage: { inputTokens: 120, outputTokens: 0 },
  });
}

/** Current model state as turn.step would hand it over. */
const on = (model: string, effort?: string) => ({ model, ...(effort ? { effort } : {}) });

// ---------------------------------------------------------------------------
// Ported test cases (5)
// ---------------------------------------------------------------------------

describe("readDecision", () => {
  it("confidence is the highest probability in the distribution", () => {
    const decision = readDecision(
      gatewayAnswer("balanced", { fast: 0.1, balanced: 0.85, deep: 0.05 }),
    );
    expect(decision?.tier).toBe("balanced");
    expect(decision?.confidence).toBeCloseTo(0.85);
    expect(decision?.effort).toBeCloseTo(1.4);
  });

  it("distribution is optional — confidence may be absent", () => {
    const decision = readDecision(gatewayAnswer("deep"));
    expect(decision?.tier).toBe("deep");
    expect(decision?.confidence).toBeNull();
  });

  it("malformed or unexpected payloads read as null, never throw", () => {
    expect(readDecision("not json")).toBeNull();
    expect(readDecision("{}")).toBeNull();
    // Unknown tier
    expect(
      readDecision(
        JSON.stringify({ answers: { tier: { type: "choice", choice: "cheap" } } }),
      ),
    ).toBeNull();
  });
});

describe("route — asymmetric confidence thresholds", () => {
  it("spending less needs the high bar; the same confidence is enough to spend more", () => {
    // 0.51 sits between the two bars: too low to downgrade, sufficient to upgrade.
    const down = readDecision(
      gatewayAnswer("fast", { fast: 0.51, balanced: 0.4, deep: 0.09 }),
    );
    expect(route(down, on("claude-sonnet-5"), config).model).toBeNull();

    const up = readDecision(
      gatewayAnswer("deep", { deep: 0.51, balanced: 0.4, fast: 0.09 }),
    );
    expect(route(up, on("claude-sonnet-5"), config).model).toBe("opus");
  });

  it("both directions are available once the bar is cleared", () => {
    const down = readDecision(
      gatewayAnswer("fast", { fast: 0.95, balanced: 0.04, deep: 0.01 }),
    );
    expect(route(down, on("claude-opus-5"), config).model).toBe("haiku");

    const up = readDecision(
      gatewayAnswer("deep", { deep: 0.9, balanced: 0.08, fast: 0.02 }),
    );
    expect(route(up, on("claude-haiku-4-5-20251001"), config).model).toBe("opus");
  });
});

// ---------------------------------------------------------------------------
// Additional mechanics (non-ported)
// ---------------------------------------------------------------------------

describe("effortLevel / effortRank", () => {
  it("rounds score to nearest rung", () => {
    expect(effortLevel(0)).toBe("low");
    expect(effortLevel(1.4)).toBe("medium");
    expect(effortLevel(2.4)).toBe("high");
    expect(effortLevel(3)).toBe("xhigh");
    expect(effortLevel(99)).toBe("xhigh"); // clamp
  });

  it("effortRank returns null for unknown or numeric effort", () => {
    expect(effortRank("unknown")).toBeNull();
    expect(effortRank(42)).toBeNull();
    expect(effortRank("low")).toBe(0);
    expect(effortRank("xhigh")).toBe(3);
    expect(effortRank("max")).toBe(4);
  });
});

describe("rankOf", () => {
  it("matches configured tier names first", () => {
    expect(rankOf("claude-haiku-4-5-20251001", config.tiers)).toBe(0);
    expect(rankOf("claude-sonnet-5", config.tiers)).toBe(1);
    expect(rankOf("claude-opus-5", config.tiers)).toBe(2);
  });

  it("returns null for unrecognised model", () => {
    expect(rankOf("gpt-4o", config.tiers)).toBeNull();
  });
});

describe("pendingDecisions", () => {
  it("single queued decision is returned by take", () => {
    const slot = pendingDecisions();
    const d: Decision = {
      tier: "fast",
      confidence: 0.9,
      risky: 0,
      effort: 0.5,
      effortConfidence: 0.8,
    };
    slot.put(d);
    expect(slot.take()).toEqual(d);
    expect(slot.take()).toBeNull(); // consumed
  });

  it("more than one queued prompt returns null on take", () => {
    const slot = pendingDecisions();
    const d: Decision = {
      tier: "balanced",
      confidence: 0.7,
      risky: 0,
      effort: 1,
      effortConfidence: null,
    };
    slot.put(d);
    slot.put(d);
    expect(slot.take()).toBeNull();
  });
});

describe("diagnosePendingDecision", () => {
  it("not started when elapsedMs is null", () => {
    expect(diagnosePendingDecision(null, 5000)).toBe("classification not started");
  });

  it("in-flight when elapsed < budget", () => {
    const msg = diagnosePendingDecision(1200, 5000);
    expect(msg).toContain("in-flight");
    expect(msg).toContain("1200ms");
  });

  it("timed out when elapsed >= budget", () => {
    const msg = diagnosePendingDecision(5001, 5000);
    expect(msg).toContain("timed out");
    expect(msg).toContain("5001ms");
  });
});
