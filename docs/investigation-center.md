# Investigation Center — Architecture

**Status:** Shipped 2026-05-31 · 12th IA addition this session.

The Investigation Center transforms ZorEWS's existing case-management
surface into a full enterprise investigation + case intelligence platform.
Mounted at `/investigation-center` as an **additive overlay** — every
existing CMS module (AlertListPage, CaseWorkflowPage, CmsCaseListPage,
CmsCaseKanbanPage, CmsCaseDetailPage, CaseTrackingTimeline,
CaseCausalAnalysisPage) is untouched and continues to operate exactly
as before.

---

## 1. Investigation Center Architecture

```
                         /investigation-center
                                  │
                                  ▼
              ┌─────────────────────────────────────────┐
              │  InvestigationCenterPage (SPA only)     │
              │  Role gate via canAccessInvestigation   │
              └────┬─────┬─────┬─────────┬──────────────┘
                   │     │     │         │
        ┌──────────┘     │     │         └──────────────┐
        ▼                ▼     ▼                        ▼
┌─────────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────────────┐
│ investigation-  │ │ evidence-    │ │ ai-          │ │ investigation-      │
│ Engine          │ │ Vault        │ │ Investigator │ │ Analytics           │
│ • listInvest…   │ │ • listEvid…  │ │ • buildAI…   │ │ • buildAnalytics    │
│ • getInvest…    │ │ • verifyEvid │ │   Report     │ │ • buildExecutiveView│
│ • applyAction   │ │ • vault…     │ │ • root cause │ │ • productivity      │
│ • commandCenter │ │   Summary    │ │ • drivers    │ │ • volume trend      │
│ • workflow      │ │ • chain of   │ │ • related    │ │ • SLA + escalation  │
│   transitions   │ │   custody    │ │   entities   │ │   rates             │
└─────────────────┘ └──────────────┘ └──────────────┘ └─────────────────────┘
                                  │
                                  ▼
                    (production swap — additive APIs)
       ┌──────────────────────────────────────────────────┐
       │  BFF: GET /investigation-center                  │
       │       GET /investigations                        │
       │       GET /investigations/:id                    │
       │       POST /investigations                       │
       │       PUT /investigations/:id                    │
       │       POST /investigations/:id/assign            │
       │       POST /investigations/:id/evidence          │
       │       POST /investigations/:id/note              │
       │       POST /investigations/:id/escalate          │
       │       POST /investigations/:id/close             │
       │                                                  │
       │  Pg: 7 new app_iam.* tables (migration 055)      │
       └──────────────────────────────────────────────────┘
```

**Design contract.** The SPA renders via pure resolvers backed by
deterministic synthesis today (FNV-1a + Mulberry32 keyed on
`(tenant, investigation_id, day)`). Production swap is mechanical:
replace resolver bodies with BFF/HTTP calls satisfying the exact same
TypeScript surface — zero SPA refactor.

**Engine modules authored in parallel** via Workflow tool — 4 subagents
in one phase, ~2 minutes wall-clock, each module independently tsc-clean
on first build (only 1 unused-import cleanup needed).

---

## 2. Case Intelligence Architecture

`buildCaseCommandCenter(tenant, asOf)` returns a unified KPI rollup:

| Metric | Source |
|--------|--------|
| `total_cases` | `Σ all investigations` |
| `by_status` | grouped by 6-status closed enum (every key at 0 when absent) |
| `by_severity` | grouped by 5-band closed enum |
| `by_domain` | banking vs insurance |
| `open_cases` | `status === 'open'` |
| `critical_cases` | `severity === 'critical'` |
| `high_risk_cases` | `severity ∈ {high, severe, critical}` |
| `escalated_cases` | `status === 'escalated'` |
| `sla_breached_cases` | `due_at < now && status !== 'closed'` |
| `fraud_cases` | `fraud_indicator === true` |
| `banking_cases` / `insurance_cases` | `domain === 'banking'/'insurance'` |
| `resolution_rate` | `closed / total ∈ [0,1]` |
| `investigation_backlog` | `open + assigned + in_review` |

