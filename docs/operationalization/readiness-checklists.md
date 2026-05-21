# ZorEWS — Production Readiness + Hardening Checklists

**Last updated:** 2026-05-21
**Authoritative parent:** [`docs/production-operationalization-roadmap.md`](../production-operationalization-roadmap.md)
**Companion artefacts:** [execution-plans.md](execution-plans.md) · [dependency-matrix.md](dependency-matrix.md) · [go-live-gating.md](go-live-gating.md)

> 4 checklists for the go-live audit. Every row maps to a verifier (command, dashboard URL, document path, or sign-off owner) and is one of `GREEN / AMBER / RED / N/A`. **Steering committee uses these as evidence at T9-P1.**

## 1. Production-readiness checklist (per-service)

Run this against EVERY service in `services/*` before sign-off. 13 services × 12 dimensions = 156 cells.

### Dimensions

| # | Dimension | Verifier | Notes |
|---|---|---|---|
| 1 | Tests pass | CI green on `main` | `gh run list --workflow=services-ci.yml --status=success` |
| 2 | TypeScript build clean | `tsc --noEmit` exits 0 | Required per `services/<svc>/tsconfig.json` |
| 3 | Health endpoint live | `/healthz` returns 200 | Mandatory for ALB target group health-check |
| 4 | RBAC enforced | All non-public routes carry `requireRole`/`requireScope` | Spot-check via `grep -r 'app.<verb>' services/<svc>/src` |
| 5 | Tenant context required | `X-Tenant-ID` header validated | Spot-check via `grep -r 'requireTenantMw' services/<svc>/src` |
| 6 | Audit emitted on mutations | M15.1 `auditTrailStore.record` called on writes | Spot-check via `grep -r 'audit' services/<svc>/src` |
| 7 | Envelope-wrapped responses | M9-onwards routes return `{header, body}` per T4.24 | Spot-check via `grep -r 'wrapResponse' services/<svc>/src` |
| 8 | Env vars documented | `services/<svc>/README.md` lists every `process.env.X` | Required for ESO sync (T3-P3) |
| 9 | Healthcheck SLO | p95 `/healthz` <100ms | Grafana service dashboard |
| 10 | Alarm wired | At least 1 PagerDuty alarm per critical path | Verify via PagerDuty service catalog |
| 11 | Runbook linked | Service has an entry in `docs/bau-runbook.md` § common ops | Manual review |
| 12 | Pentest scope confirmed | Service either in-scope per `docs/pentest-brief.md` OR explicitly out-of-scope (e.g. legacy) | Manual review |

### Per-service status (post-T8)

| Service | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| services/bff | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | TODO | TODO | TODO | TODO | TODO |
| services/auth-svc | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | TODO | TODO | TODO | TODO | TODO |
| services/audit-svc | GREEN | GREEN | GREEN | N/A (internal) | GREEN | GREEN | N/A | TODO | TODO | TODO | TODO | TODO |
| services/regulatory-svc/cases | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | TODO | TODO | TODO | TODO | TODO |
| services/regulatory-svc/alerts | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | TODO | TODO | TODO | TODO | TODO |
| services/regulatory-svc/rules | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | TODO | TODO | TODO | TODO | TODO |
| services/regulatory-svc/indicators | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | TODO | TODO | TODO | TODO | TODO |
| services/collection-adapter | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | N/A | TODO | TODO | TODO | TODO | TODO |
| services/notification-svc | GREEN | GREEN | GREEN | N/A (internal) | GREEN | N/A | N/A | TODO | TODO | TODO | TODO | TODO |
| services/pipeline-svc | GREEN | GREEN | GREEN | N/A (internal) | N/A (per-DAG) | N/A | N/A | TODO | TODO | TODO | TODO | TODO |
| services/ai-copilot-svc | GREEN | N/A (Python) | GREEN | N/A (internal) | N/A | N/A | N/A | TODO | TODO | TODO | TODO | TODO |
| web (SPA) | GREEN | GREEN | N/A (static) | N/A (client) | N/A | N/A | N/A | TODO | TODO | N/A | TODO | TODO |
| mobile (RN) | TODO | TODO | N/A (client) | N/A | N/A | N/A | N/A | TODO | TODO | TODO | TODO | TODO |

**TODO** = filled during T9-P1 audit; **GREEN** = verified in CI today; **N/A** = not applicable for this service shape.

