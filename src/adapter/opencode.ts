/**
 * src/adapter/opencode.ts — OpenCode-as-a-worker adapter.
 *
 * Spawns the OpenCode CLI as a child process and normalizes its output to the
 * shared dispatch-result shape. Recursion is prevented at the process level:
 * children are launched with MODEL_ROUTER_OC_CHILD=1, and this module refuses
 * to spawn when it sees that var in its own environment. Two independent
 * layers exist — this env guard and the session marking in index.ts — so a
 * failure of one leaves the other standing.
 *
 * IMPURE: child_process. Kept isolated so index.ts stays testable by
 * injecting a fake run function.
 */
import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { OpenCodeAdapterConfig } from "../router/config";

const execFileAsync = (
  binary: string,
  args: readonly string[],
  options: Parameters<typeof execFile>[2] & { maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [...args], { cwd: options?.cwd, env: options?.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const maxBuffer = options?.maxBuffer ?? 10 * 1024 * 1024;
    const timer = setTimeout(() => child.kill("SIGTERM"), options?.timeout ?? 0);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.length > maxBuffer) child.kill("SIGTERM");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
      if (stderr.length > maxBuffer) child.kill("SIGTERM");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(Object.assign(new Error(signal ? `terminated by ${signal}` : `exited with code ${code}`), { code, signal, stdout, stderr }));
    });
  });

/** Env var set on spawned OpenCode children. Presence ⇒ recursion. */
export const OC_CHILD_ENV = "MODEL_ROUTER_OC_CHILD";

export class OpenCodeAdapterError extends Error {
  readonly reason: "recursion" | "disabled" | "timeout" | "spawn" | "exit";
  readonly cause?: Error;
  constructor(reason: OpenCodeAdapterError["reason"], message: string, cause?: Error) {
    super(`[opencode-adapter] ${message}`);
    this.name = "OpenCodeAdapterError";
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * True when the current process is itself an adapter-spawned OpenCode child.
 * The caller treats this as mode "off" regardless of config.
 */
export function isOcChild(): boolean {
  return process.env[OC_CHILD_ENV] === "1";
}

export interface OpenCodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Milliseconds the invocation took. */
  durationMs: number;
}

export interface OpenCodeRunDeps {
  /** Injectable exec for tests. Defaults to execFileAsync. */
  exec?: typeof execFileAsync;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Run one OpenCode CLI invocation with the recursion guard applied.
 *
 * Env: children get MODEL_ROUTER_OC_CHILD=1 plus a stripped PATH-inherited
 * environment (we pass the parent env through — OpenCode needs credentials
 * and provider config from the user's environment).
 */
export async function runOpenCode(
  cfg: Pick<OpenCodeAdapterConfig, "binary" | "args" | "timeoutMs">,
  prompt: string,
  cwd: string,
  deps: OpenCodeRunDeps = {},
  agent?: string,
): Promise<OpenCodeRunResult> {
  if (isOcChild()) {
    throw new OpenCodeAdapterError(
      "recursion",
      "refusing to spawn OpenCode from inside an OpenCode adapter child",
    );
  }

  const exec = deps.exec ?? execFileAsync;
  const startedAt = deps.now?.() ?? Date.now();

  try {
    const argv = [...cfg.args, ...(agent ? ["--agent", agent] : []), prompt];
    const { stdout, stderr } = await exec(cfg.binary, argv, {
      timeout: cfg.timeoutMs,
      cwd: resolve(cwd),
      env: { ...process.env, [OC_CHILD_ENV]: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
    const durationMs = (deps.now?.() ?? Date.now()) - startedAt;
    return { stdout, stderr, exitCode: 0, durationMs };
  } catch (err: any) {
    const durationMs = (deps.now?.() ?? Date.now()) - startedAt;
    // execFile timeouts surface as err.killed === true with signal SIGTERM.
    if (err?.killed || err?.signal === "SIGTERM") {
      throw new OpenCodeAdapterError(
        "timeout",
        `OpenCode invocation exceeded ${cfg.timeoutMs}ms`,
        err,
      );
    }
    if (typeof err?.code === "number") {
      throw new OpenCodeAdapterError(
        "exit",
        `OpenCode exited ${err.code}: ${(err.stderr ?? err.stdout ?? "no output").trim()}`,
        err,
      );
    }
    throw new OpenCodeAdapterError(
      "spawn",
      `failed to spawn ${cfg.binary}: ${err?.message ?? String(err)}`,
      err,
    );
  }
}
