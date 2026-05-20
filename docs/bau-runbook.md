# ZorEWS — Business-as-Usual Runbook

**Owner:** orchestrator + SRE on-call · **Audience:** SRE primary + secondary on-call · **Last reviewed:** 2026-05-20

> Steady-state operations. Pair with `docs/dr-runbook.md` for failover-time procedures, `docs/slos.md` for targets, `docs/on-call-rota.md` for who is on which day.

---

## 1. Daily checklist (08:00 IST)

| Task | Owner | Time | Pass criteria |
|---|---|---|---|
| Grafana dashboard scan | On-call primary | 5 min | All SLOs green; no red panels |
| `make smoke` against prod | On-call primary | 2 min | Every service `/healthz` returns 200 |
| `GET /v1/audit/integrity` per tenant | On-call primary | 3 min | `valid=true` for every tenant |
| `GET /v1/integrations/adapters/health` | On-call primary | 1 min | All 8 adapters up, no degraded |
| `GET /v1/ingestion/health` | On-call primary | 1 min | Every connector healthy or degraded (≤ 1 failing) |
| Review overnight PagerDuty pages | On-call primary | 10 min | All resolved or escalated |
| Review overnight Slack #apex-ews-alerts | On-call primary | 5 min | All triaged |
| **Daily total** | | **~30 min** | |

Persistent failures: open a JIRA ticket tagged `daily-check-failure` + page secondary on-call.

---

## 2. Weekly checklist (Monday)

| Task | Owner | Time | Notes |
|---|---|---|---|
| Review past week's SLO error budget burn | SRE lead | 30 min | Per `docs/slos.md` — any burn > 50% triggers a review |
| Capacity review (Aurora, MSK, EKS, S3 storage growth) | SRE lead | 30 min | Trend lines from CloudWatch + Karpenter |
| Webhook delivery failure rate | SRE primary | 15 min | `GET /v1/webhooks/:id/deliveries` aggregated; alert if > 5% per subscription |
| Audit-chain spot-check | SRE primary | 10 min | `GET /v1/audit/integrity/sample?window=200` per tenant — any tampering → CISO page |
| Tenant onboarding queue (M2.x readiness states) | Risk-IT lead | 30 min | Stuck tenants (≥ 14 days in same step) escalate to Risk-IT |
| AI model performance trend (M7.5) | agent-ai owner | 30 min | Any metric drifting > 2σ from 30-day mean → investigate |
| Rule simulator FP-rate spot-check | agent-rule owner | 30 min | Sample 5 live rules — re-run simulator, confirm ≤ 25% FP gate |

---

## 3. Monthly checklist (1st business day)

| Task | Owner | Notes |
|---|---|---|
| RBAC quarterly access review (X.1 — every 3 months) | Risk-IT lead | Per `infra/rbac/README.md` |
| Webhook subscription audit | SRE lead | Inactive > 90 days → notify owner, auto-disable after 120 |
| API key rotation review | SRE lead | Per M1.10/M1.13/M1.15 dashboards — dormant/expiring/revocation-trend |
| Schema-registry compatibility check | agent-data | `python infra/schema-registry/scripts/check_compat.py` |
| Postmortem backlog grooming | SRE lead | Any open postmortem action > 30 days → escalate |
| Pentest finding burn-down review | CISO | Per `docs/pentest-remediation-playbook.md` SLA matrix |
| Cost review | SRE lead | FinOps dashboard (T5.5) — cost-per-alert + cost-per-customer trends |

---

## 4. Quarterly checklist (Mar/Jun/Sep/Dec)

| Task | Owner | Notes |
|---|---|---|
| DR game-day | SRE lead | Per `docs/dr-game-day-plan.md` — Q1 Aurora-only → Q4 full-stack canary |
| RBAC access review (X.1) | Risk-IT lead | Per `infra/rbac/scripts/access_review.py` |
| Schema BACKWARD-compat audit | agent-data | All registered topics still pass `check_compat.py` |
| BAU runbook freshness review | SRE lead | This document — update any drifted procedures |
| Year-2 backlog grooming | orchestrator | Per `docs/year-2-backlog.md` |

---

## 5. Annual checklist (Q1)

