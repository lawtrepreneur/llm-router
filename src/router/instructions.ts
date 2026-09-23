import { readFileSync, statSync } from "node:fs";
import type { RouterConfig } from "./config";

export type DelegateInstructionsPolicy = "strip-global" | "strip-all" | "keep";

/**
 * Returns an instruction file's contents, or `undefined` when the file cannot be
 * read for any reason. Injectable so tests need not touch the filesystem.
 */
export type InstructionFileReader = (absolutePath: string) => string | undefined;

const MARKER = /^Instructions from:[^\S\r\n]*(\S[^\r\n]*)/;

/**
 * Strip trailing forward slashes without a regex.
 *
 * `/\/+$/` is a polynomial-ReDoS footgun (CodeQL js/polynomial-redos): the `$`
 * anchor makes the engine re-scan the run of slashes from every start offset,
 * so a path of many slashes costs O(n²). Both the configured project directory
 * and the path parsed out of an `Instructions from:` marker are library input.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return value.slice(0, end);
}

const fileCache = new Map<string, { mtimeMs: number; size: number; contents: string }>();

/**
 * Real-filesystem reader. The system transform fires on every LLM step, so
 * contents are cached per path and revalidated against mtime and size.
 */
export const readInstructionFile: InstructionFileReader = (absolutePath) => {
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) return undefined;
    const cached = fileCache.get(absolutePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.contents;
    }
    const contents = readFileSync(absolutePath, "utf8");
    fileCache.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, contents });
    return contents;
  } catch {
    // Missing, unreadable, or not a file: the caller keeps the section intact.
    fileCache.delete(absolutePath);
    return undefined;
  }
};

/**
 * Length of the longest candidate rendering of `contents` that is an exact
 * prefix of `body`, or `undefined` when none is. Compared literally against the
 * original body so the removal length needs no index mapping.
 */
function matchedSpan(body: string, contents: string): number | undefined {
  const renderings = [
    contents,
    contents.replace(/\r?\n/g, "\r\n"),
    contents.replace(/\r\n/g, "\n"),
  ];
  let best: number | undefined;
  for (const candidate of [...renderings, ...renderings.map((r) => r.trimEnd())]) {
    if ((best === undefined || candidate.length > best) && body.startsWith(candidate)) {
      best = candidate.length;
    }
  }
  return best;
}

/**
 * Remove the marker line and the named file's own text from `section`, keeping
 * whatever follows. The host joins every instruction file and trailing system
 * text into one string, so the last section's end is not the file's end. If
 * the extent cannot be established from the file, the section is returned
 * unchanged: keeping an instruction is harmless, deleting unknown text is not.
 */
function removeInstructionBlock(section: string, path: string, read: InstructionFileReader): string {
  let contents: string | undefined;
  try {
    contents = read(path);
  } catch {
    // A throwing reader means the extent is unknown; keep the section.
    contents = undefined;
  }
  if (typeof contents !== "string") return section;
  const newline = section.indexOf("\n");
  const body = newline === -1 ? "" : section.slice(newline + 1);
  const span = matchedSpan(body, contents);
  if (span === undefined) return section;
  const rest = body.slice(span);
  return rest.trim() ? rest : "";
}

/**
 * opencode injects instruction files into every session, including children.
 * A global orchestrator persona can tell delegates to "fire the fast agent via
 * Task for ANY read-only work" or impose a "REQUIRED TOOLS" whitelist, even
 * though those delegates have no task tool and must do the dispatched work.
 * Keep project-local files by default: they usually contain coding conventions
 * delegates need. With no project directory, every instruction file is global.
 *
 * A section runs from its marker to the next marker or the end of the entry;
 * only the marker line plus the named file's contents are removed from it.
 * The host holds its own reference to `output.system` and reads it back after
 * the hook, so the array is mutated in place and never rebound.
 */
export function stripDelegateInstructions(
  output: { system: string[] },
  cfg: RouterConfig,
  projectDirectory: string | undefined,
  readFile: InstructionFileReader = readInstructionFile,
): void {
  try {
    const policy = cfg.delegateInstructions ?? "strip-global";
    if (policy === "keep") return;
    const system = output.system;
    if (!Array.isArray(system)) return;

    const normalize = (path: string): string =>
      stripTrailingSlashes(path.trim().replace(/\\/g, "/").toLowerCase());
    const project = projectDirectory ? normalize(projectDirectory) : undefined;
    let changed = false;
    const next = system.flatMap((entry) => {
      if (typeof entry !== "string") return [entry];
      // Horizontal whitespace only: a pathless marker must not consume the
      // following line as its path. Preserve original line endings verbatim.
      const sections = entry.split(/(?=^Instructions from:[^\S\r\n]*\S[^\r\n]*$)/m);
      let removed = false;
      const kept = sections.map((section) => {
        const marker = MARKER.exec(section);
        if (!marker) return section;
        const path = normalize(marker[1]!);
        const local = project !== undefined &&
          (path === project || path.startsWith(`${project}/`));
        if (policy !== "strip-all" && local) return section;
        const rest = removeInstructionBlock(section, marker[1]!.trim(), readFile);
        if (rest !== section) removed = true;
        return rest;
      }).join("");
      if (!removed) return [entry];
      changed = true;
      return kept.trim() ? [kept] : [];
    });
    if (changed) system.splice(0, system.length, ...next);
  } catch {
    // Fail soft: retain the original array if malformed runtime input prevents
    // computing the replacement. Instruction filtering must not break a turn.
    return;
  }
}
