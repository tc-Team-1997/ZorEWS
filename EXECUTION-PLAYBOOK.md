# ZorEWS — Production Execution Playbook

**Status:** Implementation-ready, all consistency audit fixes applied
**Last updated:** 2026-05-21
**Owner during execution:** SRE-lead
**Target:** validated staging environment in 1 working day; production cutover at T9-P2

> Single sequential playbook. Each step has a pre-flight check, exact command, expected output marker, validation, rollback, and failure diagnostic. Copy-paste from top to bottom in a working terminal. No planning here — execution only.

## Hidden blockers already resolved by this commit

Audited the existing artifacts before writing this playbook. 4 blockers fixed:

| # | Blocker found | Resolution shipped this commit |
|---|---|---|
| 1 | `scripts/bootstrap-cluster.sh` references `terraform output external_secrets_role_arn` — output didn't exist in `20-eks` | Added `infra/terraform/20-eks/eso.tf` (IRSA role + KMS-scoped policy + condition `secretsmanager.<region>.amazonaws.com`) + new `external_secrets_role_arn` output |
| 2 | `infra/k8s/karpenter/install.sh` filtered subnets with `tag:tier=private` but `10-network` tags them `Tier=private` (capital T) | Corrected filter to `Name=tag:Tier,Values=private` |
| 3 | `scripts/seed-secrets.sh` provisions `audit-svc/pg-url`, `ai-copilot-svc/pg-url`, `collection-adapter/{cases-url,mtls-cert,mtls-key}` — no ESO manifests existed to pull them | Added 3 new ExternalSecret manifests (`audit-svc-secrets.yaml`, `ai-copilot-svc-secrets.yaml`, `collection-adapter-secrets.yaml`) |
| 4 | New `secrets_kms_key_arn` variable needed on 20-eks (was implicit) | Added explicit variable + wired into ESO policy condition |

## Pre-flight (before step 0)

### Local tooling

```bash
# Required versions:
aws --version          # 2.13+
kubectl version --client --short  # 1.30+
terraform version      # 1.5+ (see infra/terraform/*/versions.tf)
helm version --short   # 3.13+
argocd version --client  # 2.10+
jq --version
```

If any tool missing:
```bash
brew install awscli kubectl terraform helm argocd jq
```

### AWS authentication

```bash
aws sts get-caller-identity
# Expected: { "Account": "<production-account-id>", "Arn": "arn:aws:sts::...:assumed-role/apex-ews-deploy/..." }
```

Validation: `Account` must match the production payer-or-member account from Track 1.

Failure: re-auth via `aws sso login --profile apex-ews-prod` (or whatever profile is configured).

### Repo on `main` at the right SHA

```bash
git fetch origin main
git rev-parse HEAD
git log --oneline -1
# Expected: matches https://github.com/tc-Team-1997/ZorEWS commits/main
```

If on a feature branch: `git checkout main && git pull origin main`.

---

## Step 0 — Tag VPC + subnets for Karpenter discovery (if not done by Terraform)

**Pre-flight:**
```bash
terraform -chdir=infra/terraform/10-network output -raw vpc_id
# Expected: vpc-xxxxxxxx (8+ hex chars)
```

**Command:**
```bash
VPC_ID=$(terraform -chdir=infra/terraform/10-network output -raw vpc_id)
CLUSTER=apex-ews-prod

# Tag private subnets for Karpenter
for s in $(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC_ID}" "Name=tag:Tier,Values=private" --query 'Subnets[].SubnetId' --output text); do
  aws ec2 create-tags --resources "${s}" --tags "Key=karpenter.sh/discovery,Value=${CLUSTER}"
done

# Tag cluster shared security group
SG=$(aws eks describe-cluster --name "${CLUSTER}" --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)
aws ec2 create-tags --resources "${SG}" --tags "Key=karpenter.sh/discovery,Value=${CLUSTER}"
```

**Validation:**
```bash
aws ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC_ID}" "Name=tag:karpenter.sh/discovery,Values=${CLUSTER}" --query 'length(Subnets)'
# Expected: 3 (one per AZ)
```

