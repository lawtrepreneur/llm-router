import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiptStore, replayReceipts, type RoutingRecord } from "../../src/receipts/store";
import { stableHash } from "../../src/contract/routing-receipt";

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

  it("replays deterministically: same version metadata and inputs yield the same receipt hash", () => {
    const base = { ...record(), classifierVersion: "fixture-1" };
    const withHash = (r: RoutingRecord): RoutingRecord => ({
      ...r,
      receiptHash: stableHash({ policy: r.policyVersion, registry: r.registryVersion, classifierVersion: r.classifierVersion, schemaHash: r.schemaHash, candidateRegistryHash: r.candidateRegistryHash, intended: r.intendedTarget, actual: r.actualTarget, escalation: r.escalation }),
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
    const hashOf = (r: RoutingRecord): string => stableHash({ policy: r.policyVersion, registry: r.registryVersion, classifierVersion: r.classifierVersion, schemaHash: r.schemaHash, candidateRegistryHash: r.candidateRegistryHash, intended: r.intendedTarget, actual: r.actualTarget, escalation: r.escalation });
    const base: RoutingRecord = { ...record(), classifierVersion: "v1", schemaHash: "schema-a", candidateRegistryHash: "reg-a" };
    const baseHash = hashOf(base);
    expect(hashOf({ ...base, classifierVersion: "v2" })).not.toBe(baseHash);
    expect(hashOf({ ...base, schemaHash: "schema-b" })).not.toBe(baseHash);
    expect(hashOf({ ...base, candidateRegistryHash: "reg-b" })).not.toBe(baseHash);
  });
});
