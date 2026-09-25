import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiptStore, type RoutingRecord } from "../../src/receipts/store";

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
});
