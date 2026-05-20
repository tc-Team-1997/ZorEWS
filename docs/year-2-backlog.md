# ZorEWS — Year-2 Backlog

**Owner:** orchestrator · **Grooming cadence:** Quarterly · **Last reviewed:** 2026-05-20

> Forward-looking themes + sized epics for the year following the prototype's Phase 5 close. This is a living document — items move to `TASKS.md` once committed to a specific phase or sprint. Year-2 here means: post-Phase-5, post-T6 (BIL 16-module ~365 APIs), post-prototype delivery to BIL.

---

## 1. Themes (priority order)

| Theme | Driver | Year-2 outcome |
|---|---|---|
| **A. Production hardening** | We have to actually deploy this to a bank | Aurora Global DB live, MSK MM2 live, blue/green deploy, pen-tested |
| **B. BIL platform completion** | T6 is 277/365 sub-phases; ~88 remain | All 16 modules at 100% surface coverage |
| **C. Real bank integrations** | T3.1-T3.3 still stubbed | CBS, IFRS9, AML, Bureau live (per-tenant feature-flagged) |
| **D. Real-time alert path** | T2.12 partial; Kafka path still batch | Indicator update → rule eval p95 < 60s end-to-end |
| **E. Continuous learning loop** | T5.1 auto-promotion gate done; training scheduler not | Quarterly auto-retrain + champion/challenger promote |
| **F. Mobile** | T4.3 unshipped | RN shell: alert list + case view + GPS field action |
| **G. Multi-region rollout** | T5.2 lands IaC; first failover unrehearsed | DR drill quarterly cadence in production |
| **H. Cost optimisation** | FinOps dashboard ships but no actions | 25% cost-per-alert reduction year-over-year |
| **I. Regulator readiness** | RBI + IRDAI compliance covered in docs, not audited | Pass first regulator audit clean |

---

## 2. Sized epics

### 2.1 Theme A — Production hardening

| Epic | Estimate | Pre-reqs | Owner |
|---|---|---|---|
| Aurora Global DB live (failover validated) | 4 weeks | T5.2 IaC | agent-integration |
| MSK MirrorMaker 2 live (lag < 2min sustained) | 3 weeks | T5.2 IaC | agent-integration |
| S3 CRR live across audit + raw + curated | 2 weeks | T5.2 IaC | agent-integration |
| Blue/green deploy pipeline | 4 weeks | EKS Karpenter | agent-integration |
| First third-party pentest engagement | 10 weeks (Q1) | T5.4 brief | CISO |
| First DR game-day | 1 week (Q1) | T5.3 runbook | SRE lead |
| Postmortem template + first 3 incidents | 2 weeks | n/a | SRE lead |

### 2.2 Theme B — BIL platform completion

Roughly 88 sub-phases remain across 16 modules. Pattern is established; ~2 sub-phases/day sustained.

| Module bucket | Remaining sub-phases (est.) | Estimate |
|---|---|---|
| M1 Auth / Identity | ~5-10 | 1-2 weeks |
| M2 Tenant operations | ~3-5 | 1 week |
| M3 Data ingestion | ~5-8 | 1-2 weeks |
| M4 Indicators | ~5-8 | 1-2 weeks |
| M5 Rule engine | ~5-7 | 1-2 weeks |
| M6 Risk scoring | ~5-7 | 1-2 weeks |
| M7 AI / ML | ~5-8 | 2 weeks |
| M8 Alerts | ~5-7 | 1-2 weeks |
| M9 Cases | ~5-7 | 1-2 weeks |
| M10 Notifications | ~5-7 | 1-2 weeks |
| M11 Dashboards | ~10-15 | 3 weeks |
| M12 Reports | ~5-7 | 1-2 weeks |
| M13 Admin config | ~3-5 | 1 week |
| M14 Integrations | ~15-20 | 3-4 weeks |
| M15 Audit | ~5-7 | 1-2 weeks |
| M16 Scenarios | ~5-7 | 1-2 weeks |
| **Total** | **~88** | **~16-22 weeks** |

