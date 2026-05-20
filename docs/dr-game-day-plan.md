# ZorEWS — DR Game-Day Plan

**Owner:** agent-integration · **Cadence:** Quarterly (Mar / Jun / Sep / Dec) · **Last reviewed:** 2026-05-20

> Quarterly rehearsal of `docs/dr-runbook.md`. Each game-day produces a scored report appended to `docs/dr-game-day-history.md` (to be authored after the first run).

---

## 1. Goals

1. **Validate** that the runbook produces a working failover within the declared RTO.
2. **Measure** actual RPO under realistic load (target: ≤ stated RPO per tier).
3. **Identify** drift between the runbook and reality (e.g. new Helm values not in `values-dr.yaml`).
4. **Practise** the on-call rota so any team member can execute it cold.

---

## 2. Cadence + scope ladder

| Quarter | Scope | Live traffic | Production blast radius |
|---|---|---|---|
| Q1 (Mar) | Aurora failover only | No (read-only secondary) | None |
| Q2 (Jun) | Aurora + MSK failover | No | None |
| Q3 (Sep) | Full stack to secondary region | Synthetic only | None |
| Q4 (Dec) | Full stack + 1-hour live shadow + failback | 10% canary | Limited (controlled) |

Q4 is the only quarter with real-tenant impact and requires written CISO + Legal sign-off 2 weeks in advance.

---

## 3. Roster

| Role | Owner | Backup |
|---|---|---|
| Incident commander | Risk-IT lead | SRE lead |
| Aurora operator | SRE primary | SRE secondary |
| EKS operator | Platform-eng primary | SRE primary |
| MSK operator | Data-eng primary | Platform-eng primary |
| Validator | QA lead | Risk-analyst on call |
| Scribe | Compliance officer | Risk-IT lead |
| Observer (RBI) | _present in writing only — RBI does not attend_ | — |

---

## 4. Pre-game checklist (T-2 weeks)

- [ ] Confirm secondary region capacity headroom (Karpenter quota + Aurora reader-count + MSK broker count).
- [ ] Tag a release candidate (e.g. `v0.X.Y-rc1`) of every service; pin the registry digests.
- [ ] Generate synthetic load via `make load-test` to baseline tenant-facing latencies.
- [ ] Notify all tenants 1 week in advance (Q4 only).
- [ ] Open the DR-WAR-ROOM Slack channel in scheduled state.
- [ ] Verify CRR lag < 60s, Aurora Global DB replication lag < 60s, MSK MM2 lag < 2 min.

---

## 5. T-0 procedure (game-day morning)

| Time | Action | Owner |
|---|---|---|
| T+00 | War room opens; incident commander declares game-day start. | Risk-IT lead |
| T+02 | Inject simulated outage (CloudWatch alarm fired manually via test-event). | Scribe |
| T+05 | On-call team receives page; clock starts. | PagerDuty |
| T+05..T+20 | Aurora failover (per runbook §3 Step 1-2). | Aurora operator |
| T+20..T+50 | EKS + MSK promotion (per runbook §3 Step 3-4). | EKS + MSK operators |
| T+50..T+65 | Validation (per runbook §3 Step 5). | Validator |
| T+65 | Game-day end-of-failover marker. RTO score recorded. | Incident commander |
| T+65..T+125 | Failback (Q3+ only, per runbook §4). | All |
| T+125 | Debrief huddle. | Incident commander |

---

## 6. Scoring rubric

| Dimension | Pass | Marginal | Fail |
|---|---|---|---|
| RTO met | ≤ target | ≤ 1.5× target | > 1.5× target |
| RPO met | ≤ target | ≤ 2× target | > 2× target |
| Runbook accuracy | 0 drift | 1-2 drift items | ≥ 3 drift items |
| Validator findings | 0 critical | 1 critical | ≥ 2 critical |
| Communications cadence | Updates ≤ 5 min apart | ≤ 10 min apart | > 10 min apart |
| Audit-chain integrity | Pass | — | Fail |

**Overall:** all-pass → Green. Any single Marginal → Amber. Any single Fail → Red, triggers a 30-day remediation playbook + re-run within the quarter.

---

## 7. Debrief artefacts

Within 5 business days of T-0:

1. **DR Game-Day Report** — `docs/dr-game-day-YYYY-MM-DD.md` with:
   - Timeline (actual vs target).
   - Scores per the rubric.
   - Drift list (runbook updates needed).
   - Validator findings.
   - Communications log.
2. **Runbook PR** — updates to `docs/dr-runbook.md` for any drift items.
3. **JIRA tickets** — one per remediation action with owner + SLA.
4. **Compliance log** — append to `docs/dr-game-day-history.md` for regulator readiness.

---

## 8. References

- `docs/dr-runbook.md` — the procedure being rehearsed.
- `docs/bau-runbook.md` — steady-state operations.
- `docs/on-call-rota.md` — primary + backup assignments.
- `docs/slos.md` — RTO/RPO targets keyed to error budget.
- `infra/terraform/30-data/global.tf` — Global DB topology.
