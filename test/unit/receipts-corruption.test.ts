import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Issue #14: corrupt records rejected loudly, valid siblings continue. */
describe("receipt corruption rejection", () => {
  it("rejects corrupt JSON lines with warning and continues valid siblings", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-"));
    const path = join(directory, "records.jsonl");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(path, `${JSON.stringify(record())}\n{not json\n`);
    const store = createReceiptStore(path);
    expect(store.read()).toHaveLength(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/line 2: malformed JSON/));
    expect(store.lastRejected()).toBe(1);
    err.mockRestore();
  });

  it("rejects records with unknown fields", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-"));
    const path = join(directory, "records.jsonl");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(path, JSON.stringify({ ...record(), smuggled: "x" }));
    const store = createReceiptStore(path);
    expect(store.read()).toHaveLength(0);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/line 1: unknown field smuggled/));
    expect(store.lastRejected()).toBe(1);
    err.mockRestore();
  });

  it("rejects records with missing required fields", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-"));
    const path = join(directory, "records.jsonl");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { outcome, ...missing } = record();
    writeFileSync(path, JSON.stringify(missing));
    const store = createReceiptStore(path);
    expect(store.read()).toHaveLength(0);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/line 1: .*missing record outcome/));
    err.mockRestore();
  });

  it("rejects unknown fields on legacy records that lack adapterMode, keeping V1 migration for known fields", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-"));
    const path = join(directory, "records.jsonl");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(path, JSON.stringify({ ...record(), adapterMode: undefined, legacyField: "x" } as never));
    const store = createReceiptStore(path);
    expect(store.read()).toHaveLength(0);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/line 1: legacy record carries unknown field legacyField/));
    expect(store.lastRejected()).toBe(1);
    err.mockRestore();
  });

  it("keeps V1 migration semantics for known fields without adapterMode", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-"));
    const path = join(directory, "records.jsonl");
    writeFileSync(path, JSON.stringify({ ...record(), adapterMode: undefined } as never));
    const store = createReceiptStore(path);
    expect(store.read()).toHaveLength(1);
    expect(store.read()[0].adapterMode).toBe("off");
  });

  it("continues past rejected records to later valid ones", () => {
    directory = mkdtempSync(join(tmpdir(), "router-receipts-"));
    const path = join(directory, "records.jsonl");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = { ...record(), id: "r2" };
    writeFileSync(path, `{broken\n${JSON.stringify(good)}\n`);
    const store = createReceiptStore(path);
    expect(store.read().map(r => r.id)).toEqual(["r2"]);
    expect(store.lastRejected()).toBe(1);
    err.mockRestore();
  });
});
