# Hermes Adapter Reconnaissance Map

**Issue**: #7  
**Status**: reconnaissance-only  
**Date**: 2026-09-25

## 1. Source evidence base

- `src/adapter/opencode.ts:1-139` — process-isolated OpenCode adapter; injected execution dependency, timeout/error normalization, and child recursion guard.
- `src/adapter/wiring.ts:1-47` — pure adapter mode and eligibility checks.
- `src/router/boundary.ts:1-124` — normalized `RoutingDecision` construction, execution gate, fallback, and observational shadow evaluation.
- `src/contract/lane-matrix.ts:1-321` — canonical fast/medium/heavy tiers, mode/task-kind lanes, and lane lookup helpers.
- `src/contract/dispatch-schema.ts:1-238` — dispatch request/result shapes and lightweight validation.
- `src/contract/escalate-schema.ts` — ⚠ INFERRED: required by the requested reconnaissance set, but its contents were not available in the supplied source evidence; exact declarations and line ranges must be verified before implementation.
- `src/contract/routing-decision.ts:1-47` — context supplied with the dispatch; defines `RoutingDecision` (`request`, `candidates`, `choice`, `confidence`, `reason`, `fallback`, `receipt`).
- ⚠ INFERRED: no Hermes adapter, Hermes handoff implementation, candidate registry, or Hermes native execution file was present in the supplied repository inventory.

## 2. Integration surface (file:line map)

| component | file | lines | role |
|---|---|---:|---|
| OpenCode adapter entry point | `src/adapter/opencode.ts` | 89-139 | `runOpenCode()` is the impure invocation boundary; it accepts config, prompt, cwd, injected deps, and optional agent. |
| RoutingDecision production/consumption boundary | `src/router/boundary.ts` | 42-93, 123 | `decideRoute()` builds and returns the normalized decision; callers must not execute a choice when `fallback` exists. |
| Execution eligibility gate | `src/router/boundary.ts` | 26-35 | `canExecuteRoute()` requires a non-fallback live decision with valid confidence. |
| RoutingCandidate registry | `src/router/boundary.ts` | 43-56, 65-70 | ⚠ INFERRED: the supplied code receives the candidate registry as the `candidates` argument; no separate registry module was evidenced. |
| Off/shadow/live mode switch | `src/adapter/wiring.ts` | 15-19, 34-46 | `effectiveAdapterMode()` and `shouldIntercept()` implement mode, grader, tier, and allowed-agent checks. |
| Adapter recursion safety | `src/adapter/opencode.ts` | 45-65, 96-101 | Child environment forces effective off behavior and prevents recursive spawning. |
| Fallback path | `src/router/boundary.ts` | 56-76, 87-90 | Invalid, unknown, or low-confidence choices become `fallback.action = "escalate"`; they are not executable. |
| Permission check point | `src/adapter/wiring.ts` | 29-46 | `allowedAgents` is fail-closed: missing agent or absent allow-list membership returns `off`. |
| Native dispatch contract | `src/contract/dispatch-schema.ts` | 70-107, 149-159 | Dispatch input and result shape available to the adapter boundary; error results use `status: "error"`. |
| Tier/lane registry | `src/contract/lane-matrix.ts` | 125-155, 295-321 | `LANE_MATRIX` and `resolveLane()` define mode/task-kind tier selection. |

## 3. Data-flow diagram (text)

```text
task text / DispatchRequest
        |
        v
phase.detect()  (classifier/phase.ts; context supplied)
        |
        v
dimensions / task kind / mode
        |
        v
composer + candidate set
        |
        v
decideRoute(request, candidates, chooser, options)
        |
        v
RoutingDecision { choice, confidence, reason, fallback, receipt }
        |
        +--> mode=shadow: record decision only; native execution remains authoritative
        |
        +--> mode=live + canExecuteRoute(): Hermes adapter translates choice
        |       |
        |       v
        |   Hermes handoff / native execution
        |
        +--> fallback or permission/validation failure: safe escalation/fallback
```

⚠ INFERRED: `phase.detect()`, the dimensions/composer stages, and the Hermes handoff names are based on the issue and supplied repository context; their call sites were not in the six requested source files.

## 4. Translation point for normalized RoutingDecision

The adapter should inject immediately after the normalized decision is produced and before native execution is selected: `src/router/boundary.ts:42-93`, with the caller-side execution gate at `src/router/boundary.ts:26-35`. This follows the OpenCode pattern of keeping process effects behind a narrow adapter function (`src/adapter/opencode.ts:89-139`) and keeping eligibility pure (`src/adapter/wiring.ts:15-46`).

⚠ INFERRED: the exact Hermes caller file and exact `hermes-handoff` API are not present in the evidence. The thin adapter should receive the already-normalized `RoutingDecision`, not rerun classification or reconstruct candidates.

## 5. Off / shadow / live representation

- **off** — do not invoke the Hermes adapter; preserve Hermes native execution. This is explicit in the OpenCode wiring: mode other than `shadow`/`live` returns `off` (`src/adapter/wiring.ts:15-19, 40-42`).
- **shadow** — invoke classification/translation only for observation and receipt emission; never replace or gate Hermes native execution. The native boundary explicitly treats shadow evaluation as observational (`src/router/boundary.ts:101-121`).
- **live** — invoke the adapter only after mode, tier, agent, and grader checks pass (`src/adapter/wiring.ts:34-46`), then hand off the selected normalized candidate only when `canExecuteRoute()` is true (`src/router/boundary.ts:26-35`).

