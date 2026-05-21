# ZorEWS — Infrastructure Dependency Matrix + Critical-Path Analysis

**Last updated:** 2026-05-21
**Authoritative parent:** [`docs/production-operationalization-roadmap.md`](../production-operationalization-roadmap.md)
**Companion artefacts:** [execution-plans.md](execution-plans.md) · [readiness-checklists.md](readiness-checklists.md) · [go-live-gating.md](go-live-gating.md)

> Maps every phase ID from `execution-plans.md` to its prerequisites, downstream consumers, and shared infrastructure. Drives critical-path analysis + estimated execution timeline. **This is the single source of truth for "what can I start in parallel?".**

## 1. Track-to-track dependency matrix

`✓` = direct prerequisite (track in row depends on track in column); `–` = no dependency; `∥` = parallel-safe.

| **↓ track / col →** | T1 AWS | T2 Data | T3 EKS | T4 Bank | T5 Obs | T6 Mobile | T7 Pentest | T8 Load | T9 Go-live |
|---|---|---|---|---|---|---|---|---|---|
| T1 AWS landing zone | — | ∥ | ∥ | ∥ | ∥ | ∥ | ∥ | ∥ | ∥ |
| T2 Data plane | ✓ | — | ∥ | ∥ | ∥ | ∥ | ∥ | ∥ | ∥ |
| T3 EKS + secrets | ✓ | ∥ | — | ∥ | ∥ | ∥ | ∥ | ∥ | ∥ |
| T4 Bank integrations | ✓ | ✓ | ✓ | — | ∥ | ∥ | ∥ | ∥ | ∥ |
| T5 Observability | ∥ | ∥ | ✓ | ∥ | — | ∥ | ∥ | ∥ | ∥ |
| T6 Mobile RN | ✓ (T1-P1 only) | ∥ | ∥ | ∥ | ∥ | — | ∥ | ∥ | ∥ |
| T7 Pentest | ∥ | ∥ | ✓ | ∥ | ∥ | ∥ | — | ∥ | ∥ |
| T8 Load test | ∥ | ✓ | ✓ | ∥ | ✓ (T5-P1 nice) | ∥ | ∥ | — | ∥ |
| T9 Go-live | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |

**Reading rules:**
- T1 blocks everything (landing zone is foundational).
- T2 + T3 can run in parallel once T1 is green.
- T4 cannot start until T1 + T2 + T3 all green (needs Aurora + EKS + VPN-routed VPC).
- T6 (mobile) only needs T1 for the AWS account; can run in parallel with T2/T3/T4/T5.
- T7 pentest needs the full production-shadow stack up (T3 done is sufficient since pentest targets BFF + auth flow + tenant isolation).
- T9 needs ALL tracks green — it's the convergence point.

## 2. Inter-phase dependency graph (critical-path edges)

The longest sequential chain (no parallelisation) defines the critical path:

```
T1-P1 → T1-P2 → T1-P3 → T1-P4 → T1-P5
     ↘
       T2-P1 → T2-P2 → T2-P3 → T2-P4 → T2-P5 → T2-P6
                                   ↘
                                     T3-P1 → T3-P2 → T3-P3 → T3-P4 → T3-P5
                                                                  ↘
                                                                    T4-P1 → T4-P2 → T4-P3
                                                                                ↘ T4-P4
                                                                                ↘ T4-P5
                                                                                ↘ T4-P6
                                                                                       ↘
                                                                                         T7-P1 → T7-P2 → T7-P3 → T7-P4
                                                                                                                     ↘
                                                                                                                       T9-P1 → T9-P2 → T9-P3 → T9-P4 → T9-P5
```

**Critical path:** `T1 (11d) → T2 (14d) → T3 (13d) → T4-P1+P2 (13d) → T7-P1+P2+P3+P4 (40d, mostly clock-time + buffer) → T9 (13d)` = **~104 business days = 21 calendar weeks raw**.

**Parallelised:** T6 mobile (30d) runs in parallel from T+0 inside the T1+T2+T3 window. T5 observability (13d) runs in parallel inside the T3+T4 window. T8 load test (14d) runs in parallel inside the T4+T7 window. **Compressed calendar: 13 weeks** (T+0 to T+13w = 2026-08-19 if T+0 = 2026-05-21).

## 3. Parallelisation diagram (weekly)

