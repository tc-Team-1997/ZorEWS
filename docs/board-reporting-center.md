# Board Reporting Center — Technical Reference

**Phase 21 IA Overlay · ZorEWS Enterprise Risk Intelligence Platform**

---

## 1. Architecture Overview

The Board Reporting Center sits at the apex of the ZorEWS intelligence stack. It consolidates outputs from every preceding center (Risk, Compliance, AI Governance, Digital Twin, etc.) into board-grade artefacts: signed packs, regulatory filings, scenario-stress summaries, and executive intelligence briefings.

```
┌─────────────────────────────────────────────────────────┐
│              BOARD REPORTING CENTER (Phase 21)           │
│   Board Packs · Exec KPIs · Regulatory Filing           │
│   AI Governance · Compliance · Predictive Forecasts     │
│   Digital Twin Reports · Autonomous AI Reports          │
├─────────┬──────────┬──────────┬──────────┬──────────────┤
│  Risk   │Compliance│  AI/ML   │  Digital │  Autonomous  │
│ Center  │ Center   │ Govern.  │   Twin   │  AI Center   │
│(Ph 4-7) │(Ph 8-11) │(Ph 12-15)│(Ph 16-18)│  (Ph 19-20)  │
└─────────┴──────────┴──────────┴──────────┴──────────────┘
            ↑ All prior centers feed into board reporting
```

The center is entirely **read-only at the intelligence layer** — it aggregates, formats, and signs data generated downstream. No new risk decisions are made here; the Board Reporting Center is the narrative and evidence layer.

---

## 2. UI Component Hierarchy

The `BoardReportingCenterPage` renders 12 tabbed sections, each backed by a dedicated pure-function builder in `boardReportingEngine.ts`.

```
BoardReportingCenterPage
├── Tab 1 — Board Pack Library        (buildBoardPackLibrary)
├── Tab 2 — Executive Reporting       (buildExecutiveKpis)
├── Tab 3 — Board Dashboards          (buildBoardDashboards)
├── Tab 4 — Regulatory Reporting      (buildRegulatoryReports)
├── Tab 5 — AI Governance Reports     (buildAiGovernanceReports)
├── Tab 6 — Compliance Reports        (buildComplianceSummary)
├── Tab 7 — Predictive Reporting      (buildPredictiveForecasts)
├── Tab 8 — Digital Twin Reports      (buildDigitalTwinReports)
├── Tab 9 — Autonomous AI Reports     (buildAutonomousAiReport)
├── Tab 10 — Board Pack Generator     (buildRecentGenerations)
├── Tab 11 — Report Scheduler         (buildReportSchedules)
└── Tab 12 — Executive Intelligence   (buildExecutiveIntelligenceSummary)
```

Each tab is independently scrollable, and the top KPI strip (`buildBoardReportingKpis`) is always visible regardless of the active tab.

---

## 3. Component Structure

### Engine + Page Pattern

The center follows the same decoupled engine–page architecture used throughout ZorEWS:

```
web/src/modules/boardReporting/
├── boardReportingEngine.ts   — Pure functions, zero React, zero I/O
└── BoardReportingCenterPage.tsx — React component; calls engine at render
```

**Engine responsibilities:**
- All business logic and data synthesis live here.
- Every function is deterministic for `(tenant, dayKey(asOf))` using FNV-1a + Mulberry32.
- No network calls, no stores, no side-effects.
- All types and enum constants are exported for test reuse.

**Page responsibilities:**
- Calls each engine builder, mapping results to display primitives.
- Handles tab state, loading skeletons, and download-button wiring.
- Guards the page with `canAccessBoardReportingCenter(roles)` — any role in `BOARD_REPORTING_ROLES` is granted access.

### RBAC

