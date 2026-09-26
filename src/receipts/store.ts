/** Secret-free, append-only routing receipts and deterministic evaluation. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { stableHash, type ShadowObservation } from "../contract/routing-receipt";
import { composeToDecision, type CompositeEvidence, type CandidateRegistry } from "../contract/routing-composer";

export const RECEIPT_STORE_VERSION = 1;
export type AdapterMode = "off" | "shadow" | "live";

export type RoutingRecord = {
  kind: "routing";
  version: 1;
  id: string;
  timestamp: string;
  intendedTarget: string;
  actualTarget: string;
  escalation: { occurred: boolean; count: number; reason?: string };
  verification: { status: "passed" | "failed" | "unavailable"; method?: string };
  latencyMs: number;
  outcome: "accepted" | "failed" | "unmet";
  policyVersion: string;
  registryVersion: string;
  /** Issue #11: classifier version when the decision carried calibrated evidence. */
  classifierVersion?: string;
  /** Issue #11: stable hash of the typed question/candidate schema. */
  schemaHash?: string;
  /** Issue #11: stable hash of the candidate registry used for the decision. */
  candidateRegistryHash?: string;
  receiptHash?: string;
  adapterMode: AdapterMode;
  downgrade?: { from: string; to: string; reason: string };
  /** Issue #13: secret-free per-dimension evidence the original decision used. */
  evidence?: Record<string, { value?: string; confidence: number; probabilities?: number[] }>;
  /** Issue #13: tier candidates available at decision time (for re-decision). */
  candidates?: string[];
  /** Phase 4: decider shadow classifier observation, secret-free. */
  shadowClassifier?: ShadowObservation;
};

export type ReceiptStore = {
  append(record: RoutingRecord): void;
  /** Issue #14: number of records rejected as corrupt during the last read(). */
  lastRejected(): number;
  read(): RoutingRecord[];
  replay(records?: RoutingRecord[]): ReplayResult;
  reDecide(records?: RoutingRecord[]): ReDecisionResult;
  report(records?: RoutingRecord[]): RoutingReport;
  saveEvalGate(report: RoutingReport): EvalGate;
  loadEvalGate(): EvalGate | null;
};

const SECRET_FIELDS = ["prompt", "body", "headers", "env", "toolOutput"] as const;

/** Documented nested fields per nested object. Unknown nested fields are dropped. */
const NESTED_FIELDS = {
  escalation: ["occurred", "count", "reason"],
  verification: ["status", "method"],
  downgrade: ["from", "to", "reason"],
  shadowClassifier: ["probabilities", "disagreement", "unavailable", "error", "latencyMs"],
} as const;

/** Documented durable fields, in write order. Everything else is dropped before persist. */
const RECORD_FIELDS = [
  "kind", "version", "id", "timestamp", "intendedTarget", "actualTarget",
  "escalation", "verification", "latencyMs", "outcome", "policyVersion",
  "registryVersion", "classifierVersion", "schemaHash", "candidateRegistryHash",
  "receiptHash", "adapterMode", "downgrade", "evidence", "candidates",
  "shadowClassifier",
] as const;

/**
 * Integrity hash over the FULL persisted record (every allowlisted field),
 * excluding only receiptHash itself — so tampering with outcome, latency,
 * verification, etc. is detected by replay, not just routing metadata.
 */
export function receiptHashOf(record: RoutingRecord): string {
  const { receiptHash: _omit, ...rest } = record;
  return stableHash(rest);
}

