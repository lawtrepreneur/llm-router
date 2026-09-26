/** Secret-free, append-only routing receipts and deterministic evaluation. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { stableHash } from "../contract/routing-receipt";

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
};

export type ReceiptStore = {
  append(record: RoutingRecord): void;
  read(): RoutingRecord[];
  replay(records?: RoutingRecord[]): ReplayResult;
  report(records?: RoutingRecord[]): RoutingReport;
};

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
  return errors;
}

function parseLines(text: string): RoutingRecord[] {
  const records: RoutingRecord[] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`malformed receipt record at line ${i + 1}`); }
    const errors = validateRoutingRecord(value);
    if (errors.length) throw new Error(`invalid receipt record at line ${i + 1}: ${errors.join("; ")}`);
    records.push(value as RoutingRecord);
  }
  return records;
}

export function createReceiptStore(path: string): ReceiptStore {
  const read = (): RoutingRecord[] => {
    try { return parseLines(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  return {
    append(record) {
      const errors = validateRoutingRecord(record);
      if (errors.length) throw new Error(`refusing invalid receipt: ${errors.join("; ")}`);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(record) + "\n", { encoding: "utf8" });
    },
    read,
    replay(records = read()) { return replayReceipts(records); },
    report(records = read()) { return reportReceipts(records); },
  };
}

export type ReplayResult = { deterministic: boolean; records: number; mismatches: string[]; policyVersions: string[]; registryVersions: string[] };
export function replayReceipts(records: RoutingRecord[]): ReplayResult {
  const mismatches: string[] = [];
  for (const [i, r] of records.entries()) {
    // The fixed versions and the recorded target are the complete replay input.
    // No classifier, network, prompt, auth, environment, or tool output is consulted.
    const expected = stableHash({ policy: r.policyVersion, registry: r.registryVersion, classifierVersion: r.classifierVersion, schemaHash: r.schemaHash, candidateRegistryHash: r.candidateRegistryHash, intended: r.intendedTarget, actual: r.actualTarget, escalation: r.escalation });
    if (r.receiptHash && r.receiptHash !== expected) mismatches.push(`record ${i + 1}: replay hash mismatch`);
  }
  return { deterministic: mismatches.length === 0, records: records.length, mismatches, policyVersions: [...new Set(records.map(r => r.policyVersion))], registryVersions: [...new Set(records.map(r => r.registryVersion))] };
}

export type RoutingReport = { records: number; failures: number; highRiskDowngrades: number; overRouting: number; latencyMs: { count: number; min: number; max: number; average: number }; replay: ReplayResult };
export function reportReceipts(records: RoutingRecord[]): RoutingReport {
  const latencies = records.map(r => r.latencyMs);
  return {
    records: records.length,
    failures: records.filter(r => r.outcome === "failed" || r.verification.status === "failed").length,
    highRiskDowngrades: records.filter(r => r.downgrade?.reason.toLowerCase().includes("risk")).length,
    overRouting: records.filter(r => r.intendedTarget !== r.actualTarget && !r.escalation.occurred).length,
    latencyMs: { count: latencies.length, min: latencies.length ? Math.min(...latencies) : 0, max: latencies.length ? Math.max(...latencies) : 0, average: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0 },
    replay: replayReceipts(records),
  };
}

export type EvalGate = { passed: boolean; checkedAt: string; reportHash: string; reason: string };
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
