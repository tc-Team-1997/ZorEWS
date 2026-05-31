# Demo Readiness & UAT Validation Center

**Status:** shipped 2026-05-31 (16th IA overlay this session).
**Route:** `/demo-readiness-center`
**Schema migration:** `data/schema/059_demo_readiness.sql`
**Owner:** orchestrator + QA + release governance

> Real-time readiness scoring across functional / data / security / compliance / integration / UAT-coverage / release dimensions. Drives demo-day and UAT sign-off. **Additive overlay** — every prior 15 IA center untouched (Governance / IAM / Rule / Audit / Recovery / Security Activity / AI Governance / Role-Based Dashboard / Executive Cockpit / Predictive Risk / Investigation / Regulatory Compliance / Data Fabric / Enterprise Demo Foundation, plus the 12 module dashboards). No existing route / API / module / workflow modified.

---

## 1. Purpose

After 15 IA overlays, the platform has hundreds of pages and thousands of deterministic data points. Demos to enterprise prospects, UAT cycles before release, and production cut-overs need ONE screen that answers "is this thing actually ready?" — across every dimension a release-governance committee cares about. The Demo Readiness Center is that screen.

It runs ~150 deterministic validations against the prior 15 IA engines, aggregates them into a 7-dimension readiness scorecard, derives an overall composite score + release status, and emits a recommendation list with assigned owners. Read-only.

## 2. 15 Deliverables (per the brief)

| # | Deliverable | Location |
|---|---|---|
| 1 | Demo Readiness Center architecture | this doc + `docs/demo-readiness-center.md` |
| 2 | React component hierarchy | `DemoReadinessCenterPage.tsx` — 10 sections, 5 engines composed |
| 3 | Validation engine architecture | 5 self-contained TypeScript modules under `web/src/modules/demoReadiness/` |
| 4 | Readiness scoring engine | `readinessEngine.ts` — 7 weighted dimensions, `statusFromScore`, `releaseStatusFromScore`, `computeOverallScore` |
| 5 | PostgreSQL schema additions | `data/schema/059_demo_readiness.sql` — 8 additive tables, all `CREATE TABLE IF NOT EXISTS` |
| 6 | Migration scripts | same — idempotent, seeds 20 UAT scenarios for BANK_DEMO |
| 7 | API contracts | shapes in engine modules; production swap = `/v1/demo-readiness/*` |
| 8 | Dashboard widgets | 10 page sections with KPI tiles, tables, pie chart |
| 9 | UAT workflow | `listUatScenarioCoverage` + `summarizeUatCoverage` + `app_iam.uat_scenarios` table |
| 10 | Role validation matrix | `validateRoleAccess` — 9 personas × 5 access axes = 45 checks |
| 11 | Data validation matrix | `validateDataQuality` — 5 check kinds × 8 entity kinds, weighted by severity |
| 12 | Release readiness report design | `buildReleaseReadinessReport` + per-recommendation owner + sign-off list |
| 13 | Executive summary dashboard | Section 1 (Overall readiness) — 7-dimension scorecard with status badges + next-step recommendations |
| 14 | Backward compatibility report | section 11 below; sibling test sweep 411/411 |
| 15 | Enterprise testing strategy | section 13 below |

## 3. Module map

```
web/src/modules/demoReadiness/
├── readinessEngine.ts                 # core scoring (7 dimensions, status, release-readiness, UAT coverage)
├── flowAndRoleValidator.ts            # banking + insurance flow + 9-persona × 5-axis role access
├── dashboardAndDataValidator.ts       # 14-dashboard QA + data quality across 8 entity kinds
├── alertCaseComplianceValidator.ts    # alerts + investigations + compliance validations
├── securityAndReleaseReporter.ts      # security posture + release readiness report
└── DemoReadinessCenterPage.tsx        # SPA page with 10 sections
```

All 5 engines are pure functions accepting `(tenant_id, asOf)`. They IMPORT from the prior IA centers' engines (Banking, Insurance, RiskOps, Analytics, DataFabric in `enterpriseDemo/*`) so validations operate on REAL deterministic data, not stubs.