KPI strip on the SPA carries 8 MetricCard tiles + by-status bar chart +
banking/insurance domain tiles.

---

## 3. Investigation Workflow Design

**6-state state machine** with closed-enum status:

```
              ┌───────────────────────────┐
              │                           ▼
   open ──→ assigned ──→ in_review ──→ pending_approval ──→ closed
                │             │              │
                │             ▼              │
                └────────→ escalated ───────┤
                              │             │
                              ▼             ▼
                          in_review      closed
                              │
                              ▼
                          closed ──→ assigned (reopen)
```

**`WORKFLOW_TRANSITIONS: Record<InvestigationStatus, InvestigationStatus[]>`**
declares allowed next-states. `canTransition(from, to)` enforces the
table. `applyAction(inv, action, actor)` is pure — returns a NEW
Investigation with status transitioned, throws `Error("invalid_transition")`
on illegal action.

**7 actions** in `INVESTIGATION_ACTIONS`:
- `assign` / `reassign` → status=assigned + sets assignee
- `escalate` → status=escalated
- `approve` → status=closed (sets closed_at)
- `reject` → status=closed (sets closed_at)
- `close` → status=closed (sets closed_at)
- `reopen` → from closed only, status=assigned, clears closed_at

---

## 4. Evidence Vault Design

`Evidence` record:

```ts
{ evidence_id, investigation_id, tenant_id,
  evidence_type: 'document' | 'pdf' | 'image' | 'screenshot' | 'external_reference',
  title, description, file_name, file_size_bytes,
  hash_sha256: string,    // 64-char hex; deterministic from id+title+uploaded_at
  version, uploaded_by, uploaded_at,
  verification_status: 'unverified' | 'verified' | 'failed',
  verified_by, verified_at,
  chain_of_custody: CustodyEntry[] }
```

**Chain of custody** (`CustodyEntry`): `ts`, `actor`, `action`
(`uploaded` | `viewed` | `downloaded` | `verified` | `version_bumped`),
`notes`.

**Hash verification**. `computeEvidenceHash(evidence_id, title,
uploaded_at)` returns 64-char hex via 8 repeated FNV-1a cycles over
distinct sub-inputs concatenated as 8×8-char chunks.
`verifyEvidence(evidence)` returns `{ ok, computed_hash, expected_hash }`
— tampered evidence (e.g. title mutation) is detected because the recomputed
hash diverges from the stored one. SPA renders ⚠ hash drift in this case.

`evidenceVaultSummary(tenant, asOf)` aggregates across the entire
investigation fleet for the SPA's tenant-wide tile strip (per-type
counts + verification rate).

---

## 5. AI Investigator Framework

`buildAIInvestigationReport(investigation_id, tenant, kind, domain, asOf)`
returns:

```ts
{ confidence, model_id: 'investigator-llm', model_version: '1.0.0',
  root_cause_analysis: string,           // 2-4 sentence narrative
  related_alerts: RelatedEntity[],       // 2-4 entries
  related_cases: RelatedEntity[],        // 1-3 entries
  related_borrowers: RelatedEntity[],    // banking only
  related_policies: RelatedEntity[],     // insurance only
  related_customers: RelatedEntity[],    // 1-3 entries
  risk_drivers: RiskDriver[],            // EXACTLY 5, sorted |shap| desc
  recommendations: InvestigationRecommendation[]  // 3-5 with priority + category
}
```

**`ROOT_CAUSE_TEMPLATES: Record<InvestigationKind, string[]>`** carries
3-4 narrative templates per kind (all 12 kinds covered: 6 banking + 6
insurance). The engine deterministically picks one template per
`(investigation_id, tenant, day)` triple.

**Domain-aware feature pools** — banking driver pool: `dpd_max_90d /
utilization / bureau_score / repayment_delay_streak / income_drop_pct`.
Insurance: `premium_due_days / claim_freq_180d / agent_persistency /
portal_login_drop / solvency_ratio`.

