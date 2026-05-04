# 20-eks

EKS 1.30 cluster `apex-ews-<env>`.

- API endpoint: private only (no public access; reach via SSM session manager / VPN).
- Secrets envelope-encrypted with `alias/apex-ews-secret` CMK.
- All control-plane log types enabled.
- OIDC provider provisioned for IRSA.

Node groups:

| Group   | Type            | Min | Max | Desired | Notes |
|---------|-----------------|-----|-----|---------|-------|
| general | `m6i.xlarge`    | 3   | 12  | 3       | All non-AI workloads |
| ai      | `g5.xlarge`     | 0   | 4   | 0       | Tainted `workload=ai:NoSchedule`; scales on demand for PD scoring + SHAP |

IRSA roles created for the seven microservices: `auth-svc`, `audit-svc`, `pipeline-svc`, `regulatory-svc`, `ai-copilot-svc`, `notification-svc`, `analytics-svc`. Output `irsa_role_arns` is consumed by the matching `infra/k8s/serviceaccounts.yaml` annotations.

Instance-type rationale:

- `m6i.xlarge` — Graviton not yet GA in `af-south-1` for all services + EBS-optimised + good price/perf for JVM/Node workloads.
- `g5.xlarge` — A10G GPU sufficient for SHAP + XGBoost batch scoring; cheapest single-GPU option in region.