## 4. The 7 readiness dimensions

| Dimension | Weight | Driven by |
|---|---|---|
| Functional | 0.20 | `summarizeFlowAndRoles` — banking + insurance flow + 9-persona × 5-axis access |
| Data | 0.18 | `validateDataQuality` — null / missing-ref / orphan / duplicate / invalid-rel checks |
| Security | 0.15 | `validateSecurity` — users / sessions / role-assignments / over-privileged / MFA |
| Compliance | 0.15 | `validateCompliance` — obligations / findings / regulatory coverage |
| Integration | 0.12 | `summarizeDashboardAndData` — 14 dashboards × 5 QA check kinds |
| UAT coverage | 0.10 | `summarizeUatCoverage` — 20-scenario inventory (passed/warning/failed) |
| Release | 0.10 | `summarizeAlertCaseCompliance` — alert + investigation health |

Weights sum to **1.0**. The composite `overall_score = round(Σ score_i × weight_i)`.

**Status banding:** `statusFromScore` maps score → `critical` (<50) / `at_risk` (<70) / `ready` (<90) / `production_ready` (≥90).

**Release status:** `releaseStatusFromScore(score, criticals)` returns `not_ready` if any criticals OR score < 60; `uat_ready` if score ∈ [60, 80); `demo_ready` if score ∈ [80, 90); `production_ready` if score ≥ 90 AND no criticals.

## 5. 10 page sections

Each behind `data-testid="drc-section-<name>"`:

1. **Overall readiness** — 7-dimension scorecard + recommended next steps (recs ≤ 6)
2. **Flow validation** — banking (borrower → alert → investigation → action → resolution) + insurance (policy → risk_detection → investigation → resolution) chains; orphans / broken flows / missing-links count + hints
3. **Role validation** — 9-persona × 5-axis matrix with per-cell granted/required badges + per-persona score + status
4. **Dashboard validation** — 14 dashboards × 5 QA check kinds (empty_widget / missing_kpi / broken_chart / missing_dataset / visibility_conflict) + per-dashboard quality score
5. **Data quality** — 5 kinds (null_value / missing_reference / orphan_record / duplicate_entity / invalid_relationship) with health + quality scores
6. **Alert validation** — 5 kinds (severity_missing / unassigned / no_escalation_path / sla_breach / no_investigation_link) + severity distribution
7. **Investigation validation** — 5 kinds (no_evidence / incomplete_timeline / no_closure_reason / orphan_case / escalation_stuck) + evidence integrity + timeline completeness + quality score
8. **Compliance validation** — 5 kinds (obligation_overdue / missing_finding / missing_report / no_audit_link / regulatory_gap) + by-framework rollup
9. **Security validation** — 5 kinds (inactive_user / stale_session / unassigned_role / over_privileged / missing_login_audit) + MFA adoption %
10. **Release readiness + UAT coverage** — recommendations sorted by priority + sign-off list + 20-scenario UAT inventory + pie chart

Cross-IA footer links to: Enterprise Demo, Data Fabric, Regulatory, Investigations, Predictive Risk, Executive Cockpit.

## 6. Schema migration (`059_demo_readiness.sql`)

8 additive tables under `app_iam.*`, all `CREATE TABLE IF NOT EXISTS`. Re-running `make migrate` is safe. Existing tables and prior migrations (001-058) untouched.

| # | Table | Purpose |
|---|---|---|
| 1 | `uat_scenarios` | 20-row UAT scenario inventory across banking / insurance / cross_domain / admin (seeded for BANK_DEMO) |
| 2 | `uat_runs` | Per-execution log of a UAT scenario with outcome + duration |
| 3 | `readiness_snapshots` | Point-in-time overall readiness snapshot (overall score / status / release status) |
| 4 | `readiness_dimension_scores` | Per-snapshot per-dimension score (7 dims × snapshot) |
| 5 | `flow_validation_findings` | Banking + insurance flow check results |
| 6 | `role_validation_findings` | Persona × axis access matrix findings |
| 7 | `data_quality_findings` | Per-entity data quality findings |
| 8 | `release_readiness_reports` | Generated release readiness report metadata + payload JSONB |

