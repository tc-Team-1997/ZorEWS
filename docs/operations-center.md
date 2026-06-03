# Production Operations Center — Architecture Reference

**Phase 23 IA overlay · additive on top of all 22 prior modules**

---

## 1. Architecture Overview

The Production Operations Center (POC) is a unified, read-only observability hub that aggregates operational signals from all 16 BIL platform modules into a single pane of glass. It is implemented as a pure-function engine in `services/bff/src/modules/operationsCenter/operationsCenterEngine.ts` — no I/O, no React, no side-effects — and consumed by the `OperationsCenterPage.tsx` SPA surface.

### Design Principles

- **Pure-function, deterministic synthesis.** Every builder function accepts `(tenant_id: string, asOf: Date)` and returns the same output for the same inputs. Production deployments replace the synthesis layer with real database queries while preserving identical return shapes.
- **Additive-only IA overlay.** All 22 prior modules are untouched. The engine exports new symbols exclusively; no imports from this file pollute existing modules.
- **Tenant isolation.** Every synthetic data point is seeded with `FNV-1a(tenant_id + section_key + dayKey(asOf))`. BIL and BANK_DEMO produce independent, non-overlapping operational views.
- **RBAC-gated surface.** The `canAccessOperationsCenter(roles)` guard admits 18 permitted roles (admin, cro, operations_manager, coo, ceo, board_member, etc.) and rejects all others.

### Section Map

| # | Section | Builder Function |
|---|---------|-----------------|
| 1 | Platform Health Command Center | `buildPlatformHealthKpis` |
| 2 | Service Registry | `buildServiceRegistry` |
| 3 | API Operations | `buildApiOperations` |
| 4 | Incident Management | `buildIncidents` |
| 5 | Change Management | `buildChangeRequests` |
| 6 | Release Management | `buildReleases` |
| 7 | Environment Management | `buildEnvironments` |
| 8 | Capacity & Performance | `buildCapacityMetrics` |
| 9 | Security Operations | `buildSecurityOpsView` |
| 10 | Business Continuity | `buildBusinessContinuity` |
| 11 | Observability Dashboard | `buildObservabilitySnapshot` |
| 12 | Executive Operations Dashboard | `buildExecutiveOpsDashboard` |
| 13 | AI Operations Insights | `buildAiOpsInsights` |

---

## 2. Service Registry

The service registry tracks 12 core platform services, each mapped to a canonical port, owner team, and default status pool.

### Tracked Services

| Service | Port | Owner Team |
|---------|------|------------|
| Alert Engine | 8081 | Risk Platform Team |
| Rules Engine | 8082 | Risk Platform Team |
| AI Engine | 8083 | AI/ML Team |
| Investigation Engine | 8084 | Case Management Team |
| Compliance Engine | 8085 | Compliance Team |
| Integration Engine | 8086 | Integration Team |
| Event Streaming Engine | 8087 | Data Platform Team |
| Reporting Engine | 8088 | Analytics Team |
| IAM Service | 8080 | Security Team |
| BFF Gateway | 8000 | Frontend Platform Team |
| Audit Service | 8089 | Governance Team |
| Recovery Service | 8090 | Operations Team |

### Service Entry Shape

Each `ServiceEntry` carries: `service_id`, `name`, `version`, `owner`, `environment`, `uptime_pct`, `status`, `last_deployment`, `health_checks_passed / total`, `avg_response_ms`, `instances`, `cpu_pct`, `memory_pct`, `dependencies[]`, `port`.

### Status Classification

Five statuses are tracked: `healthy`, `degraded`, `critical`, `offline`, `maintenance`. The STATUS_POOL in the engine assigns `maintenance` to the 12th service slot and `degraded` to the 6th, giving a realistic distribution where ~83% of services are healthy on any given day.

Healthy services synthesise:
- `avg_response_ms` in [28, 100] ms
- `cpu_pct` in [20, 65]%
- `uptime_pct` in [99.5, 100]%

