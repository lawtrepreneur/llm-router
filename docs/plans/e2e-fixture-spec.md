# End-to-End Fixture Corpus Specification

**Issue**: #10  
**Status**: draft specification — does not bind public contract  
**Depends-on**: #12 (dimension schema), #7 (Hermes adapter surface)  
**Date**: 2026-09-25

## 1. Fixture schema

### 1.1 Shared comparison fields (OpenCode + Hermes)

These fields are the adapter-neutral comparison surface. They describe the routing outcome, not the shape of either adapter's classifier request or receipt.

| Field name | Type | Description |
|---|---|---|
| `id` | `string` | Stable fixture identifier, such as `FX-001`. |
| `phase` | `planning \| execution \| mixed` | Normalized phase outcome. |
| `riskBand` | `low \| medium \| high` | Normalized risk band; `critical` is represented by `high` plus a critical fallback reason. |
| `confidenceBand` | `low \| medium \| high` | Confidence bucket used for gate comparisons. |
| `selectedTier` | `fast \| medium \| heavy \| STOP` | Normalized selected tier, or `STOP` when no candidate is admissible. |
| `fallbackAction` | `escalate \| stop \| none` | Normalized fallback action. |
| `fallbackReasonClass` | `string` | Stable reason class, not free-form adapter prose. |

### 1.2 Adapter-specific envelope fields

The following fields are excluded from cross-adapter equality checks because they are transport, implementation, or telemetry details:

- Raw prompt/context envelope and request identifiers — adapters may serialize context differently.
- Candidate scores, probability vectors, logits, and raw classifier payloads — evidence representation belongs to each adapter.
- OpenCode subprocess command, exit code, stderr, and process timing — not present in the Hermes envelope.
- Hermes model/provider/request metadata and provider error codes — not present in the OpenCode subprocess envelope.
- Receipt timestamps, trace IDs, token counts, and raw latency samples — compared only through promotion metrics.
- Adapter-specific reason text and serialized fallback objects — compared through `fallbackReasonClass` and `fallbackAction`.

### 1.3 Full fixture record shape (TypeScript-style pseudocode)

```ts
type FixtureRecord = {
  id: string;
  family: FixtureFamily;
  request: { description: string; text: string };
  candidates: Array<{
    id: string;
    tier: "fast" | "medium" | "heavy";
    available: boolean;
    permitted: boolean;
  }>;
  expected: {
    phase: "planning" | "execution" | "mixed";
    riskBand: "low" | "medium" | "high";
    confidenceBand: "low" | "medium" | "high";
    selectedTier: "fast" | "medium" | "heavy" | "STOP";
    fallbackAction: "escalate" | "stop" | "none";
    fallbackReasonClass: string;
  };
  evidence: {
    // #12 dimension schema: complexity, risk, specialty, availability, permission, phase.
    complexity: { level: string; probability?: number | "UNKNOWN" };
    risk: { level: string };
    specialty: { choice: string | null };
    availability: Record<string, "available" | "unavailable" | "UNKNOWN">;
    permission: Record<string, "allowed" | "denied" | "UNKNOWN">;
    phase: "planning" | "execution" | "mixed";
  };
  injectedFailure?:
    | "malformed-probability"
    | "timeout"
    | "classifier-failure"
    | "verification-failure";
};
```

## 2. Fixture records

### FX-001: Planning short-circuit
- **Family**: planning
- **Request metadata**: Plan a secret-free rollout sequence for a notification service.
- **Candidate registry snapshot**: `fast` available, `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: low, `0.92`
  - risk: low
  - specialty: none
  - availability: fast available; medium available; heavy available
  - permission: fast allowed; medium allowed; heavy allowed
  - phase: planning
- **Expected normalized tier**: fast
- **Expected fallback**: none + no-fallback
- **Risk level**: low
- **Rationale**: `plan` matches the existing planning short-circuit and permits direct fast handling.

### FX-002: Read-only lookup
- **Family**: light
- **Request metadata**: Show the contents of a named configuration file without editing it.
- **Candidate registry snapshot**: `fast` available, `medium` available.
- **Dimension evidence** (from #12):
  - complexity: low, `0.95`
  - risk: low
  - specialty: none
  - availability: fast available; medium available
  - permission: fast allowed; medium allowed
  - phase: execution
- **Expected normalized tier**: fast
- **Expected fallback**: none + no-fallback
- **Risk level**: low
- **Rationale**: A bounded read has low complexity and no write or safety signal.

### FX-003: Small code change
- **Family**: standard
- **Request metadata**: Implement a validation check in an existing request handler.
- **Candidate registry snapshot**: `fast` available, `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: medium, `0.78`
  - risk: medium
  - specialty: none
  - availability: fast available; medium available; heavy available
  - permission: fast allowed; medium allowed; heavy allowed
  - phase: execution
- **Expected normalized tier**: medium
- **Expected fallback**: none + no-fallback
- **Risk level**: medium
- **Rationale**: Implementation work is not planning-only and should use the standard lane.