**Recommendations** drawn from a 10-item action pool: `collect_additional_docs
/ interview_customer / verify_kyc / cross_check_with_bureau /
escalate_to_supervisor / launch_field_visit / freeze_disbursement /
consult_legal / capture_evidence_signoff / close_case_with_decision`.

Production swap: replace function body with a single Claude/Bedrock LLM
call. The same shape is returned so no SPA code changes.

---

## 6. Banking Investigation Framework

6 specialised investigation kinds in `BANKING_INVESTIGATION_KINDS`:

| Kind | Investigates |
|------|--------------|
| `borrower` | Borrower watchlist (DPD + utilisation + bureau drift) |
| `sma` | SMA-1/2/3 migration risk |
| `npa` | NPA classification + provisioning |
| `fraud` | Velocity fraud, identity theft, document fraud |
| `collections` | Collection failure, promised-to-pay drift |
| `sector_risk` | Sector concentration + macro deterioration |

Each carries the standard Investigation envelope but with `domain:
'banking'` and `borrower_id` populated (instead of `policy_id`). The
AI Investigator picks the banking driver pool + banking narrative
templates accordingly.

---

## 7. Insurance Investigation Framework

6 specialised kinds in `INSURANCE_INVESTIGATION_KINDS`:

| Kind | Investigates |
|------|--------------|
| `claim_fraud` | Claim pattern abuse, hospital watchlist, rapid post-issuance |
| `policy_risk` | Policy lapse, sum-assured concentration |
| `underwriting` | Underwriting bypass, declined-then-issued |
| `agent` | Agent cancellation clusters, persistency drops |
| `channel` | Channel-level deterioration |
| `solvency` | IRDAI solvency ratio drift |

`domain: 'insurance'` with `policy_id` populated. Insurance-flavoured
driver pool + narrative templates.

---

## 8. Database Schema (`055_investigation_center.sql`)

All tables under `app_iam.*`. **Additive only — `CREATE TABLE IF NOT
EXISTS`**. Idempotent.

| Table | Purpose |
|-------|---------|
| `investigations` | Investigation record + workflow state. CHECK constraints on domain, status, severity, kind enums. Indexed on `(tenant, status)`, `(tenant, severity) WHERE status<>'closed'`, `(tenant, assignee_username)`, partial `(tenant, due_at) WHERE status<>'closed'` for SLA scans. |
| `investigation_assignments` | Assignee history audit trail. FK CASCADE on investigations. |
| `investigation_evidence` | Evidence vault items. CHECK on `evidence_type` (5 values) + `verification_status` (3 values) + `length(hash_sha256)=64`. Partial index for unverified items. |
| `investigation_notes` | Investigator notes thread. Body capped at 4000 chars. |
| `investigation_actions` | Workflow action log. CHECK on `action` (7 actions) + status enums. Indexed by `(tenant, actor, time)` and `(tenant, action, time)`. |
| `investigation_timelines` | Per-investigation event timeline. CHECK on `event_kind` (11 kinds: alert_generated → reopened). |
| `investigation_recommendations` | AI-suggested recommendations. CHECK on priority/category/status. |

Roll-forward only. `BEFORE UPDATE` trigger on `investigations` keeps
`updated_at` fresh.

---

## 9. Migration Scripts

| File | Status | Notes |
|------|--------|-------|
| `data/schema/055_investigation_center.sql` | NEW | 7 tables + 1 trigger; idempotent. Re-runnable via `make migrate`. |
| Existing migrations 001-054 | UNCHANGED | Backward compatible. |

No destructive change — every table is additive with `IF NOT EXISTS`
guards. Rollback would be `DROP TABLE` on the 7 additions; existing
data unaffected.

---

## 10. API Architecture

All routes additive; existing `/v1/cms/cases*` + `/v1/alerts*` +
`/v1/cases/*` surfaces unchanged.