Degraded/critical services synthesise:
- `avg_response_ms` in [180, 500] ms
- `cpu_pct` in [65, 90]%
- `uptime_pct` in [92, 98]%

---

## 3. Incident Management (P1–P4 · 6-state workflow)

### Severity Classification

| Severity | SLA Target | War Room | Postmortem |
|----------|-----------|----------|------------|
| P1 | 30–120 min resolution | Required (war_room_active=true when investigating) | Mandatory within 3–10 days |
| P2 | 60–240 min resolution | Optional | Mandatory |
| P3 | 120–600 min resolution | Not required | Recommended |
| P4 | Best effort | Not required | Optional |

### 6-State Workflow

```
open → assigned → investigating → mitigated → resolved → closed
```

State transition rules enforced by the engine:
- `resolved` and `closed` states always have `resolved_at` non-null.
- `open` and `investigating` states always have `resolved_at = null`.
- P1 incidents in `investigating` state activate the war room (`war_room_active = true`).
- All resolved/closed incidents carry a `postmortem_due` date (3–10 days after resolution).

### Incident Data Model

```typescript
interface Incident {
  incident_id: string;         // INC-YYYYMMDD-NNNN
  severity: IncidentSeverity;  // P1|P2|P3|P4
  state: IncidentState;
  affected_service: ServiceName;
  owner: string;
  root_cause: string;
  business_impact: string;
  opened_at: string;
  resolved_at: string | null;
  resolution_time_min: number | null;
  war_room_active: boolean;
  postmortem_due: string | null;
}
```

The engine maintains 8 concurrent incidents representing real-world operational scenarios: memory pressure, database connection pool exhaustion, Kafka partition lag, certificate expiry, deployment failures, disk I/O saturation, and network connectivity issues.

---

## 4. Change Management (5-state workflow · rollback planning)

### Change States

```
draft → review → approved → implemented → rejected
```

Every change request carries:
- `change_type`: `standard` | `normal` | `emergency`
- `risk_level`: `low` | `medium` | `high`
- `has_rollback: true` — mandatory for all changes (invariant enforced by engine)
- `estimated_downtime_min` — zero for most changes (blue/green deployments)
- `rollback_plan` — pre-written rollback script with estimated 8-minute reversal time

### Approval Gate

Changes in `approved` or `implemented` states always have a non-null `approver` (CTO, Ops Head, or CISO). Changes in `draft`, `review`, or `rejected` states have `approver = null`. This enforces the 4-eyes approval requirement for production changes.

### Emergency Change Handling

Approximately 20% of changes are classified `emergency`. Emergency changes bypass the standard CAB review window but still require an approver and a documented rollback plan. The ITSM integration (Year-2 roadmap) will route emergency changes to an on-call approver via PagerDuty.

---

## 5. Release Management (deployment tracking · success rates)

### Release Data Model

The engine tracks 10 most-recent production deployments per tenant per day. Each `ReleaseEntry` carries version, service, deployment timestamp, deployer identity, success flag, rollback indicator, deployment duration, and release notes.

Key invariants:
- `rollback_triggered = true` implies `success = false` (a rollback is only possible after a failed deployment)
- `deployment_time_min` is always > 0 (range: 4–26 minutes for blue/green deployments)
- `bug_fixes_count >= 1` for the majority of releases (at least one bug fix per release is enforced by the lower bound in synthesis)

### Release Success Rate

The synthesis engine sets failure probability at ~8% (`rng() > 0.08 → success`), giving a realistic ~92% release success rate that matches the executive dashboard's `release_success_rate_pct` metric.

---

## 6. Environment Management (DEV → SIT → UAT → PRE-PROD → PROD)

### Five-Tier Pipeline

