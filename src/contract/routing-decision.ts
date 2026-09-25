/** The typed result shared by native routing and its execution boundary. */
export type RoutingRequest = {
  prompt: string;
  context?: Record<string, unknown>;
};

export type RoutingCandidate = {
  tier: string;
  score?: number;
  confidence?: number;
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
  /** Issue #11 versioned, secret-free evidence receipt. */
  schemaVersion?: number;
  schemaHash?: string;
  candidateRegistryVersion?: number;
  candidateRegistryHash?: string;
  classifierVersion?: string;
  calibrationVersion?: string;
  calibrationTemperature?: number;
  candidateProbabilities?: Record<string, number>;
  pMax?: number;
  calibratedConfidence?: number;
  selectedNextMargin?: number;
  unavailableCandidates?: string[];
  filteredCandidates?: string[];
  dimensions?: Record<string, { value?: string; confidence: number; probabilities?: number[] }>;
};

export interface EvidenceExplanation {
  /** What each evidence dimension answered. */
  evidenceSummary: Array<{ dimension: string; detail: string }>;
}

export interface PolicyExplanation {
  /** Non-classifier stages that raised the tier above the raw signal. */
  policyOverrides: ReadonlyArray<{ stage: string; reason: string; tier?: string }>;
}

export type RoutingDecision = {
  request: RoutingRequest;
  candidates: RoutingCandidate[];
  choice?: RoutingChoice;
  confidence: number;
  reason: string;
  fallback?: RoutingFallback;
  receipt: RoutingReceiptMetadata;
  explanation?: EvidenceExplanation & PolicyExplanation;
};
