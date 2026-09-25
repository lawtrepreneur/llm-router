/** Versioned, secret-free routing evidence and execution gate (Issue #11). */

import type { RoutingDecision, RoutingReceiptMetadata } from "./routing-decision";

export const RECEIPT_SCHEMA_VERSION = 1;
export const DEFAULT_MIN_MARGIN = 0.05;
export const DEFAULT_MIN_CALIBRATED_CONFIDENCE = 0.7;

export type CalibrationMetadata = {
  classifierVersion: string;
  calibrationVersion: string;
  temperature: number;
};

export type RoutingDimensionEvidence = {
  value?: string;
  confidence: number;
  probabilities: readonly number[];
};

export type RoutingReceipt = RoutingReceiptMetadata & {
  schemaVersion: number;
  schemaHash: string;
  candidateRegistryVersion: number;
  candidateRegistryHash: string;
  classifierVersion: string;
  calibrationVersion: string;
  calibrationTemperature: number;
  candidateProbabilities: Record<string, number>;
  pMax: number;
  calibratedConfidence: number;
  selectedNextMargin: number;
  unavailableCandidates: string[];
  filteredCandidates: string[];
  dimensions: Record<string, RoutingDimensionEvidence>;
};

const finite01 = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Stable non-secret hash suitable for receipt integrity, not cryptography. */
export function stableHash(value: unknown): string {
  const text = JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function validateRoutingReceipt(receipt: unknown): string[] {
  if (!receipt || typeof receipt !== "object") return ["receipt must be an object"];
  const r = receipt as Partial<RoutingReceipt>;
  const errors: string[] = [];
  if (r.schemaVersion !== RECEIPT_SCHEMA_VERSION) errors.push("invalid receipt schemaVersion");
  for (const key of ["schemaHash", "candidateRegistryHash", "classifierVersion", "calibrationVersion"] as const) {
    if (typeof r[key] !== "string" || r[key].length === 0) errors.push(`missing receipt ${key}`);
  }
  for (const key of ["candidateRegistryVersion", "calibrationTemperature", "pMax", "calibratedConfidence", "selectedNextMargin"] as const) {
    if (typeof r[key] !== "number" || !Number.isFinite(r[key])) errors.push(`non-finite receipt ${key}`);
  }
  if (typeof r.calibrationTemperature !== "number" || !Number.isFinite(r.calibrationTemperature) || r.calibrationTemperature <= 0) errors.push("invalid calibration temperature");
  if (!finite01(r.pMax) || !finite01(r.calibratedConfidence) || typeof r.selectedNextMargin !== "number" || r.selectedNextMargin < -1 || r.selectedNextMargin > 1) errors.push("receipt confidence or margin values are out of range");
  if (!r.candidateProbabilities || typeof r.candidateProbabilities !== "object") errors.push("missing candidate probabilities");
  else {
    const values = Object.values(r.candidateProbabilities);
    if (!values.length || values.some(value => !finite01(value))) errors.push("invalid candidate probability");
    else if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-9) errors.push("candidate probabilities must sum to 1");
    if (r.pMax !== Math.max(...values)) errors.push("pMax does not match candidate probabilities");
  }
  if (!Array.isArray(r.unavailableCandidates) || !Array.isArray(r.filteredCandidates)) errors.push("invalid candidate filters");
  if (!r.dimensions || typeof r.dimensions !== "object") errors.push("missing dimensions");
  else for (const [name, dimension] of Object.entries(r.dimensions)) {
    if (!finite01(dimension?.confidence)) errors.push(`invalid ${name} confidence`);
    if (!Array.isArray(dimension?.probabilities) || dimension.probabilities.length === 0 || dimension.probabilities.some(p => !finite01(p))) errors.push(`invalid ${name} probabilities`);
  }
  if (typeof r.schemaHash === "string" && r.dimensions && typeof r.dimensions === "object" && r.schemaHash !== stableHash({ schemaVersion: RECEIPT_SCHEMA_VERSION, dimensions: Object.keys(r.dimensions).sort() })) {
    errors.push("receipt schemaHash mismatch");
  }
  if (typeof r.candidateCount === "number" && r.candidateProbabilities && Object.keys(r.candidateProbabilities).length !== r.candidateCount) {
    errors.push("candidate probability count does not match receipt");
  }
  const selectedId = r.selectedCandidate?.metadata?.id;
  if (typeof selectedId === "string" && r.candidateProbabilities && !(selectedId in r.candidateProbabilities)) {
    errors.push("selected candidate missing from probability distribution");
  }
  if (typeof selectedId === "string" && r.candidateProbabilities && typeof r.selectedNextMargin === "number") {
    const selected = r.candidateProbabilities[selectedId];
    const next = Math.max(0, ...Object.entries(r.candidateProbabilities).filter(([id]) => id !== selectedId).map(([, probability]) => probability));
    if (Math.abs(r.selectedNextMargin - (selected - next)) > 1e-9) errors.push("selected candidate margin mismatch");
  }
  return errors;
}

/** Allowlist serialization: receipt output never carries prompts, secrets, or producer metadata. */
export function serializeRoutingReceipt(receipt: RoutingReceipt): string {
  const safe: RoutingReceipt = {
    schemaVersion: receipt.schemaVersion,
    schemaHash: receipt.schemaHash,
    candidateRegistryVersion: receipt.candidateRegistryVersion,
    candidateRegistryHash: receipt.candidateRegistryHash,
    classifierVersion: receipt.classifierVersion,
    calibrationVersion: receipt.calibrationVersion,
    calibrationTemperature: receipt.calibrationTemperature,
    candidateProbabilities: { ...receipt.candidateProbabilities },
    pMax: receipt.pMax,
    calibratedConfidence: receipt.calibratedConfidence,
    selectedNextMargin: receipt.selectedNextMargin,
    unavailableCandidates: [...receipt.unavailableCandidates],
    filteredCandidates: [...receipt.filteredCandidates],
    dimensions: { ...receipt.dimensions },
    requestId: receipt.requestId,
    taskId: receipt.taskId,
    router: receipt.router,
    decidedAt: receipt.decidedAt,
    completedAt: receipt.completedAt,
    candidateCount: receipt.candidateCount,
    selectedTier: receipt.selectedTier,
    confidence: receipt.confidence,
    reason: receipt.reason,
    mode: receipt.mode,
  };
  return JSON.stringify(safe);
}

export function canExecuteRoutingDecision(decision: RoutingDecision, options: { minMargin?: number; minCalibratedConfidence?: number } = {}): boolean {
  const receipt = decision.receipt as RoutingReceipt;
  return decision.choice !== undefined && validateRoutingReceipt(receipt).length === 0 &&
    receipt.calibratedConfidence >= (options.minCalibratedConfidence ?? DEFAULT_MIN_CALIBRATED_CONFIDENCE) &&
    receipt.selectedNextMargin >= (options.minMargin ?? DEFAULT_MIN_MARGIN);
}