**Rollback:** `aws ec2 delete-tags --resources <subnet-id> --tags Key=karpenter.sh/discovery` (no consequence; Karpenter just can't discover until re-tagged).

**Failure diagnostic:** If subnets return 0, your `Tier` tag is missing — verify `terraform output` of 10-network reports private subnet IDs and re-check the IaC.

---

## Step 1 — Apply 00-landing-zone (Org + KMS + CloudTrail + Config + GuardDuty + SCPs)

**Pre-flight:**
```bash
cd infra/terraform/00-landing-zone
terraform init
terraform validate
terraform plan -detailed-exitcode
# Exit 2 = plan has changes; exit 0 = no changes; exit 1 = error.
```

**Command:**
```bash
# First apply: keep AWS Config off to dodge race with KMS + S3 bucket creation
terraform apply -var='enable_aws_config=false' -auto-approve

# Second apply: turn on Config now that bucket + key exist
terraform apply -var='enable_aws_config=true' -auto-approve
```

**Expected output (final lines):**
```
Apply complete! Resources: 40+ added, 0 changed, 0 destroyed.

Outputs:
organization_id = "o-..."
ou_ids = { "Sandbox" = "ou-...", "Security" = "ou-...", "Workloads" = "ou-..." }
kms_key_arns = { "aurora" = "arn:...", "audit" = "arn:...", "msk" = "arn:...", "s3" = "arn:...", "secrets" = "arn:..." }
cloudtrail_bucket = "apex-ews-prod-cloudtrail-..."
config_bucket = "apex-ews-aws-config-..."
deploy_role_arn = "arn:aws:iam::...:role/apex-ews-deploy"
readonly_role_arn = "arn:aws:iam::...:role/apex-ews-readonly"
security_admin_role_arn = "arn:aws:iam::...:role/apex-ews-security-admin"
```

**Validation:**
```bash
aws organizations list-accounts --query 'length(Accounts)'
# Expected: >= 1 (master payer minimum)

aws cloudtrail describe-trails --query 'trailList[?Name==`apex-ews-org-trail`].IsMultiRegionTrail'
# Expected: [true]

aws kms describe-key --key-id alias/apex-ews-secrets --query 'KeyMetadata.KeyState'
# Expected: "Enabled"

aws guardduty list-detectors --query 'length(DetectorIds)'
# Expected: 1
```

**Rollback:** `terraform destroy -auto-approve` (audit bucket Object Lock will refuse — that's intentional; non-audit resources destroyable).

**Failure diagnostic:**
| Error | Cause | Fix |
|---|---|---|
| `EntityAlreadyExists for organization` | Org already exists from prior attempt | `terraform import aws_organizations_organization.this <org-id>` |
| `KMS CMK pending deletion 30d` | Key from prior apply was destroyed | Wait 30d or use different alias |
| `S3 bucket already owned by you` | Bucket name collision from prior apply | Add suffix to `name_prefix` var |

---

## Step 2 — Apply 10-network (VPC + subnets + NAT + flow logs)

**Pre-flight:**
```bash
cd ../10-network
terraform init
terraform validate
```

**Command:**
```bash
terraform apply -auto-approve
```

**Expected output:**
```
Apply complete! Resources: 25+ added, 0 changed, 0 destroyed.

Outputs:
vpc_id = "vpc-..."
vpc_cidr = "10.0.0.0/16"
public_subnet_ids = ["subnet-...", "subnet-...", "subnet-..."]
private_subnet_ids = ["subnet-...", "subnet-...", "subnet-..."]
data_subnet_ids = ["subnet-...", "subnet-...", "subnet-..."]
```

**Validation:**
```bash
VPC_ID=$(terraform output -raw vpc_id)
aws ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC_ID}" --query 'length(Subnets)'
# Expected: 9 (3 AZ × 3 tiers)

aws ec2 describe-nat-gateways --filter "Name=vpc-id,Values=${VPC_ID}" --query 'NatGateways[?State==`available`] | length(@)'
# Expected: 3 (one per AZ)
```

**Rollback:** `terraform destroy -auto-approve` (clean — 20-eks depends on this so destroy ordering required).

**Failure:** ENI limit on dev account = check service quotas; typical default is 5 NATs / VPC which is enough.

---

## Step 3 — Apply 20-eks (EKS cluster + Karpenter IAM + ESO IAM)

**Pre-flight:**
```bash
cd ../20-eks
terraform init
terraform validate

# Required inputs from prior layers
SECRETS_KMS_ARN=$(terraform -chdir=../00-landing-zone output -json kms_key_arns | jq -r '.secrets')
VPC_ID=$(terraform -chdir=../10-network output -raw vpc_id)
PRIVATE_SUBNETS=$(terraform -chdir=../10-network output -json private_subnet_ids)

echo "Inputs:"
echo "  KMS ARN: ${SECRETS_KMS_ARN}"
echo "  VPC ID: ${VPC_ID}"
echo "  Private subnets: ${PRIVATE_SUBNETS}"
# All 3 must be non-empty
```

**Command:**
```bash
terraform apply -auto-approve \
  -var="secrets_kms_key_arn=${SECRETS_KMS_ARN}" \
  -var="vpc_id=${VPC_ID}" \
  -var="private_subnet_ids=${PRIVATE_SUBNETS}" \
  -var='enable_karpenter=true'
```

**Expected output (key outputs to capture):**
```
Apply complete! Resources: 35+ added.

Outputs:
cluster_name = "apex-ews-prod"
cluster_endpoint = "https://...eks.amazonaws.com"
karpenter_controller_role_arn = "arn:aws:iam::...:role/apex-ews-prod-karpenter-controller"
karpenter_interruption_queue = "apex-ews-prod-karpenter"
external_secrets_role_arn = "arn:aws:iam::...:role/apex-ews-prod-external-secrets"
oidc_provider_arn = "arn:aws:iam::...:oidc-provider/..."
```

**Validation:**
```bash
aws eks describe-cluster --name apex-ews-prod --query 'cluster.status'
# Expected: "ACTIVE"

aws eks update-kubeconfig --name apex-ews-prod
kubectl get nodes
# Expected: 3+ Ready nodes (managed node group baseline)
```

**Rollback:** `terraform destroy -auto-approve` (~25 min; takes down nodes first).

**Failure:**
| Error | Fix |
|---|---|
| `cluster CREATING` for >20min | Check CloudWatch `/aws/eks/<cluster>/cluster` log group for errors |
| `IAM role propagation` warning | Re-run `terraform apply`; AWS IAM eventually consistent |

---

## Step 4 — Apply 30-data (Aurora + MSK + S3 buckets)

**Pre-flight:**
```bash
cd ../30-data
terraform init
terraform validate

VPC_ID=$(terraform -chdir=../10-network output -raw vpc_id)
DATA_SUBNETS=$(terraform -chdir=../10-network output -json data_subnet_ids)
PRIVATE_SUBNETS=$(terraform -chdir=../10-network output -json private_subnet_ids)
AURORA_KMS=$(terraform -chdir=../00-landing-zone output -json kms_key_arns | jq -r '.aurora')
MSK_KMS=$(terraform -chdir=../00-landing-zone output -json kms_key_arns | jq -r '.msk')
S3_KMS=$(terraform -chdir=../00-landing-zone output -json kms_key_arns | jq -r '.s3')
AUDIT_KMS=$(terraform -chdir=../00-landing-zone output -json kms_key_arns | jq -r '.audit')
```

**Command (~30 min — Aurora cluster creation is slow):**
```bash
terraform apply -auto-approve \
  -var="vpc_id=${VPC_ID}" \
  -var="data_subnet_ids=${DATA_SUBNETS}" \
  -var="private_subnet_ids=${PRIVATE_SUBNETS}" \
  -var="aurora_kms_key_arn=${AURORA_KMS}" \
  -var="msk_kms_key_arn=${MSK_KMS}" \
  -var="s3_kms_key_arn=${S3_KMS}" \
  -var="audit_kms_key_arn=${AUDIT_KMS}"
```

**Validation:**
```bash
aws rds describe-db-clusters --db-cluster-identifier apex-ews-prod --query 'DBClusters[0].Status'
# Expected: "available"

aws kafka list-clusters --cluster-name-filter apex-ews --query 'ClusterInfoList[0].State'
# Expected: "ACTIVE"

aws s3api get-object-lock-configuration --bucket apex-ews-prod-audit-logs --query 'ObjectLockConfiguration.ObjectLockEnabled'
# Expected: "Enabled"
```

**Rollback:** `terraform destroy -auto-approve` (Aurora final snapshot taken automatically). Audit bucket Object Lock prevents bucket deletion within 7y.

---

## Step 5 — Apply migrations + seed mart (Aurora)

**Pre-flight:**
```bash
WRITER_ENDPOINT=$(terraform -chdir=infra/terraform/30-data output -raw aurora_writer_endpoint)
MASTER_SECRET_ARN=$(terraform -chdir=infra/terraform/30-data output -raw aurora_master_user_secret_arn)

# Fetch master creds (one-time; production uses RDS Proxy + IAM auth after this)
PGUSER=apex
PGPASSWORD=$(aws secretsmanager get-secret-value --secret-id "${MASTER_SECRET_ARN}" --query SecretString --output text | jq -r '.password')

# Smoke connection
PGPASSWORD="${PGPASSWORD}" psql -h "${WRITER_ENDPOINT}" -U "${PGUSER}" -d postgres -c '\l'
```

**Command:**
```bash
# Apply all 34 schema migrations
for f in $(ls data/schema/*.sql | sort); do
  echo "==> Applying ${f}"
  PGPASSWORD="${PGPASSWORD}" psql -h "${WRITER_ENDPOINT}" -U "${PGUSER}" -d apex_ews -f "${f}"
done

# Run dbt + tests
cd data/dbt
dbt deps
dbt seed --full-refresh
dbt run
dbt test
```

**Validation:**
```bash
PGPASSWORD="${PGPASSWORD}" psql -h "${WRITER_ENDPOINT}" -U "${PGUSER}" -d apex_ews -c "
  SELECT schemaname, count(*) as tables
  FROM pg_catalog.pg_tables
  WHERE schemaname LIKE 'app_%' OR schemaname IN ('mart', 'audit', 'feature_store')
  GROUP BY schemaname ORDER BY schemaname;"

# Expected:
#  schemaname           | tables
# ----------------------+--------
#  app_alerts           | 2
#  app_audit            | 1
#  app_bff              | 2
#  app_cases            | 4
#  app_iam              | 7
#  app_scenario         | 1
#  audit                | 1
#  feature_store        | 2
#  mart                 | 4
```

**Rollback:** Aurora snapshot restore (`aws rds restore-db-cluster-from-snapshot`); pre-migration snapshot taken by Aurora automatically.

**Failure:** Migration 010_mart_tenant.sql requires `mart.customer_360` from dbt — apply mart-touching migrations AFTER `dbt run`.

---

## Step 6 — Seed Secrets Manager

**Pre-flight:**
```bash
aws kms describe-key --key-id alias/apex-ews-secrets --query 'KeyMetadata.KeyState'
# Expected: "Enabled"

# Set per-service DSN env vars (BFF uses RDS Proxy endpoint, not writer)
RDS_PROXY=$(terraform -chdir=infra/terraform/30-data output -raw rds_proxy_endpoint 2>/dev/null || echo "${WRITER_ENDPOINT}")
KAFKA_BROKERS=$(terraform -chdir=infra/terraform/30-data output -raw msk_bootstrap_brokers_sasl_iam)

# All service DSNs share the Aurora user; per-service users + grants per 004_app_schemas.sql
for svc in bff auth-svc audit-svc cases alerts rules indicators ai-copilot; do
  export "${svc^^}_PG_URL=postgresql://apex_${svc}:CHANGE_ME@${RDS_PROXY}:5432/apex_ews?sslmode=require"
done
export BFF_PG_URL="${BFF_PG_URL}"
export AUTH_SVC_PG_URL="${AUTH-SVC_PG_URL}"
export AUDIT_SVC_PG_URL="${AUDIT-SVC_PG_URL}"
export CASES_PG_URL="${CASES_PG_URL}"
export ALERTS_PG_URL="${ALERTS_PG_URL}"
export RULES_PG_URL="${RULES_PG_URL}"
export INDICATORS_PG_URL="${INDICATORS_PG_URL}"
export AI_COPILOT_PG_URL="${AI-COPILOT_PG_URL}"
export KAFKA_BROKERS
export BFF_JWKS_URL="https://auth.apex-ews.example/.well-known/jwks.json"
export APEX_CASES_URL="http://regulatory-svc-cases.apex-ews.svc:8083"
export APEX_AUDIT_URL="http://audit-svc.apex-ews.svc:8082"
export SES_FROM_ADDRESS="alerts@apex-ews.example"
```

**Command:**
```bash
ENV=prod ./scripts/seed-secrets.sh
```

**Expected output:**
```
Created/updated: 23  Skipped: 8
```

(8 skipped = vendor secrets that must be operator-provisioned out-of-band: Anthropic, AT, FCM, APNS, mTLS bank cert/key.)

**Validation:**
```bash
aws secretsmanager list-secrets --filters Key=name,Values=apex-ews/prod --query 'SecretList[].Name' | wc -l
# Expected: 23+ (env-sourced) or 31 (post-vendor-provisioning)
```

**Rollback:** `aws secretsmanager delete-secret --secret-id apex-ews/prod/<key> --force-delete-without-recovery` per key. Re-seedable via `./scripts/seed-secrets.sh` (idempotent).

---

## Step 7 — Bootstrap cluster (Karpenter + ESO + ArgoCD + Prometheus)

**Pre-flight:**
```bash
kubectl cluster-info
# Expected: Kubernetes control plane running at https://...eks.amazonaws.com
```

**Command (~20 min total):**
```bash
./scripts/bootstrap-cluster.sh apex-ews-prod
```

**Expected output (final lines):**
```
==> Bootstrap summary:
  Karpenter NodePools:
    nodepool.karpenter.sh/general
    nodepool.karpenter.sh/ai
  ESO sync status:
    apex-ews   bff-secrets   SecretSynced   2m
    ...
  ArgoCD apps:
    apex-ews-platform   Healthy   Synced
    ...
  Prometheus rules:
    monitoring   apex-ews-sli-recording          ...
    monitoring   apex-ews-burn-rate-alarms       ...
    monitoring   apex-ews-infra-alarms           ...

==> Cluster bootstrap complete.
```

**Validation:**
```bash
kubectl get nodes
kubectl get nodepools
kubectl get externalsecret -A
kubectl get applications -n argocd
kubectl get prometheusrule -n monitoring
```

All commands must return non-empty results with no `STATUS: Failed` rows.

**Rollback:**
```bash
helm uninstall karpenter -n karpenter
helm uninstall external-secrets -n external-secrets
helm uninstall argocd -n argocd
helm uninstall kube-prometheus-stack -n monitoring
kubectl delete -f infra/k8s/karpenter/nodepool.yaml
```

**Failure:**
| Error | Diagnostic | Fix |
|---|---|---|
| `external_secrets_role_arn not in 20-eks outputs` | Step 3 didn't apply with `enable_karpenter=true` | Re-run Step 3 |
| `ESO ExternalSecret status SecretSyncError` | Step 6 secrets missing | Re-run `seed-secrets.sh` |
| `karpenter pod CrashLoopBackOff` | IRSA misconfigured | `kubectl describe sa karpenter -n karpenter` and verify role-arn annotation |

---

## Step 8 — ArgoCD App-of-Apps sync (deploys 13 services)

**Pre-flight:**
```bash
ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)

# Port-forward ArgoCD locally (for one-time login)
kubectl port-forward -n argocd svc/argocd-server 8081:443 &
PF_PID=$!

argocd login localhost:8081 --insecure --username admin --password "${ARGOCD_PASSWORD}"
```

**Command:**
```bash
# Bootstrap.yaml was applied in Step 7; verify the parent app + all children
argocd app list

# Sync all children in dependency-wave order
for app in $(argocd app list -o name); do
  argocd app sync "${app}" --grpc-web
done

# Wait for ALL apps to reach Healthy
for app in $(argocd app list -o name); do
  argocd app wait "${app}" --health --timeout 600 --grpc-web
done

kill $PF_PID
```

**Expected output:**
```
NAME                          CLUSTER                         NAMESPACE  PROJECT  STATUS  HEALTH   SYNCPOLICY  CONDITIONS  REPO       PATH                          TARGET
argocd/apex-ews-platform      https://kubernetes.default.svc  argocd     default  Synced  Healthy  Auto-Prune  <none>      ...        infra/k8s/argocd/applications  main
argocd/platform-base          ...                                          default  Synced  Healthy  ...
argocd/external-secrets       ...                                          default  Synced  Healthy  ...
argocd/observability          ...                                          default  Synced  Healthy  ...
argocd/auth-svc               ...                                          default  Synced  Healthy  ...
argocd/audit-svc              ...                                          default  Synced  Healthy  ...
argocd/bff                    ...                                          default  Synced  Healthy  ...
argocd/regulatory-svc-cases   ...                                          default  Synced  Healthy  ...
argocd/regulatory-svc-alerts  ...                                          default  Synced  Healthy  ...
argocd/regulatory-svc-rules   ...                                          default  Synced  Healthy  ...
argocd/regulatory-svc-indicators ...                                       default  Synced  Healthy  ...
argocd/collection-adapter     ...                                          default  Synced  Healthy  ...
argocd/notification-svc       ...                                          default  Synced  Healthy  ...
argocd/ai-copilot-svc         ...                                          default  Synced  Healthy  ...
argocd/pipeline-svc           ...                                          default  Synced  Healthy  ...
```

**Validation:**
```bash
kubectl get deployment -n apex-ews
# Expected: 10 deployments, all "X/X ready"

kubectl get pods -n apex-ews --field-selector=status.phase!=Running 2>&1 | head -5
# Expected: "No resources found." (empty)
```

**Rollback per app:**
```bash
argocd app rollback <app-name>  # roll back 1 revision
# Or full revert: argocd app rollback <app-name> 0  # revert to initial state
```

**Failure:**
| Symptom | Diagnostic | Fix |
|---|---|---|
| Pod `ImagePullBackOff` | ECR image not pushed | Run `./.github/workflows/deploy-prod.yml` to push images |
| Pod `CreateContainerConfigError` | Secret missing | `kubectl get secret -n apex-ews | grep -v default` should show ≥10 secrets |
| Service `OutOfSync` for >10min | Wave-ordering deadlock | `argocd app sync <stuck-app> --force` |

---

## Step 9 — Production smoke + tenant-isolation tests

**Pre-flight:**
```bash
BFF_URL=https://api.apex-ews.example
AUTH_URL=https://auth.apex-ews.example

# Provision smoke-test admin credentials in Secrets Manager (one-time)
aws secretsmanager create-secret \
  --name apex-ews/prod/admin-smoke-credentials \
  --secret-string "{\"username\":\"alice.admin\",\"password\":\"$(openssl rand -base64 12)\"}" \
  --kms-key-id alias/apex-ews-secrets

# Provision the user in auth-svc (one-time via admin endpoint or DB INSERT per 004_app_schemas.sql)
```

**Command:**
```bash
BFF_URL="${BFF_URL}" AUTH_URL="${AUTH_URL}" ENV=prod \
  ./scripts/smoke.sh
```

**Expected output:**
```
═══════════════════════════════════════════
Smoke result: PASS=10 FAIL=0 WARN=0
═══════════════════════════════════════════
```

Then:

```bash
./scripts/test-tenant-isolation.sh
# Expected: PASS=7 FAIL=0
```

Then:

```bash
./scripts/infra-health.sh
# Expected: PASS=20+ FAIL=0
```

**If FAIL > 0 on smoke or tenant-isolation: HALT.** Do not proceed to T9-P2 cutover.

**Rollback if any test fails:**
```bash
./scripts/rollback.sh
# Requires CISO_SIGNOFF=<incident_id> env var
```

---

## Step 10 — DR drill (Gate B)

**Pre-flight:**
- Aurora Global secondary cluster present (T2 IaC with `enable_aurora_autoscale=true` post-30-day baseline)
- Secondary-region EKS cluster ready (or use the `--scope=aurora` slim path for first drill)

**Command:**
```bash
./scripts/dr-drill.sh --scope=aurora --target=staging
```

**Expected output (report file):**
```
═══════════════════════════════════════════
DR drill complete — report: reports/dr-drills/<timestamp>-aurora-staging.md
GREEN=6 AMBER=0 RED=0
═══════════════════════════════════════════
```

**Validation:** the generated report file shows all 6 rubric rows GREEN.

**Rollback:** the drill is a rehearsal against staging — primary unaffected. If staging primary lost, restore from latest snapshot.

---

## Step 11 — Pre-go-live 5-gate review (T9-P1)

**Pre-flight:**
- Gate A: pentest final attestation PDF signed
- Gate B: DR drill report GREEN (from Step 10)
- Gate C: 5× load test report PASSED
- Gate D: ISO 27001 Stage-1 audit report
- Gate E: Steering meeting scheduled

**Command:** (manual — steering committee review)

**Validation:** all 5 PDFs filed; minutes signed; CISO + CTO + Steering chair signatures collected.

**Failure:** any AMBER/RED gate → slip T9-P2 by 1+ week per failed gate.

---

## Step 12 — T9-P2 cutover (24h read-only soak)

**Pre-flight:**
- Step 11 Gate E signed
- DNS TTL lowered to 60s
- All hands available; PagerDuty staffed

**Command:**
```bash
# T-2h: prep
kubectl set env deployment/bff BFF_READ_ONLY=true INTEGRATIONS_MODE=live -n apex-ews
kubectl rollout status deployment/bff -n apex-ews

# T-0: flip Route 53 to point production hostname at new ALB
# (manual via console; expected propagation <5min with TTL=60s)

# T+0 to T+24h: read-only soak
# (monitor; no commands; SLO dashboards + smoke loop)

# T+24h after read-only soak passes:
kubectl set env deployment/bff BFF_READ_ONLY=false -n apex-ews
kubectl rollout status deployment/bff -n apex-ews
```

**Validation:**
```bash
# Read-only soak validation (run every 30min for 24h):
./scripts/smoke.sh
# Expected: PASS=10 FAIL=0 every iteration

# Audit chain integrity after first write:
curl -sf -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "X-Tenant-ID: BANK_DEMO" -H "X-Channel: API" \
  ${BFF_URL}/v1/audit/integrity \
  | jq -r '.body.valid'
# Expected: "true"
```

**Rollback:**
```bash
# 1. Flip integrations mode + read-only
kubectl set env deployment/bff INTEGRATIONS_MODE=mock BFF_READ_ONLY=true -n apex-ews

# 2. Route 53 record reverts to staging ALB (DNS propagation ~5min)
# (manual)

# 3. Tenant disabled
CISO_SIGNOFF=cutover-revert-$(date -u +%Y%m%dT%H%MZ) \
  ./scripts/rollback.sh --tenant-disable BANK_DEMO
```

---

## Step 13 — Hypercare (week 1 + week 2)

**Day 0-7:**
- Daily 09:00 IST standup
- Daily smoke + infra-health + tenant-isolation
- Primary on-call pinned
- Daily metrics report to steering

**Day 8-14:**
- MWF standup
- Continued smoke loop
- Year-2 backlog grooming

**Validation:**
```bash
# Daily SLO budget check
curl -sf "${PROMETHEUS_URL}/api/v1/query?query=apex_ews:slo:bff:error_budget_remaining" \
  | jq -r '.data.result[0].value[1]'
# Expected: > 0.75 (i.e. <25% budget burnt)

# Daily audit chain check across all tenants
for t in BANK_DEMO BIL; do
  echo "${t}: $(curl -sf -H "Authorization: Bearer ${ACCESS_TOKEN}" -H "X-Tenant-ID: ${t}" -H "X-Channel: API" \
    ${BFF_URL}/v1/audit/integrity | jq -r '.body.valid')"
done
# Expected: "BANK_DEMO: true" and "BIL: true"
```

---

## Observability coverage verification (post-deployment)

After Step 8 and Step 9:

```bash
# 1. Every service emits /metrics
for svc in bff auth-svc audit-svc; do
  kubectl exec -n apex-ews deployment/${svc} -- wget -qO- http://localhost:9090/metrics 2>/dev/null | head -3
  echo "---"
done

# 2. Prometheus scraping every service
PROM_POD=$(kubectl get pod -n monitoring -l app.kubernetes.io/name=prometheus -o name | head -1)
kubectl exec -n monitoring "${PROM_POD}" -- wget -qO- http://localhost:9090/api/v1/targets \
  | jq '.data.activeTargets[] | select(.health != "up") | .labels.job'
# Expected: (empty — all UP)

# 3. SLO recording rules have data
kubectl exec -n monitoring "${PROM_POD}" -- wget -qO- \
  "http://localhost:9090/api/v1/query?query=apex_ews:slo:bff:error_budget_remaining" \
  | jq '.data.result | length'
# Expected: > 0
```

If any of these returns empty: ServiceMonitor labels don't match the service labels. Check `kubectl get svc -n apex-ews <svc> -o yaml | grep -A 3 labels:` and ensure `apex-ews-monitored: "true"` is set on the Service.

---

## GitOps sync order verification

ArgoCD wave-order audit table — verify before T9-P1:

| Wave | App | Should be Healthy before next wave |
|---|---|---|
| 0 | platform-base (namespaces, RBAC, network policies) | ✓ |
| 1 | external-secrets (CRDs, ESO controller) | ✓ |
| 3 | observability (Prometheus, Grafana, Loki) | ✓ |
| 4 | auth-svc, audit-svc | ✓ |
| 5 | regulatory-svc/{cases,alerts,rules,indicators} | ✓ |
| 6 | bff | ✓ |
| 7 | collection-adapter, notification-svc, ai-copilot-svc | ✓ |
| 8 | pipeline-svc | ✓ |

```bash
# Verify wave ordering observed during sync:
argocd app history apex-ews-platform | head -10

# Should show child apps synced in ascending wave order
```

---

## Operational verification checklist (final pre-go-live)

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | All 14 ArgoCD apps Healthy + Synced | `argocd app list -o json \| jq '[.[] \| select(.status.health.status != "Healthy")] \| length'` | `0` |
| 2 | All ESO synced | `kubectl get externalsecret -A -o json \| jq '[.items[] \| select(.status.conditions == null or .status.conditions[-1].status != "True")] \| length'` | `0` |
| 3 | All HPAs current populated | `kubectl get hpa -A -o json \| jq '[.items[] \| select(.status.currentMetrics == null)] \| length'` | `0` |
| 4 | All PDBs ≥ 1 disruption allowed | `kubectl get pdb -A -o json \| jq '[.items[] \| select(.status.disruptionsAllowed == 0)] \| length'` | `0` |
| 5 | Smoke passes | `./scripts/smoke.sh` | `PASS=10 FAIL=0` |
| 6 | Infra health passes | `./scripts/infra-health.sh` | `PASS=20+ FAIL=0` |
| 7 | Tenant isolation passes | `./scripts/test-tenant-isolation.sh` | `PASS=7 FAIL=0` |
| 8 | Aurora reader CPU < 60% | Grafana dashboard | Green |
| 9 | MSK broker disk < 70% | Grafana dashboard | Green |
| 10 | Audit chain integrity for every tenant | `for t in BANK_DEMO BIL; do curl ... /v1/audit/integrity \| jq -r '.body.valid'; done` | `true` × N |
| 11 | DNS resolution from BFF pod | `kubectl exec -n apex-ews deployment/bff -- nslookup api.apex-ews.example` | resolves |
| 12 | OAuth token issuance | `curl -X POST ${AUTH_URL}/oauth/token -d 'grant_type=client_credentials...'` | `200 OK` with `access_token` |

All 12 must be GREEN before T9-P2 cutover.

---

## Failure escalation

| Symptom | Escalation |
|---|---|
| Smoke or tenant-iso test FAIL | Halt cutover; CISO + SRE-lead war-room |
| Aurora failover detected | Page CISO + CTO immediately; verify via DR runbook before normal ops |
| Audit chain integrity FAIL | Page CISO; pause all writes; investigate via M15.2 verifyChain |
| Pentest Critical reopened mid-execution | Pause cutover; 3-day patch SLA per remediation playbook |

---

## Post-execution: what to update

After Step 12 + 13 complete:

1. `STATUS.md` — append cutover entry with date + commit SHA + tenant
2. `docs/access-review-evidence-log.md` — log first quarterly access review
3. `docs/dr-game-day-history.md` — log first DR drill report
4. `reports/dr-drills/<ts>.md` — committed for audit
5. `docs/bau-runbook.md` § change log — cutover entry
6. M15.1 audit chain — auto-records every action via service code; verify daily

Steering meets at T9-P5 for 30-day post-launch review.

---

## Cross-reference — every script and manifest used

| Step | Artifact | Owner |
|---|---|---|
| 0 | `aws ec2 create-tags` | SRE |
| 1 | `infra/terraform/00-landing-zone/` | SRE+CISO |
| 2 | `infra/terraform/10-network/` | SRE |
| 3 | `infra/terraform/20-eks/` + `eso.tf` | SRE |
| 4 | `infra/terraform/30-data/` | DATA+SRE |
| 5 | `data/schema/*.sql` + `data/dbt/` | DATA |
| 6 | `scripts/seed-secrets.sh` | SRE |
| 7 | `scripts/bootstrap-cluster.sh` (chains `karpenter/install.sh` + `external-secrets/*.yaml` + `prometheus/*.yaml`) | SRE |
| 8 | `infra/k8s/argocd/bootstrap.yaml` + 14 applications | SRE |
| 9 | `scripts/smoke.sh` + `scripts/test-tenant-isolation.sh` + `scripts/infra-health.sh` | SRE+CISO |
| 10 | `scripts/dr-drill.sh` | SRE-lead+CISO |
| 11 | Steering committee review | ORCH+steering |
| 12 | manual cutover + `scripts/rollback.sh` (CISO_SIGNOFF=) | SRE+CISO |
| 13 | hypercare cadence per `docs/bau-runbook.md` § daily | SRE-on-call |

End of playbook.
