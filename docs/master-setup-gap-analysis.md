# MASTER SETUP — EWS Gap Analysis vs ZorEWS Prototype

**Source doc:** `MASTER SETUP-EWS (1).pdf` (16-page menu/screen specification)
**Codebase baseline:** ZorEWS @ 2026-05-20 (T6 277 sub-phases shipped, ~433 routes, 8068 BFF tests + 476 SPA tests)
**Analysis date:** 2026-05-20
**Scope:** Architecture + implementation gap analysis only — no code changes made.

---

## 1. Executive Summary

| Metric | Initial | A done | B done | C done | D.1 done | D.2 done (2026-05-21) |
|---|---|---|---|---|---|---|
| Overall PDF coverage (weighted) | ~74% | ~84% | ~92% | ~95% | ~96% | **~97%** |
| PDF surfaces fully shipped (✅) | 24/49 | 28/49 | 32/49 | 35/49 | 36/49 | **37/49** |
| BFF route count delta | — | +33 | +61 | +71 | +72 | **+78** (Field-Level Masking adds 6) |
| BFF test suite | 8087 | 8333 | 8606 | 8718 | 8749 | **8839** ✅ |

## Phase D — IN PROGRESS 🚧

| Sub-phase | Module | Routes | Tests |
|---|---|---|---|
| D.1 System Monitoring | `system/monitoring_dashboard.ts` (composer) | 1 | 27 |
| D.2 Field-Level Masking | `security/field_masking.ts` (store + resolver) | 6 | 56 |
| D.3 Audit Admin retention | _pending_ | — | — |
| D.4 Metadata / Lineage | _pending_ | — | — |
| **Running total** | **2 modules** | **7 routes** | **83 tests** |

## Phase C — COMPLETE ✅

| Sub-phase | Module | Routes | Tests |
|---|---|---|---|
| C.1 STR Reporting | `aml/str_reporting.ts` | 8 | 60 |
| C.2 AML Dashboard | `aml/aml_dashboard.ts` (composer) | 1 | 21 |
| C.3 Fraud Dashboard | `fraud/fraud_dashboard.ts` (composer) | 1 | 31 |
| **Total** | **3 modules** | **10 routes** | **112 tests** |

## Phase B — COMPLETE ✅

All 4 master-data CRUD items shipped end-to-end:

| Sub-phase | Module | Routes | Tests | Schema |
|---|---|---|---|---|
| B.1 (Customer) | `customer_master.ts` | 8 | 59 | `028_master_customers.sql` |
| B.2 (Bureau) | `bureau_master.ts` | 8 | 49 | `030_master_bureaus.sql` |
| B.3 (Account) | `account_master.ts` | 6 | 41 | `031_master_accounts.sql` |
| B.4 (Policy) | `policy_master.ts` | 6 | 42 | `032_master_policies.sql` |
| **Total** | **4 modules** | **28 routes** | **191 tests** | **4 migrations** |

Combined with Phase A (4 greenfield modules + 33 routes + 200 tests + 4 migrations), the entire backend gap for PDF master setup is now closed:
- **8 new BFF modules** under `services/bff/src/master/` + `src/dq/` + `src/recon/`
- **61 new routes** (all enveloped, audit:read admin-only)
- **391 new jest tests** (all passing)
- **8 new SQL migrations** in dedicated schemas (`app_master`, `app_dq`, `app_recon`)
- **8 new Recovery Center adapters** registered
- Overall PDF coverage 74% → **92%**
- Zero changes to shipped runtime (M3/M4/M6/M11/M14.x/dbt all untouched)

## Phase A — COMPLETE ✅

All 4 greenfield items shipped end-to-end (BFF module + Recovery adapter + SQL migration + jest tests):

| Sub-phase | Module | Routes | Tests | Schema |
|---|---|---|---|---|
| A.1 (2026-05-21) | `services/bff/src/master/sector_master.ts` | 6 | 49 | `024_master_sectors.sql` |
| A.2 (2026-05-21) | `services/bff/src/master/geography_master.ts` | 6 | 47 | `025_master_geographies.sql` |
| A.3 (2026-05-21) | `services/bff/src/dq/dq_engine.ts` | 10 | 57 | `026_dq_engine.sql` |
| A.4 (2026-05-21) | `services/bff/src/recon/recon_engine.ts` | 11 | 47 | `027_recon_engine.sql` |
| **Total** | **4 modules** | **33 routes** | **200 tests** | **4 migrations** |

