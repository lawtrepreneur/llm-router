/**
 * src/adapter/wiring.ts — pure mode/eligibility logic for the OpenCode adapter.
 *
 * The impure spawn lives in opencode.ts; this module holds the decisions so
 * index.ts wiring stays thin and testable without processes.
 */
import type { OpenCodeAdapterConfig } from "../router/config";
import { isOcChild } from "./opencode";

/**
 * Effective adapter mode. Children of the adapter never re-enter it: the env
 * guard forces "off" regardless of config, which is what makes shadow/live
 * safe to leave on inside an intercepted tier.
 */
export function effectiveAdapterMode(cfg: RouterConfigLike): "off" | "shadow" | "live" {
  if (isOcChild()) return "off";
  const mode = cfg.opencodeAdapter?.mode;
  return mode === "shadow" || mode === "live" ? mode : "off";
}

export interface RouterConfigLike {
  opencodeAdapter?: OpenCodeAdapterConfig;
}

/**
 * Decide whether a task dispatch on `tier` should reach the adapter.
 *
 * All four conditions must hold:
 *  - adapter mode is shadow or live (off never intercepts)
 *  - the dispatched tier is in the configured tiers list
 *  - the dispatching agent is allowed (empty allowedAgents = nobody, fail-closed)
 *  - the dispatch is a real tier dispatch (header check lives in the caller)
 */
export function shouldIntercept(
  cfg: RouterConfigLike,
  tier: string,
  agent: string | undefined,
  options: { isGrader?: boolean } = {},
): "off" | "shadow" | "live" {
  const mode = effectiveAdapterMode(cfg);
  if (mode === "off") return "off";
  if (options.isGrader) return "off";
  const adapter = cfg.opencodeAdapter!;
  if (!adapter.tiers.includes(tier)) return "off";
  if (!agent || !adapter.allowedAgents.includes(agent)) return "off";
  return mode;
}