Per-service detail review: SRE-lead + each service's named owner. ~4 hours total work.

## 2. Production-hardening checklist (per-layer)

7 architectural layers × ~6-8 hardening rules each. Every row must be GREEN before T9-P2 cutover.

### Network layer

| # | Rule | Verifier | Status |
|---|---|---|---|
| N1 | All inbound traffic to ALB only via WAF | ALB security group source = WAF-only ENI | TODO |
| N2 | No public IPs on EKS nodes | `aws ec2 describe-instances --filters 'Name=tag:Name,Values=apex-ews-*' --query 'Reservations[].Instances[].PublicIpAddress'` returns nulls | TODO |
| N3 | NACLs deny ingress on db-tier subnets | `aws ec2 describe-network-acls` for db-tier subnets shows ingress-deny-all + egress-allow-vpc-only | TODO |
| N4 | VPN tunnels active-active | `aws ec2 describe-vpn-connections` shows 2 IPsec tunnels in `UP` state | TODO |
| N5 | DNS resolver locked to internal-only for `apex-ews.internal` | Route53 private hosted zone associated with VPC | TODO |
| N6 | Egress to internet via NAT only (no direct EKS node→0.0.0.0/0) | Route table inspection | TODO |
| N7 | TLS 1.2+ required end-to-end | ALB SecurityPolicy = `TLSPolicy-2022-10`; service-to-service mTLS where supported | TODO |

### Compute layer

| # | Rule | Verifier | Status |
|---|---|---|---|
| C1 | EKS endpoint private (or restricted to NAT/VPN CIDRs) | `aws eks describe-cluster --query 'cluster.resourcesVpcConfig.endpointPrivateAccess'` returns true | TODO |
| C2 | Kubernetes Pod Security Standards enforced (`baseline` namespace label) | `kubectl get ns -L pod-security.kubernetes.io/enforce` shows baseline+ on every workload ns | TODO |
| C3 | All containers run as non-root | `kubectl get pods -A -o json | jq '.items[].spec.containers[].securityContext.runAsUser'` (no nulls + no 0s) | TODO |
| C4 | Read-only root filesystem per container | `securityContext.readOnlyRootFilesystem: true` on all containers | TODO |
| C5 | All EKS workloads have resource requests + limits | `kubectl get pods -A -o json | jq` audit for missing | TODO |
| C6 | Node-group AMI patched ≤30 days old | `aws ec2 describe-images` cross-checked against latest AL2023 release date | TODO |
| C7 | Karpenter consolidation respects PDBs | PDB minAvailable: 2 on hot-path services per `infra/k8s/pdb.yaml` | TODO |
| C8 | No `:latest` tags in production manifests | `grep -r ':latest' infra/k8s/` returns 0 hits | TODO |

### Data layer

| # | Rule | Verifier | Status |
|---|---|---|---|
| D1 | Aurora encrypted at rest with KMS | `aws rds describe-db-clusters --query 'DBClusters[].StorageEncrypted'` returns true | TODO |
| D2 | Aurora TLS-required for connections | `parameter_group_family` enforces `rds.force_ssl=1` | TODO |
| D3 | Aurora master password rotated every 90 days | `aws secretsmanager describe-secret --secret-id <master>` shows `RotationEnabled=true` | TODO |
| D4 | Per-service Aurora users with least-priv (no superuser) | Manual review of `data/schema/004_app_schemas.sql` grants + production grants | TODO |
| D5 | Aurora backup retention ≥30d | `aws rds describe-db-clusters --query 'DBClusters[].BackupRetentionPeriod'` returns ≥30 | TODO |
| D6 | MSK encrypted at rest with KMS | `aws kafka describe-cluster --query 'ClusterInfo.EncryptionInfo'` shows AT_REST + IN_TRANSIT TLS | TODO |
| D7 | MSK IAM auth (no SASL/SCRAM static creds) | `aws kafka describe-cluster --query 'ClusterInfo.ClientAuthentication.Sasl.Iam.Enabled'` returns true | TODO |
| D8 | S3 audit bucket Object Lock COMPLIANCE 7y | `aws s3api get-object-lock-configuration --bucket apex-ews-audit-logs` returns COMPLIANCE + 2555d | TODO |
| D9 | S3 versioning + lifecycle + KMS on every bucket | `aws s3api get-bucket-versioning + lifecycle + encryption` × 3 buckets | TODO |
| D10 | S3 bucket public access block enabled | `aws s3api get-public-access-block` returns all 4 flags `true` | TODO |

