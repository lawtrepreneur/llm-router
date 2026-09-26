/**
 * src/contract/shadow-metrics.ts
 *
 * Issue #17 / #21: shadow-classifier agreement and calibration metrics over
 * routing receipts. Pure TS: no I/O, deterministic for equal input. Consumes
 * the additive `shadowClassifier` observation persisted by Phase 4.
 */
import type { RoutingRecord } from "../receipts/store.js";
import { brierScore, expectedCalibrationError, aurcArea, type CalibrationMetrics } from "./routing-metrics.js";

/** Fixed classifier probability order (ShadowObservation contract). */
export const SHADOW_TIER_ORDER = ["fast", "medium", "heavy"] as const;
export type ShadowTier = (typeof SHADOW_TIER_ORDER)[number];

/** One native-tier × classifier-argmax agreement cell. */
export interface ShadowAgreementMatrix {
  /** matrix[nativeTier][classifierTier] = count. */
  matrix: Record<ShadowTier, Record<ShadowTier, number>>;
  /** Records with a usable observation (probabilities present). */
  observations: number;
  /** Usable observations where classifier argmax ≠ native tier. */
  disagreements: number;
  /** Consulted-but-failed observations. */
  unavailable: number;
  /** Total records carrying a shadowClassifier field. */
  total: number;
}

/** Classifier argmax tier for a probability vector aligned to SHADOW_TIER_ORDER. */
export function shadowArgmax(probabilities: readonly number[]): ShadowTier | null {
  if (probabilities.length !== SHADOW_TIER_ORDER.length) return null;
  let best = -1;
  let bestIdx = -1;
  for (let i = 0; i < probabilities.length; i++) {
    const p = probabilities[i];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0) return null;
    if (p > best) { best = p; bestIdx = i; }
  }
  return bestIdx >= 0 ? SHADOW_TIER_ORDER[bestIdx] : null;
}

/** Agreement/disagreement counts over receipts that carry shadow observations. */
export function shadowAgreement(records: readonly RoutingRecord[]): ShadowAgreementMatrix {
  const empty = (): Record<ShadowTier, number> => ({ fast: 0, medium: 0, heavy: 0 });
  const out: ShadowAgreementMatrix = {
    matrix: { fast: empty(), medium: empty(), heavy: empty() },
    observations: 0, disagreements: 0, unavailable: 0, total: 0,
  };
  for (const r of records) {
    const sc = r.shadowClassifier;
    if (!sc) continue;
    out.total++;
    if (sc.unavailable) { out.unavailable++; continue; }
    const argmax = sc.probabilities ? shadowArgmax(sc.probabilities) : null;
    if (!argmax) { out.unavailable++; continue; }
    out.observations++;
    const native = (SHADOW_TIER_ORDER as readonly string[]).includes(r.actualTarget)
      ? (r.actualTarget as ShadowTier) : null;
    if (native) out.matrix[native][argmax]++;
    if (sc.disagreement) out.disagreements++;
  }
  return out;
}

/** Native tier realized = 1 when classifier assigned the native tier (per observation, one-hot label). */
function calibrationObservations(records: readonly RoutingRecord[]): { probability: number; label: number }[] {
  const obs: { probability: number; label: number }[] = [];
  for (const r of records) {
    const sc = r.shadowClassifier;
    if (!sc || sc.unavailable || !sc.probabilities) continue;
    const argmax = shadowArgmax(sc.probabilities);
    if (!argmax) continue;
    const native = (SHADOW_TIER_ORDER as readonly string[]).includes(r.actualTarget)
      ? (r.actualTarget as ShadowTier) : null;
    if (!native) continue;
    // One-hot: classifier probability for the native tier vs realized outcome.
    obs.push({ probability: sc.probabilities[SHADOW_TIER_ORDER.indexOf(native)], label: argmax === native ? 1 : 0 });
  }
  return obs;
}

/** Brier/ECE/AURC over shadow observations; null when no usable observations. */
export function shadowCalibration(records: readonly RoutingRecord[]): CalibrationMetrics | null {
  const obs = calibrationObservations(records);
  if (obs.length === 0) return null;
  const labels = obs.map(o => o.label);
  const aurc = aurcArea(obs.map(o => o.probability), labels);
  if (aurc === null) return null;
  return {
    brier: brierScore(obs),
    ece: expectedCalibrationError(obs),
    aurc,
  };
}

/** Latency percentiles over usable shadow observations (ms). */
export function shadowLatency(records: readonly RoutingRecord[]): { count: number; p50: number; p95: number } {
  const lats = records
    .map(r => r.shadowClassifier)
    .filter((sc): sc is NonNullable<typeof sc> => !!sc && !sc.unavailable && typeof sc.latencyMs === "number")
    .map(sc => sc.latencyMs)
    .sort((a, b) => a - b);
  if (lats.length === 0) return { count: 0, p50: 0, p95: 0 };
  const at = (q: number) => lats[Math.min(lats.length - 1, Math.floor(q * lats.length))];
  return { count: lats.length, p50: at(0.5), p95: at(0.95) };
}