### 2.3 Theme C — Real bank integrations

| Epic | Estimate | Pre-reqs | Owner |
|---|---|---|---|
| CBS real connector (T3.1) | 8 weeks | Bank API access | agent-integration + agent-data |
| IFRS9 stage live feed (T3.2) | 6 weeks | ECL pipeline | agent-integration + agent-ai |
| AML bidirectional correlation (T3.3) | 8 weeks | AML vendor SDK | agent-integration |
| Bureau live integration (CIBIL/CRIF/EXPERIAN/EQUIFAX) | 6 weeks each, parallelisable | Bureau MoUs | agent-integration |
| Per-tenant integration enablement (feature flag) | 2 weeks | M13.1 config | agent-integration |

### 2.4 Theme D — Real-time alert path (T2.12)

| Epic | Estimate | Pre-reqs | Owner |
|---|---|---|---|
| Kafka producer on `apex.indicator.values` | 3 weeks | Indicator compute service | agent-indicator |
| Streaming rule evaluator (consumer group) | 4 weeks | rules service | agent-rule |
| End-to-end latency monitoring (indicator → SPA SSE) | 2 weeks | M15.1 audit + Grafana | SRE lead |
| Failure / replay strategy | 2 weeks | DLQ topic + outbox pattern | agent-alert |
| Load test to confirm p95 < 60s under 10× current volume | 1 week | infra | SRE lead |

### 2.5 Theme E — Continuous learning loop (T5.1 retraining)

| Epic | Estimate | Pre-reqs | Owner |
|---|---|---|---|
| Quarterly retrain scheduler (Airflow DAG) | 3 weeks | feature store | agent-ai |
| Champion/challenger A/B test harness in production | 4 weeks | M7.x model registry + auto-promotion gate | agent-ai |
| Drift-triggered ad-hoc retrain | 2 weeks | T2.6 drift monitor | agent-ai |
| Model card auto-generation on promotion | 1 week | M7.1 + audit | agent-ai |

### 2.6 Theme F — Mobile (T4.3)

| Epic | Estimate | Pre-reqs | Owner |
|---|---|---|---|
| RN shell + auth (TOTP 2FA + biometrics) | 4 weeks | M1.1 | agent-ui |
| Alert list + filter + ack | 3 weeks | M8.x | agent-ui |
| Case view + action capture | 4 weeks | M9.1 + M14.10 | agent-ui |
| GPS-tagged field action log | 2 weeks | M14.10 | agent-ui |
| Offline mode + sync queue | 4 weeks | DB layer | agent-ui |
| App Store + Play Store release | 3 weeks | branding + privacy review | agent-ui + CISO |

### 2.7 Theme G — Multi-region rollout

| Epic | Estimate | Pre-reqs | Owner |
|---|---|---|---|
| Secondary region terraform applied to dev environment | 1 week | T5.2 IaC | agent-integration |
| Secondary region applied to staging | 1 week | dev OK | agent-integration |
| Secondary region applied to prod | 1 week | staging OK | agent-integration |
| Q1 + Q2 + Q3 + Q4 DR game-days (T5.3 cadence) | 1 week each | game-day plan | SRE lead |
| First production failback exercise (Q4) | 1 week | Q3 game-day clean | SRE lead |

### 2.8 Theme H — Cost optimisation

| Epic | Estimate | Pre-reqs | Owner |
|---|---|---|---|
| Karpenter spot-instance ramp for non-critical EKS workloads | 2 weeks | EKS cluster | SRE lead |
| Aurora reader autoscale to zero off-hours | 2 weeks | Aurora | agent-data |
| S3 lifecycle: raw to IA-tier after 90 days | 1 week | S3 | agent-data |
| MSK broker right-sizing review | 1 week | MSK | agent-integration |
| FinOps dashboard wired (T5.5) | shipped | — | — |
| Quarterly cost-per-alert + cost-per-customer trend review | 1 day quarterly | T5.5 | SRE lead + FinOps |