### Secrets layer

| # | Rule | Verifier | Status |
|---|---|---|---|
| S1 | All secrets in Secrets Manager (no env-file in repo) | `git grep -i 'password\|secret\|token' .env*` returns no committed values | TODO |
| S2 | KMS rotation enabled on all 5 CMKs | `aws kms describe-key` × 5 | TODO |
| S3 | Service-account credentials use OAuth client-credentials, not long-lived API keys | M1.2/M1.3 enforced; no `apex_` keys in CI secrets | TODO |
| S4 | JWT signing key rotated quarterly | auth-svc rotation playbook in `docs/bau-runbook.md` | TODO |
| S5 | OAuth client secrets one-time-only (never re-displayed) | M1.2 contract verified — no `client_secret` in GET responses | TODO |
| S6 | TOTP backup codes single-use | M1.1 contract verified via jest | TODO |

### IAM layer

| # | Rule | Verifier | Status |
|---|---|---|---|
| I1 | No `Resource: *` in IAM policies (except documented exceptions) | Manual review of `infra/terraform/*/iam.tf` | TODO |
| I2 | Cross-account roles use OIDC, not access keys | All GitHub Actions → AWS use OIDC | TODO |
| I3 | RBAC matrix CI gate green | `.github/workflows/rbac-matrix.yml` exits 0 | TODO |
| I4 | Quarterly access review filed | `docs/access-review-evidence-log.md` 2026-Q2 entry signed | TODO |
| I5 | Break-glass accounts tested in last quarter | Manual entry in `docs/access-review-evidence-log.md` § break-glass | TODO |
| I6 | Service-account API keys (M1.2) inventory current | `/v1/admin/api-keys` admin lookup matches Secrets Manager truth | TODO |
| I7 | No `*Administrator*` policy on service roles | Inspect every IAM role in production account | TODO |

### Observability layer

| # | Rule | Verifier | Status |
|---|---|---|---|
| O1 | All services emit `/metrics` (prom-client) | Prometheus targets dashboard shows ≥ 10 UP | TODO |
| O2 | All services emit structured JSON logs | `kubectl logs <pod>` shows valid JSON per line | TODO |
| O3 | X-Ray traces propagate W3C TraceContext | Manual test: trace from SPA → BFF → adapter shows 3+ spans | TODO |
| O4 | All P0/P1 alarms have runbook URL in description | PagerDuty service catalog cross-check | TODO |
| O5 | SLO burn-rate alarms active (12+) | Grafana SLO dashboard renders | TODO |
| O6 | FinOps dashboard (T5.5) live | `/v1/finops/dashboard` returns valid envelope | TODO |
| O7 | Audit chain integrity check daily | `docs/bau-runbook.md` § daily; manual log of last 7 days | TODO |

### Deployment layer

| # | Rule | Verifier | Status |
|---|---|---|---|
| DP1 | ArgoCD AutoSync on; manual `kubectl apply` forbidden in prod | Spot-check via `kubectl get events` for `ApplyChange` outside ArgoCD | TODO |
| DP2 | Helm + manifest changes via PR-to-`main` only | GitHub branch protection: `main` requires PR + CI green + 1 review | TODO |
| DP3 | CI image-build SBOM published | Trivy SARIF in GitHub Security for every PR | TODO |
| DP4 | Container scan via security-scan.yml passes | `.github/workflows/security-scan.yml` exits 0 | TODO |
| DP5 | Schema BACKWARD-compat enforced | `.github/workflows/schema-compat.yml` exits 0 | TODO |
| DP6 | Terraform fmt + validate green on all 5 layers | `.github/workflows/terraform-ci.yml` exits 0 | TODO |
| DP7 | No production deploys outside change-control window | All deploys logged in `docs/bau-runbook.md` § change log | TODO |

### Mobile layer

