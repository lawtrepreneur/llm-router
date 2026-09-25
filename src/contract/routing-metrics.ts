/**
 * src/contract/routing-metrics.ts
 *
 * Deterministic, labeled-fixture routing calibration metrics: Brier score,
 * Expected Calibration Error (ECE), and Area Under the Receiver-Operating
 * Characteristic curve (AURC). They describe classifier/calibration quality
 * over a fixed set of (probability, outcome) labels — never inferred from a raw
 * pMax. Pure TS: no I/O, no crypto, deterministic for equal input.
 */

/** One labeled observation aligned by index: probability[i] pairs with label[i]. */
export interface LabeledObservation {
  /** Model predicted probability in [0,1]. */
  probability: number;
  /** Binary ground-truth outcome: 1 = realized, 0 = not realized. */
  label: number;
}

/** Binned ECE result (one entry per populated bin plus a summary error). */
export interface EceResult {
  /** Mean |confidence − accuracy| weighted by each sample's fraction of the set. */
  error: number;
  /** One tuple per populated bin: [binCenter, samples, meanConfidence, meanAccuracy]. */
  bins: ReadonlyArray<[number, number, number, number]>;
}

/** AURC in [0,1]; null when labels are degenerate (no positives or no negatives). */
export type AurcResult = number | null;

/** The three labeled calibration metrics. */
export interface CalibrationMetrics {
  brier: number;
  ece: EceResult;
  aurc: AurcResult;
}

/** A labeled calibration fixture produced by a classifier against test data. */
export interface LabeledFixture {
  observations: readonly LabeledObservation[];
}

// ---------------------------------------------------------------------------
// Brier — mean squared error between predicted probability and binary outcome
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function brierScore(observations: readonly LabeledObservation[]): number {
  let sum = 0;
  for (const o of observations) {
    const diff = clamp01(o.probability) - o.label;
    sum += diff * diff;
  }
  return observations.length > 0 ? sum / observations.length : NaN;
}

// ---------------------------------------------------------------------------
// ECE — mean per-sample |confidence − accuracy| within its probability bin
// ---------------------------------------------------------------------------

export function expectedCalibrationError(
  observations: readonly LabeledObservation[],
  binCount = 10,
): EceResult {
  const width = 1 / binCount;
  let error = 0;
  let weightedSum = 0;
  const counts: number[] = new Array(binCount).fill(0);

  for (const o of observations) {
    let bin = Math.floor(clamp01(o.probability) / width);
    if (bin < 0) bin = 0;
    if (bin >= binCount) bin = binCount - 1;
    counts[bin]++;
    weightedSum += Math.abs(clamp01(o.probability) - o.label);
  }

  const bins: [number, number, number, number][] = [];
  for (let b = 0; b < binCount; b++) {
    if (counts[b] === 0) continue;
    let binConf = 0;
    let binLabels = 0;
    for (const o of observations) {
      const bb = Math.floor(clamp01(o.probability) / width);
      if (bb !== b) continue;
      binConf += clamp01(o.probability);
      if (o.label === 1) binLabels++;
    }
    bins.push([((b + 0.5) * width), counts[b], binConf / counts[b], binLabels / counts[b]]);
    error += (counts[b] / observations.length) * Math.abs(binConf / counts[b] - binLabels / counts[b]);
  }

  return { error, bins };
}

// ---------------------------------------------------------------------------
// AURC — area under the ROC curve from ranked predictions (Mann-Whitney integral)
// ---------------------------------------------------------------------------

/**
 * Rank predictions and integrate TPR over FPR (trapezoidal). Returns null when
 * there is no discrimination possible (all labels identical). Perfect ranking
 * of a positive → 1.0; worst ranking → 0.0.
 */
export function aurcArea(
  predictions: readonly number[],
  labels: readonly number[],
): AurcResult {
  const nPos = labels.filter(l => l === 1).length;
  const nNeg = labels.length - nPos;
  if (nPos === 0 || nNeg === 0) return null;

  // Pair prediction with label, sort by descending confidence.
  const paired: Array<[number, number]> = [];
  for (let i = 0; i < labels.length; i++) paired.push([clamp01(predictions[i] ?? 0), labels[i]]);
  paired.sort((a, b) => b[0] - a[0]);

  // Trapezoidal area under ROC: integral of TPR over FPR across ranked predictions.
  let truePositives = 0;
  let falsePositives = 0;
  let tprPrev = 0;
  let fprPrev = 0;
  let area = 0;
  for (const [, label] of paired) {
    if (label === 1) truePositives++;
    else falsePositives++;
    const tpr = truePositives / nPos;
    const fpr = falsePositives / nNeg;
    area += 0.5 * (fpr - fprPrev) * (tpr + tprPrev);
    tprPrev = tpr;
    fprPrev = fpr;
  }
  return area;
}

/** All three metrics over a labeled fixture. */
export function calibrationMetrics(fixture: LabeledFixture, binCount = 10): CalibrationMetrics {
  return { brier: brierScore(fixture.observations), ece: expectedCalibrationError(fixture.observations, binCount), aurc: aurcArea(fixture.observations.map(o => o.probability), fixture.observations.map(o => o.label)) };
}