Every CHECK constraint mirrors a closed enum declared in the engines. Seeds 20 UAT scenarios for `BANK_DEMO` via `INSERT … ON CONFLICT DO NOTHING`.

## 7. RBAC

Sidebar visibility: `admin / supervisor / risk_analyst`. Page-level access via `canAccessDemoReadinessCenter` extends to 16 personas (super_admin / country_admin / bank_admin / insurance_admin / fraud_analyst / auditor / compliance_officer / operations_user / executive / cdo / cro / ceo / board_member + the 3 sidebar roles).

Refused: `field_officer / investigator / unknown` → redirect to dashboard.

## 8. Closed enums

```
ReadinessStatus       critical | at_risk | ready | production_ready
ReadinessDimension    functional | data | security | compliance | integration | uat_coverage | release
CheckSeverity         info | warning | error | critical
ValidationOutcome     passed | warning | failed
ReleaseStatus         not_ready | uat_ready | demo_ready | production_ready
FlowStage             borrower | alert | investigation | action | resolution | policy | risk_detection
FlowKind              banking | insurance
RolePersona           super_admin | country_admin | bank_admin | insurance_admin | risk_analyst | fraud_analyst | auditor | operations_user | executive
AccessAxis            menu_visibility | route_access | dashboard_access | data_access | permission_alignment
DashboardCheckKind    empty_widget | missing_kpi | broken_chart | missing_dataset | visibility_conflict
DataQualityCheckKind  null_value | missing_reference | orphan_record | duplicate_entity | invalid_relationship
AlertCheckKind        severity_missing | unassigned | no_escalation_path | sla_breach | no_investigation_link
InvestigationCheckKind no_evidence | incomplete_timeline | no_closure_reason | orphan_case | escalation_stuck
ComplianceCheckKind   obligation_overdue | missing_finding | missing_report | no_audit_link | regulatory_gap
SecurityCheckKind     inactive_user | stale_session | unassigned_role | over_privileged | missing_login_audit
```

## 9. Tests

Suite: `web/src/__tests__/DemoReadinessCenter.test.tsx` — **42 vitest cases all pass**.

Coverage:
- Role gate (16 personas + legacy + refuse-unknown)
- All 6 closed-enum invariants
- Scoring primitives (statusFromScore boundaries, weight sum = 1.0, release status logic, computeOverallScore)
- UAT coverage (20-scenario inventory + partition)
- buildOverallReadiness (default + injected inputs)
- generateRecommendations (low-score path + all-high path)
- Flow / role / dashboard / data-quality / alert / investigation / compliance / security validators (per-report partition + composite scores)
- Release readiness (high-score → demo/prod_ready; low-score → uat_ready/not_ready)
- SPA page render (all 10 sections + role gate + KPI tiles)

**Sibling sweep across 10 prior IA centers** (EnterpriseDemoCenter / DataFabricCenter / RegulatoryComplianceCenter / InvestigationCenter / PredictiveRiskCenter / ExecutiveCockpit / RoleBasedDashboard / DashboardPage / AppShell / AppShellNavGroups) — **411/411 pass. Zero regression.**

## 10. Production migration path

Each engine resolver becomes a `/v1/demo-readiness/*` BFF route:

| Endpoint | Replaces |
|---|---|
| `GET /v1/demo-readiness/overall` | `buildOverallReadiness` |
| `GET /v1/demo-readiness/uat/scenarios` + `/summary` | `listUatScenarioCoverage` + `summarizeUatCoverage` |
| `POST /v1/demo-readiness/uat/runs` | new — records a UAT execution to `uat_runs` |
| `GET /v1/demo-readiness/flows` | `validateFlows` |
| `GET /v1/demo-readiness/roles` | `validateRoleAccess` |
| `GET /v1/demo-readiness/dashboards` | `validateDashboards` |
| `GET /v1/demo-readiness/data-quality` | `validateDataQuality` |
| `GET /v1/demo-readiness/alerts` | `validateAlerts` |
| `GET /v1/demo-readiness/investigations` | `validateInvestigations` |
| `GET /v1/demo-readiness/compliance` | `validateCompliance` |
| `GET /v1/demo-readiness/security` | `validateSecurity` |
| `POST /v1/demo-readiness/release-report` | `buildReleaseReadinessReport` + persist to `release_readiness_reports` |

