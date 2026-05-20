# ZorEWS — Service Level Objectives

**Owner:** SRE lead + Risk-IT · **Review cadence:** Quarterly · **Last reviewed:** 2026-05-20

> SLI (what we measure), SLO (target), error budget (how much slack), and burn-rate alerts (when to wake someone up). Pair with `docs/bau-runbook.md` for daily verification + `docs/dr-runbook.md` for failover-time SLO behaviour.

---

## 1. Tier-1 SLOs (tenant-facing)

| Service | SLI | SLO | Error budget | Burn-rate alert |
|---|---|---|---|---|
| Public API (`/v1/*`) | % requests returning 2xx within 1s | **99.5% / 30 days** | 3.6h/month | 2h fast burn → page |
| Auth (`/auth/*`, `/oauth/token`) | % requests returning 2xx within 500ms | **99.9% / 30 days** | 43 min/month | 30min fast burn → page |
| Alert ingestion → SPA delivery | p95 latency from `apex.regulatory.events` → SSE bell | **< 60s** | n/a (latency SLO) | Sustained > 60s 5min → page |
| Webhook dispatch | % deliveries succeeded within 16s (3 retries) | **99.0% / 30 days** | 7.2h/month | Per-subscription > 5% failure 24h → notify owner |
| BFF envelope correctness | % envelope-shape valid in CI | **100%** | 0 | Any test failure → block merge |

---

## 2. Tier-2 SLOs (internal / data-plane)

| Service | SLI | SLO | Error budget |
|---|---|---|---|
| Aurora writer | % availability | **99.99% / 30 days** | 4.3 min/month |
| MSK broker | % availability per broker | **99.9% / 30 days** | 43 min/broker/month |
| MSK MirrorMaker 2 lag | p95 lag primary→secondary | **< 2 min** | n/a (latency) |
| Audit S3 (Object Lock) | % objects with valid Object Lock | **100%** | 0 |
| Audit hash-chain | % `verifyChain()` returns `valid=true` | **100%** | 0 |
| Schema-registry compatibility | % topic versions pass BACKWARD check | **100%** | 0 |

---

## 3. Tier-3 SLOs (analytics / batch)

| Service | SLI | SLO | Error budget |
|---|---|---|---|
| dbt mart rebuild | % daily refresh completed by 06:00 IST | **99% / 30 days** | 3 misses/month |
| AI model promotion | % auto-promotion gate decisions within 1min | **99% / 30 days** | n/a |
| Report generation | p95 latency for monthly report | **< 5min** | n/a (latency) |
| FinOps dashboard freshness | Data lag from billing | **< 24h** | n/a (latency) |

---

## 4. Error budget policy

| Burn rate | Action |
|---|---|
| 0-25% over 30 days | Normal operations; ship features. |
| 25-50% | Heightened monitoring; pause non-critical deploys. |
| 50-75% | Feature freeze. Deploy only fixes that reduce burn. |
| 75-100% | Mandatory engineering response; on-call rotation reinforced. |
| > 100% | Customer notification; CISO + CTO review; SLO target may need recalibration. |

Burn rate calculated on a rolling 30-day window. Reset on the 1st of each calendar month.

---

## 5. Burn-rate alerts

Two-window approach (fast + slow) to balance alert fatigue vs sensitivity:

| Window | Threshold (per SLO) | Action |
|---|---|---|
| 1h fast | Consuming 5% of monthly budget in 1h | PagerDuty: page primary on-call |
| 6h slow | Consuming 10% of monthly budget in 6h | PagerDuty: page primary; if unresolved at 24h, page secondary |
| 3d slow | Consuming 50% of monthly budget in 3d | Slack notify SRE channel; review at next standup |

Configured per SLO in CloudWatch + Grafana alert rules. Source-of-truth lives in `infra/observability/` (to be authored).

---

## 6. SLO ownership

| SLO | Owner | Backup |
|---|---|---|
| Public API | SRE primary | BFF agent |
| Auth | auth-svc agent | SRE primary |
| Alert ingestion | agent-alert | SRE primary |
| Webhook dispatch | BFF agent | SRE primary |
| Aurora | agent-data | SRE primary |
| MSK + MM2 | agent-integration | SRE primary |
| Audit + hash-chain | agent-integration | CISO |
| Schema-registry | agent-data | agent-integration |
| dbt mart | agent-data | agent-integration |
| AI promotion | agent-ai | agent-integration |
| Reports | BFF agent | SRE primary |
| FinOps | SRE lead | FinOps consultant |

---

## 7. Reporting cadence

| Cadence | Audience | Format |
|---|---|---|
| Weekly | SRE team | Slack post in #apex-ews-slo: top 3 burn rates + any anomalies |
| Monthly | Engineering leadership | PDF: per-SLO status, error-budget trend, postmortem coverage |
| Quarterly | CISO + CTO + board | Slide deck: SLO compliance %, customer impact, year-over-year |
| Annually | RBI / IRDAI (on request) | Formal report per regulatory framework |

---

## 8. SLO recalibration

SLOs are recalibrated annually OR when:

- Sustained over-achievement (≥ 6 months at < 25% burn) — consider tightening.
- Sustained under-achievement (≥ 3 months at > 75% burn) — consider loosening or investing in reliability.
- Major architectural change (e.g. DR failover changes the latency profile).
- Customer commitment change (e.g. new SLA with a tenant).

Recalibration requires: CISO + CTO + SRE-lead sign-off + customer notification 30 days in advance for tier-1 SLO loosenings.

---

## 9. References

- `docs/bau-runbook.md` — daily/weekly verification of these SLOs.
- `docs/dr-runbook.md` — SLO behaviour during failover.
- `docs/pentest-remediation-playbook.md` — security incident impact on SLOs.
- `infra/observability/` — alert rules (to be authored).
- Google SRE Book Ch. 4 — Service Level Objectives.
