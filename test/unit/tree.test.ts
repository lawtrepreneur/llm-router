import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { snapshotTree } from "../../src/verify/tree";

const state = vi.hoisted(() => ({ head: "head1", status: "", diff: "", index: "", untracked: "", content: "", stage: "", error: false, calls: [] as string[][], directories: [] as string[] }));
vi.mock("node:child_process", () => ({
  execFile: (_binary: string, args: string[], options: { cwd: string }, callback: (error: Error | null, stdout: string) => void) => {
    state.calls.push(args);
    state.directories.push(options.cwd);
    const command = args.slice(1).join(" ");
    const output = command === "rev-parse --show-toplevel" ? process.cwd()
      : command === "rev-parse HEAD" ? state.head
      : command.startsWith("status") ? state.status
      : command.startsWith("diff HEAD") ? state.diff
      : command.startsWith("diff --cached") ? state.index
      : command === "ls-files --stage" ? state.stage : state.untracked;
    callback(state.error ? new Error("unavailable") : null, output);
  },
}));
vi.mock("node:fs/promises", () => ({
  realpath: async (path: string) => path,
  lstat: async () => ({ mode: 33188, size: 4, isFile: () => true, isSymbolicLink: () => false }),
  readFile: async () => state.content,
  readlink: async () => "target",
}));
beforeEach(() => Object.assign(state, { head: "head1", status: "", diff: "", index: "", untracked: "", content: "", stage: "", error: false, calls: [], directories: [] }));
const capture = () => snapshotTree(process.cwd(), new AbortController().signal);
describe("Git tree fingerprint adapter", () => {
  it("fingerprints the whole repository even when tests run in a subdirectory", async () => {
    const cwd = resolve("packages/app");
    const snapshot = await snapshotTree(cwd, new AbortController().signal);
    expect(snapshot?.cwd).toBe(cwd);
    expect(state.directories[0]).toBe(cwd);
    expect(state.directories.slice(1).every(dir => dir === process.cwd())).toBe(true);
  });
  it.each(["diff", "index", "status", "content"] as const)("hash changes with %s, including same-path untracked content edits", async field => {
    state.untracked = "untracked.txt\0";
    const first = await capture(); state[field] = "changed";
    expect((await capture())?.fingerprint).not.toBe(first?.fingerprint);
    expect(state.calls.every(args => args[0] === "--no-pager")).toBe(true);
  });
  it("retains HEAD, dirty flag, and absolute changed paths including rename destinations", async () => {
    state.status = " M old.ts\0R  new.ts\0before.ts\0?? untracked.txt\0";
    const snapshot = await capture();
    expect(snapshot).toMatchObject({ head: "head1", dirty: true });
    expect(snapshot?.files.map(f => f.path)).toEqual([resolve("old.ts"), resolve("new.ts"), resolve("untracked.txt")]);
  });
  it("returns unavailable for Git errors, aborted captures, and submodules", async () => {
    state.error = true; expect(await capture()).toBeUndefined();
    state.error = false; state.stage = "160000 commit 0\tsubmodule";
    expect(await capture()).toBeUndefined(); state.stage = "";
    const controller = new AbortController(); controller.abort();
    expect(await snapshotTree(process.cwd(), controller.signal)).toBeUndefined();
  });
});
