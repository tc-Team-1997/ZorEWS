# Grafana dashboards — provisioning

**Phase:** T5-P1 (per [`docs/operationalization/execution-plans.md`](../../../docs/operationalization/execution-plans.md))
**Owner:** SRE
**Last updated:** 2026-05-21

> Grafana dashboards-as-code, provisioned via the `kube-prometheus-stack` Helm chart's ConfigMap pattern. Dashboards live under `dashboards/`; the install script wraps them in a ConfigMap with the `grafana_dashboard: "1"` label so the Grafana sidecar auto-loads them.

## Files

| File | Purpose | Recording rules consumed |
|---|---|---|
| `dashboards/slo-overview.json` | Tier-1 SLO error budgets + burn rates at 1h/6h/3d. The single dashboard the steering committee + on-call see. | `apex_ews:slo:*:burn_rate:*` + `apex_ews:slo:*:error_budget_remaining` |
| `dashboards/bff-service.json` | BFF service detail — request rate, latency p50/p95/p99, error rate by route, in-flight requests | `apex_ews:sli:bff:*` |
| `dashboards/aurora-msk-eks.json` | Infrastructure layer — Aurora CPU + connections, MSK broker disk + consumer lag, EKS node + HPA status | CloudWatch + kube-state-metrics + Karpenter metrics |
| `dashboards/tenant-spend.json` | Per-tenant cost + alert/case/audit volume (FinOps T5.5 surface) | T5.5 FinOps endpoint output |

## Provisioning

The `bootstrap-cluster.sh` script provisions Grafana via Helm with sidecar enabled:

```yaml
grafana:
  sidecar:
    dashboards:
      enabled: true
      label: grafana_dashboard
      labelValue: "1"
      searchNamespace: ALL
```

Then apply the ConfigMaps:

```bash
# Install all dashboards as ConfigMaps in the monitoring namespace
for dashboard in infra/k8s/grafana/dashboards/*.json; do
  name=$(basename "${dashboard%.json}")
  kubectl create configmap "grafana-${name}" \
    --from-file="${dashboard}" \
    --namespace monitoring \
    --dry-run=client -o yaml | \
    kubectl label --local -f - --dry-run=client -o yaml \
    grafana_dashboard=1 | \
    kubectl apply -f -
done
```

Or via Helm values (recommended; ArgoCD-managed):

```yaml
grafana:
  dashboardsConfigMaps:
    default: "grafana-slo-overview"
    default: "grafana-bff-service"
    default: "grafana-aurora-msk-eks"
    default: "grafana-tenant-spend"
```

## Authoring new dashboards

1. Author in Grafana UI (use `dev` environment Grafana)
2. Settings → JSON Model → copy
3. Save under `dashboards/<name>.json`
4. Replace any hardcoded `datasource: "<uuid>"` with `"datasource": "${DS_PROMETHEUS}"` template var
5. PR to `main`; ArgoCD picks up via the observability Application

## Cross-references

- SLO definitions: [`docs/slos.md`](../../../docs/slos.md)
- Recording rules: [`../prometheus/recording-rules.yaml`](../prometheus/recording-rules.yaml)
- Alerting rules: [`../prometheus/alerting-rules.yaml`](../prometheus/alerting-rules.yaml)
- Runbook for each alarm: [`docs/bau-runbook.md`](../../../docs/bau-runbook.md)
