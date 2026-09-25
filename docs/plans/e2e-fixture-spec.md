# End-to-End Fixture Corpus Specification

**Issue**: #10  
**Status**: composer-level corpus implemented — adapter/execution gates pending  
**Depends-on**: #7 (Hermes adapter surface)  
**Date**: 2026-09-25 · updated after #12 landed

## 1. Fixture schema

### 1.1 Composer-level comparison fields

These are the fields asserted in `test/unit/e2e-routing-fixtures.test.ts` against
`composeToDecision()` output. They are the composer-native surface, not adapter-specific.

| Field | Source in `RoutingDecision` | Type |
|---|---|---|
| `selectedTier` | `decision.choice?.tier ?? null` | `"fast" \| "medium" \| "heavy" \| null` |
| `fallbackAction` | `decision.fallback?.action ?? "none"` | `"escalate" \| "none"` |
| `fallbackReason` | `decision.fallback?.reason` | `string \| undefined` |
| `neverFast` | assertion: `choice?.tier !== "fast"` | `boolean` (fixture metadata) |

**Note**: `STOP`, `confidenceBand`, `riskBand`, `fallbackReasonClass` are NOT emitted by
the composer. They are reserved for later adapter/evaluation normalization (see §5).

### 1.2 Adapter-specific envelope fields (excluded from composer equality)

- Raw prompt/context envelope and request identifiers
- Candidate scores, probability vectors, logits, raw classifier payloads
- OpenCode subprocess command, exit code, stderr, process timing
- Hermes model/provider/request metadata and provider error codes
- Receipt timestamps, trace IDs, token counts, raw latency samples

### 1.3 Actual fixture record shape (implemented)

```ts
// test/fixtures/e2e-routing-fixtures.ts
export interface E2ERoutingFixture {
  id: `FX-${string}`;
  family: FixtureFamily;
  request: RoutingRequest;              // { prompt: string; context?: ... }
  evidence: CompositeEvidence;          // src/contract/routing-composer.ts
  registry: CandidateRegistry;         // src/contract/routing-composer.ts
  expected: {
    selectedTier: "fast" | "medium" | "heavy" | null;
    fallbackAction: "escalate" | "none";
    fallbackReasonPattern?: RegExp;
    neverFast?: boolean;
  };
  riskLevel: "low" | "medium" | "high";
  rationale: string;
}
```

`CompositeEvidence` requires:
- `schemaVersion: SCHEMA_VERSION`
- `complexity`, `risk`: `ScalarComposite` — `{ value, confidence, probabilities: readonly number[], reason, version }`
- `specialty`: `SpecialtyComposite` — `{ value, tier?, confidence, probabilities, reason, version }`
- `availability`, `permission`: `GateComposite` — `{ gates: Record<string, boolean>, confidence, probabilities, reason, version }`
- `calibration` (required): `{ classifierVersion, calibrationVersion, temperature (>0), candidateProbabilities (sum=1), calibratedConfidence }`
- `phase` (optional): `PhaseComposite` — `{ value, confidence, probabilities, reason, version }`

## 2. Fixture records

**Authoritative source**: `test/fixtures/e2e-routing-fixtures.ts`

The executable fixture corpus lives in TypeScript and is the single source of truth.
The duplicate prose catalogue that existed here has been removed to prevent drift.
Fixture IDs, families, evidence, registry, and expected outcomes are defined there
and are verified by `test/unit/e2e-routing-fixtures.test.ts`.

### Implemented fixtures (as of commit a190e06 + review fixes)

| ID | Family | Expected tier | Escalates |
|---|---|---|---|
| FX-001 | execution | fast | — |
| FX-002 | execution | medium | — |
| FX-003 | execution | heavy | — |
| FX-004 | high-risk-downgrade | heavy | — (neverFast) |
| FX-005 | execution | heavy | — |
| FX-006 | mixed-phase | medium | — |
| FX-007 | specialty-match | heavy | — (neverFast) |
| FX-008 | planning | fast | — |
| FX-009 | planning | heavy | — |
| FX-010 | low-confidence | null | escalate |
| FX-011 | malformed-evidence | null | escalate |
| FX-012 | malformed-evidence | null | escalate |
| FX-013 | specialty-miss | null | escalate |
| FX-013B | unknown-candidate | null | escalate |
| FX-014 | unavailable-candidate | null | escalate |
| FX-015 | permission-denial | null | escalate (neverFast) |
| FX-016 | no-eligible-candidate | null | escalate (neverFast) |
| FX-017 | determinism | medium | — |


## 3. Comparison logic

### 3.1 Equality check definition

OpenCode ≡ Hermes for a fixture only when `phase`, `riskBand`, `confidenceBand`, `selectedTier`, `fallbackAction`, and `fallbackReasonClass` match exactly. Adapter-specific envelope fields are ignored. A `STOP` result is equivalent only when both adapters report `fallbackAction: stop` and the same reason class.

### 3.2 Promotion-report metrics

- Fixture pass rate
- High-risk downgrade count
- Fallback rate
- Over-routing rate
- Timeout rate
- Latency p50/p95

## 4. Known gaps pending #12

- Exact score scales, probability validity rules, and low-confidence thresholds.
- The low-margin definition and whether it is absolute or relative.
- Canonical `Choice`, `Score`, and `Noul` serialization and missing-value behavior.
- Specialty vocabulary and tie-breaking when multiple specialties match.
- Whether `critical` is a first-class risk band or a reason modifier on `high`.
- Exact availability and permission state names, including timeout versus unknown.
- Verification-failure promotion semantics and the authoritative fallback reason classes.

## 5. Fixture families coverage matrix

Composer-implementable families (in `test/fixtures/e2e-routing-fixtures.ts`):

| Family | FX IDs | Gate it satisfies |
|---|---|---|
| planning | FX-008, FX-009 | Planning phase does not short-circuit high complexity. |
| execution | FX-001..FX-005 | Low/medium/high complexity routes correctly. |
| mixed-phase | FX-006 | Mixed phase forces floor of medium. |
| specialty-match | FX-007 | Registered specialty tier floor applied. |
| specialty-miss | FX-013 | Unknown specialty without tier → escalate. |
| low-confidence | FX-010 | Confidence < 0.7 → escalate; never selects a tier. |
| malformed-evidence | FX-011, FX-012 | Non-finite / out-of-range probabilities → escalate. |
| unknown-candidate | FX-013B | Gate referencing undeclared candidate ID → escalate. |
| unavailable-candidate | FX-014 | Unavailable target and no eligible candidate above → escalate. |
| permission-denial | FX-015 | All candidates unauthorized → escalate. |
| no-eligible-candidate | FX-016 | Zero eligible candidates → escalate. |
| high-risk-downgrade | FX-004 | High-risk floor prevents fast selection. |
| determinism | FX-017 | Same evidence → deep-equal decisions. |

Deferred families (adapter/execution gate — not faked at composer level):

| Family | Deferred reason |
|---|---|
| classifier-timeout | Requires adapter/transport layer; no composer shim. |
| transport-failure | Same. |
| verification-failure | Receipt verification gate not in composer scope. |
| opencode-hermes-equivalence | Requires both adapters implemented. |
| off-shadow-live-rollout | Requires adapter mode wiring. |