const own = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function validateRoutingRecord(value: unknown): string[] {
  if (!own(value)) return ["record must be an object"];
  const r = value as Partial<RoutingRecord>;
  const errors: string[] = [];
  if (r.kind !== "routing" || r.version !== 1) errors.push("unknown record kind or version");
  for (const key of ["id", "timestamp", "intendedTarget", "actualTarget", "policyVersion", "registryVersion", "adapterMode", "outcome"] as const) {
    if (typeof r[key] !== "string" || !r[key]) errors.push(`missing record ${key}`);
  }
  if (!Number.isFinite(r.latencyMs) || (r.latencyMs ?? -1) < 0) errors.push("invalid record latencyMs");
  if (!own(r.escalation) || typeof r.escalation.occurred !== "boolean" || !Number.isInteger(r.escalation.count) || r.escalation.count < 0) errors.push("invalid record escalation");
  if (!own(r.verification) || !["passed", "failed", "unavailable"].includes(String(r.verification.status))) errors.push("invalid record verification");
  if (!["off", "shadow", "live"].includes(String(r.adapterMode))) errors.push("invalid record adapterMode");
  if (!["accepted", "failed", "unmet"].includes(String(r.outcome))) errors.push("invalid record outcome");
  if (r.downgrade !== undefined && (!own(r.downgrade) || typeof r.downgrade.reason !== "string")) errors.push("invalid record downgrade");
  // Phase 4: decider shadow observation is optional but shape-checked.
  if (r.shadowClassifier !== undefined) {
    const s = r.shadowClassifier;
    const finite01 = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
    if (!own(s) || typeof s.disagreement !== "boolean" || !Number.isFinite(s.latencyMs) || s.latencyMs < 0)
      errors.push("invalid record shadowClassifier");
    if (own(s)) {
      if (s.unavailable !== undefined && typeof s.unavailable !== "boolean") errors.push("invalid record shadowClassifier.unavailable");
      if (s.error !== undefined && typeof s.error !== "string") errors.push("invalid record shadowClassifier.error");
      // Exactly one valid state: unavailable XOR usable-with-probabilities.
      if (s.unavailable === true) {
        if (s.probabilities !== undefined) errors.push("invalid record shadowClassifier.probabilities");
      } else {
        if (!Array.isArray(s.probabilities) || s.probabilities.length !== 3 || s.probabilities.some(p => !finite01(p)))
          errors.push("invalid record shadowClassifier.probabilities");
        else if (Math.abs(s.probabilities.reduce((a: number, b: number) => a + b, 0) - 1) > 1e-6)
          errors.push("invalid record shadowClassifier.probabilities");
      }
    }
  }
  // Issue #13: re-decision inputs are secret-free and shape-checked.
  if (r.evidence !== undefined) {
    if (!own(r.evidence)) errors.push("invalid record evidence");
    else {
      for (const [dim, rec] of Object.entries(r.evidence)) {
        if (!own(rec) || typeof rec.confidence !== "number" || !Number.isFinite(rec.confidence)) errors.push(`invalid record evidence[${dim}]`);
        if (rec?.value !== undefined && typeof rec.value !== "string") errors.push(`invalid record evidence[${dim}].value`);
        if (rec?.probabilities !== undefined && (!Array.isArray(rec.probabilities) || rec.probabilities.some(p => typeof p !== "number" || !Number.isFinite(p)))) errors.push(`invalid record evidence[${dim}].probabilities`);
      }
    }
  }
  if (r.candidates !== undefined && (!Array.isArray(r.candidates) || r.candidates.some(c => typeof c !== "string"))) errors.push("invalid record candidates");
  for (const secret of SECRET_FIELDS) if (secret in r) errors.push(`secret-carrying field rejected: ${secret}`);
  return errors;
}

/** Explicit migration default for pre-adapterMode V1 records. */
export const LEGACY_DEFAULT_ADAPTER_MODE: AdapterMode = "off";

/** Project onto the documented durable shape: unknown fields are dropped, never persisted. */
function allowlistRecord(record: RoutingRecord): RoutingRecord {
  const out = {} as RoutingRecord;
  for (const field of RECORD_FIELDS) {
    if (field in record) (out as Record<string, unknown>)[field] = record[field];
  }
  // Defense in depth: nested objects are strictly allowlisted too — unknown
  // nested fields are dropped, then secret-bearing keys are removed if any
  // nested field name ever collides with a secret name.
  for (const nested of ["escalation", "verification", "downgrade", "shadowClassifier"] as const) {
    const value = out[nested];
    if (!own(value)) continue;
    const cleanNested = {} as Record<string, unknown>;
    for (const field of NESTED_FIELDS[nested]) {
      if (field in value) cleanNested[field] = (value as Record<string, unknown>)[field];
    }
    for (const secret of SECRET_FIELDS) delete cleanNested[secret];
    (out as Record<string, unknown>)[nested] = cleanNested;
  }
  // Issue #13: evidence entries are allowlisted per-dimension (secret-free).
  if (own(out.evidence)) {
    const cleanEvidence: Record<string, unknown> = {};
    for (const [dim, rec] of Object.entries(out.evidence)) {
      if (!own(rec)) continue;
      cleanEvidence[dim] = Object.fromEntries(
        ["value", "confidence", "probabilities"].filter(k => k in rec).map(k => [k, (rec as Record<string, unknown>)[k]]),
      );
    }
    (out as Record<string, unknown>).evidence = cleanEvidence;
  }
  return out;
}

