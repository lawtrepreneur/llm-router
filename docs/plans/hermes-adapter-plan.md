# Hermes Adapter — Architecture Plan

**Issue:** #7 · **Status:** plan-only · **Date:** 2026-09-26
**Owner note:** Jev explicitly excluded (per instruction).
**Subsidiary docs:** [docs/plans/hermes-adapter-map.md](docs/plans/hermes-adapter-map.md) (recon), [docs/plans/e2e-fixture-spec.md](docs/plans/e2e-fixture-spec.md) (#10, depends-on #7).

---

## 1. Objective

Fill the `src/adapter/hermes.ts` stub — implement a **thin transport adapter** that hands dispatched tasks to an external Hermes worker and normalizes its response onto `src/contract/routing-decision.ts::RoutingDecision`, mirroring the proven shape of `opencode.ts`. Pure wiring (`shouldIntercept`/`effectiveAdapterMode`) and boundary (`decideRoute`) stay untouched; all impure execution lives behind an injected `exec` in this one file.

The stub's own guardrails already encode most decisions: recursion via `HERMES_CHILD_ENV`, injected `deps.exec` (default deliberately absent until contract lands), timeout normalization, and the `off/shadow/live` mode union. **Do not add new abstractions** — reuse opencode.ts as the mechanical template.

---

## 2. Grounding facts (verified from shipped code)

| Artifact | File:line | Role / fact |
|---|---|---|
| RoutingDecision contract | `src/contract/routing-decision.ts:65-74` | `{ request, candidates, choice?, confidence, reason, fallback?, receipt }`. **This is the adapter's return type.** No extra fields — reuse existing. |
| Receipt metadata | `src/contract/routing-receipt.ts` (+ `routing-decision.ts:24-53`) | `RoutingReceiptMetadata`: requestId/taskId/router/decidedAt/completedAt/candidateCount/selectedTier/confidence/reason/fallback/mode(="live"\|"shadow")/producer. Adapter stamps `mode`, and, where known, `producer`. |
| Opencode reference impl | `src/adapter/opencode.ts:14-155` | Template to copy mechanically: `execFileAsync` wrapper with maxBuffer+kill-on-limit (10 MiB each, default timeout 0=none), recursion guard, `HermesAdapterError` with reason union + cause, `OpenCodeRunDeps`/`runOpenCode(cfg, prompt, cwd, deps, agent?)`, injected exec defaulting to real impl. |
| Opencode child env | `src/adapter/opencode.ts:52-53` | `OC_CHILD_ENV = "MODEL_ROUTER_OC_CHILD"`. Hermes mirrors it as `HERMES_CHILD_ENV = "MODEL_ROUTER_HERMES_CHILD"` (§3). |
| Recursion guard (hermes stub) | `src/adapter/hermes.ts:47-53,110-115` | `isHermesChild()` → throws `recursion`. Keep. |
| Timeout/errors (hermes stub) | `src/adapter/hermes.ts:66-155` | `HermesRunResult { payload, durationMs }`; `HermesRunDeps { exec?, now? }`; reasons `"recursion"\|"disabled"\|"timeout"\|"spawn"\|"exit"\|"handoff"`. Stub already maps timeout/spawn/exit. |
| Eligibility (wiring) | `src/adapter/wiring.ts:15-46` | `shouldIntercept(cfg, tier, agent, {isGrader})`, `effectiveAdapterMode(cfg)` → off/shadow/live; grader ⇒ off; child ⇒ off. **Unchanged.** |
| Router config shape | `src/router/config.ts:552-589` | `OpenCodeAdapterConfig` = `{ mode, tiers, binary, args, timeoutMs, allowedAgents, tierAgents }`. Hermes uses subset: `mode`, `tiers`, `timeoutMs`, `allowedAgents`; add `binary`, maybe `args`, `promptTemplate`. |
| Adapter registry + rollback | `src/adapter/registry.ts:1-37` (imported `src/index.ts:16`) | `AdapterEntry { name, modeKey }`; `rollBackAdapters()` sets each entry's RouterState key to "off". **Hermes registration must be gated on contract + test suite** — do NOT register live. |
| Native dispatch seam | `src/index.ts:530-830` | Orchestrates decision → producer prompt → gate(`accept`) → receipt append. Adapter call is a transport swap inside this flow; the gate/receipt/escalation logic must **not** be reworked. |
| Receipt persistence | `src/receipts/store.ts:191-232` | `createReceiptStore(path)`; `append(record)` validates + allowlists (RECORD_FIELDS) + stamps receiptHash; corrupt record ⇒ throws. Receipt = routing metadata, **not** adapter execution — reuse unchanged. |
| Fixture equivalence | `docs/plans/e2e-fixture-spec.md:1-45` | Composer comparison fields are **adapter-independent**: `{ selectedTier, fallbackAction, fallbackReason, neverFast }`. Adapter-specific envelope (child command, exit code, provider codes) is **excluded** from equality. Hermes must produce the same decision fields so fixtures hold across adapters. |
| Missing contract | `docs/plans/hermes-adapter-map.md:16` + stub §2 | No `src/**/*.hermes`, no handoff impl, no candidate registry file present. #12 (dimension schema + RoutingDecision extension) is the real dependency. Hermes adapter is a **transport shim**, not an inference engine. |

**Conclusion:** this is mechanical porting of opencode.ts into hermes.ts under a documented external contract, with eligibility/wiring/boundary/receipts/fallback/registry reused unchanged. No new module structure required (YAGNI).

---

## 3. Interfaces (exact types — no additions beyond the contract)

### 3.1 Child-env constant (§3)
```ts
export const HERMES_CHILD_ENV = "MODEL_ROUTER_HERMES_CHILD"; // presence ⇒ recursion
```

### 3.2 Config (subset of OpenCodeAdapterConfig) — §4
```ts
export interface HermesAdapterConfig {
  mode: "off" | "shadow" | "live";          // existing union, default off
  tiers: string[];                            // dispatched tiers intercepted
  allowedAgents: string[];                    // fail-closed: empty = nobody
  binary: string;                             // hermes executable/command (e.g. "hermes")
  args: string[] = ["handoff"];               // default handoff verb (TBD on #12)
  timeoutMs: number = 60_000;                 // matches DEFAULT_OPENCODE_ADAPTER
}
```

### 3.3 Run result / deps (§5) — reuse stub verbatim + one change
```ts
export interface HermesRunResult {
  /** Normalized RoutingDecision produced by the worker. */
  decision: RoutingDecision;                  // <-- changed from raw `payload` string
  durationMs: number;
}

export interface HermesRunDeps {
  exec?: (
    prompt: string,
    options: { timeoutMs: number; env: NodeJS.ProcessEnv },
  ) => Promise<{ decision: RoutingDecision }>; // <-- normalizes to decision, not payload
  now?: () => number;
}
```
> The stub's `payload`/`string` return and the “No default until contract is known” guard (§3) **are correct as-is** — leave them until the wire format is confirmed. Do NOT fabricate a JSON schema here.

### 3.4 Adapter config shape in RouterState (§6, registry seam)
Reuses `opencodeAdapter` naming pattern: `hermesAdapterMode?: "off"|"shadow"|"live"` + `hermesAdapter?` optional block mirroring OpenCodeAdapterConfig subset. Registered only once the contract is defined (see §7).

---

## 4. Exact sequence (thin adapter, one impure file)

**Entry point** — nothing here calls the worker. Eligibility is decided upstream (§6). This file exposes exactly two public entry points: `runHermes(cfg, decision, cwd, deps?, agent?)` and `isHermesChild()`.

1. **Decision enters from boundary/index.** The router calls `runHermes(...)` with the normalized `RoutingDecision` (not raw prompt). Adapter does not recompute routing — it is a dumb transport (§2, e2e-fixture-spec "thin").
2. `runHermes`: check `isHermesChild()` → throw `"recursion"` (stub §3, keep verbatim).
3. If `!deps.exec` → throw `"handoff"` (stub §5, keep — blocks premature wiring until contract lands).
4. Serialize decision to the Hermes wire format **defined by #12**, pass via injected `exec`.
5. On success: `return { decision: parsedDecision, durationMs }`. **Normalize**: extract worker fields back into a `RoutingDecision`, stamping only adapter-owned metadata (§3): set `receipt.mode = decision.receipt.mode ?? "live"`, carry through requestId/taskId/producer when known from context.
6. On failure (child throws), translate into `HermesAdapterError` (§7) — mirror opencode's exit-code branch.

---

## 5. Native task/result handoff (§8, §21, #10)

The router already owns the native contract; Hermes inherits it rather than redefining it.

**Wire format:** `decision.request.prompt` is the work text (opencode passes prompt to child; here the worker consumes the full decision). Worker returns a normalized `RoutingDecision` echoing §3 fields: `request.prompt`, `candidates`, optional `choice`, confidence, reason, `receipt.mode`, and `fallback`.

**Handoff boundary:**
- **Task in → result out:** adapter sends the *decision* to Hermes; Hermes returns a *decision*. No prompt/response envelope invented here (avoids scope creep vs opencode).
- **Producer text:** if worker emits plain text, wrap as `{ decision }` — do not duplicate opencode's `<task_result>`/tag unwrapping. Text handling stays in the router/gate layer (§21).
- **Receipt write:** does NOT go through `src/receipts/store.ts` from this file. Receipt append is already owned by index.ts post-gate (§7, §4). The adapter only normalizes; persistence is the shared router flow.

**Reuse over build:** task-in/result-out = transport pass-through of the existing decision shape; do not invent a new handoff protocol — reuse the `RoutingDecision` type end-to-end (§31).

---

## 6. Timeout / error-safe fallback (§9, #20)

Mirrors opencode's maxBuffer/kill + reason mapping (§5). No new fallback path in boundary; failure is **not** auto-retried here — the router's escalation/gate handles it (§7, §4).

| Primitive | Reuse |
|---|---|
| Bound invocation | `execFileAsync`-style wrapper (maxBuffer 10 MiB each, kill on overflow, timeout → SIGTERM) copied from opencode.ts:18-41 |
| Reasons union | `"recursion"\|"disabled"\|"timeout"\|"spawn"\|"exit"\|"handoff"` (stub §2, keep) |
| Child recursion guard | `isHermesChild()` (§3) — fail-closed |
| Fallback reuse | boundary's `canExecuteRoute`/legacy gate + receipts downgrade (no new code; adapter surfaces failure as a rejected handoff, not a silent skip) |

**Failure contract:** on any worker failure, throw the mapped `HermesAdapterError`; the router catch-block (§7) records producer failure and routes to escalation/gate. **No silent degradation** — Hermes is an alternative transport; a failed call surfaces identically to a failed native producer (§21).

---

## 7. Receipts / gates / rollback reuse (§13, #9)

All three are **already generic**; the Hermes adapter touches none of their logic:
- **Receipts:** `RoutingRecord.adapterMode` (opencode-shipped §22; add Hermes as a value if needed — do not change validation shape). Receipt append path in index.ts is transport-agnostic. Reuse unchanged (§4, #9).
- **Gates:** shared by all wirings via one accept/verify code path (single gate); no adapter-specific gating invented. Reuse unchanged (§16, GA-5 invariant).
- **Rollback:** `registerAdapter` + `rollBackAdapters` (§6) — Hermes entry added to `adapterRegistry` **only after** the contract/test suite land; until then `rollBackAdapters` is a no-op for Hermes. No wiring change required now.

---

## 8. Cross-adapter fixture equivalence (§29, #10, e2e-fixture-spec)

This is the correctness gate — the adapter must be transparent to fixtures (§31):
- **Hold invariant:** composer comparison fields `{ selectedTier, fallbackAction, fallbackReason, neverFast }` (§25, §26) are computed by `composeToDecision`, independent of transport. The Hermes adapter returns a `RoutingDecision`; when wired through `decideRouteFromEvidence` with the same evidence/registry, output **must** equal opencode's for the same fixture set.
- **Excluded from equality (§27–30):** raw prompt envelope, child command/exit/stderr, provider request/metadata — i.e. everything that differs by transport. The Hermes adapter must not let these leak into comparison fields.
- **Action:** run `test/unit/e2e-routing-fixtures.test.ts` (or equivalent) with the Hermes adapter injected; assert fixture equality holds for both adapters. Any adapter-specific drift fails this test — the equivalence spec is the acceptance proof (§31, #10).

---

## 9. Sequencing — three-phase, non-blocking stub first

**Phase 0 — Contract (blocks this work).** Confirm wire format + dimension schema from #12; define `hermes-handoff` invocation contract before editing beyond the stub's existing scaffolding. Until then, keep the stub's deliberate `handoff`-not-implemented guard.

**Phase 1 — Transport (thin port of opencode.ts, one impure file):**
1. Copy `execFileAsync` + recursion guard from opencode.ts into hermes.ts (§3).
2. Implement `runHermes(cfg, decision, cwd, deps?, agent?)` returning `{ decision, durationMs }`.
3. Add config shape (subset of OpenCodeAdapterConfig) + RouterState persistence via `writeState({ hermesAdapterMode })` (§6), gated behind contract/registry.

**Phase 2 — Normalization (decision round-trip):** map worker decision → `RoutingDecision`, stamp only adapter-owned metadata (`receipt.mode`, carry-through producer). Ensure fixture-comparison fields survive untouched (§8, #10).

**Phase 3 — Verification (evidence-only):** wire the Hermes adapter through boundary + index as a parallel transport; run e2e fixtures across opencode vs Hermes for equivalence. **Rollback registration last.**

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| External `hermes-handoff` contract undocumented → wrong serialization | High (no contract yet) | High — whole adapter wasted | Block Phase 3 until #12 + wire format defined; keep injected exec for swap without code rewrite |
| Duplicate of opencode.ts drifts out of sync | Medium | Low | Do NOT duplicate logic; reuse the same wrapper pattern, one-file-only impurity (§5) |
| Receipt fields leak adapter-specific noise into comparison fixtures | Medium | High — breaks #10 equivalence | Normalize decision back to `RoutingDecision`; exclude transport fields from equality (§8) |
| Hermes child fails silently (no error surfaced) | Medium | High | Fail-closed: any worker failure throws mapped error, routes to escalation/gate (§6, §9) |

---

## 11. Acceptance checks (verify-and-stop set)

**Non-blocking:**
- [ ] Stub compiles unchanged until #12 contract confirmed; `deps.exec` absent ⇒ `"handoff"` error (§3).
- [ ] No changes to `src/router/boundary.ts`, `src/adapter/wiring.ts`, `docs/plans/*` (recon docs).

**Blocking:**
- [ ] `isHermesChild()` recursion guard throws `"recursion"` when invoked inside a child with env set (§3, #4).
- [ ] Timeout beyond `timeoutMs` throws `"timeout"`.
- [ ] Wire format for `hermes-handoff` + normalization of worker output to `RoutingDecision` fully specified (blocked on #12).
- [ ] e2e fixture suite passes with Hermes adapter injected **and** opencode adapter removed (`neverFast`, `selectedTier`, etc. match) — equivalence proof (§8, #10).
- [ ] `adapterRegistry` entry for Hermes present but non-active (rollback no-op) until contract lands (§6).

---

## Appendix A: File map (do-not-touch vs change)

**Do NOT touch:** `src/contract/routing-decision.ts`, `routing-receipt.ts`, `routing-composer.ts`; `wiring.ts`, `boundary.ts`; `docs/plans/*.md`. These define the shared contract; adapter is a thin consumer.

**Change (minimal):** `src/adapter/hermes.ts` only — port opencode.ts mechanics, reuse stub scaffolding verbatim where already correct (§3–§5). Everything else (§6–§9) reuses existing modules unchanged.
