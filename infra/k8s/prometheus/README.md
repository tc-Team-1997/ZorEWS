# Prometheus — SLO recording rules + burn-rate alarms

**Phase:** T5-P1 + T5-P3 (per [`docs/operationalization/execution-plans.md`](../../../docs/operationalization/execution-plans.md))
**Owner:** SRE
**Last updated:** 2026-05-21

> PrometheusRule CRDs that implement the tier-1 SLOs from [`docs/slos.md`](../../../docs/slos.md). Recording rules pre-compute SLO budget burn at 1h + 6h + 3d windows; alerting rules fire when burn rate exceeds the budget threshold.

## Files

| File | Purpose |
|---|---|
| `namespace.yaml` | `monitoring` namespace for Prometheus + Grafana + Loki |
| `recording-rules.yaml` | Pre-aggregated SLI/SLO recording rules (cheap to query) |
| `alerting-rules.yaml` | Burn-rate alarms — 1h fast, 6h medium, 3d slow per multi-burn-rate spec |
| `infra-alerting.yaml` | Aurora / MSK / EKS / Karpenter / ESO alarms (infrastructure-level) |

## Service Level Objectives covered

Per [`docs/slos.md`](../../../docs/slos.md) tier-1:

| SLO | Target | Window | Burn-rate alarm |
|---|---|---|---|
| Public API availability | 99.5% / 30d | 3.6h budget/month | 1h fast at 14.4× burn |
| Auth-svc availability | 99.9% / 30d | 43min budget/month | 1h fast at 14.4× burn |
| Alert ingest p95 latency | <60s | n/a (latency-bound) | 1h p95 alarm |
| Webhook delivery success | 99.0% / 30d | 7.2h budget/month | 1h fast at 14.4× burn |
| BFF envelope correctness | 100% | n/a (binary) | Immediate alarm on any malformed envelope |
| Aurora writer availability | 99.99% / 30d | 4.3min budget/month | 1h fast at 14.4× burn |
| MSK availability | 99.9% / 30d | 43min budget/month | 1h fast at 14.4× burn |
| Audit chain integrity | 100% | n/a | Immediate alarm on `valid=false` |

## Multi-burn-rate alarm spec (Google SRE workbook)

For a 99.5%/30d SLO (0.5% error budget = 3.6h):

| Severity | Window | Burn rate | Triggers if | Budget burned at trigger |
|---|---|---|---|---|
| P1 (fast) | 1h | 14.4× | error rate > 0.5% × 14.4 = 7.2% over 1h | 14.4% in 1h = ~5min of monthly budget burnt in 1h |
| P1 (medium) | 6h | 6× | error rate > 3% over 6h | 36% in 6h = ~20% of monthly budget burnt in 6h |
| P2 (slow) | 3d | 1× | error rate > 0.5% over 3d | 50% of monthly budget by end of window |

PagerDuty escalation per `docs/on-call-rota.md`: P0 → primary + immediate page; P1 → primary at 5min; P2 → Slack only.

## Bootstrap sequence

```bash
# 1. Install kube-prometheus-stack Helm chart (one-time)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --values values-prometheus.yaml

# 2. Apply PrometheusRule CRDs
kubectl apply -f recording-rules.yaml
kubectl apply -f alerting-rules.yaml
kubectl apply -f infra-alerting.yaml

# 3. Verify rules are loaded
kubectl get prometheusrule -n monitoring
kubectl exec -n monitoring prometheus-kube-prometheus-stack-prometheus-0 -- \
  promtool check rules /etc/prometheus/rules/...
```

## Validation gate (T5-P3)

- `curl prometheus:9090/api/v1/rules` returns all recording + alerting groups
- `apex_ews:slo:error_budget_remaining:percent` recording rule has ≥ 7 days of history
- Synthetic alarm test: deliberately fail `/v1/alerts` for 2min → 1h burn alarm fires within 1m
- PagerDuty integration: synthetic alarm creates incident within 30s

## Rollback

```bash
# Remove alarming rules but keep recording rules (Grafana still works)
kubectl delete -f alerting-rules.yaml -f infra-alerting.yaml

# Full rollback: remove kube-prometheus-stack
helm uninstall kube-prometheus-stack -n monitoring
```

CloudWatch metrics remain as a fallback observability layer; Grafana can be reconfigured to read from CloudWatch via the CloudWatch datasource.

## Cost considerations

- Prometheus storage: ~15GB/day at current scale; retention 15 days = ~225GB on PVC
- Loki: ~50GB/day logs; retention 90d → S3 lifecycle
- Grafana: stateless; no storage
- Total monthly cost: ~$300 (EBS + S3 + EC2 for monitoring node) — well within T5.5 FinOps envelope

## Cross-references

- SLO definitions + targets: [`docs/slos.md`](../../../docs/slos.md)
- Critical alarm catalogue: [`docs/operationalization/readiness-checklists.md`](../../../docs/operationalization/readiness-checklists.md) §3
- Runbook URLs (mandatory on every alert): annotation `runbook_url` on every rule
- On-call escalation: [`docs/on-call-rota.md`](../../../docs/on-call-rota.md)