**Headline:** The system's *runtime* — rule evaluation, scoring, alerts, cases, workflow, audit, notifications — is heavily shipped (90%+). The gap is concentrated in **admin master-data UIs** (Customer / Account / Product / Sector / Geography / Bureau setup screens) and **two greenfield modules** (Data Quality Engine, Reconciliation & Controls). The backend data models for most master-setup items either already exist in `mart.*` or `app_iam.tenants`; what's missing is the **CRUD admin SPA + a thin master-data table layer for the 5 lookup-style entities**.

---

## 2. PDF → Shipped Coverage Matrix

### 2.1 Master Setup (12 submenus)

| # | PDF screen | Status | % | What's shipped | What's missing |
|---|---|---|---|---|---|
| 1 | Customer Master Setup | ⚠️ | 25% | `mart.customer_360` (10k rows), Customer Risk Profile + List pages (read-only) | Admin SPA page to CREATE / EDIT customer master with `KYC_Status`, `PEP_Flag`, `Risk_Category`, `Segment`, `Industry`, mandatory-field toggle + risk-weight assignment |
| 2 | Account & Exposure Master | ⚠️ | 20% | `mart.loan_360` (24k loans) — read-only view via Customer 360 panel | Admin master-data table + CRUD for `Account_Type`, `Loan_Type`, `Credit_Limit` defaults |
| 3 | Product & Policy Master (Insurance) | ⚠️ | 25% | M14.1 InsuranceAdapter (read-only stub: policies + claims) | Admin master for `Policy_Type` catalogue, premium rules, coverage-limit defaults |
| 4 | Sector & Industry Master | ❌ | 0% | — | New table `app_setup.sectors` + admin CRUD: `sector_id`, `sector_name`, `risk_weight`, `regulatory_category`. Consumed by sector-risk dashboard + portfolio analysis |
| 5 | Geography & Risk Region Master | ❌ | 0% | — | New table `app_setup.geographies` + admin CRUD: `country`, `risk_level`, `sanction_flag`. Feeds AML + EWS |
| 6 | External Bureau Master (CIBIL) | ⚠️ | 30% | M14.5 BureauAdapter (read-side stub: CIBIL/CRIF/EXPERIAN/EQUIFAX) | Admin screen to set per-bureau `score_weight` in risk calculation |
| 7 | Rule Master Setup | ✅ | 100% | T1.7 DSL + lifecycle, M5.1–M5.18 templates + bulk-clone + simulation + audit, EWS Rules Engine (RP-1..3), SPA Visual Builder + Wizard | — |
| 8 | Threshold & Parameter Setup | ✅ | 100% | M4.3 default thresholds + M4.4 per-tenant overrides + M4.10 auto-tune from history + M4.14 band-gap audit; M13.1 system params (`alerts.*_sla_hours`, scoring thresholds) | — |
| 9 | Risk Score Configuration | ✅ | 95% | M6.1 Σ(W×V) engine + M6.3 6 library presets + M6.4 custom presets + M6.10 effective-weights view + M6.13 sensitivity + M6.14 what-if + M6.18 family matrix | "Drag-drop weight adjustment" UX hint from PDF — currently numeric form; cosmetic upgrade |
| 10 | Alert Classification Setup | ✅ | 100% | M8.1 BIL Red/Orange/Yellow/Green + M8.2 routing matrix + M8.10 routing diff vs default + admin override | — |
| 11 | Case Management Setup | ✅ | 100% | M9.1 6-state investigation + M9.2 custom 8-step checklists + M9.3 maker-checker + T4.19 CAS/CAP + T4.20 approvals fan-out | — |
| 12 | Workflow & Escalation Setup | ✅ | 100% | M8.2 SLA hours + escalation_after_hours per class + T4.21 issue-owner groups (branch teams) + T4.22 leave-cover request | — |

**Master Setup subtotal: 7.05 / 12 = ~59%**

### 2.2 Configuration (7 submenus)