### FX-004: Multi-system migration
- **Family**: heavy
- **Request metadata**: Design and execute a migration strategy across two services with rollback.
- **Candidate registry snapshot**: `fast` available, `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: high, `0.91`
  - risk: high
  - specialty: migration strategy
  - availability: fast available; medium available; heavy available
  - permission: fast allowed; medium allowed; heavy allowed
  - phase: mixed
- **Expected normalized tier**: heavy
- **Expected fallback**: none + no-fallback
- **Risk level**: high
- **Rationale**: Cross-service migration and rollback require the heavy lane despite planning language.

### FX-005: Planning then implementation
- **Family**: mixed-phase
- **Request metadata**: First plan, then implement, test, and document a cache invalidation change.
- **Candidate registry snapshot**: `fast` available, `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: high, `0.84`
  - risk: medium
  - specialty: none
  - availability: fast available; medium available; heavy available
  - permission: fast allowed; medium allowed; heavy allowed
  - phase: mixed
- **Expected normalized tier**: heavy
- **Expected fallback**: none + no-fallback
- **Risk level**: medium
- **Rationale**: The executable portion must prevent a planning-only fast short-circuit.

### FX-006: Security specialist present
- **Family**: specialty-match
- **Request metadata**: Audit an authentication boundary for privilege escalation.
- **Candidate registry snapshot**: `fast` available, `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: high, `0.89`
  - risk: high
  - specialty: security specialist
  - availability: fast available; medium available; heavy available
  - permission: fast allowed; medium allowed; heavy allowed
  - phase: execution
- **Expected normalized tier**: heavy
- **Expected fallback**: none + no-fallback
- **Risk level**: high
- **Rationale**: The explicit security signal maps to a high-risk lane and the specialty is available.

### FX-007: Specialist absent
- **Family**: specialty-miss
- **Request metadata**: Review a database migration for regulatory retention requirements; no compliance specialist is registered.
- **Candidate registry snapshot**: `medium` available, `heavy` available; compliance specialist unavailable.
- **Dimension evidence** (from #12):
  - complexity: high, `0.86`
  - risk: high
  - specialty: compliance specialist (no match)
  - availability: medium available; heavy available; compliance unavailable
  - permission: medium allowed; heavy allowed
  - phase: execution
- **Expected normalized tier**: heavy
- **Expected fallback**: escalate + specialty-unavailable
- **Risk level**: high
- **Rationale**: The router must not silently downgrade when the required specialty is absent.

### FX-008: Low confidence
- **Family**: low-confidence
- **Request metadata**: Classify an underspecified request to “make the service better.”
- **Candidate registry snapshot**: `fast` available, `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: medium, `0.41` ⚠ PENDING-#12 threshold
  - risk: medium
  - specialty: none
  - availability: fast available; medium available; heavy available
  - permission: fast allowed; medium allowed; heavy allowed
  - phase: execution
- **Expected normalized tier**: medium
- **Expected fallback**: escalate + low-confidence
- **Risk level**: medium
- **Rationale**: Ambiguous evidence may select the standard lane, but must produce a promotion-visible low-confidence fallback.

### FX-009: Low margin
- **Family**: low-margin
- **Request metadata**: Compare two plausible approaches to a small API refactor with nearly tied candidates.
- **Candidate registry snapshot**: `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: medium, `0.76` ⚠ PENDING-#12 margin threshold
  - risk: medium
  - specialty: none
  - availability: medium available; heavy available
  - permission: medium allowed; heavy allowed
  - phase: execution
- **Expected normalized tier**: medium
- **Expected fallback**: escalate + low-margin
- **Risk level**: medium
- **Rationale**: A narrow winner is accepted only with an explicit low-margin fallback classification.

### FX-010: Non-finite evidence
- **Family**: malformed-evidence
- **Request metadata**: Implement a small feature with classifier evidence containing `NaN` and probability `1.2`.
- **Candidate registry snapshot**: `fast` available, `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: UNKNOWN ⚠ PENDING-#12 malformed-evidence policy
  - risk: medium
  - specialty: none
  - availability: fast available; medium available; heavy available
  - permission: fast allowed; medium allowed; heavy allowed
  - phase: execution
- **Expected normalized tier**: medium
- **Expected fallback**: escalate + malformed-evidence
- **Risk level**: medium
- **Rationale**: Invalid numeric evidence must not become false certainty or route to fast.

