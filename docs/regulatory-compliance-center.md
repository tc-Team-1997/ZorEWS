# Regulatory Compliance Center — Architecture

**Status:** Shipped 2026-05-31 · 13th IA addition this session.

Central control tower for regulatory monitoring, compliance tracking, audit
readiness and reporting across **banking + insurance**. Mounted at
`/regulatory-compliance-center` as an **additive overlay** — every existing
module (Audit Center, Governance, IAM, Rule Center, AI Governance, Recovery,
Investigation Center, Predictive Risk Center, Executive Cockpit, Role-Based
Dashboard, Security Activity) is untouched and continues to operate exactly
as before.

---

## 1. Regulatory Center Architecture

```
                      /regulatory-compliance-center
                                 │
                                 ▼
            ┌────────────────────────────────────────┐
            │ RegulatoryComplianceCenterPage (SPA)   │
            │ Role gate via canAccessRegulatoryCenter│
            └───┬──────┬──────┬───────┬──────────────┘
                │      │      │       │
       ┌────────┘      │      │       └──────────────┐
       ▼               ▼      ▼                      ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐
│ regulatory-  │ │ compliance-  │ │ regulatory-  │ │ aiCompliance         │
│ Framework    │ │ Monitoring   │ │ Reporting    │ │ Assistant            │
│ Engine       │ │              │ │ Hub          │ │                      │
│ • obligations│ │ • findings   │ │ • reports    │ │ • gaps + risks       │
│ • workflow   │ │ • command    │ │ • calendar   │ │ • recommendations    │
│   state mc   │ │   center     │ │ • export     │ │ • exception analysis │
│ • frameworks │ │ • heatmap    │ │   receipts   │ │ • exec dashboard     │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────────────┘
                                  │
                                  ▼
                  (production swap — additive APIs)
       ┌──────────────────────────────────────────────────┐
       │  BFF: GET /regulatory-compliance-center          │
       │       GET /compliance-obligations                │
       │       GET /compliance-findings                   │
       │       GET /regulatory-reports                    │
       │       POST /compliance-review                    │
       │       POST /compliance-action                    │
       │       POST /report-export                        │
       │                                                  │
       │  Pg: 7 new app_iam.* tables (migration 056)      │
       └──────────────────────────────────────────────────┘
```

**Design contract.** Engine modules authored in parallel via Workflow tool —
4 subagents in one phase (~2.5 minutes wall-clock, ~2.5M tokens) producing
`regulatoryFrameworkEngine` + `complianceMonitoring` + `regulatoryReportingHub`
+ `aiComplianceAssistant`. tsc clean on first build after 3 unused-import
cleanups + 1 priority-enum mismatch fix.

---

## 2. Banking Compliance Framework

8 frameworks in `BANKING_FRAMEWORKS`:

| Framework | Regulator | Coverage |
|-----------|-----------|----------|
| `rbi` | Reserve Bank of India | Master Circulars · asset classification · IRAC norms |
| `basel_iii` | Basel Committee | Pillar I/II/III — capital, supervisory review, market discipline |
| `basel_iv` | Basel Committee | Final output floor + standardised approach |
| `aml` | FIU-IND / Internal | Suspicious-transaction monitoring + reporting |
| `kyc` | RBI KYC Directions | Customer identification + periodic refresh |
| `credit_risk` | RBI Internal Guidelines | PD / LGD / EAD computation + monitoring |
| `operational_risk` | Basel + RBI | Loss-event tracking + RCSA |
| `regulatory_filings` | Reserve Bank of India | DSB / SAR / ALM / OSMOS returns |

Each framework has a `RegulatoryFrameworkDef` entry in `REGULATORY_FRAMEWORKS`
exposing `label`, `regulator`, `description`, `primary_geography`.

---

## 3. Insurance Compliance Framework

8 frameworks in `INSURANCE_FRAMEWORKS`:

| Framework | Regulator | Coverage |
|-----------|-----------|----------|
| `irdai` | IRDAI | Master regulations + circulars |
| `solvency` | IRDAI + Internal | Solvency ratio + reserve adequacy |
| `claims_governance` | IRDAI | Claims TAT · repudiation review · fraud screening |
| `policy_governance` | IRDAI | Issuance · endorsements · cancellations |
| `persistency` | IRDAI Form-K | 13/25/37/49/61-month persistency tracking |
| `fraud_compliance` | IRDAI Anti-Fraud | Anti-fraud framework + watchlist screening |
| `underwriting_compliance` | IRDAI | UW guidelines · risk-rating · declination tracking |
| `regulatory_filings_insurance` | IRDAI | Form K / L / quarterly returns |

