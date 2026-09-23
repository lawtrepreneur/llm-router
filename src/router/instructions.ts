import type { RouterConfig } from "./config";

export type DelegateInstructionsPolicy = "strip-global" | "strip-all" | "keep";

/**
 * opencode injects instruction files into every session, including children.
 * A global orchestrator persona can tell delegates to "fire the fast agent via
 * Task for ANY read-only work" or impose a "REQUIRED TOOLS" whitelist, even
 * though those delegates have no task tool and must do the dispatched work.
 * Keep project-local files by default: they usually contain coding conventions
 * delegates need. With no project directory, every instruction file is global.
 * Marker-delimited sections extend to the next marker or the end of the entry.
 */
export function stripDelegateInstructions(
  output: { system: string[] },
  cfg: RouterConfig,
  projectDirectory: string | undefined,
): void {
  try {
    const policy = cfg.delegateInstructions ?? "strip-global";
    if (policy === "keep") return;

    const normalize = (path: string): string =>
      path.trim().replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const project = projectDirectory ? normalize(projectDirectory) : undefined;
    output.system = output.system.flatMap((entry) => {
      if (typeof entry !== "string") return [entry];
      // Horizontal whitespace only: a pathless marker must not consume the
      // following line as its path. Preserve original line endings verbatim.
      const sections = entry.split(/(?=^Instructions from:[^\S\r\n]*\S[^\r\n]*$)/m);
      let removed = false;
      const kept = sections.filter((section) => {
        const marker = /^Instructions from:[^\S\r\n]*(\S[^\r\n]*)/.exec(section);
        if (!marker) return true;
        const path = normalize(marker[1]!);
        const local = project !== undefined &&
          (path === project || path.startsWith(`${project}/`));
        if (policy === "strip-all" || !local) {
          removed = true;
          return false;
        }
        return true;
      }).join("");
      return removed && !kept.trim() ? [] : [kept];
    });
  } catch {
    // Fail soft: retain the original array if malformed runtime input prevents
    // computing the replacement. Instruction filtering must not break a turn.
    return;
  }
}