| Environment | Label | Health Floor | Uptime Range |
|-------------|-------|-------------|-------------|
| development | DEV | 70% | 5–65 days |
| sit | SIT | 70% | 5–65 days |
| uat | UAT | 70% | 5–65 days |
| pre_production | PRE-PROD | 70% | 5–65 days |
| production | PROD | 88% | 45–225 days |

Production receives privileged treatment in synthesis:
- Health score floored at 88% (vs 70% for lower environments).
- Uptime days minimum 45 (vs 5 for lower environments), guaranteeing production always shows the highest `uptime_days` value across the fleet.
- Services total always equals `SERVICE_NAMES.length` (12) — all services run in production.
- Lower environments may run 6–12 services depending on day-seeded RNG.

### Health Color Mapping

```
health_score >= 88  →  green
health_score >= 72  →  amber
health_score < 72   →  red
```

---

## 7. Capacity Planning (CPU / Memory / Storage forecasting)

### Metrics Tracked

The `CapacityMetrics` interface provides a comprehensive snapshot of current and forecasted resource utilisation:

| Metric | Description |
|--------|-------------|
| `cpu_current_pct` | Current cluster-wide CPU utilisation |
| `cpu_forecast_7d_pct` | Projected CPU in 7 days (linear trend) |
| `memory_current_pct` | Current memory utilisation |
| `memory_forecast_7d_pct` | Projected memory in 7 days |
| `storage_current_pct` | Primary storage utilisation |
| `storage_forecast_7d_pct` | Projected storage in 7 days |
| `db_connections_pct` | PostgreSQL connection pool utilisation |
| `db_iops_pct` | Aurora I/O operations per second vs capacity |
| `queue_backlog` | Kafka consumer lag (messages behind) |
| `network_bandwidth_pct` | Network bandwidth utilisation |
| `scale_out_recommended` | True if `cpu > 72%` OR `memory > 78%` |
| `capacity_headroom_days` | Days until capacity action required |
| `pod_count / pod_capacity` | Current vs maximum Kubernetes pod count |
| `hourly_trend` | 12-hour rolling CPU, memory, requests trend |

### Scale-Out Decision Logic

```typescript
scale_out_recommended = cpu_current_pct > 72 || memory_current_pct > 78
```

When `scale_out_recommended = true`, the Operations Center surfaces a prominent warning with a recommended action (horizontal pod autoscaler adjustment or node group expansion via Karpenter).

### Capacity Headroom Formula

```typescript
capacity_headroom_days = clamp(90 - (cpu + memory) / 2, 10, 90)
```

At 50% average utilisation the headroom is 65 days. At 80% average utilisation the headroom drops to 10 days, triggering an immediate capacity review.

---

## 8. Security Operations (integrated with Security Activity Center)

The Security Ops section surfaces a focused operational view of the platform's security posture, complementing the dedicated Security Activity Center module (Phase 19).

### Metrics

| Metric | Synthesis Range |
|--------|----------------|
| `failed_logins_24h` | 0–28 |
| `suspicious_activities_24h` | 0–6 |
| `mfa_compliance_pct` | 96–99.8% |
| `vulnerability_critical` | 0–2 |
| `vulnerability_high` | 0–5 |
| `patch_compliance_pct` | 92–99.8% |
| `security_score` | 78–96 |

### Recent Security Events

The engine surfaces 5 recent security events with severity classification (`info` / `warning`), timestamps, and actor attribution. Example events tracked:

- Admin login from new IP with 2FA verification
- Service account password rotation
- Brute force attempt blocked
- Privilege escalation request with CRO approval
- Dormant API key revocation (>90 days inactive)

### Integration Points

- **M1 IAM Service**: Feeds failed login counts and MFA compliance data.
- **M15 Audit Service**: Provides the privilege changes and security event stream.
- **M1.2 API Keys**: Dormant key detection connects to the API key lifecycle lifecycle distribution analytics (M1.10/M1.13).

---

## 9. Business Continuity (RTO/RPO tracking · DR readiness)

### Recovery Targets

