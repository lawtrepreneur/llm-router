/** The typed result shared by native routing and its execution boundary. */
export type RoutingRequest = {
  prompt: string;
  context?: Record<string, unknown>;
};

export type RoutingCandidate = {
  tier: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type RoutingChoice = RoutingCandidate & {
  confidence: number;
};

export type RoutingFallback = {
  tier?: string;
  action: "escalate" | "fallback";
  reason: string;
};

export type RoutingReceiptMetadata = {
  requestId?: string;
  taskId?: string;
  router: string;
  decidedAt: string;
  completedAt?: string;
  candidateCount: number;
  selectedTier?: string;
  selectedCandidate?: RoutingCandidate;
  confidence: number;
  reason: string;
  fallback?: RoutingFallback;
  mode: "live" | "shadow";
  producer?: Record<string, unknown>;
};

export type RoutingDecision = {
  request: RoutingRequest;
  candidates: RoutingCandidate[];
  choice?: RoutingChoice;
  confidence: number;
  reason: string;
  fallback?: RoutingFallback;
  receipt: RoutingReceiptMetadata;
};