---

## 4. Obligation Registry Design

`ComplianceObligation` record:

```ts
{ obligation_id, tenant_id, regulation, framework, domain, clause,
  category: 'filing' | 'review' | 'audit' | 'submission' | 'board_review' | 'monitoring',
  owner, review_frequency: 'daily'..'annual'..'ad_hoc',
  status: 'compliant' | 'at_risk' | 'overdue' | 'in_review' | 'closed',
  last_review_date, next_due_date, priority: FindingSeverity,
  description, evidence_required }
```

`listObligations(tenant, asOf, filters?)` synthesises ~40 deterministic
obligations per tenant — 20 banking + 20 insurance spread across all 16
frameworks. Status distribution: ~50% compliant / 25% at_risk / 10% overdue /
10% in_review / 5% closed. Sorted by `next_due_date` ascending (earliest-due
first). SPA renders a filterable table with domain × status × category chips.

---

## 5. Compliance Workflow Design

**5-state state machine** with closed-enum status:

```
draft ──→ under_review ──→ approved ──→ submitted ──→ closed
   ▲          │                                          │
   │          ├──→ draft (reject)                        │
   │          └──→ closed                                │
   └─────────────────────────────────────────────────────┘
                    closed → draft (re-open)
```

**6 actions** in `COMPLIANCE_WORKFLOW_ACTIONS`:
- `assign` → sets reviewer (status unchanged)
- `review` → draft → under_review
- `approve` → under_review → approved (stamps approved_at)
- `reject` → under_review → draft
- `escalate` → any non-closed → under_review
- `submit` → approved → submitted (stamps submitted_at)

`applyWorkflowAction(item, action, actor)` is pure — returns a NEW
`ComplianceItem` with status transitioned; throws
`Error("invalid_transition")` on illegal transition. The page surface
renders 5 status-bucket tiles + 6 action buttons + the workflow item table.

---

## 6. Reporting Hub Architecture

8 `REPORT_KINDS` covering the full regulatory output surface:

| Kind | Examples |
|------|----------|
| `rbi` | DSB-I, SAR, OSMOS quarterly |
| `basel` | Pillar III disclosures, LCR/NSFR |
| `aml` | FIU-IND STR/CTR returns |
| `kyc` | Periodic refresh status + escalations |
| `irdai` | Form K, L, quarterly P&L |
| `solvency` | Solvency ratio + reserve adequacy |
| `fraud` | Cross-domain fraud incidence pack |
| `executive_compliance` | Exec dashboard print export |

Each `RegulatoryReportDef` carries `default_format`, `supported_formats`,
`frequency`, `next_due_at`, `page_count`. `listRegulatoryReports(tenant,
asOf, filters?)` returns 16 deterministic definitions (8 kinds × 2
variants). `requestReportExport(req, asOf)` produces a deterministic
`ReportExportReceipt` with `estimated_ready_at` = asOf + page_count × 200 ms
clamped ≥ +5s. Unknown report_id returns `status='failed'` instead of
throwing — keeps the SPA degradation graceful.

`listRegulatoryCalendar(tenant, asOf, daysHorizon=60)` overlays the 5 calendar
entry kinds (filing_deadline / review_cycle / audit_cycle /
regulatory_submission / board_review) with `urgency` derived from
`days_until_due` boundaries (overdue / due_today / due_soon ≤7d / upcoming).

---

## 7. Database Schema (`056_regulatory_compliance.sql`)

All tables under `app_iam.*`. **Additive only — `CREATE TABLE IF NOT
EXISTS`**. Idempotent.

| Table | Purpose |
|-------|---------|
| `regulatory_frameworks` | Closed-enum framework registry; 16-row seed via INSERT ON CONFLICT DO NOTHING |
| `compliance_obligations` | Obligation Registry with CHECK constraints on domain, category, status, frequency, priority enums + partial index on overdue |
| `compliance_reviews` | Review-cycle log per obligation; FK CASCADE |
| `compliance_findings` | Open findings + remediation; partial index `WHERE status IN ('open', 'in_progress')`; FK SET NULL to obligations |
| `regulatory_reports` | Report registry; 8-kind CHECK + format + frequency + page_count CHECK |
| `regulatory_calendar` | Filing deadlines + review cycles + board reviews; FK SET NULL to reports + obligations; partial index `WHERE completed_at IS NULL` |
| `compliance_actions` | Workflow action log (6 actions × 5 status enums); CHECK constraints on action + status transitions |

`BEFORE UPDATE` trigger on `compliance_obligations` keeps `updated_at` fresh.

---

## 8. Migration Scripts

