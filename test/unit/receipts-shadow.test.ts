import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiptStore, validateRoutingRecord, type RoutingRecord } from "../../src/receipts/store";
import { reportReceipts } from "../../src/receipts/store";

let directory: string;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

const record = (shadow?: unknown): RoutingRecord => ({
  kind: "routing", version: 1, id: "r1", timestamp: "2026-01-01T00:00:00.000Z",
  intendedTarget: "medium", actualTarget: "medium", escalation: { occurred: false, count: 0 },
  verification: { status: "passed", method: "deterministic" }, latencyMs: 10,
  outcome: "accepted", policyVersion: "p1", registryVersion: "r1", adapterMode: "shadow",
  ...(shadow === undefined ? {} : { shadowClassifier: shadow as RoutingRecord["shadowClassifier"] }),
});

describe("receipt shadow observations", () => {
  it("accepts a valid shadow record and persists it", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-shadow-"));
    const store = createReceiptStore(join(directory, "records.jsonl"));
    store.append(record({ probabilities: [0.2, 0.7, 0.1], disagreement: false, latencyMs: 5 }));
    const read = store.read();
    expect(read).toHaveLength(1);
    expect(read[0].shadowClassifier).toEqual({ probabilities: [0.2, 0.7, 0.1], disagreement: false, latencyMs: 5 });
  });

  it("accepts old records without the field", () => {
    expect(validateRoutingRecord(record())).toEqual([]);
  });

  it("rejects invalid probabilities", () => {
    expect(validateRoutingRecord(record({ probabilities: [0.5, 1.2, 0.1], disagreement: false, latencyMs: 1 }))).toContain("invalid record shadowClassifier.probabilities");
    expect(validateRoutingRecord(record({ probabilities: [0.5, 0.5], disagreement: false, latencyMs: 1 }))).toContain("invalid record shadowClassifier.probabilities");
  });

  it("rejects invalid disagreement and latency", () => {
    expect(validateRoutingRecord(record({ probabilities: [0.2, 0.7, 0.1], disagreement: "yes", latencyMs: 1 }))).toContain("invalid record shadowClassifier");
    expect(validateRoutingRecord(record({ probabilities: [0.2, 0.7, 0.1], disagreement: true, latencyMs: -1 }))).toContain("invalid record shadowClassifier");
  });

  it("drops unknown nested shadow fields on persist", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-shadow-"));
    const store = createReceiptStore(join(directory, "records.jsonl"));
    store.append({ ...record(), shadowClassifier: { disagreement: false, latencyMs: 3, smuggled: "x" } } as RoutingRecord);
    expect(store.read()[0].shadowClassifier).toEqual({ disagreement: false, latencyMs: 3 });
  });

  it("reports observations and disagreements", () => {
    const report = reportReceipts([
      record(),
      record({ disagreement: false, latencyMs: 1 }),
      record({ disagreement: true, latencyMs: 2 }),
      record({ disagreement: true, latencyMs: 2 }),
    ]);
    expect(report.shadowObservations).toBe(3);
    expect(report.shadowDisagreements).toBe(2);
  });

  it("replay is deterministic and ignores shadow fields", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-shadow-"));
    const store = createReceiptStore(join(directory, "records.jsonl"));
    store.append(record({ probabilities: [0.2, 0.7, 0.1], disagreement: true, latencyMs: 5 }));
    expect(store.replay().deterministic).toBe(true);
  });
});