| Week | T1 AWS | T2 Data | T3 EKS | T4 Bank | T5 Obs | T6 Mobile | T7 Pentest | T8 Load | T9 Go-live |
|---|---|---|---|---|---|---|---|---|---|
| 1 (W21) | P1 P2 P3 | — | — | — | — | P1 | — | — | — |
| 2 (W22) | P4 P5 | P1 P2 | — | — | — | P2 (12d total) | — | — | — |
| 3 (W23) | ✓ done | P3 P4 | P1 | — | — | P2 | — | — | — |
| 4 (W24) | | P5 P6 | P2 P3 | — | — | P2 | — | — | — |
| 5 (W25) | | ✓ done | P4 P5 | P1 | P1 | P2 done | — | — | — |
| 6 (W26) | | | ✓ done | P2 | P2 P3 | P3 | T7-P1 (selection) | P1 P2 | — |
| 7 (W27) | | | | P3 P4 P5 P6 (parallel) | P3 P4 | P3 done · P4 | T7-P2 (window starts) | P2 | — |
| 8 (W28) | | | | P3 P4 P5 P6 | ✓ done | P4 done | T7-P2 | P3 (5× gate) | — |
| 9 (W29) | | | | P3 P4 P5 P6 | | P5 (submit stores) | T7-P2 | P3 P4 | — |
| 10 (W30) | | | | ✓ done | | P5 (store review) | T7-P3 (remediation) | P4 done | — |
| 11 (W31) | | | | | | P5 (approved) | T7-P3 | | T9-P1 (gate review) |
| 12 (W32) | | | | | | ✓ done | T7-P4 (retest + attest) | | T9-P2 (cutover) |
| 13 (W33) | | | | | | | ✓ done | | T9-P3 P4 (hypercare) |

**Hypercare extends into Week 14-17 (post-T+13w).** T9-P5 (30-day review) fires at calendar T+13w + 30d = T+17w.

## 4. Cross-service runtime dependency graph

(Which services depend on which infrastructure components at runtime.)

| Service | Aurora | MSK | S3 | Redis | KMS | Secrets Mgr | VPN→bank | OAuth+JWKS | ALB | WAF |
|---|---|---|---|---|---|---|---|---|---|---|
| BFF (services/bff) | ✓ writer+readers | ✓ producer (5 topics) | – | – | ✓ envelope | ✓ via ESO | ✓ (T4+) | ✓ verify | ✓ public ingress | ✓ |
| auth-svc | ✓ writer | – | – | – | ✓ | ✓ | – | ✓ issue | ✓ public ingress | ✓ |
| audit-svc | ✓ writer | ✓ consumer apex.audit.events | ✓ audit bucket | – | ✓ | ✓ | – | ✓ verify | – (internal) | – |
| regulatory-svc/cases | ✓ writer | ✓ producer apex.case.events | – | – | – | ✓ | – | ✓ verify | – | – |
| regulatory-svc/alerts | ✓ writer | ✓ producer apex.regulatory.events | – | – | – | ✓ | – | ✓ verify | – | – |
| regulatory-svc/rules | ✓ writer | – | – | – | – | ✓ | – | ✓ verify | – | – |
| regulatory-svc/indicators | ✓ reader | ✓ producer apex.indicator.values | – | – | – | ✓ | – | ✓ verify | – | – |
| collection-adapter | – | ✓ consumer apex.case.events | – | – | – | ✓ | ✓ (T4-P6) | – | – | – |
| notification-svc | – | ✓ consumer | – | – | – | ✓ vendor keys | – | – | – | – |
| pipeline-svc (MWAA) | ✓ via dbt | – | ✓ raw bucket | – | ✓ | ✓ | ✓ CBS read | – | – | – |
| ai-copilot-svc | ✓ reader (features) | – | ✓ models bucket | – | – | ✓ ANTHROPIC_API_KEY | – | – | – | – |
| Mobile RN | – (via BFF) | – | – | – | – | – | – | ✓ via Expo | – | – |

**Conclusion:** every TS service needs `Aurora + Secrets-Mgr + KMS + JWKS-verify` at minimum. Without these, the service refuses to start (see `services/bff/src/server.ts` env-validation block as the reference pattern).

## 5. Deployment architecture validation matrix