| # | PDF screen | Status | % | What's shipped | What's missing |
|---|---|---|---|---|---|
| 13 | System Parameter Config | ✅ | 100% | M13.1 (13 platform defaults across 5 categories) + M13.2 audit trail + M13.3 rollback + M13.9 printable summary + M13.13 schema markdown | — |
| 14 | Notification Setup | ✅ | 100% | M10.1 email + M10.2 SMS + M10.3 push + M10.7 quiet hours + M10.10 resolution chain + M10.11 unified template catalog | — |
| 15 | Integration Config (API/ETL) | ✅ | 100% | M3.1 connector registry (8 connectors) + M14.x adapter fleet + M14.9 fleet health | — |
| 16 | Data Source Config | ✅ | 100% | M3.1 registry + M3.2 schemas + M3.10 retry policies + M3.13 type distribution | — |
| 17 | Schedule & Job Config | ✅ | 100% | M12.2 recurring report schedules + M3.5 connector run analytics + M3.6 failure patterns | — |
| 18 | Audit Config | ⚠️ | 40% | M15.x audit chain shipped (writers always-on, retention via S3 Object Lock in IaC) | Admin SPA page for audit retention/sampling policy controls (currently env-var only) |
| 19 | Access Control Config | ✅ | 100% | RBAC matrix (`infra/rbac/matrix.json`) + T3.9 quarterly access review + T4.21 user teams + X.1 review evidence log | — |

**Configuration subtotal: 6.4 / 7 = ~91%**

### 2.3 Full EWS Ecosystem (20 modules from §1 of PDF, excluding Master Setup which is above)

| # | PDF module | Status | % | Notes |
|---|---|---|---|---|
| E1 | Dashboard & Monitoring | ✅ | 95% | DashboardPage + M11.1 Claims + M11.2 UW + M11.3 Agent + M11.4 Operational + M11.5 Executive Watchlist + M11.6 Customer 360 + Analytics (4 sub-dashboards) + Recovery Analytics. SLA Monitoring + Exception Dashboard exist as sub-tiles |
| E2 | Early Warning System (EWS Core) | ✅ | 100% | Rule Execution + Alert Generation + Alert Monitoring + Risk Trend Analysis + Scenario Simulation (T4.2 + M16.1–M16.21) all shipped |
| E3 | Customer & Exposure Management | ⚠️ | 70% | Customer Profile ✅, Account Details ✅, Loan Exposure ✅, Policy Exposure ✅ (M14.1 adapter). **Collateral Details ❌** (not shipped) |
| E4 | Data Integration & ETL | ✅ | 100% | T1.4 MWAA DAGs + M3.1 connector registry + M3.6 error/failure-pattern + Batch Upload via dbt seed + API Integration M14.x + Job Scheduler |
| E5 | Data Quality (DQ) Engine | ❌ | 10% | Only dbt tests run — no DQ Rule Master, no DQ Dashboard, no Exception Data ledger. **Module-level gap.** |
| E6 | Risk Scoring Engine | ✅ | 100% | M6.x suite (presets, custom, sensitivity, what-if, family matrix, multiplier histograms) |
| E7 | Trigger & Alert Management | ✅ | 100% | M8.1–M8.17 (classification, routing, ack/unack, SLA detail, ack-time histogram, channel distribution, daily volume, compliance-by-class, dow×hour heatmap) |
| E8 | Case Management | ✅ | 100% | M9.1–M9.17 + CAS/CAP + checklists + maker-checker + transitions matrix |
| E9 | Workflow & Escalation | ✅ | 100% | M8.2 routing + escalation + T4.21 teams + T4.22 leave cover + maker-checker approvals fan-out |
| E10 | AML Integration | ⚠️ | 50% | M14.3 AML adapter (sanctions/PEP/adverse-media/internal) ✅. **STR Reporting ❌**, AML Dashboard SPA page ❌, PEP screening UI ❌ |
| E11 | Fraud Monitoring | ⚠️ | 50% | T2.11 Fraud indicator family (FRD-001..004) + 3 seed rules (RULE-031..033) ✅. **No dedicated Fraud SPA page / dashboard.** Fraud Cases route through generic case mgmt |
| E12 | Reconciliation & Controls | ❌ | 0% | No record-count recon, no amount recon, no break analysis, no exception handling. **Module-level gap.** |
| E13 | Reporting & Regulatory | ✅ | 100% | M12.1 catalog (9 BIL reports) + M12.2 schedules + M12.5 job analytics + M12.10 runtime trends + M12.13 daily volume + multi-format export (PDF/Excel/CSV) |
| E14 | Data Warehouse & Analytics | ✅ | 100% | `mart.*` (4 tables, 124k rows) + Analytics SPA page with 4 sub-dashboards (risk trend, PD distribution, stage migration, alert resolution) |
| E15 | Metadata & Lineage | ⚠️ | 30% | `docs/data-lineage.md` (X.2) ✅. **No SPA page** rendering lineage; no Data Dictionary / Business Glossary / Impact Analysis UI |
| E16 | Audit & Logs | ✅ | 100% | M15.1–M15.17 (audit log + hash-chain + integrity spot-check + activity heatmap + per-actor + severity + correlation + evidence packaging) |
| E17 | Notification & Communication | ✅ | 100% | M10.x (email/SMS/push + quiet hours + templates catalog + dispatch ledger + NotificationDispatches SPA page) |
| E18 | Master Setup (see §2.1) | ⚠️ | 59% | See Master Setup subtotal above |
| E19 | Configuration (see §2.2) | ✅ | 91% | See Configuration subtotal above |
| E20 | Admin (Super Control Layer) — see §2.4 | ⚠️ | 74% | See Admin subtotal below |

