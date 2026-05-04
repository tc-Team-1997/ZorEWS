# APEX EWS — Requirements

> Derived from `APEX_EWS_Roadmap.pdf` (v1.0, April 2026). Scope below is the **prototype monorepo** the agent loop will build, not the literal 24-month tendered banking platform. Production deployment, regulator sign-off, real CBS/AML integration and ISO 27001 audit are out of scope here.

## 1. Objectives

1. Detect default risk **30–60 days before DPD** via indicator + rule + AI scoring engines.
2. Reduce simulated NPA formation by **20–30%** in evaluation harness.
3. Cut Alert → Action median time to **< 4 hours** in the prototype workflow.
4. Demonstrate **99.95% SLA / RTO ≤ 30 min / RPO < 1s** posture via IaC + DR runbook.
5. Maintain Kenya DPA 2019 / ISO 27001 control mapping with immutable audit trail.

## 2. In-scope Modules (8)

| # | Module               | Owning agent       | Phase intro |
|---|----------------------|--------------------|-------------|
| 1 | Data Aggregation     | agent-data         | Phase 1     |
| 2 | Indicator Engine     | agent-indicator    | Phase 1     |
| 3 | Rule Engine          | agent-rule         | Phase 1     |
| 4 | AI Risk Scoring (PD) | agent-ai           | Phase 2     |
| 5 | Alert Engine         | agent-alert        | Phase 1→2   |
| 6 | Case Management      | agent-case         | Phase 3     |
| 7 | Integration Layer    | agent-integration  | Phase 0→3   |
| 8 | UI (Web + Mobile)    | agent-ui           | Phase 1→4   |

## 3. Functional Requirements

### FR-DATA — Data Aggregation
- FR-DATA-1: Ingest CBS loans, repayments, transactions, customer profile via batch + Kafka.
- FR-DATA-2: Aurora PostgreSQL 16 schemas: `raw`, `staging`, `mart`, `audit`.
- FR-DATA-3: dbt models materialise `mart.customer_360`, `mart.loan_360`, `mart.txn_features`.
- FR-DATA-4: MWAA DAGs `cbs_ingestion`, `bureau_sync`, `feature_build` run on schedule with quality gates.

### FR-IND — Indicator Engine
- FR-IND-1: Four families — Financial, Behavioural, Transaction, Credit.
- FR-IND-2: Each indicator has metadata: id, family, formula, window, severity weight.
- FR-IND-3: Compute on event (Kafka) and on schedule; persist to `mart.indicator_values`.

### FR-RULE — Rule Engine
- FR-RULE-1: Rule DSL (JSON) with `when` (predicate), `then` (alert spec), `version`, `status`.
- FR-RULE-2: Lifecycle: draft → simulate → live → retired; each transition audited.
- FR-RULE-3: Simulation against ≥ 12 months of historical indicator values.
- FR-RULE-4: Ship ≥ 25 seed rules across the four indicator families.

### FR-AI — AI Risk Scoring
- FR-AI-1: PD model (gradient-boosted baseline) with SHAP reason codes.
- FR-AI-2: Risk levels Low/Medium/High mapped from PD bands (configurable).
- FR-AI-3: Champion/challenger registry; A/B shadow scoring flag.
- FR-AI-4: Drift monitoring — data drift, prediction drift, performance drift.

### FR-ALERT — Alert Engine
- FR-ALERT-1: Alerts produced to Kafka topic `apex.regulatory.events`.
- FR-ALERT-2: Severity = max(rule severity, score-band severity).
- FR-ALERT-3: Smart prioritisation queue: Critical / Medium / Low.
- FR-ALERT-4: Notification fan-out: in-app, email (SES), SMS (Africa's Talking) for Critical.

### FR-CASE — Case Management
- FR-CASE-1: Lifecycle: Alert → Case → Assigned → Action → Monitored → Closed.
- FR-CASE-2: Case carries single ID across EWS ↔ Collection.
- FR-CASE-3: Action log with field-officer call/visit capture and GPS (mobile).
- FR-CASE-4: Closed-loop outcome: was the action effective (cured / cured-temp / defaulted)?

### FR-INT — Integration
- FR-INT-1: REST `POST /ews/evaluate`, `GET /ews/alerts`, `GET /ews/risk-profile/{id}`, `POST /ews/action`.
- FR-INT-2: Kafka topics — `apex.cbs.events`, `apex.indicator.values`, `apex.regulatory.events`, `apex.case.events`.
- FR-INT-3: Glue Schema Registry — BACKWARD compatibility enforced in CI.
- FR-INT-4: SSO + MFA (TOTP) across Risk, Collection, Supervisor, Admin roles.

### FR-UI — Web + Mobile
- FR-UI-1: **Login + style mirror DMS_Network** — split layout, brand-navy carousel left, sign-in form right; tokens from `tailwind.config.ts` (brand-navy `#0D2B6A`, brand-blue `#1565C0`, brand-sky `#2196F3`, ink `#2C2C2A`, divider `#F1EFE8`, semantic success/warning/danger).
- FR-UI-2: Reuse DMS UI primitives — Button, Input, Badge, Panel, MetricCard, DataTable.
- FR-UI-3: Screens — EWS Dashboard, Alert List, Customer Risk Profile, Rule Configuration, Case View, Scenario Simulation.
- FR-UI-4: Mobile (React Native, deferred prototype) — Alert list, Case view, Call/visit log, GPS.

## 4. Non-Functional Requirements

| Code | NFR | Target |
|------|-----|--------|
| NFR-PERF-1 | Alert generation latency (event → UI) | < 60s P95 |
| NFR-PERF-2 | Dashboard page load | < 2s P95 |
| NFR-PERF-3 | Scenario run (1M simulated accounts) | < 15 min |
| NFR-SCALE  | Sustain 5× pilot volume in load test | no SLA breach |
| NFR-SEC-1  | KMS-managed CMKs, IRSA per service, no static keys | 100% |
| NFR-SEC-2  | OWASP ASVS L2 controls in code | 100% |
| NFR-AUDIT  | Immutable audit log (hash-chain, S3 Object Lock) | 7-year retention |
| NFR-COMP   | Kenya DPA 2019 + ISO 27001 control mapping | documented |
| NFR-DR     | Multi-region active-passive | RTO ≤ 30 min, RPO < 1s |
| NFR-OBS    | CloudWatch + X-Ray + structured logs | 100% services |

## 5. Acceptance Criteria (per phase)

- **Phase 0** — Charter signed, landing zone IaC reviewed, integration contracts drafted.
- **Phase 1** — Rule engine + alerts running on a seeded portfolio; ≥ 25 rules; ≤ 25% FP rate on synthetic data.
- **Phase 2** — PD model AUC ≥ 0.78 on holdout; SHAP attached to every score; smart queue live.
- **Phase 3** — Alert auto-routing to Collection ≥ 95% high-severity; reconciliation breaks ≤ 0.05%.
- **Phase 4** — Dashboard suite + scenario engine + mobile shell; load test at 5× pilot volume passes.
- **Phase 5** — DR drill green (RTO ≤ 30 min, RPO < 1s); pen-test critical findings = 0; FinOps report.

## 6. Glossary

- **CBS** — Core Banking System.
- **DPD** — Days Past Due.
- **EWS** — Early Warning System.
- **IFRS 9** — accounting standard for expected credit loss (ECL).
- **IRA** — Insurance Regulatory Authority (cross-cutting reference from architecture).
- **MRM** — Model Risk Management.
- **NPA** — Non-Performing Asset.
- **PD** — Probability of Default.
- **SHAP** — SHapley Additive exPlanations (per-feature contribution).