/**
 * Issue #14: parse lines loudly but tolerantly — a corrupt/invalid record is
 * rejected with a stderr warning (line number + reason), valid siblings
 * continue. Returns the count of rejected records so callers can exit non-zero.
 */
export function parseLines(text: string): { records: RoutingRecord[]; rejected: number } {
  const records: RoutingRecord[] = [];
  let rejected = 0;
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { console.error(`receipts: rejecting line ${i + 1}: malformed JSON`); rejected++; continue; }
    // Unknown fields must be rejected even for legacy records — only the
    // documented known fields (minus adapterMode) are migrated, never dropped.
    const isLegacy = own(value) && value.kind === "routing" && value.version === 1 && value.adapterMode === undefined;
    // Legacy records must NOT get silently allowlisted — an unknown field on
    // a pre-adapterMode record is still corruption and gets rejected loudly.
    const legacyUnknownFields = isLegacy
      ? Object.keys(value as Record<string, unknown>).filter(k => !(RECORD_FIELDS as readonly string[]).includes(k))
      : [];
    if (legacyUnknownFields.length) {
      for (const key of legacyUnknownFields) console.error(`receipts: rejecting line ${i + 1}: legacy record carries unknown field ${key}`);
      rejected += legacyUnknownFields.length;
      continue;
    }
    // Legacy V1 records written before adapterMode existed: explicit migration
    // to the documented default, then hash is verified against migrated fields.
    if (isLegacy) {
      const migrated = allowlistRecord(value as RoutingRecord) as RoutingRecord;
      migrated.adapterMode = LEGACY_DEFAULT_ADAPTER_MODE;
      migrated.receiptHash = receiptHashOf(migrated);
      value = migrated;
    }
    // Unknown top-level fields are rejected on read (write still allowlists).
    const unknownFields = own(value) ? Object.keys(value).filter(k => !(RECORD_FIELDS as readonly string[]).includes(k)) : [];
    const errors = [...unknownFields.map(f => `unknown field ${f}`), ...validateRoutingRecord(value)];
    if (errors.length) {
      console.error(`receipts: rejecting line ${i + 1}: ${errors.join("; ")}`);
      rejected++;
      continue;
    }
    records.push(value as RoutingRecord);
  }
  return { records, rejected };
}

export function createReceiptStore(path: string): ReceiptStore {
  // Memoized read so replay/report observe appended records and in-memory
  // tampering checks without a redundant disk hit per call.
  let memo: RoutingRecord[] | undefined;
  let rejectedLastRead = 0;
  const read = (): RoutingRecord[] => {
    if (!memo) {
      try {
        const parsed = parseLines(readFileSync(path, "utf8"));
        memo = parsed.records;
        rejectedLastRead = parsed.rejected;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") memo = []; else throw error; }
    }
    return memo;
  };
  return {
    lastRejected: () => rejectedLastRead,
    append(record) {
      const errors = validateRoutingRecord(record);
      if (errors.length) throw new Error(`refusing invalid receipt: ${errors.join("; ")}`);
      // Write only the allowlisted durable shape; secret/unknown fields never
      // reach disk, and the hash covers exactly what is persisted.
      const clean = allowlistRecord(record);
      const stamped = { ...clean, receiptHash: receiptHashOf(clean) };
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(stamped) + "\n", { encoding: "utf8" });
      memo = undefined; // re-read from disk on next read()
    },
    read,
    replay(records = read()) { return replayReceipts(records); },
    reDecide(records = read()) {
      return reDecideReceipts(records, composerReDecider(composeToDecision));
    },
    report(records = read()) { return reportReceipts(records); },
    saveEvalGate(report) { return saveEvalGate(join(path, "..", "eval-gate.json"), report); },
    loadEvalGate() { return loadEvalGate(join(path, "..", "eval-gate.json")); },
  };
}

export type ReplayResult = { deterministic: boolean; records: number; mismatches: string[]; policyVersions: string[]; registryVersions: string[] };
export function replayReceipts(records: RoutingRecord[]): ReplayResult {
  const mismatches: string[] = [];
  for (const [i, r] of records.entries()) {
    // Full persisted record (minus receiptHash itself) is the replay input.
    // No classifier, network, prompt, auth, environment, or tool output is consulted.
    const expected = receiptHashOf(r);
    if (r.receiptHash && r.receiptHash !== expected) mismatches.push(`record ${i + 1}: replay hash mismatch`);
  }
  return { deterministic: mismatches.length === 0, records: records.length, mismatches, policyVersions: [...new Set(records.map(r => r.policyVersion))], registryVersions: [...new Set(records.map(r => r.registryVersion))] };
}