| Task | Owner | Notes |
|---|---|---|
| Third-party pentest engagement | CISO | Per `docs/pentest-brief.md` |
| ISO 27001:2022 surveillance audit prep | CISO + Risk-IT | Per `docs/compliance-mapping.md` |
| RBI Cyber Resilience self-assessment | Risk-IT lead | Master Direction June 2024 |
| IRDAI Info-Sec self-assessment | Risk-IT lead | Guidelines April 2023 |
| Cloud-cost optimisation review | SRE lead + FinOps | Karpenter + Aurora reader autoscale + S3 IA-tier migration |
| Vendor security review (Anthropic, SES, Africa's Talking) | CISO | Annual due diligence |

---

## 6. Common operations

### 6.1 Adding a new tenant

1. Admin creates via `POST /v1/tenants` (M2.x).
2. Run readiness check `GET /v1/tenants/me/readiness` until all 9 checks pass.
3. Walk through onboarding wizard via `POST /v1/tenants/:id/onboarding/steps/:step_id`.
4. Verify dashboard renders + audit-chain hash matches expected genesis.
5. Add tenant to FinOps dashboard (T5.5) for cost tracking.

### 6.2 Rotating an API key

1. Mint replacement via `POST /v1/admin/api-keys` — capture plaintext from response (shown ONCE).
2. Update service config to use new key.
3. Verify new key works via `GET /v1/svc/whoami`.
4. Revoke old key via `POST /v1/admin/api-keys/:key_id/revoke`.
5. Verify M1.15 revocation timeline reflects the change.

### 6.3 Investigating a webhook delivery failure

1. Pull recent deliveries: `GET /v1/webhooks/:id/deliveries`.
2. Check status codes — if 5xx from subscriber, contact subscriber owner; if 4xx, payload schema may have drifted.
3. Test-fire to validate connectivity: `POST /v1/webhooks/:id/test`.
4. If signature mismatch, the secret may have rotated on subscriber side — coordinate rotation.
5. Persistent failure (> 5% over 24h) → flag to subscriber owner + auto-disable after 7 days at 100% failure.

### 6.4 Promoting an AI model

1. Build new version: agent-ai runs training pipeline + registers via M7.1.
2. Submit promotion request: `POST /v1/ai/promotions` with rationale.
3. CISO/Risk-IT reviewer approves: `POST /v1/ai/promotions/:id/approve` (NOT the submitter — segregation per M9.3 maker-checker pattern).
4. Auto-promotion gate (T5.1) evaluates: thresholds in `services/bff/src/ai_auto_promotion_gate.ts`.
5. Verify via M7.5 performance ledger — first 24h metrics should match challenger.

### 6.5 Responding to a high-priority alert

1. Acknowledge: `POST /v1/alerts/:id/ack`.
2. If escalation needed: `POST /v1/cases/maker-checker` for sensitive case action.
3. Investigate via M9.1 — open investigation, walk through M9.2 checklist.
4. Close with decision (`fraud_confirmed` / `fraud_unsubstantiated` / `partial_fraud` / `data_quality`).
5. Verify webhook fan-out fired (`case.closed` event).

---

## 7. Escalation matrix

| Severity | Initial response | Escalation if unresolved |
|---|---|---|
| P0 (production down) | On-call primary, immediate | Page secondary at 15min; CISO + CTO at 30min |
| P1 (service degraded) | On-call primary, within 30min | Page secondary at 1h; SRE lead at 2h |
| P2 (single tenant impact) | On-call primary, within 2h | Risk-IT lead at 4h |
| P3 (monitoring noise) | Next business day | Engineering manager if persistent |

---

## 8. References

- `docs/dr-runbook.md` — failover procedure.
- `docs/dr-game-day-plan.md` — quarterly DR rehearsal.
- `docs/slos.md` — SLI/SLO/error budget definitions.
- `docs/on-call-rota.md` — primary + secondary assignments.
- `docs/pentest-brief.md` + `docs/pentest-remediation-playbook.md` — security ops.
- `docs/database-schema.md` — data layout.
- `docs/architecture.md` — system topology.
- `infra/rbac/matrix.json` — RBAC source-of-truth.
