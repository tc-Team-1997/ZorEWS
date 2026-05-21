# cert-manager — ACM-style certificate automation

**Phase:** T3-P5 (per [`docs/operationalization/execution-plans.md`](../../../docs/operationalization/execution-plans.md))
**Owner:** SRE
**Last updated:** 2026-05-21

> cert-manager + ClusterIssuer (Let's Encrypt) for internal cluster certs. Public-facing ALB uses ACM-managed certs directly (better integration; auto-rotates without cluster involvement). cert-manager covers the in-cluster TLS surface (Argo CD UI, Grafana, internal ingress).

## Files

| File | Purpose |
|---|---|
| `namespace.yaml` | `cert-manager` namespace |
| `cluster-issuer.yaml` | 2 ClusterIssuer CRs: `letsencrypt-prod` (real certs) + `letsencrypt-staging` (rate-limit-friendly for testing) |
| `internal-certificate.yaml` | example Certificate CRs for ArgoCD UI + Grafana |

## Install

```bash
# Helm chart (one-time per cluster)
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --version v1.15.0 \
  --set installCRDs=true \
  --set prometheus.enabled=true \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=${CERT_MANAGER_ROLE_ARN} \
  --wait --timeout 5m

# Apply ClusterIssuers + initial Certificates
kubectl apply -f infra/k8s/cert-manager/cluster-issuer.yaml
kubectl apply -f infra/k8s/cert-manager/internal-certificate.yaml

# Verify
kubectl get clusterissuer
kubectl get certificate -A
```

## DNS01 vs HTTP01

DNS01 (Route 53) preferred for production:
- Works for internal-only hostnames (no public reachability needed)
- Required for wildcard certs (e.g. `*.internal.apex-ews.example`)
- Requires the IAM role + Route 53 hosted zone provisioned by 40-edge

HTTP01 fallback: only when DNS01 unavailable; needs an Ingress reachable on port 80.

## Validation

```bash
# Certificate Ready=True
kubectl get cert -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'

# Issuer ready
kubectl get clusterissuer letsencrypt-prod -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
```

## Rollback

```bash
# Disable auto-renewal but keep existing cert
kubectl delete certificate -A --all

# Full removal
helm uninstall cert-manager -n cert-manager
kubectl delete crd certificates.cert-manager.io clusterissuers.cert-manager.io issuers.cert-manager.io
```

Existing cert resources are not removed by uninstall — they remain valid until expiry (~60d for Let's Encrypt).