**Ecosystem subtotal: 15.19 / 20 = ~76%**

### 2.4 Admin Module (10 sub-areas from PDF §21)

| # | PDF sub-area | Status | % | Notes |
|---|---|---|---|---|
| A1 | User & Role Management | ✅ | 100% | T1.12 auth-svc + AdminUsersPage + Permission Matrix via RBAC + Role Assignment via user.roles |
| A2 | Access Control (Module / Row / Field) | ⚠️ | 70% | Module access via RBAC ✅, Row-level via `tenant_id` scoping ✅, **Field-Level Masking ❌** (only one-off `copilot_pii_masker.ts` for chat, not config-driven) |
| A3 | System Administration (Env / Settings / Feature Toggle) | ⚠️ | 40% | Feature toggles via M13.1 `features.*` ✅. **No env-config UI** (managed by IaC), **no Application Settings SPA page**, feature toggles editable via generic `/admin/config` only |
| A4 | System Monitoring (Server / Job / Performance) | ⚠️ | 30% | `/healthz` endpoints per service ✅, M3.1 connector health ✅, M14.9 adapter fleet health ✅. **No SPA dashboard** showing server health / job queue / perf metrics |
| A5 | Security Management (Password / Login / MFA) | ✅ | 100% | T4.7 hardening (rate-limit + lockout + captcha + password history + OWASP headers + idle timeout) + M1.1 TOTP 2FA + M1.2 API keys + M1.3 key auth |
| A6 | Audit Administration (Config / Retention) | ⚠️ | 50% | M15.x ledger live ✅, S3 Object Lock retention in IaC ✅. **No SPA page** to view/change retention policy |
| A7 | Backup & Recovery | ✅ | 95% | **Recovery Center fully shipped today** (soft-delete archive, restore, purge, analytics dashboard). `docs/dr-runbook.md` + `dr-game-day-plan.md` for DR. **Minor gap:** no DR admin SPA (runbook is markdown) |
| A8 | Integration Management (API Keys / 3rd-party / External) | ✅ | 100% | M1.2 API keys + AdminServiceClientsPage + M14.1–M14.8 adapter fleet + M14.9 health |
| A9 | Notification Admin (Email / SMS gateway) | ✅ | 100% | M10.1 SES + M10.2 Africa's Talking + M10.3 Firebase/APNS + NotificationTemplatesPage + NotificationDispatchesPage |
| A10 | Configuration Control (Global / Version / Release) | ⚠️ | 50% | Global params ✅ (M13.1). **No Version Control / Release Management SPA page** (git is implicit, not surfaced) |

**Admin subtotal: 7.4 / 10 = ~74%**

---

## 3. Module-wise Completion Report

| Section | Items | Shipped | Partial | Missing | Score |
|---|---|---|---|---|---|
| Master Setup | 12 | 6 | 4 | 2 | 59% |
| Configuration | 7 | 6 | 1 | 0 | 91% |
| Ecosystem | 20 | 12 | 6 | 2 | 76% |
| Admin | 10 | 5 | 5 | 0 | 74% |
| **TOTAL (weighted)** | **49** | **29** | **16** | **4** | **~74%** |

**Caveat on the headline 74%:** the system is mostly *runtime-complete* (rules / scoring / alerts / cases / audit / notifications / reporting — all >90%). The drag on the score is purely **admin master-data UIs**. A user demoing the live alert pipeline sees ~95% of what the PDF describes; a user opening the admin panels expecting to manage Sector/Geography/Bureau masters sees gaps.

---

## 4. Pending Feature Catalogue

### 4.1 Critical (blocks demo or has a regulator/compliance hook)