| Method | Path                                  | Required scope                | Notes |
|--------|---------------------------------------|-------------------------------|-------|
| GET    | `/investigation-center`               | analyst+ / exec               | Manifest (kinds, statuses, transitions, thresholds) |
| GET    | `/investigations?filters…`            | `cases:list`                  | Filter by status / severity / domain / kind / sla_breached |
| GET    | `/investigations/:id`                 | `cases:read`                  | Full case envelope |
| POST   | `/investigations`                     | `cases:create`                | Create new investigation |
| PUT    | `/investigations/:id`                 | `cases:write`                 | Update mutable fields |
| POST   | `/investigations/:id/assign`          | `cases:assign`                | Triggers applyAction('assign') |
| POST   | `/investigations/:id/evidence`        | `cases:write`                 | Upload + recompute hash |
| POST   | `/investigations/:id/note`            | `cases:write`                 | Add to notes thread |
| POST   | `/investigations/:id/escalate`        | `cases:escalate`              | Triggers applyAction('escalate') |
| POST   | `/investigations/:id/close`           | `cases:close`                 | Triggers applyAction('close') |

Envelope follows the platform standard `{header, body}` /
`{header, error}`. All enums validated against closed lists; bad input
returns `400 EWS_400_invalid_input`.

Every state-change action writes to the M15.1 audit chain (when wired
in the BFF follow-up) with `event_type: 'investigation.<action>'`.

---

## 11. RBAC Model

**Page gate**: `canAccessInvestigationCenter(roles)` admits 18 declared
roles in `INVESTIGATION_ROLES`:

```
super_admin · country_admin · bank_admin · insurance_admin ·
risk_analyst · fraud_analyst · collection_manager · investigator · auditor ·
cro · ceo · cfo · coo · board_member · country_head ·
+ legacy: admin · supervisor · executive
```

Brief explicitly lists risk_analyst + fraud_analyst + collection_manager
+ investigator + auditor — all granted page access. `field_officer` is
NOT in the list and is bounced to `/`. Sidebar entry is gated to
`['admin', 'supervisor', 'risk_analyst']` for discoverability but the
page-local gate is broader.

**RBAC matrix (`infra/rbac/matrix.json`) untouched** — zero regression
on existing scopes. The 10 API routes above slot into existing scope
keys (`cases:list`, `cases:read`, `cases:write`, `cases:assign`,
`cases:escalate`, `cases:close`, `cases:create`).

---

## 12. Analytics Architecture

`buildInvestigationAnalytics(tenant, asOf)` returns:

| Metric | Notes |
|--------|-------|
| `average_resolution_time_days` | 4-12 day band |
| `median_resolution_time_days` | ≤ average |
| `investigator_productivity` | 6 rows, sorted by `closed_cases_30d` desc |
| `case_volume_trend` | 12-week series (week_offset -11..0) with opened/closed/escalated |
| `fraud_detection_rate` | 0..1 |
| `recovery_success_rate` | 0..1 |
| `sla_compliance_rate` | 0..1 |
| `escalation_rate` | 0..1 |

SPA renders 5 KPI tiles + recharts area-chart for volume trend + table
for productivity.

---

## 13. Executive Investigation View

`buildExecutiveInvestigationView(tenant, asOf)` returns:

```ts
{ top_open_cases: ExecutiveCaseRow[],      // top 5 by exposure (open + assigned + in_review + pending_approval + escalated)
  critical_investigations: ExecutiveCaseRow[],  // top 5 critical-severity by exposure
  fraud_exposure_kes: number,              // Σ exposure where fraud_indicator
  recovery_impact_kes: number,             // Σ exposure where status='closed'
  investigation_performance: {
    sla_compliance_rate, avg_resolution_days, closure_rate_30d
  } }
```

Each `ExecutiveCaseRow` carries `{investigation_id, title, severity,
domain, exposure_kes, assignee_username, age_days}` — enough for the
exec drill-through link straight into the SPA workspace tab.

---

## 14. Testing Strategy