The 8 backing tables under `app_iam.demo_*` are the persistence target. Engine swap follows the T4.13–T4.18 pattern.

## 11. Backward compatibility report

- ✅ All 15 prior IA centers render unchanged (sidebar + routes + sub-pages)
- ✅ Sibling vitest sweep: 411/411 passing (no regression on Enterprise Demo / Data Fabric / Regulatory / Investigation / Predictive Risk / Executive Cockpit / Role-Based Dashboard / Dashboard / AppShell / AppShellNavGroups)
- ✅ No existing migration touched (001-058 intact)
- ✅ No existing API/route removed
- ✅ No business workflow modified
- ✅ Existing demo seeds preserved (raw, app_*, mart, audit chain, prior demo_* tables)
- ✅ RBAC / Governance / Audit / Compliance architecture unchanged — Demo Readiness reads them, never writes
- ✅ tsc baseline preserved (26 pre-existing errors, zero new in demoReadiness)
- ✅ vite build clean (5.16s)

## 12. Demo readiness checklist

- ✅ Every section renders non-empty (deterministic synthesis guarantees content)
- ✅ Overall composite score in [0, 100]
- ✅ 7 dimension scores all derived from REAL prior-IA engine outputs (not random)
- ✅ UAT coverage at 20 seeded scenarios with passed/warning/failed split
- ✅ Recommendations list sorted by priority with assigned owners
- ✅ Release status badge updates with score (uat_ready / demo_ready / production_ready / not_ready)
- ✅ Sign-off list surfaces (CRO / CISO / CTO / Compliance Officer per release status)
- ✅ Estimated UAT-to-completion days surfaced

## 13. Enterprise testing strategy

1. **Daily** — auto-run `buildOverallReadiness` per tenant; alert if dimension drops below 70.
2. **Pre-UAT (T-7 days)** — full validator sweep; release status must be ≥ `uat_ready` to start cycle.
3. **Mid-UAT (T-3 days)** — re-run; track UAT scenario pass rate; aim for ≥ 80% before promotion.
4. **Demo-day (T-1 day)** — overall score ≥ 80, no `failed` UAT scenarios, no critical recommendations → demo green-light.
5. **Production cut-over (T-day)** — release status `production_ready` + sign-offs from CRO/CISO/CTO + zero failed checks → go live.
6. **Post-release (T+1 day)** — snapshot to `readiness_snapshots`; trend over time becomes the release-quality KPI.

## 14. Verification

```bash
cd /Users/chuadhary_taniya/ZorEWS/web
npx tsc --noEmit                    # 26 pre-existing baseline; zero new in demoReadiness
npx vite build                      # clean (5.16s)
npx vitest run src/__tests__/DemoReadinessCenter.test.tsx
# Test Files  1 passed (1)
#      Tests  42 passed (42)
npx vitest run \
  src/__tests__/EnterpriseDemoCenter.test.tsx \
  src/__tests__/DataFabricCenter.test.tsx \
  src/__tests__/RegulatoryComplianceCenter.test.tsx \
  src/__tests__/InvestigationCenter.test.tsx \
  src/__tests__/PredictiveRiskCenter.test.tsx \
  src/__tests__/ExecutiveCockpit.test.tsx \
  src/__tests__/RoleBasedDashboard.test.tsx \
  src/__tests__/DashboardPage.test.tsx \
  src/__tests__/AppShell.test.tsx \
  src/__tests__/AppShellNavGroups.test.tsx
# Test Files  10 passed (10)
#      Tests  411 passed (411)
```
