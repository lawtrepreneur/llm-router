import type {
  RoutingCandidate,
  RoutingDecision,
  RoutingRequest,
} from "../contract/routing-decision";

export type RouteChooser = (
  request: RoutingRequest,
  candidates: readonly RoutingCandidate[],
) => { candidate?: RoutingCandidate; confidence: number; reason: string };

export type RouteBoundaryOptions = {
  confidenceThreshold?: number;
  now?: () => string;
  requestId?: string;
  taskId?: string;
  mode?: "live" | "shadow";
  producer?: Record<string, unknown>;
  onDecision?: (decision: RoutingDecision) => void;
  shadow?: {
    choose: RouteChooser;
    onDecision?: (decision: RoutingDecision) => void;
  };
};

export function canExecuteRoute(decision: RoutingDecision): boolean {
  return (
    !decision.fallback &&
    !!decision.choice &&
    Number.isFinite(decision.choice.confidence) &&
    decision.choice.confidence >= 0 &&
    decision.choice.confidence <= 1 &&
    decision.choice.confidence >= decision.receipt.confidence &&
    decision.receipt.mode === "live"
  );
}

/**
 * The native routing boundary. It only returns a decision; callers must not
 * execute a choice unless `fallback` is absent.
 */
export function decideRoute(
  request: RoutingRequest,
  candidates: readonly RoutingCandidate[],
  choose: RouteChooser,
  options: RouteBoundaryOptions = {},
): RoutingDecision {
  const threshold = options.confidenceThreshold ?? 0.7;
  const result = choose(request, candidates);
  const finiteConfidence = Number.isFinite(result.confidence);
  const validConfidence = finiteConfidence && result.confidence >= 0 && result.confidence <= 1;
  const confidence = validConfidence ? result.confidence : 0;
  const belongsToCandidates = result.candidate
    ? candidates.includes(result.candidate)
    : false;
  const accepted = validConfidence && belongsToCandidates && confidence >= threshold;
  const reason = accepted
    ? result.reason
      : !validConfidence
      ? "invalid route confidence"
      : !belongsToCandidates
        ? "selected route is not a supplied candidate"
        : `low-confidence route: ${result.reason}`;

  const decision: RoutingDecision = {
    request,
    candidates: [...candidates],
    choice: accepted
      ? { ...result.candidate!, confidence }
      : undefined,
    confidence,
    reason,
    fallback: accepted
      ? undefined
      : {
          action: "escalate",
          reason,
        },
    receipt: {
      requestId: options.requestId,
      taskId: options.taskId,
      router: "native",
      decidedAt: (options.now ?? (() => new Date().toISOString()))(),
      candidateCount: candidates.length,
      selectedTier: accepted ? result.candidate?.tier : undefined,
      selectedCandidate: accepted ? result.candidate : undefined,
      confidence,
      reason,
      fallback: accepted ? undefined : { action: "escalate", reason },
      mode: options.mode ?? "live",
      producer: options.producer,
    },
  };

  try {
    options.onDecision?.(decision);
  } catch {
    // Telemetry must not change the native execution decision.
  }

  // Shadow evaluation is deliberately observational. Its result is never
  // merged into, or used to gate, the native decision above.
  if (options.shadow) {
    try {
      const shadowDecision = decideRoute(request, candidates, options.shadow.choose, {
        confidenceThreshold: threshold,
        now: options.now,
        requestId: options.requestId,
        taskId: options.taskId,
        mode: "shadow",
        producer: options.producer,
      });
      try {
        options.shadow.onDecision?.(shadowDecision);
      } catch {
        // Shadow telemetry is best effort by design.
      }
    } catch {
      // Shadow telemetry must not change native execution.
    }
  }

  return decision;
}