### 2.9 Theme I — Regulator readiness

| Epic | Estimate | Pre-reqs | Owner |
|---|---|---|---|
| ISO 27001:2022 internal audit | 4 weeks | compliance-mapping.md | CISO |
| ISO 27001:2022 surveillance audit (third-party) | 6 weeks | internal audit clean | CISO |
| RBI Cyber Resilience self-assessment + filing | 3 weeks | T5.4 + T5.6 | Risk-IT lead |
| IRDAI Info-Sec self-assessment + filing | 3 weeks | T5.4 + T5.6 | Risk-IT lead |
| DPA 2019 audit trail review | 2 weeks | M15.1 + M15.2 + M15.3 | CISO |
| First regulator examination (RBI / IRDAI request) | 4-8 weeks | T5.x + M15.x | CISO + Risk-IT |

---

## 3. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bank API access delays | High | Slips Theme C by 4-8 weeks | Parallel sandbox integration testing; engage bank IT early |
| Pentest finds Critical that requires architecture change | Medium | 4-8 weeks rework | T5.4 brief is tight; threat model up-front |
| AWS quota limits on secondary region | Medium | Slips Theme A/G by 2-4 weeks | Submit quota increases at T5.2 IaC plan |
| BIL team scope creep on remaining 88 sub-phases | High | Slips Theme B | Quarterly scope review with BIL stakeholders |
| Model performance degradation post-retraining | Medium | Tenant-facing accuracy drop | Champion/challenger A/B + drift monitor (Theme E) |
| Regulator (RBI/IRDAI) issues new directive | Medium | 4+ weeks rework | Compliance subscription + monthly review |

---

## 4. Out-of-scope for Year 2

These are explicitly NOT planned for year 2 — captured here so they don't reappear as "missed" deliverables:

- Multi-cloud (Azure / GCP) — AWS-only until business case proven.
- White-label SaaS offering — single-tenant deployments only.
- Self-service tenant onboarding (no human-in-loop) — onboarding wizard requires Risk-IT approval.
- Real-time NL→SQL Copilot in production (T2.9 stub stays stub) — accuracy bar not met.
- Cross-bank consortium (sharing risk signals) — regulatory blocker.
- Public bug-bounty programme — first need clean pentest then maybe Year 3.

---

## 5. Year-2 success criteria

By end of Year 2, ZorEWS should:

- [ ] Have run ≥ 1 production failover exercise (Theme G).
- [ ] Pass ISO 27001:2022 surveillance audit clean (Theme I).
- [ ] Operate with 99.5% tier-1 SLO compliance over rolling 30 days (per `docs/slos.md`).
- [ ] Serve ≥ 5 tenants in production (currently 2: BANK_DEMO + BIL).
- [ ] Cover ≥ 95% of T6 BIL sub-phases (Theme B).
- [ ] Have ≥ 1 live bank integration end-to-end (Theme C — minimum CBS).
- [ ] Achieve cost-per-alert reduction ≥ 25% year-over-year (Theme H).
- [ ] Mobile RN shell shipped to TestFlight + Play Store internal track (Theme F).
- [ ] Real-time alert path p95 < 60s validated under load (Theme D).
- [ ] Continuous learning loop running quarterly with auto-promotion gate (Theme E).

---

## 6. References

- `TASKS.md` — current sprint backlog.
- `STATUS.md` — what's shipped to date.
- `docs/dr-runbook.md` + `docs/dr-game-day-plan.md` — Theme A + G.
- `docs/pentest-brief.md` + `docs/pentest-remediation-playbook.md` — Theme A + I.
- `docs/bau-runbook.md` + `docs/slos.md` + `docs/on-call-rota.md` — Theme A.
- `docs/compliance-mapping.md` — Theme I.
- `docs/bac-a-manual-gap-analysis.md` — Theme B context.
