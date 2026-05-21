# External Secrets Operator — AWS Secrets Manager bridge

**Phase:** T3-P3 (per [`docs/operationalization/execution-plans.md`](../../../docs/operationalization/execution-plans.md))
**Owner:** SRE
**Last updated:** 2026-05-21

> External Secrets Operator (ESO) syncs secrets from AWS Secrets Manager into Kubernetes Secret resources. Per-service ExternalSecret manifests pull the credentials each service needs. The ClusterSecretStore is the single bridge to AWS — services never carry IAM credentials directly.

## Files

| File | Purpose |
|---|---|
| `namespace.yaml` | `external-secrets` namespace |
| `cluster-secret-store.yaml` | ClusterSecretStore → AWS Secrets Manager (IRSA via OIDC) |
| `bff-secrets.yaml` | BFF: BFF_PG_URL + ANTHROPIC_API_KEY + KAFKA_BROKERS + JWKS_URL |
| `auth-svc-secrets.yaml` | auth-svc: AUTH_SVC_PG_URL + JWT signing keys |
| `audit-svc-secrets.yaml` | audit-svc: AUDIT_DB_URL + S3 audit bucket prefix |
| `regulatory-svc-cases-secrets.yaml` | CASES_PG_URL + APEX_CASES_URL |
| `regulatory-svc-alerts-secrets.yaml` | ALERTS_PG_URL + APEX_CASES_URL + KAFKA_BROKERS |
| `regulatory-svc-rules-secrets.yaml` | RULES_PG_URL |
| `regulatory-svc-indicators-secrets.yaml` | INDICATORS_PG_URL |
| `collection-adapter-secrets.yaml` | APEX_CASES_URL + mTLS client cert (from Secrets Manager binary blob) |
| `notification-svc-secrets.yaml` | SES + Africa's Talking + FCM service account + APNS .p8 |
| `pipeline-svc-secrets.yaml` | MWAA connection strings |
| `ai-copilot-svc-secrets.yaml` | Aurora reader DSN + ANTHROPIC_API_KEY (separate from BFF) |

## Bootstrap sequence

```bash
# 1. Install ESO via Helm chart
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets --create-namespace \
  --set installCRDs=true \
  --set serviceAccount.create=true \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::$ACCOUNT_ID:role/external-secrets-operator

# 2. Apply ClusterSecretStore (the bridge)
kubectl apply -f cluster-secret-store.yaml

# 3. Apply per-service ExternalSecret manifests
kubectl apply -f bff-secrets.yaml -f auth-svc-secrets.yaml -f ...

# 4. Verify sync
kubectl get externalsecret -A
# Should show SyncedToTarget for every entry
```

## IRSA role required

The ESO ServiceAccount must be annotated with an IAM role that allows:

```hcl
# Terraform (illustrative — actual role lives in infra/terraform/20-eks/iam.tf)
data "aws_iam_policy_document" "eso_secrets_read" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:ListSecrets",
    ]
    resources = [
      "arn:aws:secretsmanager:af-south-1:*:secret:apex-ews/prod/*",
      "arn:aws:secretsmanager:af-south-1:*:secret:apex-ews/staging/*",
    ]
  }
  statement {
    actions = ["kms:Decrypt"]
    resources = ["arn:aws:kms:af-south-1:*:key/apex-ews-secrets"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.af-south-1.amazonaws.com"]
    }
  }
}
```

## Refresh interval

Every ExternalSecret declares `refreshInterval: 5m`. Secrets that ESO detects as rotated (Secrets Manager `VersionId` change) are pushed into the K8s Secret within 5 minutes. Services that load env-vars at process start need a pod rollout to pick up new values — wire a watching sidecar or restart-on-secret-change controller if zero-downtime rotation matters (recommended for Aurora master password rotation per T2-P1 90-day cycle).

## Validation gate (T3-P3)

- `kubectl get externalsecret -A` shows `STATUS=SecretSynced` for every entry
- `kubectl get secret bff-pg-url -o jsonpath='{.metadata.annotations}'` shows ESO sync timestamp < 2min ago
- Synthetic test: rotate `apex-ews/prod/bff-pg-url` in Secrets Manager → K8s Secret reflects within 5 min

## Rollback

```bash
# Disable ESO sync (CRDs remain; secrets stop refreshing)
kubectl scale deployment external-secrets -n external-secrets --replicas=0

# Fallback: manually create K8s Secret from Secrets Manager values
aws secretsmanager get-secret-value --secret-id apex-ews/prod/bff-pg-url \
  --query SecretString --output text \
  | xargs -I {} kubectl create secret generic bff-pg-url --from-literal=url={}
```

24h bridge maximum — operator must re-enable ESO before 24h for compliance.
