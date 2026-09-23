/** Fingerprint a read-only tool call for redundancy detection. */
export function fingerprintToolCall(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "read": {
      // Fixed field order preserves repeats regardless of argument insertion order.
      // Keep path-only fingerprints unchanged when no range was supplied.
      const range = Object.fromEntries(
        ["offset", "limit", "start", "end", "line", "lines", "range"]
          .filter((key) => a[key] != null)
          .map((key) => [key, a[key]]),
      );
      const suffix = Object.keys(range).length ? `:${JSON.stringify(range)}` : "";
      return `read:${a.file_path ?? a.filePath ?? ""}${suffix}`;
    }
    case "grep":
      return `grep:${a.pattern ?? ""}:${a.path ?? a.glob ?? ""}`;
    case "glob":
      return `glob:${a.pattern ?? ""}:${a.path ?? ""}`;
    case "ls":
      return `ls:${a.path ?? ""}`;
    default:
      return `${tool}:${JSON.stringify(a).slice(0, 120)}`;
  }
}
