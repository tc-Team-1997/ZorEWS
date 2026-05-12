# ZorEWS — Skills Matrix

## Per-agent Skill Profile

| Agent              | Primary skills                                                | Supporting                                            |
|--------------------|---------------------------------------------------------------|-------------------------------------------------------|
| orchestrator       | Programme governance, RACI, phase-gate review, KPI tracking   | Markdown docs, risk register                          |
| agent-data         | PostgreSQL/Aurora, dbt, Apache Airflow, Kafka producers       | Data quality testing, lineage                         |
| agent-indicator    | Domain modelling (credit risk indicators), Python/Java, SQL   | Statistical thresholds, time-series windows           |
| agent-rule         | DSL design, rule lifecycles, simulation harness               | Backtesting, FP/FN tuning                             |
| agent-ai           | XGBoost/sklearn, SHAP, MLOps, drift monitoring                | Model risk management docs, prompt design (Claude)    |
| agent-alert        | Event-driven design, Kafka, prioritisation queues             | SES, Africa's Talking SMS, templating                 |
| agent-case         | State machines, RBAC workflows                                | Audit logging, mobile field-officer UX                |
| agent-integration  | Terraform/CDK, EKS, MSK, IAM, KMS, API design, security       | Schema registry, CI/CD, FinOps                        |
| agent-ui           | React 18 + Vite + Tailwind, Zustand/Redux, Storybook, RN      | DMS design tokens, accessibility, persona-driven UX   |

## Skill → Agent Cross-Reference

- **Kafka producer/consumer:** agent-data, agent-indicator, agent-alert, agent-case, agent-integration.
- **Aurora schema work:** agent-data (DDL), agent-integration (Terraform mgmt).
- **Auth + RBAC:** agent-integration (auth-svc), agent-ui (gating), every agent (IRSA usage).
- **Audit log:** every agent emits → agent-integration owns audit-svc.
- **DMS UI tokens:** agent-ui only — others must not introduce raw hex values.