| Item | Effort | Owner | Notes |
|---|---|---|---|
| **DQ Engine module** — DQ Rule Master + execution + dashboard + exception data ledger | Large (~2 weeks) | agent-data | Closes E5. Wraps existing dbt-test infrastructure into an operator-visible runtime. ~6 new BFF routes + 4 SPA pages + 1 new schema (`app_dq.*` with `dq_rules`, `dq_executions`, `dq_exceptions`) |
| **Reconciliation & Controls module** — record-count recon + amount recon + break analysis + exception handling | Large (~1.5 weeks) | agent-data + agent-integration | Closes E12. ~5 BFF routes + 4 SPA pages + new schema `app_recon.*` |
| **AML STR Reporting** (Suspicious Transaction Report submission) | Medium (~1 week) | agent-alert | Closes E10 gap. Requires: STR form fields (per RBI XBRL spec), draft/submit workflow, regulator-format export, audit trail |
| **Sector & Industry Master** + admin SPA | Small (~3 days) | agent-data + agent-ui | Closes Master Setup item 4. New table `app_setup.sectors` (sector_id, name, risk_weight, regulatory_category) + AdminSectorsPage + integration into portfolio dashboard's sector breakdown |
| **Geography & Risk Region Master** + admin SPA | Small (~3 days) | agent-data + agent-ui | Closes Master Setup item 5. New table `app_setup.geographies` (country, risk_level, sanction_flag) + AdminGeographiesPage + feed into AML M14.3 |

### 4.2 High-priority (gap is functional, not just UX)

| Item | Effort | Owner |
|---|---|---|
| **Customer Master Setup admin SPA** (KYC_Status, PEP_Flag, Risk_Category, Segment, Industry create/edit form) | Small (~3 days) | agent-ui |
| **External Bureau Master admin** (per-bureau score_weight assignment) | Small (~2 days) | agent-integration + agent-ui |
| **Fraud Monitoring dashboard** (dedicated SPA page over T2.11 Fraud family) | Small (~3 days) | agent-ui |
| **AML Dashboard** SPA page (over M14.3 adapter + sanctions/PEP/adverse-media) | Small (~3 days) | agent-ui |
| **Collateral Details** sub-screen in Customer & Exposure 360 | Small (~3 days) | agent-data + agent-ui |
| **Field-Level Masking** admin (config-driven PII masking per role) | Medium (~5 days) | agent-integration |

### 4.3 Medium-priority (cosmetic / completeness)

| Item | Effort | Owner |
|---|---|---|
| **System Monitoring** SPA dashboard (server health / job queue / perf metrics) | Medium | agent-integration |
| **Audit Admin** SPA (retention policy controls) | Small | agent-integration |
| **Metadata / Data Lineage** SPA page (renders docs/data-lineage.md interactively + impact analysis tree) | Medium | agent-data |
| **Application Settings** SPA (vs generic /admin/config) — branded toggles for features.* | Small | agent-ui |
| **Version Control / Release Management** SPA (read-only — show current release + git SHA) | Small | agent-integration |
| **Account & Exposure Master** admin SPA (Account_Type catalogue, defaults) | Small | agent-ui |
| **Product & Policy Master** admin SPA (Policy_Type catalogue for M14.1 swap) | Small | agent-ui |

### 4.4 Low-priority (UX polish)

| Item | Effort |
|---|---|
| Drag-drop weight adjustment UX (Risk Score Config) — currently numeric form | Small |
| DR Admin SPA page (currently markdown runbook) | Small |
| AML PEP-Screening dedicated UI (currently rolled into M14.3) | Small |

---

## 5. New Backend Surface Required

### 5.1 New tables (5)

| Table | Owner | Used by |
|---|---|---|
| `app_setup.sectors` | agent-data | Sector dashboard, portfolio analysis, indicator inputs |
| `app_setup.geographies` | agent-data | AML, EWS, customer risk |
| `app_setup.bureau_config` (per-tenant bureau weight overrides) | agent-integration | M6.x scoring, M14.5 bureau adapter |
| `app_dq.dq_rules` + `app_dq.dq_executions` + `app_dq.dq_exceptions` | agent-data | DQ Engine module |
| `app_recon.recon_runs` + `app_recon.recon_breaks` | agent-data | Reconciliation module |

### 5.2 New BFF route groups (~20 routes)

- `/v1/admin/setup/sectors/*` (5 routes)
- `/v1/admin/setup/geographies/*` (5 routes)
- `/v1/admin/setup/bureau-weights/*` (3 routes)
- `/v1/dq/rules/*` + `/v1/dq/executions/*` + `/v1/dq/dashboard` (~6 routes)
- `/v1/recon/runs/*` + `/v1/recon/breaks/*` (~5 routes)
- `/v1/aml/str/*` (4 routes — draft/submit/list/export)