| Metric | Target | Tested Range |
|--------|--------|-------------|
| RTO (Recovery Time Objective) | 15 minutes | 12–40 minutes tested |
| RPO (Recovery Point Objective) | 5 minutes | 3–7 minutes tested |

### DR Readiness Assessment

The `BusinessContinuityStatus` interface tracks:

- `backup_status`: `current` (>95% probability) or `stale` (<5% probability). `failed` status is not synthesised but is supported for production alerting.
- `recovery_readiness`: Always `ready` in synthesis (reflects the nominal operating state post Phase 5 T5.2–T5.3).
- `dr_readiness`: `ready` (80% probability) or `partial` (20% probability).
- `failover_tested`: True for ~85% of tenants (reflects quarterly DR drill cadence per `docs/dr-runbook.md`).

### Recovery Tier (Service Prioritisation)

The top 6 services are stratified into a recovery tier with per-service RTO and RPO targets:

```typescript
recovery_tier: [
  { service: 'Alert Engine',    rto_min: 5–30,  rpo_min: 1–9, status: 'ready'|'partial'|'untested' },
  { service: 'Rules Engine',    ... },
  { service: 'AI Engine',       ... },
  { service: 'Investigation Engine', ... },
  { service: 'Compliance Engine', ... },
  { service: 'Integration Engine', ... },
]
```

Status distribution across tiers: ~60% `ready`, ~25% `partial`, ~15% `untested`.

---

## 10. Observability (logs · metrics · traces · alerts · dependencies)

### Data Points

The `ObservabilitySnapshot` captures the four pillars of observability:

**Logs**
- `logs_per_min`: 2,800–5,000 log events per minute platform-wide.
- `error_logs_per_min`: 8–40 error-level logs per minute. Always less than `logs_per_min`.

**Traces**
- `traces_per_min`: 380–800 distributed traces per minute.

**Metrics Anomalies**
- `metric_anomalies_24h`: 0–8 anomalous metric patterns detected in the last 24 hours.

**Alerts**
- `active_alerts`: 0–12 firing Grafana/CloudWatch alert rules.
- `alert_noise_ratio`: 0.08–0.20 (noise-to-signal ratio for active alerts).

### Service Dependency Graph

The engine tracks 6 critical service-to-infrastructure dependencies:

| From Service | To Dependency | Baseline Latency |
|-------------|--------------|-----------------|
| Alert Engine | PostgreSQL | 8 ms |
| AI Engine | Feature Store | 42 ms |
| Rules Engine | Kafka | 12 ms |
| Compliance Engine | PostgreSQL | 9 ms |
| BFF Gateway | Alert Engine | 35 ms |
| Event Streaming Engine | Kafka | 6 ms |

Each dependency link carries a synthesised `status` (`ok` / `slow` / `down`) and a jittered `latency_ms` to reflect real-world variability.

### Top Error Sources

Four services from the registry are selected as top error sources with `error_count` (0–45) and a canonical `top_error` message sampled from a pool of realistic platform errors (connection pool exhaustion, schema validation failures, downstream service unavailability, GC pressure).

---

## 11. AI Operations Insights (failure prediction · capacity forecasting)

The AI Insights section provides 6 proactive, ML-derived operational recommendations sourced from `buildAiOpsInsights`. Unlike the reactive incident management view, AI Ops surfaces **predictive** findings before they become incidents.

### Insight Types

| Type | Description |
|------|-------------|
| `failure_prediction` | Predicted service failure based on resource trend analysis |
| `capacity_forecast` | Projected capacity exhaustion with timeline |
| `incident_hotspot` | Recurring failure pattern identification |
| `release_risk` | High-risk deployment window detection |
| `recommendation` | Optimisation or right-sizing opportunity |

### Insight Severity Levels

- `critical`: Immediate action required (e.g., memory exhaustion in 18 hours).
- `warning`: Action required within 24–72 hours (e.g., deployment window risk, recurring failure pattern).
- `info`: Preventive or optimisation action (e.g., connection pool right-sizing, certificate renewal).