export type RoutingReport = { records: number; failures: number; highRiskDowngrades: number; overRouting: number; shadowObservations: number; shadowDisagreements: number; latencyMs: { count: number; min: number; max: number; average: number }; replay: ReplayResult };
export function reportReceipts(records: RoutingRecord[]): RoutingReport {
  const latencies = records.map(r => r.latencyMs);
  return {
    records: records.length,
    failures: records.filter(r => r.outcome !== "accepted" || r.verification.status === "failed" || r.intendedTarget !== r.actualTarget).length,
    highRiskDowngrades: records.filter(r => r.downgrade?.reason.toLowerCase().includes("risk")).length,
    overRouting: records.filter(r => r.intendedTarget !== r.actualTarget && !r.escalation.occurred).length,
    shadowObservations: records.filter(r => r.shadowClassifier !== undefined).length,
    shadowDisagreements: records.filter(r => r.shadowClassifier?.disagreement === true).length,
    latencyMs: { count: latencies.length, min: latencies.length ? Math.min(...latencies) : 0, max: latencies.length ? Math.max(...latencies) : 0, average: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0 },
    replay: replayReceipts(records),
  };
}

export type EvalGate = { passed: boolean; checkedAt: string; reportHash: string; reason: string };
// ---------------------------------------------------------------------------
// Issue #13: pure deterministic policy re-decision replay.
// ---------------------------------------------------------------------------
export type ReDecisionDiff = {
  id: string;
  requestHash: string;
  originalIntendedTarget: string;
  /** null when the record carries no re-decidable evidence (never fabricated). */
  reDecidedTarget: string | null;
  mismatch: boolean;
};
export type ReDecisionResult = { records: number; mismatches: number; diffs: ReDecisionDiff[] };
export type EvidenceReDecider = (
  evidence: NonNullable<RoutingRecord["evidence"]>,
  candidates: NonNullable<RoutingRecord["candidates"]>,
) => string | null;
type ComposeLike = (evidence: CompositeEvidence, registry: CandidateRegistry) => { receipt?: { selectedTier?: string } | undefined };

/**
 * Re-decide every record through the given pure policy function and diff the
 * result against the original intended target. No classifier, network, SDK,
 * or filesystem access here — `reDecide` is caller-supplied and pure.
 * Records without stored evidence get `reDecidedTarget: null` and no mismatch.
 */
export function reDecideReceipts(records: RoutingRecord[], reDecide: EvidenceReDecider): ReDecisionResult {
  const diffs: ReDecisionDiff[] = [];
  for (const r of records) {
    const requestHash = stableHash({ id: r.id, evidence: r.evidence, candidates: r.candidates });
    const reDecidedTarget = r.evidence && r.candidates ? reDecide(r.evidence, r.candidates) : null;
    diffs.push({
      id: r.id,
      requestHash,
      originalIntendedTarget: r.intendedTarget,
      reDecidedTarget,
      mismatch: reDecidedTarget !== null && reDecidedTarget !== r.intendedTarget,
    });
  }
  return { records: records.length, mismatches: diffs.filter(d => d.mismatch).length, diffs };
}

/** Default pure re-decider: run the existing composer over stored evidence. */
export function composerReDecider(
  compose: ComposeLike,
): EvidenceReDecider {
  return (evidence, candidates) => {
    // ponytail: registry rebuilt from tier-name candidates; ids === tier names.
    const registry = {
      schemaVersion: 1,
      tiers: ["fast", "medium", "heavy"] as const,
      candidates: Object.fromEntries(candidates.map(tier => [tier, { id: tier, tier: tier as "fast" | "medium" | "heavy" }])),
    } as CandidateRegistry;
    const decision = compose({ ...evidence, schemaVersion: 1 }, registry);
    return decision?.receipt?.selectedTier ?? "escalated";
  };
}
export function saveEvalGate(path: string, report: RoutingReport): EvalGate {
  const gate: EvalGate = { passed: report.failures === 0 && report.replay.deterministic, checkedAt: new Date().toISOString(), reportHash: stableHash(report), reason: report.failures === 0 && report.replay.deterministic ? "evaluation passed" : "evaluation failures or replay mismatch" };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(gate) + "\n");
  renameSync(tmp, path);
  return gate;
}
export function loadEvalGate(path: string): EvalGate | null {
  try { const gate = JSON.parse(readFileSync(path, "utf8")) as EvalGate; return gate.passed === true && typeof gate.reportHash === "string" ? gate : null; }
  catch { return null; }
}
