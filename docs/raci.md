# ZorEWS — RACI Matrix

**Owner:** orchestrator · **Companion to:** `docs/charter.md` · **Last reviewed:** 2026-05-20

> Per-activity Responsible / Accountable / Consulted / Informed map. One role per cell unless noted. Activities grouped by phase + module.

**Legend:** R = Responsible (does the work) · A = Accountable (signs off, owns outcome — exactly one) · C = Consulted (provides input) · I = Informed (kept in the loop).

**Roles:**
- ORCH = Programme orchestrator (Risk-IT lead)
- CISO
- CTO
- RIT = Risk-IT lead (= ORCH in prototype phase)
- COMP = Compliance officer
- SRE = SRE lead
- DATA = agent-data owner
- IND = agent-indicator owner
- RULE = agent-rule owner
- AI = agent-ai owner
- ALRT = agent-alert owner
- CASE = agent-case owner
- INT = agent-integration owner
- UI = agent-ui owner
- BIL = BIL stakeholder
- BANK = Bank stakeholder

---

## 1. Programme governance

| Activity | ORCH | CISO | CTO | RIT | COMP | SRE | BIL | BANK |
|---|---|---|---|---|---|---|---|---|
| Charter approval | R | A | A | C | C | C | I | I |
| Quarterly steering committee | R | A | A | R | C | I | C | C |
| Scope change request | R | A | A | C | I | I | C | C |
| Year-2 backlog grooming | R | C | A | C | I | C | C | C |
| Postmortems | R | C | A | C | I | R | I | I |
| Definition of Done sign-off | R | A | A | C | C | C | I | I |

---

## 2. Build (T0–T6)

| Activity | ORCH | DATA | IND | RULE | AI | ALRT | CASE | INT | UI |
|---|---|---|---|---|---|---|---|---|---|
| Aurora schemas (T1.2) | I | A,R | C | I | C | I | C | C | I |
| dbt mart (T1.3) | I | A,R | C | C | C | I | I | C | I |
| Indicator engine (T1.5/T1.6) | I | C | A,R | C | C | I | I | I | I |
| Rule engine (T1.7-T1.9) | I | C | C | A,R | I | C | I | I | I |
| PD model (T2.2-T2.6) | I | C | C | I | A,R | C | I | C | I |
| Alert producer (T1.10-T2.7) | I | I | C | C | C | A,R | C | C | I |
| Notification svc (T1.11) | I | I | I | I | I | A,R | I | C | I |
| Case management (T3.5) | I | I | I | I | I | C | A,R | C | I |
| Collection adapter (T3.4) | I | I | I | I | I | C | C | A,R | I |
| Web SPA (T1.14-T1.16) | I | I | I | I | I | I | I | C | A,R |
| BFF (T3.10 / T4.24) | I | I | I | I | I | C | C | A,R | C |
| Auth-svc (T1.12 / M1.x) | I | I | I | I | I | I | I | A,R | C |
| Audit-svc (T1.13 / M15.x) | I | I | I | I | I | I | I | A,R | I |
| BIL 16-module expansion (T6) | A | C | C | C | C | C | C | R | C |
| Multi-tenant foundation (T4.24) | A | C | I | I | I | C | C | R | C |

---

## 3. Infrastructure + IaC

| Activity | ORCH | CTO | SRE | INT | DATA | CISO |
|---|---|---|---|---|---|---|
| Landing zone Terraform (T0.2) | I | A | C | R | I | C |
| Production VPC + EKS + Aurora + MSK (T1.1) | I | A | C | R | C | C |
| Aurora Global DB (T5.2) | I | A | C | R | C | C |
| S3 CRR (T5.2) | I | A | C | R | C | C |
| MSK MirrorMaker 2 (T5.2) | I | A | C | R | C | C |
| Schema-registry + CI (T3.8) | I | C | I | A,R | C | I |
| RBAC matrix + CI (T3.9) | C | A | I | R | I | C |
| terraform-ci.yml + services-ci.yml | I | C | I | A,R | I | I |
| IaC + container scan (X.3) | I | A | C | R | I | C |

---

## 4. Security + compliance

| Activity | ORCH | CISO | CTO | RIT | COMP | INT |
|---|---|---|---|---|---|---|
| Pentest engagement (T5.4) | I | A,R | C | I | C | C |
| Remediation triage | C | A,R | C | C | C | R |
| Critical findings → customer notify | C | A,R | C | C | C | I |
| RBAC quarterly access review (X.1) | C | A | C | R | C | R |
| Audit chain integrity (M15.2) | I | A | I | C | C | R |
| Evidence packaging (M15.3) | I | A | I | C | R | R |
| DPA 2019 + ISO 27001 mapping | I | A,R | C | C | C | C |
| RBI / IRDAI self-assessment | I | A | C | R | R | C |
| KMS rotation | I | A | C | I | I | R |

---

## 5. Operations

| Activity | ORCH | CTO | SRE | RIT | CISO | UI |
|---|---|---|---|---|---|---|
| BAU daily checklist (T5.6) | I | I | A,R | C | I | I |
| BAU monthly review | C | I | A,R | C | I | I |
| SLO monitoring + reporting | I | I | A,R | C | I | I |
| Error budget policy enforcement | C | A | R | C | C | I |
| On-call rotation | C | I | A,R | C | I | I |
| DR runbook execution | C | C | A,R | C | C | I |
| DR game-day rehearsal (T5.3) | I | C | A,R | C | C | I |
| Postmortem template | C | I | A,R | C | C | I |
| FinOps dashboard review (T5.5) | C | A | R | C | I | I |
| Cost optimisation (Year-2 Theme H) | C | A | R | C | I | I |
| Customer notification | C | A | R | I | C | C |

---

## 6. Data + analytics

| Activity | ORCH | DATA | AI | RIT | COMP |
|---|---|---|---|---|---|
| Data lineage doc (X.2) | C | A,R | C | C | C |
| Feature store + 24mo backfill (T2.1) | I | A,R | C | I | I |
| dbt refresh schedule | I | A,R | I | C | I |
| Model retraining loop (T5.1) | I | C | A,R | C | I |
| Model promotion approval (M7.2) | I | C | C | A | C |
| Drift monitoring (T2.6) | I | C | A,R | C | I |

---

## 7. Stakeholders + adoption

| Activity | ORCH | CTO | BIL | BANK | COMP |
|---|---|---|---|---|---|
| Tenant onboarding | A | I | R (BIL only) | R (BANK only) | C |
| Adoption metrics tracking (X.4) | A | C | C | C | I |
| Quarterly stakeholder review | A,R | I | C | C | I |
| Year-2 backlog stakeholder input | C | I | C | C | I |

---

## 8. Conventions

- **Exactly one A per row.** If two principals share accountability, list both with "A,R" or pick the senior.
- **R can be plural.** Multiple roles may share Responsibility for execution.
- **C ≠ R.** Consulted means "input requested before decision"; Responsible means "does the work".
- **I = visible.** Informed means the role gets the deliverable or update but doesn't owe input.
- **Empty cell = not involved.** No ambiguity.

---

## 9. Review cadence

- **Quarterly:** Steering committee reviews this matrix for drift (any roles changed, any activities added).
- **On material scope change:** Re-run the matrix for the affected area.
- **On staff turnover:** Re-assign A/R rows within 1 week.

---

## 10. References

- `docs/charter.md` — programme charter + principals roster.
- `docs/risk-register.md` — programme risks.
- `docs/on-call-rota.md` — operational responsibility.
- `AGENTS.md` — agent roster + owned paths.
- `infra/rbac/README.md` — RBAC + access review.