```ts
export const BOARD_REPORTING_ROLES = [
  'admin', 'supervisor', 'risk_analyst', 'super_admin', 'country_admin',
  'bank_admin', 'insurance_admin', 'fraud_analyst', 'auditor',
  'compliance_officer', 'executive', 'cdo', 'cro', 'ceo', 'coo', 'cfo',
  'board_member', 'operations_manager', 'country_head', 'company_secretary',
];
```

Roles that require privileged access (e.g. pack approval, digital sign-off) are enforced at the workflow layer, not the view layer.

---

## 4. Database Design

Eight tables underpin the persistent layer (production only; prototype uses deterministic synthesis):

| Table | Schema | Purpose |
|---|---|---|
| `board_packs` | `app_board` | Pack metadata — type, version, approval_status, sign-off fields |
| `pack_sections` | `app_board` | FK to `board_packs`; section-level content + sign-off |
| `pack_distributions` | `app_board` | Distribution list per pack + delivery confirmation |
| `regulatory_filings` | `app_board` | Regulatory return metadata — framework, status, due_date |
| `ai_governance_reports` | `app_board` | AI report records linked to model_registry IDs |
| `scheduled_reports` | `app_board` | Recurring schedule entries — frequency, recipients, last/next run |
| `generation_requests` | `app_board` | Async job tracker for pack generation — status, download_urls |
| `executive_briefings` | `app_board` | Point-in-time executive intelligence snapshots |

All tables carry `tenant_id` (FK → `app_iam.tenants`, NOT NULL) and `created_at`/`updated_at` audit columns. The schema migration file is `data/schema/036_board_reporting.sql` (additive, no prior table altered).

---

## 5. APIs

The Board Reporting Center adds the following BFF routes, all mounted under `/v1/board/`:

### Pack Generation

| Method | Path | RBAC | Description |
|---|---|---|---|
| `GET` | `/v1/board/packs` | `audit:read` | List all board packs for the tenant |
| `GET` | `/v1/board/packs/:pack_id` | `audit:read` | Single pack detail |
| `POST` | `/v1/board/packs/generate` | `audit:read` | Queue a new pack generation job |
| `GET` | `/v1/board/packs/generations` | `audit:read` | Recent generation requests |
| `POST` | `/v1/board/packs/:pack_id/approve` | `audit:read` | Submit pack for approval |
| `POST` | `/v1/board/packs/:pack_id/sign` | `audit:read` | Digital sign-off by authorised officer |

### Scheduling

| Method | Path | RBAC | Description |
|---|---|---|---|
| `GET` | `/v1/board/schedules` | `audit:read` | List all report schedules |
| `POST` | `/v1/board/schedules` | `audit:read` | Create a new schedule |
| `PATCH` | `/v1/board/schedules/:id` | `audit:read` | Update schedule parameters |
| `DELETE` | `/v1/board/schedules/:id` | `audit:read` | Delete a schedule |
| `POST` | `/v1/board/schedules/:id/run-now` | `audit:read` | Trigger an immediate run |

### KPIs and Intelligence

| Method | Path | RBAC | Description |
|---|---|---|---|
| `GET` | `/v1/board/kpis` | `audit:read` | Dashboard-level KPI strip |
| `GET` | `/v1/board/executive-intelligence` | `audit:read` | Narrative executive summary |
| `GET` | `/v1/board/regulatory-reports` | `audit:read` | All regulatory filing statuses |
| `GET` | `/v1/board/ai-governance-reports` | `audit:read` | AI governance report list |

All routes are tenant-gated (require `X-Tenant-ID` header), envelope-wrapped (`{header, body}` shape), and return `EWS_4xx` error codes per the standard contract.

---

## 6. Board Workflow

Pack lifecycle follows a governed five-stage workflow:

```
draft → under_review → approved → distributed → archived
```

| Stage | Trigger | Actor |
|---|---|---|
| `draft` | Engine generates initial pack | System |
| `under_review` | Pack submitted for review | Report Owner |
| `approved` | Reviewer approves the pack | CRO / CFO / CEO (per pack type) |
| `distributed` | Pack sent to distribution list | Company Secretary |
| `archived` | Next cycle pack supersedes this one | System (automatic after next generation) |