| Tier | Coverage | Status |
|------|----------|--------|
| Engine resolvers | INVESTIGATION_ROLES gate (18 roles + 3 legacy + bounce); 6-status transitions; 7 actions; listInvestigations shape + filters (status/domain/severity/sla_breached) + tenant divergence + determinism; getInvestigation hit/miss; applyAction (assign/escalate/close/reopen + invalid_transition); buildCaseCommandCenter aggregates + partitions | ✅ |
| Evidence vault | 5 EVIDENCE_TYPES + 3 verification statuses; listEvidence 2-6 deterministic; 64-char hex hash invariant; verifyEvidence ok on pristine + drift detected on tamper; getEvidence null on miss; evidenceVaultSummary aggregate | ✅ |
| AI Investigator | Exactly 5 risk drivers sorted |shap| desc; banking → borrowers+ / policies empty; insurance → policies+ / borrowers empty; 3-5 recommendations with valid priority+category; confidence [0,1]; deterministic | ✅ |
| Analytics + Exec | Avg + median resolution bounds; productivity sorted desc; 12-week volume series; rates in [0,1]; top_open_cases capped at 5 sorted by exposure desc; critical_investigations all `severity=critical`; non-negative exposures | ✅ |
| Page render | admin sees 9 sections; risk_analyst + fraud_analyst + investigator + auditor granted; field_officer bounced; 8 KPI cards + domain tiles + 5 evidence-type tiles + 7 workflow action buttons + 8-step case timeline + status/domain/severity filter chips; filter narrows list | ✅ |
| Sibling sweep | PredictiveRiskCenter + ExecutiveCockpit + RoleBasedDashboard + AppShell + AppShellNavGroups + DashboardPage = 150/150 | ✅ |
| Build | `tsc --noEmit` clean on all 5 new modules; `vite build` clean (4.75s) | ✅ |

**Total: 66 new tests** in `InvestigationCenter.test.tsx`.

---

## 15. Backward Compatibility Plan

| Surface | Impact |
|---------|--------|
| `AlertListPage` (`/alerts`) | UNCHANGED |
| `CaseWorkflowPage` (`/cms/workflow`) | UNCHANGED |
| `CmsCaseListPage` (`/cms/cases`) | UNCHANGED |
| `CmsCaseKanbanPage` (`/cms/cases/kanban`) | UNCHANGED |
| `CmsCaseDetailPage` (`/cms/cases/:id`) | UNCHANGED |
| `CaseTrackingTimeline` (component) | UNCHANGED |
| `CaseCausalAnalysisPage` (`/cms/causal`) | UNCHANGED |
| Executive Cockpit + Role-Based Dashboard + Predictive Risk + Audit + Recovery + Governance + IAM + Security Activity + AI Governance | UNCHANGED |
| RBAC matrix (`infra/rbac/matrix.json`) | UNCHANGED |
| App.tsx Route count | 151 → 152 (added 1; zero removed) |
| Sidebar navigation | +1 nav leaf in `action-center` group (after Predictive Risk Center). Zero existing entries removed. |
| Database tables | +7 new tables in `app_iam` (migration 055). Zero existing tables altered or dropped. |
| BFF routes | UNCHANGED today (engine renders client-side). Future routes per §10 are additive. |
| Existing CMS API surfaces | UNCHANGED — the Investigation Center is a sibling overlay, not a replacement. |
| `app_cases.cases` and `app_cases.actions` tables | UNCHANGED — Investigation Center stores its own enterprise-investigation records in `app_iam.investigations`. |

**Smoke verification post-deploy:**
1. `/cms/cases` renders identically to pre-deploy.
2. `/cms/cases/:id` renders identically.
3. `/cms/workflow` renders identically.
4. `/cms/causal` renders identically.
5. `/alerts` renders identically.
6. `/executive-cockpit` + `/predictive-risk-center` + `/dashboards/role-based` render identically.
7. `make migrate` exits 0.

---

**IA additions this session — 12 total (overlay-not-replacement; additive only; backward-compat preserved every time):**

Rule Center · Audit + Recovery · AI Governance · IAM · Governance · Security
Activity · Recovery Management · Navigation Simplification · Role-Based
Dashboard Engine · Executive Risk Cockpit · Predictive Risk Center ·
**Investigation Center**
