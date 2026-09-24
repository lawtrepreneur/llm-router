# ADR 0003 — OpenCode CLI as a Tier Worker (Adapter)
> **Status:** Accepted **Date:** 2026-09-24 **Wave/Phase:** 6.0
> **Supersedes:** none **Depends on:** ADR 0002 (acceptance gate — adapter results flow through it)
> **Deciders:** repo owner + implementer
## Context
Issue #6 asked for OpenCode (the host application this plugin already runs inside) to be usable as a tier worker — another model family's CLI invoked for delegation, its result routed through the same dispatch/verification path as any model call, with three modes (`off`/`shadow`/`live`), guaranteed non-recursion, and preserved manual tier override.
Two facts from ADR 0002's spike decide the shape:
- OpenCode's plugin hooks can **mutate** tool args (`tool.execute.before`) and tool **output** (`tool.execute.after`), but no hook *replaces* a tool execution. A naïve "run the CLI in `before`, swap the result in `after`" design (stub-and-swap) was prototyped and rejected: the inner tier run still executes (duplicate cost), and the later gate/verify path derived its DoD from the mutated stub prompt — the worker was then verified against the wrong prompt.
- `client.session.prompt` gives the plugin full ownership of a delegation flow, including session creation, producer prompt, and gate.
## Decision
Live mode routes the OpenCode CLI through the **plugin-owned `delegate` tool flow** rather than the task hooks:
1. The CLI runs inside the delegate's producer-attempt slot, with a synthetic producer ID `opencode:<uuid>` (the CLI worker has no server-side session).
2. The artefact (stdout) enters `prepareVerification`/`accept` exactly as a native producer's text does — baseline, deterministic checks, independent grader: unchanged.
3. No task-hook mutation. The stub-and-swap design was deleted entirely.
**Recursion is blocked twice, independently:**
- **Process-level:** the child is spawned with `MODEL_ROUTER_OC_CHILD=1`; `isOcChild()` (read at intercept) forces mode `off`, so a child invoking `delegate` never re-spawns the CLI.
- **State-level:** grader sessions are rejected by `shouldIntercept` (fail-closed), and CLI workers are excluded from native session tracking by construction.
**Manual override is preserved:** only tiers listed in `opencodeAdapter.tiers` are intercepted. A `[tier:X]` tag for any other tier routes natively; a CLI failure on an adapter tier is one failed ladder attempt, and escalation to a **non-adapter tier takes the native path** (by design — the ladder's degradation guarantees survive).
**Agent scoping is fail-closed:** `allowedAgents` names the orchestrator agents permitted to use the adapter. The dispatching agent is memoised from `chat.message` (`tool.execute.before` does not carry `agent`); an unknown agent, or a direct invocation with no session, is refused — never guessed.
**CLI worker identity ceiling (accepted):** `disposeChildSession` is a no-op for `opencode:*` synthetic IDs — there is no native session to delete. Tracked as a known limitation, not a bug.
## Alternatives considered
- **Stub-and-swap via task hooks** (rejected): no hook replaces execution; inner tier runs anyway; gate verified the stub prompt. See Context.
- **SDK-driven OpenCode sessions** (`client.session.prompt` against the host's own server): cleaner session semantics, but it would recurse into the host's model routing — the very loop the guards exist to prevent — and couples the adapter to server availability.
- **Always-on adapter** (no `allowedAgents`): rejected; fail-open allowlists invite the recursion and cost problems the router exists to manage.
## Consequences
- OpenCode's model family is now a routable worker: quality arbitrage across model families with one verification gate.
- CLI latency/cost is unpriced by `costRatio` (tier cost model still assumes native models); accepted for now.
- The adapter is inert by default: shipped `mode: "off"`, `tiers: []`, empty allowlist.
## Verification
- 11 unit tests (modes, guard, fail-closed agents, real spawn/timeout/exit classification).
- 5 integration tests: live CLI routing through the gate; CLI failure → native escalation on non-adapter tiers; no native producer in live mode; recursion guard end-to-end; shadow non-interference.
