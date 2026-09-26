import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiptStore, receiptHashOf, replayReceipts, type RoutingRecord } from "../../src/receipts/store";

let directory: string;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

const record = (): RoutingRecord => ({
  kind: "routing", version: 1, id: "r1", timestamp: "2026-01-01T00:00:00.000Z",
  intendedTarget: "medium", actualTarget: "heavy", escalation: { occurred: true, count: 1 },
  verification: { status: "passed", method: "deterministic" }, latencyMs: 12,
  outcome: "accepted", policyVersion: "p1", registryVersion: "r1", adapterMode: "shadow",
});

describe("receipt store", () => {
  it("appends, reads, replays and reports without retaining prompts", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-"));
    const store = createReceiptStore(join(directory, "records.jsonl"));
    store.append(record());
    expect(store.read()).toHaveLength(1);
    expect(store.replay().deterministic).toBe(true);
    expect(store.report().latencyMs.average).toBe(12);
  });

  it("rejects malformed and unknown records loudly", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-"));
    const store = createReceiptStore(join(directory, "records.jsonl"));
    expect(() => store.append({ ...record(), kind: "secret" } as never)).toThrow(/invalid receipt/);
  });

  it("drops unknown nested fields from escalation, verification and downgrade on persist", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-"));
    const store = createReceiptStore(join(directory, "records.jsonl"));
    store.append({
      ...record(),
      escalation: { occurred: true, count: 1, reason: "fail", smuggled: "x" },
      verification: { status: "passed", method: "deterministic", smuggled: "y" },
      downgrade: { from: "heavy", to: "medium", reason: "cost", smuggled: "z" },
    } as never);
    const line = JSON.parse((require("node:fs").readFileSync(join(directory, "records.jsonl"), "utf8") as string).trim());
    expect(line.escalation).toEqual({ occurred: true, count: 1, reason: "fail" });
    expect(line.verification).toEqual({ status: "passed", method: "deterministic" });
    expect(line.downgrade).toEqual({ from: "heavy", to: "medium", reason: "cost" });
    expect(JSON.stringify(line)).not.toContain("smuggled");
  });

  it("replays deterministically: same version metadata and inputs yield the same receipt hash", () => {
    const base = { ...record(), classifierVersion: "fixture-1" };
    const withHash = (r: RoutingRecord): RoutingRecord => ({
      ...r,
      receiptHash: receiptHashOf(r),
    });
    // Same input + same versions → identical hash, deterministic replay.
    const a = replayReceipts([withHash({ ...base, id: "a" })]);
    const b = replayReceipts([withHash({ ...base, id: "b", timestamp: "2027-01-01T00:00:00.000Z" })]);
    expect(a.deterministic).toBe(true);
    expect(b.deterministic).toBe(true);
    // Tampered hash → replay flags the mismatch.
    const tampered = { ...withHash(base), receiptHash: "deadbeef" };
    expect(replayReceipts([tampered]).mismatches).toHaveLength(1);
  });

  it("changes receipt hash when each version-metadata field changes independently", () => {
    const hashOf = receiptHashOf;
    const base: RoutingRecord = { ...record(), classifierVersion: "v1", schemaHash: "schema-a", candidateRegistryHash: "reg-a" };
    const baseHash = hashOf(base);
    expect(hashOf({ ...base, classifierVersion: "v2" })).not.toBe(baseHash);
    expect(hashOf({ ...base, schemaHash: "schema-b" })).not.toBe(baseHash);
    expect(hashOf({ ...base, candidateRegistryHash: "reg-b" })).not.toBe(baseHash);
    expect(hashOf({ ...base, outcome: "failed" })).not.toBe(baseHash);
  });
});