⚠ INFERRED: Hermes should represent these modes with the same three-state adapter decision and leave Hermes's native executor intact for `off` and `shadow`; the exact handoff call is not evidenced.

## 6. Required test seams

- Inject the classifier CLI runner, analogous to `OpenCodeRunDeps.exec` (`src/adapter/opencode.ts:75-80`), so tests never call an external Jev API.
- Inject clock/time source for deterministic timeout duration and receipt timestamps (`src/adapter/opencode.ts:75-80`; `src/router/boundary.ts:12-20`).
- Inject the candidate list/registry and chooser, using `RouteChooser` (`src/router/boundary.ts:7-10`), to supply fixed fixtures.
- Inject or parameterize Hermes handoff/native execution so shadow tests assert no native replacement and live tests assert one handoff.
- Inject adapter config (`mode`, `tiers`, `allowedAgents`) and grader flag to exercise `shouldIntercept()` (`src/adapter/wiring.ts:34-46`).
- Feed serialized classifier stdout directly to the response parser; test malformed JSON/schema and unknown candidates without subprocesses.
- Capture `RoutingDecision` via `onDecision` and shadow `onDecision` (`src/router/boundary.ts:19-23, 95-119`) for equivalence assertions between OC and Hermes.

## 7. Minimal adapter change list

- Add one thin Hermes adapter module, shaped like `runOpenCode()` (`src/adapter/opencode.ts:89-139`), with a narrow injected runner and typed normalized result.
- Reuse the existing classifier CLI invocation contract; do not duplicate `phase.detect()`, lane selection, or candidate construction. ⚠ INFERRED: the exact CLI command/arguments require verification outside the supplied files.
- Add a pure Hermes wiring function shaped like `effectiveAdapterMode()`/`shouldIntercept()` (`src/adapter/wiring.ts:15-46`) that returns `off | shadow | live` and fails closed on permission checks.
- Translate the classifier result into the existing `RoutingDecision` at the boundary described in section 4; preserve `receipt.mode`, `fallback`, and confidence semantics.
- Add only the Hermes-to-`hermes-handoff` mapping at the native execution edge. ⚠ INFERRED: exact target fields and API names depend on Hermes and #12.
- Add adapter-focused fixture tests with injected runner, chooser, clock, candidate registry, permission config, and native handoff spy; no external Jev/Hermes service.
- Do not alter Hermes native execution for `off` or `shadow`; do not add a second routing policy.

## 8. Failure-path map

| failure type | detection point | policy response | test coverage needed |
|---|---|---|---|
| classifier timeout | adapter runner, analogous to `runOpenCode()` timeout handling (`src/adapter/opencode.ts:106-125`) | return safe fallback/escalation; never execute an unverified choice | injected rejected runner with timeout marker; assert native-safe fallback |
| malformed response | Hermes adapter response parser; ⚠ INFERRED exact parser location | treat as invalid decision and escalate; no candidate execution | invalid JSON, missing fields, NaN/out-of-range confidence |
| unknown candidate | decision boundary membership check (`src/router/boundary.ts:53-63`) | fallback with reason `selected route is not a supplied candidate` | candidate omitted from supplied registry |
| unavailable candidate | ⚠ INFERRED adapter/registry availability check before handoff | fallback/escalate to safe native route; do not call unavailable target | registry marks selected candidate unavailable |
| permission failure | `shouldIntercept()` (`src/adapter/wiring.ts:43-46`) | return `off`; preserve native execution | missing agent, disallowed agent, grader mode |
| verification failure | dispatch result verdict/status (`src/contract/dispatch-schema.ts:114-159`) | represent unmet/error as non-executable and escalate according to native policy | `unmet`, `unverifiable`, and `error` fixtures |
| high-risk downgrade attempt | ⚠ INFERRED policy guard; lane matrix identifies heavy/security/destructive kinds (`src/contract/lane-matrix.ts:48-60`) | reject downgrade and use safe fallback/escalation | heavy/security fixture attempting fast/medium candidate; assert no handoff |

## 9. Open questions / dependency on #12

- What are the canonical dimension names, value domains, and serialization shape for the classifier output?
- Does #12 define whether planning is represented as a dimension, task kind, or explicit candidate constraint?
- Which exact candidate IDs map to Sol, Claude, and the light/standard/heavy execution lanes?
- Does #12 define confidence calculation, threshold ownership, and whether Hermes or this router owns normalization?
- What is the exact `hermes-handoff` request/response contract, including native fallback and permission errors?
- How are unavailable providers represented, and is availability checked during candidate construction or at handoff time?
- What is the authoritative high-risk policy for rejecting a downgrade, and which receipt reason must be recorded?
- Which fields must be preserved across OpenCode and Hermes fixtures to prove equivalent policy decisions?

⚠ INFERRED: all Hermes-specific answers above remain blocked until #12 and the Hermes handoff contract are available.