### Confidence Scoring

Each insight carries a `confidence_score` in [0, 1] (synthesised range: 0.74–0.98). Production implementation will derive this from the actual ML model's posterior probability.

### Sample Insight — Failure Prediction

```
Type: failure_prediction
Severity: warning
Title: AI Engine Memory Exhaustion in ~18 Hours
Description: Memory usage trending at +2.4%/hour. At current rate,
             OOM-kill threshold reached in 18 hours.
Recommendation: Restart AI Engine with increased heap allocation
               (8GB → 12GB) during next maintenance window.
Confidence: 0.91
Predicted Impact: SLA breach probability 72% in next 24h
```

---

## 12. Testing Strategy

### Test Suite Location

`web/src/__tests__/OperationsCenter.test.tsx`

### Coverage Summary

102 tests across 15 describe groups:

| Group | Tests | Scope |
|-------|-------|-------|
| canAccessOperationsCenter | 5 | RBAC guard — roles allow/deny |
| Enum constants | 6 | Shape + cardinality of all exported enums |
| buildPlatformHealthKpis | 10 | Range bounds, invariants, determinism |
| buildServiceRegistry | 10 | 12-service count, per-field shapes |
| buildApiOperations | 8 | 10-API count, latency ordering |
| buildIncidents | 10 | 8-incident count, state/severity rules |
| buildChangeRequests | 8 | 8-CR count, has_rollback=true invariant |
| buildReleases | 8 | 10-release count, rollback⇒!success |
| buildEnvironments | 8 | 5-env count, prod uptime supremacy |
| buildCapacityMetrics | 8 | Capacity bounds, hourly trend length |
| buildSecurityOpsView | 6 | Security metric bounds |
| buildBusinessContinuity | 6 | RTO/RPO positivity, recovery_tier length |
| buildObservabilitySnapshot | 6 | Log ordering, dependency count |
| buildExecutiveOpsDashboard | 6 | Availability bounds, narrative non-empty |
| buildAiOpsInsights | 6 | 6 insights, confidence [0,1], type validity |

### Key Invariants Tested

1. **Determinism**: Every builder returns identical output for `(TENANT, AS_OF)` across two calls.
2. **Rollback ⇒ failure**: `rollback_triggered = true` in releases always co-occurs with `success = false`.
3. **Resolved incidents have timestamps**: `resolved_at` is non-null for `resolved` and `closed` states.
4. **P1 war room activation**: `war_room_active = true` only when `severity = P1 AND state = investigating`.
5. **Production environment superiority**: Production `uptime_days` is always the highest across all 5 environments.
6. **has_rollback invariant**: Every change request has `has_rollback = true`.
7. **Error logs bounded by total logs**: `error_logs_per_min < logs_per_min` always.
8. **Green health ⇒ score ≥ 90**: The health colour derivation logic is consistent with the score thresholds.

---

## 13. Backward Compatibility

The Operations Center is a Phase 23 **additive-only** IA overlay. All symbols are newly exported from `operationsCenterEngine.ts`:

- No existing module imports from this file.
- No existing routes are modified.
- The `OperationsCenterPage.tsx` is a new route (`/operations-center`) with its own `requireRole` gate.
- All 22 prior module test suites remain unaffected (verified by the CI gate at `.github/workflows/services-ci.yml`).

Production deployment path:
1. Replace each `build*` function with a corresponding `pg*Reader` that queries the unified view layer (`unified.*` views from T4.25).
2. The `IOperationsCenterStore` interface (planned, Year-2) will accept either the synthetic engine or a Postgres-backed reader without changing the SPA contract.
3. The `canAccessOperationsCenter` RBAC check is already wired to the same `OPERATIONS_ROLES` constant used by all other enterprise-role guarded surfaces.

---

*Last updated: 2026-06-03 — Phase 23 Production Operations Center shipped.*