Transitions are irreversible except for `under_review → draft` (reviewer sends back for revision). Every transition is recorded in the M15 audit trail with `resource_type: 'board_pack'`, actor, timestamp, and SHA-256 pack hash.

---

## 7. Approval Workflow

Board pack approval uses a multi-level digital sign-off mechanism aligned with RBI operational risk governance:

```
1. Preparer creates/generates pack              (automated or manual)
2. Report Owner reviews and submits for approval
3. Primary Approver reviews and approves        (CRO / CFO / CCO by type)
4. Company Secretary / Board Secretariat countersigns
5. Distribution triggered automatically on countersignature
```

**Self-approval is refused** (same maker-checker principle as CAS/CAP — `approved_by` cannot equal `requested_by`).

Each approval event is written to both the board pack store and the M15 hash-chain audit trail. The `signed_off_at` timestamp and `approved_by` name are embedded in the exported PDF watermark.

Pack types and their required approvers:

| Pack Type | Primary Approver | Countersigner |
|---|---|---|
| `board_risk` | CRO | Board Chairman |
| `executive_risk` | CRO | MD & CEO |
| `audit_committee` | Chief Internal Auditor | Audit Committee Chair |
| `regulatory_filing` | CCO | Company Secretary |
| `ceo` | MD & CEO | Board Chairman |
| Others | Report Owner + CRO | Company Secretary |

---

## 8. Executive Reporting — KPI Framework

The executive KPI framework covers three verticals:

### Banking KPIs (6 indicators)
- **Gross NPA Ratio** — primary credit quality signal; benchmark: industry 3.8%
- **SMA Distribution** — early-warning migration; peer benchmark: 5.5%
- **Delinquency Rate** — 30+ DPD bucket; internal threshold: 4.0%
- **Portfolio Risk Score** — composite AI score `/100`; target: 65
- **Recovery Rate** — collections effectiveness; peer: 62%
- **Fraud Exposure** — value at risk from fraud; budget-gated

### Insurance KPIs (6 indicators)
- **Claims Ratio** — IRDAI norm: ≤80%; breach → `watch` above 78%, `breach` above 85%
- **Fraud Rate** — insurance fraud incidence; industry benchmark: 2.5%
- **Persistency (13M)** — policy retention; target: 82%, IRDAI minimum implied floor
- **Solvency Ratio** — capital adequacy; IRDAI minimum: 150%
- **Loss Ratio** — net claims vs earned premium; target: <75%
- **Underwriting Quality** — composite UW score `/100`; target: 75

### Enterprise KPIs (4 indicators)
- **Enterprise Risk Score** — cross-domain risk composite; target: 72/100
- **Compliance Score** — obligation and breach composite; target: 80/100
- **AI Health Score** — model governance health; target: 85/100
- **Data Quality Score** — data pipeline quality; target: 88/100

Each KPI carries `threshold_status ∈ {within, watch, breach}`, a period label, and a QoQ change metric.

---

## 9. Regulatory Reporting

The center tracks 12 regulatory returns across 6 frameworks and 2 domains:

### RBI Returns (Banking)
- **BSR** — Basic Statistical Return (monthly)
- **OSS** — Offsite Surveillance System (quarterly)
- **Large Exposure Framework** (monthly)
- **KYC Compliance Certificate** (annual)

### Basel III (Banking)
- **Capital Adequacy Report** — CRAR + Tier 1/2 breakdown (quarterly)
- **Liquidity Coverage Ratio** — LCR daily/monthly return

### PMLA (Banking)
- **Suspicious Transaction Report** — STR filings to FIU-IND (monthly)

### IRDAI Returns (Insurance)
- **Form KI** — Annual Returns (annual)
- **Solvency Margin Report** (quarterly)
- **Claims Settlement Report** (monthly)
- **Fraud Monitoring Report** (quarterly)

