# ZorEWS — Agent Roster

> The build is run by an **Orchestrator** plus **8 module agents**. Agents only edit files inside their owned paths and append to their own log. The Orchestrator alone edits `TASKS.md` + `STATUS.md`.

## Update Protocol (every agent, every task)

1. **Read** `STATUS.md`, `TASKS.md`, your own `logs/<agent>.md` for context.
2. **Work** strictly inside your owned paths.
3. **Tick** your task checkbox in `TASKS.md`.
4. **One-liner** under today's heading in `STATUS.md` — `[<agent>] <what shipped>`.
5. **Detail** — full entry in `logs/<agent>.md` with: task id, files touched, decisions, hand-offs, blockers.
6. **Hand-off** — name the next agent + task id explicitly in the log.

## Roster

### orchestrator — programme tracking
- **Owns:** `TASKS.md`, `STATUS.md`, `logs/orchestrator.md`, phase-gate reviews.
- **Reads:** everyone's logs.
- **DoD:** all phase tasks ticked, KPIs in STATUS, next-phase entry block written.

### agent-data — Data Aggregation
- **Owns:** `data/`, `services/pipeline-svc/`, ingestion DAGs.
- **Inputs:** CBS / LOS / bureau source contracts (Phase 0 from agent-integration).
- **Outputs:** Aurora schemas (`raw`, `staging`, `mart`), dbt models, MWAA DAGs, sample seed data.
- **Hand-off to:** agent-indicator (feature tables ready), agent-ai (training data backfill).
- **DoD:** dbt run succeeds locally on seed data; quality gate fails loud on bad input.

### agent-indicator — Indicator Engine
- **Owns:** `services/regulatory-svc/indicators/`, indicator definitions + tests.
- **Inputs:** `mart.customer_360`, `mart.loan_360`, `mart.txn_features` (agent-data).
- **Outputs:** indicator catalog (JSON), Java/Python compute functions, `mart.indicator_values`.
- **Hand-off to:** agent-rule (catalog), agent-ai (features).
- **DoD:** ≥ 80% of spec indicators implemented with unit tests.

### agent-rule — Rule Engine
- **Owns:** `rules/`, `services/regulatory-svc/rules/`.
- **Inputs:** indicator catalog (agent-indicator).
- **Outputs:** rule DSL, lifecycle (draft → simulate → live → retired), simulator, ≥ 25 seed rules.
- **Hand-off to:** agent-alert (rule firings).
- **DoD:** simulator replays 12 months of synthetic data; FP rate ≤ 25% on seed portfolio.

### agent-ai — AI Risk Scoring
- **Owns:** `ml/`, `services/ai-copilot-svc/`.
- **Inputs:** feature tables (agent-data), indicator values (agent-indicator).
- **Outputs:** PD model (sklearn / XGBoost), SHAP explainer, model registry stub, drift monitor.
- **Hand-off to:** agent-alert (PD + risk band per customer), agent-ui (Risk Profile screen).
- **DoD:** AUC ≥ 0.78 on synthetic holdout; SHAP top-5 reasons in every prediction payload.

### agent-alert — Alert Engine
- **Owns:** `services/regulatory-svc/alerts/`, `services/notification-svc/`.
- **Inputs:** rule firings (agent-rule), risk scores (agent-ai).
- **Outputs:** alert producer to `apex.regulatory.events`, severity merge, smart-queue, SES + Africa's Talking adapters.
- **Hand-off to:** agent-case (alert → case), agent-ui (Alert List).
- **DoD:** alert end-to-end latency < 60s P95 in local stack; notification stub adapters wired.

### agent-case — Case Management
- **Owns:** `services/regulatory-svc/cases/`, case state machine, assignment.
- **Inputs:** alerts (agent-alert).
- **Outputs:** case lifecycle API + state machine, action log, outcome capture.
- **Hand-off to:** agent-integration (Collection auto-routing), agent-ui (Case View).
- **DoD:** alert → case → assigned → action → closed exercised in integration test.

### agent-integration — Platform + External
- **Owns:** `infra/`, `integrations/`, `services/auth-svc/`, `services/audit-svc/`, API gateway, Kafka topology.
- **Inputs:** target architecture (Phase 0).
- **Outputs:** Terraform (VPC, EKS, MSK, Aurora, KMS), k8s manifests, CBS/IFRS9/AML/Collection contract stubs + mocks, schema registry, RBAC matrix, audit-svc with hash-chain S3.
- **Hand-off to:** every agent (platform), agent-case (Collection mock), agent-ai (model serving infra).
- **DoD:** `terraform validate` clean; topic schemas registered; auth-svc issues JWT + TOTP locally.

### agent-ui — Web + Mobile
- **Owns:** `web/`, `mobile/`, design system.
- **Inputs:** API contracts (agent-integration), screens spec.
- **Outputs:**
  - Web React+Vite SPA, **login + style mirroring DMS_Network** (see `.dms-reference/`).
  - Tailwind tokens copied from DMS (`brand-navy`, `brand-blue`, `brand-sky`, `ink`, `divider`, semantic success/warning/danger).
  - Reused primitives — `Button`, `Input`, `Badge`, `Panel`, `MetricCard`, `DataTable`.
  - Screens — Dashboard, Alert List, Customer Risk Profile, Rule Config, Case View, Scenario Simulation.
  - Mobile RN shell (deferred — alert list + case view only in prototype).
- **Hand-off to:** agent-orchestrator (demo-ready).
- **DoD:** `npm run build` clean; Login renders identical to DMS reference; Dashboard wired to mock API.

## Kafka Topic Contract (shared)

| Topic                       | Producer            | Consumers                          | Schema family       |
|-----------------------------|---------------------|------------------------------------|---------------------|
| `apex.cbs.events`           | agent-integration   | agent-data                         | CBS event v1        |
| `apex.indicator.values`     | agent-indicator     | agent-rule, agent-ai               | Indicator v1        |
| `apex.regulatory.events`    | agent-alert         | agent-case, agent-ui, agent-integration | Alert v1       |
| `apex.case.events`          | agent-case          | agent-integration (Collection)     | Case v1             |
| `apex.audit.events`         | every service       | agent-integration (audit-svc)      | Audit v1            |

All schemas live in `infra/schema-registry/` and are validated in CI (BACKWARD compatibility).
