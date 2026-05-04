# Kubernetes manifests

Plain YAML (no Helm/Kustomize for Phase 0 scaffolding). Apply order:

1. `namespaces.yaml`
2. `rbac.yaml`
3. `serviceaccounts.yaml` (after substituting `${IRSA_ROLE_ARN_*}` placeholders from `infra/terraform/20-eks/outputs.tf`)
4. `network-policies.yaml`
5. `deployments.yaml`

Conventions:

- Pod-Security `restricted` enforced per namespace (NFR-SEC-2).
- Every Deployment uses an IRSA SA — no static AWS keys.
- Pods that produce audit events are labelled `apex-ews.io/emits-audit: "true"` so the `allow-audit-emit` NetworkPolicy lets them reach `audit-svc:8081`.
- AI workloads are scheduled on the tainted `ai` node group only.
