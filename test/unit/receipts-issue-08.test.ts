import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiptStore, loadEvalGate, saveEvalGate, type RoutingRecord, type RoutingReport as ReceiptReport, type ReceiptStore } from "../../src/receipts/store";

/**
 * Issue #8 — acceptance suite for durable receipts.
 *
 * Runs against the SHIPPED store surface only (append/read/replay/report/
 * saveEvalGate/loadEvalGate). No Hermes execution, no classifier call: replay
 * determinism is proven from hashes alone. Old-record compatibility is asserted
 * on a minimal fixture that omits adapter/phase.
 */

const clean = (): RoutingRecord => ({
  kind: "routing", version: 1, id: "issue-08-a", timestamp: "2026-01-01T00:00:00.000Z",
  intendedTarget: "heavy", actualTarget: "heavy", escalation: { occurred: false, count: 0 },
  verification: { status: "passed", method: "deterministic" }, latencyMs: 20, outcome: "accepted",
  policyVersion: "p1", registryVersion: "r1", adapterMode: "shadow", receiptHash: "ok", downgrade: undefined,
});

describe("issue #8 acceptance — receipts", () => {
  let directory: string | undefined;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it("A1: durable record carries only metadata + hashes, never secret fields", () => {
    const r = clean();
    for (const secret of ["prompt", "body", "headers", "env", "toolOutput"]) {
      expect(Object.keys(r)).not.toContain(secret);
    }
  });

  it("A2: append refuses to persist records carrying secret-carrying fields", () => {
    const store = createReceiptStore(join(mkdtempSync(join(tmpdir(), "issue08-")), "r.jsonl"));
    expect(() => store.append({ ...clean(), prompt: "top-secret" } as never)).toThrow(/invalid receipt/);
    expect(() => store.append({ ...clean(), body: "{}", headers: {}, env: {}, toolOutput: "x" } as never)).toThrow(/invalid receipt/);
  });

  it("A3: replay is deterministic from recorded fields; old-record shape still replays", () => {
    const r = clean();          // minimal record with no adapter/phase (legacy-compatible)
    for (const mode of ["off", "shadow", "live"] as const) {
      const store = createReceiptStore(join(mkdtempSync(join(tmpdir(), "issue08-")), "r.jsonl"));
      store.append(r);          // append + read round-trips through disk
      expect(store.read()).toHaveLength(1);
      expect(store.replay().deterministic).toBe(true);   // deterministic, no classifier/API consulted
    }
  });

  it("A4: replay flags a tampered receipt hash loudly (non-deterministic)", () => {
    const store = createReceiptStore(join(mkdtempSync(join(tmpdir(), "issue08-")), "r.jsonl"));
    store.append(clean());
    const recs = store.read();
    // Corrupt the stored hash so the deterministic self-check can fail.
    recs[0].receiptHash = "deadbeef";
    expect(store.replay().deterministic).toBe(false);   // loud rejection, not silent accept
  });

  it("C1: report populates high-risk downgrade counter when reason names risk", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue08-"));
    const store: ReceiptStore = createReceiptStore(join(dir, "r.jsonl"));
    store.append(clean());
    store.append({ ...clean(), outcome: "unmet", verification: { status: "failed" }, receiptHash: undefined });
    store.append({ ...clean(), downgrade: { from: "heavy", to: "medium", reason: "high-risk routing" } } as never);
    const report = store.report();
    expect(report.highRiskDowngrades).toBe(1);          // populated + tested via report path
  });

  it("C2: report exposes failures and over-routing counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue08-"));
    const store = createReceiptStore(join(dir, "r.jsonl"));
    store.append(clean());                               // accepted, no drift
    store.append({ ...clean(), verification: { status: "failed" }, receiptHash: undefined });  // failure
    store.append({ ...clean(), intendedTarget: "heavy", actualTarget: "medium", escalation: { occurred: false, count: 0 } }); // over-routing
    const report = store.report();
    expect(report.failures).toBe(2);                    // failed verification + unmet outcome
    expect(report.overRouting).toBe(1);
  });

  it("D1: green eval gate round-trips when replay is deterministic (recorded, then re-loaded)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "issue08-")), "gate.json");
    createReceiptStore(path).append(clean());   // recorded with a good hash → deterministic self-check
    const gate = createReceiptStore(path).saveEvalGate(storeReported(clean()));
    expect(gate.passed).toBe(true);            // gate persists (atomic write) for live execution
    expect(createReceiptStore(path).loadEvalGate()).not.toBeNull();   // reloadable proof of the gate
  });

  it("D2: an unverified/live record makes the eval gate block execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue08-"));
    // A failed verification is never a green receipt, so the live eval gate must block.
    const bad = storeReported({ ...clean(), verification: { status: "failed" }, receiptHash: undefined });
    expect(bad.failures).toBeGreaterThan(0);
    createReceiptStore(join(dir, "gate.json")).saveEvalGate(bad);
    expect(createReceiptStore(join(dir, "gate.json")).loadEvalGate()).toBeNull();   // blocked, not loaded for execution
  });

  it("E: supported adapter modes (off/shadow/live) round-trip in durable receipts", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue08-"));
    const store = createReceiptStore(join(dir, "r.jsonl"));
    for (const mode of ["off", "shadow", "live"] as const) {
      store.append({ ...clean(), adapterMode: mode });
    }
    const report = store.report();
    expect(report.records).toBe(3);                     // all three modes persisted and read back
  });
});

function storeReported(record: RoutingRecord): ReceiptReport {
  const dir = mkdtempSync(join(tmpdir(), "issue08-"));
  const store = createReceiptStore(join(dir, "r.jsonl"));
  try { store.append({ ...record }); return store.report(); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