Use this matrix as a pre-go-live deploy-architecture review. Every row should be `green` before T9-P1.

| Layer | Component | Validation | Verifier | Last validated |
|---|---|---|---|---|
| **Network** | VPC topology | 3 AZ × (public + private + database) subnets exist | `aws ec2 describe-subnets` count = 9 | Pre-T1-P3 |
| **Network** | NAT redundancy | 1 NAT per AZ; route table per private subnet → corresponding NAT | `aws ec2 describe-route-tables` cross-checked vs `docs/architecture.md` §3 | Pre-T3-P1 |
| **Network** | VPN | 2 active IPsec tunnels to bank network; BGP UP | `aws ec2 describe-vpn-connections --filters 'Name=state,Values=available'` returns 2 tunnels | Pre-T4-P2 |
| **Network** | WAF | OWASP Top-10 ruleset attached to public ALB; rate-limit 1000/s/IP | `aws wafv2 list-rules --web-acl-arn` returns ≥7 rules | Pre-T7-P2 |
| **Compute** | EKS version | 1.30 (latest stable -1 minor) | `aws eks describe-cluster --query 'cluster.version'` | Pre-T8-P3 |
| **Compute** | Karpenter | Both NodePools (`general` + `ai`) provisioned | `kubectl get nodepools -o name` returns 2 | Pre-T8-P3 |
| **Compute** | HPAs | 7 HPAs (per T4.4 IaC) with `current` populated | `kubectl get hpa -A` shows all 7 with non-`<unknown>` current values | Pre-T8-P3 |
| **Compute** | PDBs | All 5 services (auth/audit/notif/reg/ai-copilot) have PDB with minAvailable matching `infra/k8s/pdb.yaml` | `kubectl get pdb -A` shows 5 entries | Pre-T8-P3 |
| **Data** | Aurora Multi-AZ | Writer + 2 readers across 3 AZs | `aws rds describe-db-clusters --query 'DBClusters[0].DBClusterMembers'` returns 3 entries | Pre-T2-P3 |
| **Data** | Aurora Global | Secondary region cluster member | `aws rds describe-global-clusters` returns 2 cluster members | Pre-T7-P2 |
| **Data** | Aurora autoscale | Reader autoscale target (CPU 65% + connection 700) | `aws application-autoscaling describe-scaling-policies --service-namespace rds` returns 2 policies | Pre-T8-P3 |
| **Data** | RDS Proxy | TLS-required, IAM auth, 80% max-conn% | `aws rds describe-db-proxies` shows `RequireTLS=true` | Pre-T9-P1 |
| **Data** | MSK | 3 brokers ACTIVE; IAM auth; auto-scale enabled | `aws kafka describe-cluster --query 'ClusterInfo.State'` returns ACTIVE | Pre-T8-P3 |
| **Data** | MSK MM2 | Connector running; secondary-region replication lag <2min | `aws kafkaconnect describe-connector --query 'connectorState'` returns RUNNING; CloudWatch `MM2-ReplicationLatency` <2min | Pre-T9-P1 |
| **Data** | S3 audit | Object Lock COMPLIANCE 7y; CRR enabled | `aws s3api get-object-lock-configuration --bucket apex-ews-audit-logs` returns COMPLIANCE+2555d | Pre-T9-P1 |
| **Data** | dbt mart | All 4 mart tables populated; 79+ tests green | `dbt test --select mart.*` exits 0 | Pre-T9-P1 |
| **Security** | KMS rotation | 5 CMKs with KeyRotationStatus=true | `aws kms describe-key` × 5 | Pre-T7-P1 |
| **Security** | Secrets rotation | Aurora master secret on 90d schedule via Secrets Manager | `aws secretsmanager describe-secret --secret-id <aurora>` returns `RotationEnabled=true` | Pre-T7-P1 |
| **Security** | IAM least-privilege | No `Resource: *` in service roles except KMS-Decrypt-via-service condition | Manual review of `infra/terraform/30-data/iam.tf` | Pre-T7-P2 |
| **Security** | RBAC matrix | `infra/rbac/matrix.json` + access_review.py green | `python infra/rbac/scripts/access_review.py --matrix infra/rbac/matrix.json --validate-only` exits 0 | Quarterly per X.1 |
| **Security** | JWKS rotation | auth-svc `/.well-known/jwks.json` exposed; BFF JwksVerifier configured | `curl https://auth.apex-ews.example/.well-known/jwks.json` returns valid JWK Set | Pre-T9-P1 |
| **Audit** | Hash chain verified | M15.2 `/v1/audit/integrity` returns `valid=true` for every tenant | Run `for t in BANK_DEMO BIL; do curl ... /v1/audit/integrity ; done` | Daily per `docs/bau-runbook.md` |
| **Audit** | S3 Object Lock test | Try `aws s3api delete-object --bucket apex-ews-audit-logs ...` → AccessDenied | Pre-T9-P1 negative test | Pre-T9-P1 |
| **Observability** | Prometheus targets | All 10 services UP | `curl prometheus:9090/api/v1/targets` shows `health=up` × 10 | Pre-T8-P3 |
| **Observability** | Burn-rate alarms | All tier-1 SLOs have 1h + 6h + 3d alarms | Grafana SLO dashboard shows 12+ alarms | Pre-T9-P1 |
| **Observability** | X-Ray traces | End-to-end trace visible for `/v1/customers/:id/360` | Manual UI test in X-Ray console | Pre-T9-P1 |
| **CI/CD** | All 5 workflows green on main | schema-compat, services-ci, terraform-ci, rbac-matrix, security-scan | `gh run list --workflow=services-ci.yml --status=success --limit=1` returns ≤2h ago | Continuous |
| **Mobile** | Apps approved | iOS TestFlight + Android Play Internal Testing track | Apple App Store Connect + Play Console screenshots filed | Pre-T9-P1 |

