# ZorEWS — Programme Charter

**Owner:** orchestrator · **Sponsor:** CISO + CTO · **Last reviewed:** 2026-05-20

> One-page charter covering mission, scope, success criteria, principals, governance, and operating cadence. Paired with `docs/raci.md` for accountability + `docs/risk-register.md` for tracked risks.

---

## 1. Mission

Build a banking-grade Early Warning System (ZorEWS) for credit, fraud, and operational risk that aggregates CBS, bureau, IFRS9, AML, and behavioural signals; surfaces risk indicators and AI-driven scores; manages alert → case lifecycle end-to-end; and integrates with Collection.

**Prototype phase target:** demoable end-to-end vertical slice across all 16 modules, covering 1 banking tenant (BANK_DEMO) + 1 insurance tenant (BIL), with synthetic data + IaC for production rollout + RBI/IRDAI compliance scaffolding.

---

## 2. Scope

### In-scope
- Multi-tenant data platform (Aurora + MSK + S3) with envelope-wrapped REST API.
- Indicator engine (32+25 = 57 KRIs across banking + insurance verticals).
- Rule engine (30+ seed rules, lifecycle, simulation, backtesting).
- AI risk scoring (PD model + SHAP) + auto-promotion gate.
- Alert + case management with maker-checker.
- 6 BIL dashboards (Claims / Underwriting / Agent / Operational / Executive / Customer 360).
- Notification channels (email + SMS + push).
- Audit chain (SHA-256) + evidence packaging.
- Multi-region DR IaC (Aurora Global + S3 CRR + MSK MM2).
- 8 BIL upstream adapter stubs (Insurance / IFRS9 / AML / DMS / Bureau / Agent / Finance / HR).

### Explicitly out-of-scope (prototype phase)
- Real AWS deploy (Terraform `apply`) and live bank integrations — only IaC + OpenAPI mocks.
- Real-time Kafka streaming on indicator → rule path (still batch via DAG).
- Mobile native release to public stores (RN shell deferred).
- DR drill in production (game-day plan published, not yet rehearsed).
- Pen-test execution (brief published, no engagement yet).
- ISO 27001:2022 audit (control mapping done; surveillance audit deferred).

---

## 3. Success criteria

By end of prototype phase, ZorEWS must:

- [x] Have all 16 BIL modules at ≥ 1 live sub-phase (current: 100% module coverage, 277/365 ≈ 76% API surface).
- [x] Demo end-to-end alert → case → action flow with maker-checker enforced.
- [x] Carry tamper-evident audit chain (M15.2 `verifyChain()` returns valid=true).
- [x] Ship multi-region DR IaC + DR runbook + game-day plan (T5.2 + T5.3).
- [x] Ship penetration-test brief + remediation playbook (T5.4).
- [x] Ship BAU runbook + SLOs + on-call rota (T5.6).
- [x] Ship Year-2 backlog with sized epics (T5.7).
- [x] FinOps dashboard surfacing cost-per-alert + cost-per-customer (T5.5).
- [ ] Pass `make ci` clean (install + test + build + lint).
- [ ] Render in `make web-dev` (Path A — MSW) without console errors on every route.

---

## 4. Principals + governance

| Role | Owner | Reports to |
|---|---|---|
| Programme orchestrator | Risk-IT lead (Daisy) | CISO + CTO |
| CISO | _named_ | CEO |
| CTO | _named_ | CEO |
| Risk-IT lead | _named_ | CTO |
| Compliance officer | _named_ | CISO |
| SRE lead | _named_ | CTO |
| BIL stakeholder (insurance vertical) | _named_ | CEO |
| Bank stakeholder (banking vertical) | _named_ | CEO |

### Steering committee

- **Cadence:** Monthly (last Tuesday of the month).
- **Membership:** CISO + CTO + Risk-IT lead + Compliance officer + 1 stakeholder per active tenant.
- **Quorum:** CISO OR CTO + 2 other principals.
- **Decisions:** Logged in `docs/steering-decisions.md` (to be authored on first meeting).

### Daily cadence

- Asynchronous via Slack `#apex-ews` channel + JIRA project APEX-EWS.
- No standing daily meeting — escalations via PagerDuty (per `docs/on-call-rota.md`).

---

## 5. Operating model

| Layer | Tools | Source of truth |
|---|---|---|
| Code | GitHub | `main` branch |
| Tickets | JIRA (APEX-EWS project) | JIRA |
| Docs | this repo, `docs/` directory | `main` branch |
| Comms | Slack | `#apex-ews` |
| Incidents | PagerDuty + Slack DR-WAR-ROOM | PagerDuty timeline |
| Deploys | GitHub Actions + ArgoCD (production) | ArgoCD app state |
| Observability | CloudWatch + Grafana | Grafana dashboards |
| Security | DefectDojo / SARIF | DefectDojo |

---

## 6. Budget envelope (illustrative, prototype phase)

| Category | Monthly ceiling | Owner |
|---|---|---|
| AWS infrastructure | $14k (BANK_DEMO + BIL tenants combined) | SRE lead |
| Third-party services (SES + Africa's Talking + Anthropic) | $2k | CTO |
| Pentest engagement (annual amortised) | $5k/month | CISO |
| FinOps consulting | $1k | SRE lead |
| **Monthly total** | **$22k** | — |

Tracked via the FinOps dashboard (T5.5) + reviewed monthly per `docs/bau-runbook.md` §3.

---

## 7. Risk posture

- **Risk appetite:** LOW for security/compliance, MEDIUM for operational, HIGH for feature-velocity (prototype phase — acceptable to defer polish).
- **Risk register:** `docs/risk-register.md` (to be authored alongside this charter).
- **Escalation:** Any Critical risk → CISO + CTO same-day; logged in steering committee notes.

---

## 8. Definition of Done (programme level)

The prototype phase is "done" when:

1. All 7 Phase 5 tasks closed (T5.1 partial OK).
2. Section 3 success criteria all checked.
3. `STATUS.md` reflects current state.
4. Steering committee signs off in writing.

---

## 9. Change control

- Material scope changes (new module, removed module, regulator addition) require steering committee written approval.
- Minor scope adjustments (sub-phase reordering, dependency swaps) are orchestrator-discretion + logged in commit messages.
- Out-of-scope items move to `docs/year-2-backlog.md` rather than getting dropped.

---

## 10. References

- `docs/raci.md` — accountability matrix.
- `docs/risk-register.md` — tracked programme risks.
- `STATUS.md` — current state.
- `TASKS.md` — backlog.
- `REQUIREMENTS.md` — original scope source.
- `AGENTS.md` — agent roster.
- `docs/bau-runbook.md` + `docs/dr-runbook.md` + `docs/pentest-brief.md` + `docs/year-2-backlog.md` — Phase 5 outputs.