| File | Status | Notes |
|------|--------|-------|
| `data/schema/056_regulatory_compliance.sql` | NEW | 7 tables + 1 trigger + 16-framework seed; idempotent. |
| Existing migrations 001-055 | UNCHANGED | Backward compatible. |

Roll-forward only — every addition is guarded by `IF NOT EXISTS`. Rollback
would be 7 `DROP TABLE` statements; no existing data affected.

---

## 9. APIs

All routes additive; existing `/v1/audit/*` + `/v1/governance/*` +
`/v1/reports/*` surfaces unchanged.

| Method | Path                              | Required scope               | Notes |
|--------|-----------------------------------|------------------------------|-------|
| GET    | `/regulatory-compliance-center`   | analyst+ / exec              | Manifest (frameworks, status enums, action enums) |
| GET    | `/compliance-obligations?…`       | `compliance:list`            | Filter by framework/domain/status/category |
| GET    | `/compliance-findings?…`          | `compliance:list`            | Filter by severity/status/framework/domain |
| GET    | `/regulatory-reports?…`           | `compliance:list`            | Filter by kind/domain/format |
| POST   | `/compliance-review`              | `compliance:review`          | Records review outcome + writes audit event |
| POST   | `/compliance-action`              | `compliance:action`          | Applies workflow action (maker-checker honoured) |
| POST   | `/report-export`                  | `compliance:export`          | Enqueues export; returns receipt with estimated_ready_at |

Envelope follows platform standard `{header, body}` / `{header, error}`.
All enums validated against closed lists; bad input returns
`400 EWS_400_invalid_input`.

Every state-change action writes to the M15.1 audit chain (when wired in
the BFF follow-up) with `event_type: 'compliance.<action>'`.

---

## 10. RBAC Model

**Page gate**: `canAccessRegulatoryCenter(roles)` admits 15 declared roles in
`REGULATORY_ROLES`:

```
super_admin · country_admin · compliance_officer · auditor · risk_analyst ·
fraud_analyst · cro · ceo · cfo · coo · board_member · country_head ·
+ legacy admin / supervisor / executive
```

Brief explicitly lists `compliance_officer` + `auditor` + `risk_analyst` +
exec personas — all granted page access. `field_officer` and `investigator`
are NOT in the list and are bounced to `/`. Sidebar entry is gated to
`['admin', 'supervisor', 'risk_analyst']` for discoverability while the
page-local gate is broader.

**RBAC matrix (`infra/rbac/matrix.json`) untouched** — zero regression on
existing scopes. The 7 API routes above slot into existing/new scope keys
(`compliance:list`, `compliance:review`, `compliance:action`,
`compliance:export`).

---

## 11. AI Compliance Framework

`buildAIComplianceReport(tenant, asOf)` returns:

```ts
{ confidence, model_id: 'compliance-llm', model_version: '1.0.0',
  compliance_gaps: ComplianceGap[],          // 4-7 entries
  upcoming_risks: UpcomingComplianceRisk[],  // 4-7 entries
  recommendations: AIComplianceRecommendation[],  // 5-8 entries
  exception_analysis: ExceptionAnalysisRow[]      // 4-7 entries
}
```

**Each gap** carries `severity` (FindingSeverity) + `missing_obligations[]` +
`recommended_owner`. **Each risk** carries `probability` (0..1) + `impact`
(FindingSeverity) + `horizon_days` (7/30/60/90) + `mitigation_recommendation`.
**Each recommendation** carries `priority` (low/medium/high) + `category`
(policy/training/control/filing/audit) + `target_framework`. **Each
exception** carries `reason` (data_gap/process_failure/system_outage/
regulatory_change/training_gap) + `frequency_30d` + recommended_action.

Production swap: single Claude/Bedrock LLM call returning the same shape;
SPA needs zero changes.

---

## 12. Executive Dashboard

`buildExecutiveComplianceDashboard(tenant, asOf)` returns:

```ts
{ compliance_health_score: 0..100,
  regulatory_risk_score: 0..100,
  open_findings, pending_actions, upcoming_deadlines_count,
  audit_readiness: 'ready' | 'needs_attention' | 'not_ready',
  top_obligations_at_risk: 5 entries,
  compliance_trend_30d: 30 entries (day_offset -29..0 with health + risk),
  regulator_breakdown: 4 entries (RBI / IRDAI / Basel Committee / Internal) }
```

`audit_readiness` derived from `compliance_health_score`:
- `≥ 80` → `ready`
- `50–79` → `needs_attention`
- `< 50` → `not_ready`

SPA renders 4 KPI tiles + 30-day stacked area chart (health vs risk) +
top-5 obligations-at-risk list + regulator breakdown table.