**Gate criterion:** every row above must show `green` and `last validated` within 14 days of T9-P1.

## 6. Estimated execution timeline (calendar)

Anchored at T+0 = 2026-05-21. Each week = ~5 business days.

| Week | Start | Tracks active | Milestones |
|---|---|---|---|
| 1 | 2026-05-21 | T1 + T6 | AWS Organizations live; mobile EAS pipeline up |
| 2 | 2026-05-28 | T1 + T2 + T6 | KMS + VPC done; Aurora cluster up |
| 3 | 2026-06-04 | T2 + T6 | Aurora migrations applied; dbt run green |
| 4 | 2026-06-11 | T2 + T3 + T6 | MSK + S3 lifecycle; EKS cluster up |
| 5 | 2026-06-18 | T3 + T4 + T5 + T6 | Karpenter + ESO + ArgoCD deploy; Observability stack up |
| 6 | 2026-06-25 | T4 + T5 + T6 + T7-prep | SLOs instrumented; VPN to bank validated |
| 7 | 2026-07-02 | T4 (parallel P3-P6) + T7-P1 + T8 + T6 | CBS/IFRS9/AML/Bureau all wiring up; pentest vendor signed |
| 8 | 2026-07-09 | T4 + T7-P2 + T8-P3 (5× gate) + T6 | Bank integration full reconciliation; 5× load test gate |
| 9 | 2026-07-16 | T4 + T7-P2 + T8-P4 + T6 | Stretch test report; pentest fieldwork mid-cycle |
| 10 | 2026-07-23 | T7-P3 (remediation) + T6-P5 | Mobile submitted to stores |
| 11 | 2026-07-30 | T7-P3 + T9-P1 | App store approval; final 5-gate review begins |
| 12 | 2026-08-06 | T7-P4 + T9-P2 | Pentest final attestation; tenant-1 cutover |
| 13 | 2026-08-13 | T9-P3 P4 | Hypercare week 1 + 2 |
| 14-17 | 2026-08-20 to 2026-09-13 | Steady state + 2nd tenant | 30-day review at end of week 17 |

**Hard deadlines:**
- W7 end (2026-07-09) — must enter T7-P2 (pentest fieldwork) else T7 slips
- W11 end (2026-07-31) — must have app-store approval else T9-P2 slips
- W12 end (2026-08-07) — T7-P4 attestation MUST be clean for go-live

**Slip handling:**
- T2/T3 slip → T4 slips correspondingly (compresses T7 buffer)
- T7 slip → T9 must slip; cannot launch with unremediated Critical
- T9 slip → Steering committee reviews; 2-week minimum slip per failed gate

## 7. Risk register — operationalization-specific