### 5.3 New SPA pages (~22)

| Section | New page |
|---|---|
| Master Setup | AdminCustomerMaster, AdminAccountMaster, AdminPolicyMaster, AdminSectorMaster, AdminGeographyMaster, AdminBureauMaster |
| DQ Engine | DqRulesPage, DqExecutionsPage, DqDashboardPage, DqExceptionsPage |
| Reconciliation | ReconRunsPage, ReconBreaksPage, ReconExceptionsPage, ReconDashboardPage |
| AML/Fraud | AmlDashboardPage, AmlStrReportingPage, FraudMonitoringPage |
| Admin | SystemMonitoringPage, AuditAdminPage, FieldMaskingAdminPage, ApplicationSettingsPage, ReleaseMgmtPage |
| Metadata | DataLineagePage |

---

## 6. Roadmap (suggested sequencing for remaining implementation)

**Phase A — close greenfield modules (3–4 weeks)**
1. Sector & Industry Master (table + admin SPA + indicator wiring) — 3 days
2. Geography & Risk Region Master (table + admin SPA + AML wiring) — 3 days
3. DQ Engine module (rules + executions + dashboard + exceptions) — 2 weeks
4. Reconciliation & Controls module — 1.5 weeks

**Phase B — close master-data CRUD gap (1.5 weeks)**
5. Customer Master Setup admin SPA — 3 days
6. External Bureau Master admin — 2 days
7. Account & Exposure Master admin SPA — 3 days
8. Product & Policy Master admin SPA — 3 days

**Phase C — close AML/Fraud completeness (1.5 weeks)**
9. AML Dashboard SPA — 3 days
10. AML STR Reporting workflow — 1 week
11. Fraud Monitoring dashboard SPA — 3 days

**Phase D — admin polish (1 week)**
12. System Monitoring dashboard — 3 days
13. Field-Level Masking admin — 3 days (depends on a small middleware change)
14. Audit Admin page — 1 day
15. Metadata/Lineage interactive SPA — 2 days

**Phase E — UX polish (3 days, optional)**
16. Drag-drop weight adjustment, DR admin SPA, version/release page — 1 day each

**Estimated total to 100% PDF coverage: ~6–7 weeks of focused work**, parallelisable across the 9 module agents (orchestrator + 8 module agents per AGENTS.md). At the demonstrated T6 cadence (~2 sub-phases/day), the work is sized at ~85–100 sub-phase commits.

---

## 7. Critical observations

1. **The PDF describes the *administrative* face of EWS; ZorEWS has built the *runtime* face.** This is the right priority order — a system that can run rules + score risk + raise alerts + route cases is more valuable than one that has admin CRUD for sectors. But ZorEWS now needs ~6 weeks of admin-UI work to "look like" the PDF spec.

2. **No backend redesign is required.** Every gap maps to either (a) a thin master-data table + admin CRUD, or (b) a new module (DQ, Reconciliation) that doesn't touch existing runtime. Adding these will not break the 277 T6 sub-phases or the 8068 BFF tests.

3. **Two modules (DQ Engine, Reconciliation) are the only genuine greenfield work.** Everything else is either shipped, or a missing CRUD admin on top of an existing data model.

4. **The Recovery Center (just shipped today) closes the PDF's "Backup & Recovery" submenu.** This was completed in the same session as this analysis.

5. **PDF "Drag-drop weight adjustment"** is a UX upgrade on top of M6.x — the backend is fully ready (`POST /v1/scoring/presets/custom`), just the SPA control needs replacing.

6. **Compliance hooks that need extra care:** STR reporting (RBI XBRL format), field-level masking (DPA 2019), retention policy admin (ISO 27001). These should land in Phase A/C with explicit compliance officer review.

---

## 8. Files referenced

| Path | Purpose |
|---|---|
| `STATUS.md` | T6 sub-phase tally + module coverage matrix |
| `TASKS.md` | Per-task backlog + DoD |
| `todo.md` | Feature-gap registry vs EWS.docx (sister doc to this one) |
| `AGENTS.md` | Owned paths + module agents |
| `docs/database-schema.md` | Column-level reference for shipped schemas |
| `docs/data-lineage.md` | Provenance map (X.2) |
| `docs/recovery-center.md` | Soft-delete + restore architecture (just shipped) |
| `infra/rbac/matrix.json` | RBAC source-of-truth |

**No code changes were made.** This document is pure analysis output.
