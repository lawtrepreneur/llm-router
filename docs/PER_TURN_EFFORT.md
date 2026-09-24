# Per-turn effort and timing (Claude Code 2.1.280)

What upstream Claude Code 2.1.280 does with per-turn effort and timing, which models declare
those capabilities, and what that means for the `anthropic` preset this router ships. Each
section says whether it states a **fact** (with its source) or a **recommendation**.

**Cross-references:** [CONFIG_REFERENCE.md — Per-tier `effort`](./CONFIG_REFERENCE.md#per-tier-effort) · [CONFIG_REFERENCE.md — Known issue: the provider matrix covers `effort` only](./CONFIG_REFERENCE.md#known-issue-the-provider-matrix-covers-effort-only)

**Evidence:** `D:\git\claude-code-wire-compat\docs\protocol\versions\claude-code-2.1.280-analysis.md`
(search it for `per-turn-control-2026-07-01`; the message shape is in §11.2, "Per-turn effort
and timing on `api_system` messages").

---

## The upstream mechanism (fact)

Everything in this section comes from the 2.1.280 analysis above. None of it was observed
from this repository.

### Effort travels on the message, not the request

Upstream `api_system` messages carry their own `outputConfig` object holding `effort` and
`timing`. The analysis derives this from two downgrade transforms in the bundle: one strips
the whole `outputConfig` from an `api_system` message when per-message effort is
unavailable, the other strips only `timing` when `per_turn_timing` is unavailable.

The consequence of that placement is the point of the feature: effort can change
mid-conversation **without invalidating the prompt-cache prefix**, because the change is
appended as a message rather than written into the request-level configuration that the
cached prefix depends on.

### Which models declare the capabilities

| Capability | Declared by |
|---|---|
| `per_turn_effort` | `claude-opus-5-5`, `claude-fable-5-1` |
| `per_turn_timing` | `claude-opus-5-5`, `claude-fable-5-1`, `claude-mythos-5-1` |

`claude-mythos-5-1` declares `per_turn_timing` but not `per_turn_effort`.

### Which beta identifiers are emitted

| Beta identifier | Emitted by default? |
|---|---|
| `per-turn-control-2026-07-01` | Yes — on the default request path, for a model whose catalogue entry declares `per_turn_effort`. |
| `timing-2026-09-09` | No — environment-gated off; it requires `CLAUDE_CODE_PER_TURN_TIMING`. |

### What `claude-opus-5-5` rejects

- A manually supplied thinking budget, answered with **HTTP 400**. This is already recorded
  in [CONFIG_REFERENCE.md](./CONFIG_REFERENCE.md#known-issue-the-provider-matrix-covers-effort-only).
  Effort on that model is expressed through `effort`, never through a token budget.
- `tool_choice` values `any` and `tool`.

---

## What this means for this router

### Facts read from this repository

The bundled `anthropic` preset points `@medium` at `claude-opus-5-5`. From `tiers.json`:

```jsonc
"medium": {
  "model": "anthropic/claude-opus-5-5",
  "variant": "high",
  "effort": "high",
```

`buildAgentOptions` in `src/router/agent-options.ts` emits `budget_tokens` whenever
`thinking.budgetTokens` is truthy, and `reasoning_effort` / `reasoning_summary` whenever the
matching `reasoning.*` field is set, without a provider gate. Only the `effort` branch
consults `isClaudeModel`. This is **not new**: it is the known issue already recorded in
[CONFIG_REFERENCE.md — Known issue: the provider matrix covers `effort` only](./CONFIG_REFERENCE.md#known-issue-the-provider-matrix-covers-effort-only).

Nothing in `buildAgentOptions` emits a per-turn `outputConfig` or either beta identifier
above. A tier's `effort` is a registration-time value on the agent's `options`, fixed for
the life of that agent.

### The consequence (derived from the upstream evidence, not observed here)

With the tier exactly as shipped, `@medium` sets `effort: "high"` and no `thinking` block, so
`buildAgentOptions` registers `effort: "high"` and **no** `budget_tokens`. The shipped
default does not, by itself, send a manual thinking budget.

The exposure is one edit away. When a `claude-opus-5-5` tier also sets
`thinking.budgetTokens` — in an overrides file or an edited preset — `buildAgentOptions`
registers `budget_tokens` with no gate, and a request on that tier carries a manual
thinking budget to a model that rejects it. The upstream evidence says that request is
answered with HTTP 400. Because `thinking.budgetTokens` outranks `effort` in the precedence
rules, the `effort` that would have worked is dropped at the same time.

No test and no live request in this repository has produced that 400. It is derived from
the upstream analysis.

Not verified here: whether opencode turns the tier's `variant: "high"` into a thinking
budget further down the stack. That mapping lives outside this repository.

---

## Recommendations

These are recommendations, not current behaviour.

1. **Configuration, now:** on a `claude-opus-5-5` tier (and on the other Anthropic models
   listed in the known issue) set `effort`, never `thinking.budgetTokens`.
2. **Code, as a follow-up:** gate the `budget_tokens` and `reasoning_*` branches of
   `buildAgentOptions` by model family, as the `effort` branch already is, and warn instead
   of registering when a tier names a field its model rejects. A code change is **out of
   scope for this document**. It changes `buildAgentOptions` behaviour and so moves golden
   snapshots for any preset that exercises it; it belongs in its own change with its own
   tests.