| ID | Risk | Probability | Impact | Owner | Mitigation | Trigger |
|---|---|---|---|---|---|---|
| OPS-R1 | Bank-side VPN not provisioned by W6 | Medium | High (T4 blocked) | INT+bank liaison | Weekly status call with bank network team starting W3; written SoW with bank-side deadline | Slip beyond W7 = activate VPN-mocks fallback for go-live, defer T4-P3-P6 to post-launch |
| OPS-R2 | Aurora migration 0NN fails on production-sized data | Low | High (T2 blocked) | DATA | Migrations CI-validated against 10k-customer snapshot; staging-restore test in T2-P2 | Migration timeout >5min → re-architect as backfill job, not blocking migration |
| OPS-R3 | Pentest reveals Critical needing architecture change | Medium | High (T9 slips) | CISO+CTO | Threat-model exercise in W3-W4; pre-pentest internal `services-ci.yml` security-scan must be zero-Critical | 3-day patch SLA per `docs/pentest-remediation-playbook.md`; war-room flow tested in T7-P1 |
| OPS-R4 | Karpenter cost runaway on spot interruptions | Medium | Medium | SRE | Test budget alarm at $200/day; gradually ramp consolidation policy from `WhenEmpty` → `WhenEmptyOrUnderutilized` post-launch | Disable Karpenter; revert to managed node groups |
| OPS-R5 | App-store rejection delays mobile launch | Medium | Medium | UI | Pre-submission privacy review with legal; submit early (W10) for buffer | App-store rejection ≠ launch block — mobile can ship in W14 if necessary |
| OPS-R6 | DR game-day reveals undocumented manual step | Medium | Medium | SRE | DR game-day MUST run before T9-P1 (added to T9 prereqs); runbook gaps filed against `docs/dr-runbook.md` immediately | DR Amber = fix runbook + re-run within 2 weeks |
| OPS-R7 | 5× load test fails at first run | Medium | Medium | SRE | 3-week T8 buffer absorbs 1 capacity-tuning iteration; documented remediation per `infra/load-test/reports/template.md` §recommendations | Failed 5× = HPA min uplift + Aurora reader upsize + retest; 3 consecutive failures escalates to Year-2 Theme A |
| OPS-R8 | Tenant ops team not trained by W12 | Low | Medium | INT+ORCH | Training sessions on `docs/bau-runbook.md` § common ops scheduled in W11 + W12 | Cutover requires sign-off from tenant ops lead |
| OPS-R9 | Cost runaway during hypercare | Medium | Low | SRE+FinOps | M14 cost alarms at 120% of monthly envelope; FinOps dashboard (T5.5) reviewed daily in hypercare | Budget breach → emergency capacity-down + post-mortem |
| OPS-R10 | Regulator (RBI/IRDAI) requires data residency | Low | High | CISO+Compliance | Pre-launch self-assessment per `docs/year-2-backlog.md` Theme I; af-south-1 + ap-south-1 already in-region | Compliance failure = launch slip; cannot waive |

## 8. Quick-reference: blocker-to-fallback map

| If this is blocked | Fall back to | For how long | Trade-off |
|---|---|---|---|
| Bank VPN (T4-P1) | INTEGRATIONS_MODE=mock | Until W14 | Loses real integration data; everything else launches |
| Aurora Global (T2-P4) | Single-region Aurora | Permanent | Loses DR; not acceptable for go-live |
| EKS Karpenter (T3-P2) | Managed node groups (min=3) | Permanent | Higher base cost; no other risk |
| Pentest Critical unresolved (T7-P3) | None — cannot launch | Slip by ≥1 week | This is a hard gate per `docs/charter.md` |
| Apps not approved (T6-P5) | Defer mobile to post-launch | Until W15 | Field officers continue on SPA only |
| DR game-day Amber/Red (T9-P1 gate b) | None — must re-run within 2 weeks | Slip by 2-4 weeks | This is a hard gate |
| 5× load test fail (T9-P1 gate c) | Capacity uplift + retest | 1 week per iteration | Cost increase; if >3 iterations, escalate to Year-2 Theme A |
| ISO 27001 Stage-1 (T9-P1 gate d) | None — formal audit cycle | Slip by 4-6 weeks | This is a hard gate per regulator readiness |
| Steering sign-off (T9-P1 gate e) | Reschedule meeting | Slip by 1 week | This is a hard gate |