---

## 13. Testing Strategy

| Tier | Coverage | Status |
|------|----------|--------|
| Engine resolvers | REGULATORY_ROLES gate (15+legacy+bounce); 5-status workflow transitions; 6 actions; listObligations shape + filters + tenant divergence + determinism; getObligation hit/miss; applyWorkflowAction (review/approve/submit) | ✅ |
| Framework catalog | 16 frameworks (8 banking + 8 insurance); listFrameworks; getFramework hit/null; REPORT_KINDS = 8; REPORT_FORMATS = pdf/excel/csv | ✅ |
| Findings + monitoring | listFindings shape + filters + determinism; buildComplianceCommandCenter (aggregates + audit_readiness thresholds); buildComplianceHeatmap (16 rows + green/amber/red bands) | ✅ |
| Reporting hub | 16 reports + filters + getRegulatoryReport null on miss; buildReportingHubSummary aggregates; listRegulatoryCalendar urgency classification (overdue/due_today/due_soon/upcoming); requestReportExport deterministic receipt + failed status on unknown id | ✅ |
| AI + Executive | confidence [0,1]; 4-7 gaps + 4-7 risks + 5-8 recommendations + 4-7 exceptions; valid priority + category enums; deterministic; executive dashboard 30-day trend with day_offset -29..0; 5 top obligations; regulator breakdown | ✅ |
| Page render | admin sees 9 sections; risk_analyst + compliance_officer + auditor granted; field_officer bounced; 8 KPI cards + 4 framework lists + 3 obligation domain chips + obligation status/category filters + finding severity chips + 8 report kind chips + 6 workflow actions + 5 workflow buckets + 4 calendar urgency buckets + 4 exec KPIs; filter interaction + export receipt | ✅ |
| Sibling sweep | InvestigationCenter + PredictiveRiskCenter + ExecutiveCockpit + RoleBasedDashboard + AppShell + AppShellNavGroups + DashboardPage = 216/216 | ✅ |
| Build | `tsc --noEmit` clean on all 5 new modules; `vite build` clean (4.96s) | ✅ |

**Total: 67 new tests** in `RegulatoryComplianceCenter.test.tsx`.

---

## 14. Migration Strategy

1. Apply `data/schema/056_regulatory_compliance.sql` via `make migrate` (idempotent).
2. The 16-framework seed populates immediately; obligations + findings +
   reports + calendar + actions tables stay empty until the BFF wire-up
   inserts them.
3. SPA renders against the deterministic engine resolvers from day one —
   no database round-trip required.
4. When the BFF wires the 7 routes from §9, swap resolver bodies to call
   the BFF. SPA surface contract stays stable.
5. Optionally seed `compliance_obligations` from the synthetic resolver
   output as a one-time backfill (`INSERT … ON CONFLICT DO NOTHING`) for
   demo richness.

Roll-forward only.

---

## 15. Backward Compatibility Plan

| Surface | Impact |
|---------|--------|
| Audit Center (`/audit-center`) | UNCHANGED |
| Governance Center (`/admin/governance`) | UNCHANGED |
| IAM Center (`/admin/iam`) | UNCHANGED |
| Rule Center (`/rules/*`) | UNCHANGED |
| Recovery Management (`/recovery-center`) | UNCHANGED |
| AI Governance (`/ai/*`) | UNCHANGED |
| Security Activity Center | UNCHANGED |
| Role-Based Dashboard + Executive Cockpit + Predictive Risk + Investigation | UNCHANGED |
| RBAC matrix (`infra/rbac/matrix.json`) | UNCHANGED |
| App.tsx Route count | 152 → 153 (added 1; zero removed) |
| Sidebar navigation | +1 nav leaf in `action-center` group (after Investigation Center). Zero existing entries removed. |
| Database tables | +7 new tables in `app_iam` (migration 056). Zero existing tables altered. |
| BFF routes | UNCHANGED today (engine renders client-side). Future routes per §9 are additive. |

**Smoke verification post-deploy:**
1. `/audit-center` renders identically.
2. `/admin/governance` renders identically.
3. `/recovery-center` renders identically.
4. `/investigation-center` + `/predictive-risk-center` + `/executive-cockpit` render identically.
5. `make migrate` exits 0.

---

**IA additions this session — 13 total (overlay-not-replacement; additive only; backward-compat preserved every time):**

Rule Center · Audit + Recovery · AI Governance · IAM · Governance · Security
Activity · Recovery Management · Navigation Simplification · Role-Based
Dashboard Engine · Executive Risk Cockpit · Predictive Risk Center ·
Investigation Center · **Regulatory Compliance Center**
