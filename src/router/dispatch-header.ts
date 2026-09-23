/**
 * Mechanical dispatch guidance, independent of provider tool vocabulary.
 * Tier identity prevents delegates routing their assignment back to another tier.
 * The directory paragraph prevents refusal of a valid path when a stale environment
 * block advertises a directory that does not exist.
 * Tool-schema authority prevents zero-call returns such as `ESCALATE: ... the
 * available tools here are not the Read/Grep/Glob/Bash tools described in the request`.
 * Empty-result guidance prevents declaring tools broken after a gitignore-filtered
 * search returns "No files found".
 * The budget paragraph makes the cap explicit and prevents halting when the
 * redundancy detector flags a legitimate non-overlapping second read of a file.
 * The final notice calls out the zero-tool-call false refusals directly.
 */
export function buildDispatchHeader(input: {
  tier: string;
  cap: number | "none";
  projectDirectory: string | undefined;
}): string {
  const paragraphs = [
    `[router] You are @${input.tier}. Execute this dispatch yourself; do not route it to another tier, and do not ask to be re-dispatched.`,
  ];
  if (input.projectDirectory) {
    paragraphs.push(`Working directory: ${input.projectDirectory}. You are already there — do not ask permission to read or write inside it.`);
  }
  paragraphs.push(
    'Tool names mentioned in this dispatch are descriptive and vary by provider; your own tool schema is the authority on what you can do. Never refuse or hand back work because a named tool looks unfamiliar or missing — attempt it, and if you cannot finish, name the specific step that failed.',
    'An empty result is a result. Search tools honour .gitignore, so a "no matches" answer inside an ignored path means the filter applied, not that your tools are broken; use a shell ripgrep with --no-ignore there before concluding anything is absent.',
    `${input.cap === "none" ? "Read-only budget: uncapped for this dispatch." : `Read-only budget: ${input.cap} calls.`} The runtime appends [cap: N/MAX] and [⚠ REDUNDANT] to results. Reading a different region of a file you have already opened is NOT a redundant read.`,
    // The parser takes the first directive: pin the resolved budget before the
    // instructional CAP:none example, which must not override the real dispatch.
    `CAP:${input.cap}`,
    'To change the budget, put CAP:N or CAP:none accompanied by a reason: line in the dispatch.',
    'A hand-back with zero tool calls is recorded as a false refusal.',
  );
  return paragraphs.join("\n\n");
}