| # | Rule | Verifier | Status |
|---|---|---|---|
| M1 | App signed with prod cert (not debug) | App store metadata + EAS Build log | TODO |
| M2 | Privacy policy + ToS pages live | URLs published in app metadata | TODO |
| M3 | No analytics SDKs collecting PII | Code review of mobile/src/* + SDK config | TODO |
| M4 | OTA updates signed | Expo EAS Update signing cert configured | TODO |
| M5 | Push notification deep links use universal-links/app-links (not custom URLs) | Manual test on iOS + Android | TODO |
| M6 | Local data (SQLite queue) encrypted | `expo-sqlite` encryption flag or platform-default keystore | TODO |

## 3. Observability coverage matrix

10 services × 6 telemetry dimensions = 60 cells. Every row must be GREEN before T8-P3.

| Service | Logs (Loki) | Metrics (Prom) | Traces (X-Ray) | Health endpoint | SLO recording | Critical alarms |
|---|---|---|---|---|---|---|
| services/bff | TODO | TODO | TODO | `/healthz` | T5-P3 | T5-P2 |
| services/auth-svc | TODO | TODO | TODO | `/healthz` | T5-P3 | T5-P2 |
| services/audit-svc | TODO | TODO | TODO | `/healthz` | T5-P3 | T5-P2 |
| services/regulatory-svc/cases | TODO | TODO | TODO | `/healthz` | T5-P3 | T5-P2 |
| services/regulatory-svc/alerts | TODO | TODO | TODO | `/healthz` | T5-P3 | T5-P2 |
| services/regulatory-svc/rules | TODO | TODO | TODO | `/healthz` | T5-P3 | T5-P2 |
| services/regulatory-svc/indicators | TODO | TODO | TODO | `/healthz` | T5-P3 | T5-P2 |
| services/collection-adapter | TODO | TODO | TODO | `/healthz` | T5-P3 | T5-P2 |
| services/notification-svc | TODO | TODO | TODO | `/healthz` | T5-P3 | T5-P2 |
| services/ai-copilot-svc | TODO | TODO | TODO | `/health` | T5-P3 | T5-P2 |

**Critical alarms catalog** (paged → P0/P1):

| Alarm | Severity | Condition | Runbook |
|---|---|---|---|
| BFF p95 >1500ms for 5min | P1 | `apex_ews:slo:bff_p95_ms{quantile=0.95} > 1500` | `docs/bau-runbook.md` § common ops "high latency" |
| BFF error rate >2% for 5min | P0 | `apex_ews:slo:bff_error_rate{le=300} > 0.02` | `docs/bau-runbook.md` § common ops "elevated errors" |
| Aurora writer CPU >80% for 10min | P1 | `aws_rds_cpu_utilization_average{role=writer} > 80` | `docs/bau-runbook.md` § common ops "database under pressure" |
| Aurora reader CPU >80% for 10min | P1 | same `role=reader` | as above |
| MSK broker disk >85% | P0 | `kafka_broker_disk_used_percent > 85` | `docs/bau-runbook.md` § common ops "kafka disk pressure" |
| Aurora failover detected | P0 | `aws_rds_failover_count > 0` | `docs/dr-runbook.md` (potential DR scenario) |
| Webhook delivery success rate <90% (1h) | P1 | per-subscription M11 dashboard | `docs/bau-runbook.md` § common ops "webhook failures" |
| Audit chain integrity fail | P0 | `apex_ews:audit:chain_valid == 0` | `docs/dr-runbook.md` § audit trail (security-critical) |
| VPN tunnel both down | P0 | `aws_vpn_tunnel_state{state!=UP} > 0` for both | T4-P1 owner + bank network team |
| ESO secret sync stale >10min | P1 | `external_secret_sync_seconds_since_last_success > 600` | `docs/bau-runbook.md` § common ops "ESO outage" |
| Pentest finding Critical reopened | P0 | DefectDojo webhook → PagerDuty | `docs/pentest-remediation-playbook.md` §1 |
| ArgoCD app OutOfSync >10min | P1 | argocd_app_health_status{status!=Synced} | `docs/bau-runbook.md` § common ops "argocd drift" |
| HPA scaling failure | P1 | `kube_horizontalpodautoscaler_status_condition{status=False}` | `docs/bau-runbook.md` § common ops "HPA stuck" |
| Karpenter provisioning failure | P1 | Karpenter event `Failed` rate >5/min | `docs/bau-runbook.md` § common ops "karpenter wedged" |
| Aurora Global replica lag >2min | P1 | `aws_rds_aurora_global_db_replication_lag_seconds > 120` | `docs/dr-runbook.md` § potential failover |

## 4. Environment readiness checks (per environment)

Run these against `dev` + `staging` + `production` before each promotion. Pre-T9-P1 = all 3 GREEN.

### Common rows (every env)

| # | Check | Command/verifier | dev | staging | prod |
|---|---|---|---|---|---|
| E1 | All 34 schema migrations applied | `psql -c "SELECT COUNT(*) FROM _schema_history"` returns 34 | TODO | TODO | TODO |
| E2 | dbt run + test green | `cd data/dbt && dbt run && dbt test` exits 0 | TODO | TODO | TODO |
| E3 | All Kubernetes services Healthy in ArgoCD | `argocd app list -o json | jq` shows 10× Healthy | TODO | TODO | TODO |
| E4 | All ExternalSecrets Synced | `kubectl get externalsecret -A --no-headers | grep -c SynchronisedToTarget` returns full count | TODO | TODO | TODO |
| E5 | All HPAs `current` populated | `kubectl get hpa -A` shows no `<unknown>` | TODO | TODO | TODO |
| E6 | All PDBs `ALLOWED DISRUPTIONS` ≥ 1 | `kubectl get pdb -A` shows no zeros | TODO | TODO | TODO |
| E7 | Prometheus targets all UP | `curl prometheus:9090/api/v1/targets | jq '.data.activeTargets[] | .health'` all `up` | TODO | TODO | TODO |
| E8 | PagerDuty integration tested | Synthetic alarm fires → PagerDuty incident within 30s | TODO | TODO | TODO |
| E9 | Audit chain valid for all configured tenants | `/v1/audit/integrity` returns `valid=true` for each tenant | TODO | TODO | TODO |
| E10 | RBAC matrix self-consistent | `python infra/rbac/scripts/access_review.py --matrix infra/rbac/matrix.json --validate-only` exits 0 | TODO | TODO | TODO |
| E11 | OAuth token issuance works | `POST /oauth/token` returns 200 with valid JWT | TODO | TODO | TODO |
| E12 | JWKS endpoint serves valid JWK Set | `curl /.well-known/jwks.json | jq` returns key with `alg=RS256` | TODO | TODO | TODO |
| E13 | Tenant CRUD admin route works | `GET /v1/tenants` returns ≥1 tenant | TODO | TODO | TODO |
| E14 | Adapter fleet health 8/8 UP | `GET /v1/integrations/adapters/health` returns all UP | TODO | TODO (mocks) | TODO (live integrations) |
| E15 | Backup verified in last 7d | Aurora snapshot tested via restore-to-temp-cluster | N/A | TODO | TODO |

### Environment-specific

**Dev** — additional rows: zero pentest findings outstanding · Docker Compose works locally · MSW handlers + offline-mode SPA work.

**Staging** — additional rows: load-test ran in past 14 days · DR game-day in past 90 days · all migrations applied via CI (not manual psql) · `INTEGRATIONS_MODE=mock` confirmed.

**Production** — additional rows: 5× load-test gate PASSED · pentest final attestation signed · `INTEGRATIONS_MODE=live` confirmed · WAF in `BLOCK` mode (not COUNT) · Aurora Global secondary cluster reachable · S3 CRR replication lag <15min · Object Lock COMPLIANCE confirmed.

## 5. Sign-off log

Use this at T9-P1 steering review. Every cell must carry name + date + status.

| Domain | Owner | Sign-off | Date | Notes |
|---|---|---|---|---|
| Network hardening | SRE-lead | | | |
| Compute hardening | SRE-lead | | | |
| Data hardening | DATA-lead | | | |
| Secrets hardening | CISO | | | |
| IAM hardening | CISO | | | |
| Observability coverage | SRE-lead | | | |
| Deployment hardening | SRE-lead + CTO | | | |
| Mobile hardening | UI-lead + CISO | | | |
| Bank integration ready | INT-lead + bank-side liaison | | | |
| Pentest attestation | CISO + vendor PM | | | |
| Load-test attestation | SRE-lead | | | |
| DR game-day Green | SRE-lead + CISO | | | |
| ISO 27001 Stage-1 audit | CISO + auditor | | | |
| Tenant ops training | INT-lead + tenant ops lead | | | |
| FinOps cost envelope | CTO + FinOps | | | |
| Compliance (DPA + RBI + IRDAI) | CISO + Compliance officer | | | |
| Overall go-live | Steering chair (CISO OR CTO) | | | |

The combined `apex_ews_v1_production_attestation.pdf` is the bundling artifact from `go-live-gating.md` §4.