### IFRS 9 (Banking/Insurance)
- **Stage Classification Report** — IFRS 9 staging per RBI accounting circular (quarterly)

Submission status flows through `in_preparation → due_soon → filed | overdue`. Penalty risk (`none | low | medium | high`) is assigned per filing to guide escalation priority.

---

## 10. AI Reporting

AI governance reports are structured into five report types, generated quarterly and reviewed by the AI Committee:

| Report Type | Scope | Key Signals |
|---|---|---|
| `model_performance` | All production models | AUC, accuracy, champion vs challenger |
| `drift` | PSI, feature drift monitoring | PSI thresholds, alert counts |
| `explainability` | SHAP coverage, transparency scores | Coverage %, avg transparency score |
| `prediction_accuracy` | Hit rate, F1, precision by segment | Segment-level precision, recall |
| `ai_risk` | AI risk register, ethics, concentration | Risk count by severity, vendor concentration |

Each report includes `overall_status ∈ {healthy, watch, action_required}`, a narrative `summary`, `key_metrics[]` with `{metric, value, status}` shapes, and `recommendations[]` for the board/committee.

---

## 11. Testing Strategy

### Unit Tests (`BoardReportingCenter.test.tsx`)
**85+ tests across 14 groups**, covering:
- Access control (`canAccessBoardReportingCenter`)
- All enum constants
- Every builder function for shape, field types, value ranges, and invariants
- Determinism (same `(tenant, asOf)` always produces identical output)
- Tenant isolation (BANK_DEMO vs BIL produce different rng-derived values)

Tests are written against the exported pure functions in `boardReportingEngine.ts`. No React rendering required — the engine is framework-agnostic.

### Running Tests
```bash
cd web
npx vitest run --reporter=verbose src/__tests__/BoardReportingCenter.test.tsx
```

### Integration Smoke
Route-level integration tests (BFF jest) verify:
- All `/v1/board/*` routes return 200 for valid admin roles
- Tenant isolation: BIL requests cannot access BANK_DEMO packs
- RBAC enforcement: non-allowed roles return 403
- Missing `X-Tenant-ID` returns 400 with `EWS_400_invalid_input`

### Regression Guard
The `BoardReportingCenter.test.tsx` suite imports only from `boardReportingEngine.ts`. No imports from the page component, no MSW setup, no DOM rendering. This decoupled approach means:
- Engine tests can run in parallel with the SPA test suite
- A page refactor cannot break engine tests
- The engine can be tested before the page is built

---

## 12. Backward Compatibility

The Board Reporting Center is **strictly additive**. The Phase 21 implementation guarantee:

1. **Zero prior module alterations** — no file outside `web/src/modules/boardReporting/` or `docs/board-reporting-center.md` is touched.
2. **New routes only** — all `/v1/board/*` routes are newly mounted; no existing route paths are modified.
3. **New schema migration only** — `036_board_reporting.sql` adds the `app_board` schema; it does not `ALTER` any existing table.
4. **No enum extension in existing files** — `BOARD_REPORTING_ROLES`, `PACK_TYPES`, `APPROVAL_STATUSES`, and all other enums are defined fresh in `boardReportingEngine.ts`.
5. **AppShell nav is additive** — the "Board Reporting" nav link is appended to the existing nav group list; no existing nav entry is reordered or removed.
6. **Full SPA test suite passes unchanged** — the prior 879/880 vitest pass count (with the documented `CaseActivityTimeline` calendar-drift flake) is unaffected. `BoardReportingCenter.test.tsx` adds to this total.

### Verification Command
```bash
make ci   # install + test + build + lint — all gates must be green
```

---

*Document last updated: Phase 21 Board Reporting Center shipment.*
*Owner: orchestrator — programme tracking.*
*Next review: Phase 22 planning session.*