### FX-011: Unknown candidate
- **Family**: unknown-candidate
- **Request metadata**: Route a code review when the registry contains an unrecognized candidate identifier.
- **Candidate registry snapshot**: `medium` available, `heavy` available, `mystery-v9` unknown.
- **Dimension evidence** (from #12):
  - complexity: medium, `0.74`
  - risk: medium
  - specialty: none
  - availability: medium available; heavy available; mystery-v9 UNKNOWN
  - permission: medium allowed; heavy allowed; mystery-v9 UNKNOWN
  - phase: execution
- **Expected normalized tier**: medium
- **Expected fallback**: escalate + unknown-candidate
- **Risk level**: medium
- **Rationale**: Unknown entries are excluded from selection and surfaced rather than treated as available.

### FX-012: Registered but unavailable heavy
- **Family**: unavailable-candidate
- **Request metadata**: Run a performance diagnosis while the heavy worker is offline.
- **Candidate registry snapshot**: `medium` available, `heavy` unavailable.
- **Dimension evidence** (from #12):
  - complexity: high, `0.88`
  - risk: medium
  - specialty: performance
  - availability: medium available; heavy unavailable
  - permission: medium allowed; heavy allowed
  - phase: execution
- **Expected normalized tier**: medium
- **Expected fallback**: escalate + candidate-unavailable
- **Risk level**: medium
- **Rationale**: The best available candidate is used, while the unavailable heavy target remains visible in the fallback class.

### FX-013: Permission denied
- **Family**: permission-denial
- **Request metadata**: Apply a production configuration change without production-write permission.
- **Candidate registry snapshot**: `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: high, `0.87`
  - risk: high
  - specialty: config update
  - availability: medium available; heavy available
  - permission: medium denied; heavy denied
  - phase: execution
- **Expected normalized tier**: STOP
- **Expected fallback**: stop + permission-denied
- **Risk level**: high
- **Rationale**: No tier may bypass a denied permission at the execution boundary.

### FX-014: Classifier timeout
- **Family**: classifier-timeout
- **Request metadata**: Diagnose repeated failures in a cross-service deployment; classifier exceeds its deadline.
- **Candidate registry snapshot**: `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: UNKNOWN ⚠ PENDING-#12 timeout evidence
  - risk: high
  - specialty: deployment
  - availability: medium available; heavy available
  - permission: medium allowed; heavy allowed
  - phase: mixed
- **Expected normalized tier**: heavy
- **Expected fallback**: escalate + classifier-timeout
- **Risk level**: high
- **Rationale**: Timeout fails closed toward the safe heavier tier rather than selecting fast from partial evidence.

### FX-015: Classifier hard failure
- **Family**: classifier-timeout
- **Request metadata**: Classify an implementation request after the classifier subprocess exits non-zero.
- **Candidate registry snapshot**: `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: UNKNOWN ⚠ PENDING-#12 failure evidence
  - risk: medium
  - specialty: none
  - availability: medium available; heavy available
  - permission: medium allowed; heavy allowed
  - phase: execution
- **Expected normalized tier**: heavy
- **Expected fallback**: escalate + classifier-failure
- **Risk level**: medium
- **Rationale**: A classifier failure uses the conservative execution path and records the failure.

### FX-016: Verification failure
- **Family**: verification-failure
- **Request metadata**: Apply a low-risk edit whose post-run verification reports a failed check.
- **Candidate registry snapshot**: `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: medium, `0.79`
  - risk: medium
  - specialty: none
  - availability: medium available; heavy available
  - permission: medium allowed; heavy allowed
  - phase: execution
- **Expected normalized tier**: heavy
- **Expected fallback**: escalate + verification-failure
- **Risk level**: medium
- **Rationale**: Verification failure promotes the next safe tier and must not be reported as a successful medium run.

### FX-017: High-risk downgrade attempt
- **Family**: high-risk-downgrade
- **Request metadata**: Perform a destructive production data operation with an explicit fast-tier override.
- **Candidate registry snapshot**: `fast` available, `medium` available, `heavy` available.
- **Dimension evidence** (from #12):
  - complexity: high, `0.97`
  - risk: high
  - specialty: destructive-operation
  - availability: fast available; medium available; heavy available
  - permission: fast allowed; medium allowed; heavy allowed
  - phase: execution
- **Expected normalized tier**: heavy
- **Expected fallback**: stop + downgrade-blocked
- **Risk level**: critical
- **Rationale**: Existing `detect()` rules are promote-only; a caller cannot force a high-risk lane down to fast.

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

| Family | FX IDs | Gate it satisfies |
|---|---|---|
| planning | FX-001 | Planning short-circuit remains fast. |
| light | FX-002 | Bounded read routes to fast. |
| standard | FX-003 | Normal implementation routes to medium. |
| heavy | FX-004 | High complexity/migration routes to heavy. |
| mixed-phase | FX-005 | Mixed plan/execute work is not fast-only. |
| specialty-match | FX-006 | Matching specialty is selected. |
| specialty-miss | FX-007 | Missing specialty is surfaced and not downgraded. |
| low-confidence | FX-008 | Low confidence produces fallback telemetry. |
| low-margin | FX-009 | Narrow candidate margin is surfaced. |
| malformed-evidence | FX-010 | Non-finite/out-of-range evidence fails safely. |
| unknown-candidate | FX-011 | Unknown registry entries are not selected. |
| unavailable-candidate | FX-012 | Unavailable candidates trigger conservative fallback. |
| permission-denial | FX-013 | Permission denial stops execution. |
| classifier-timeout | FX-014, FX-015 | Timeout/failure cannot route from partial evidence. |
| verification-failure | FX-016 | Failed verification promotes and records failure. |
| high-risk-downgrade | FX-017 | High-risk downgrade is blocked. |
