# ZorEWS — Production Operationalization Roadmap

**Owner:** CTO + SRE lead · **Audience:** Steering committee + agent-integration + Risk-IT · **Last reviewed:** 2026-05-21 · **Status:** Draft — pending steering sign-off

> The build phase is complete. Every contract surface — BFF + SPA + mobile + integrations + analytics + audit — is shipped, additive-only, with ~8,500 tests + tsc + IaC validation green. This roadmap covers the path from "code in repo + tests pass + IaC validates" to **"first paying tenant in production, monitored, on-call, SLO-tracked"**.
>
> Pair with `docs/dr-runbook.md` for failover semantics, `docs/bau-runbook.md` for steady-state ops, `docs/year-2-backlog.md` for the post-launch feature backlog, `docs/risk-register.md` for risk acceptance.

---

## 0. Executive summary

| Question | Answer |
|---|---|
| **Calendar** | T-0 = 2026-05-21 · Target tenant-1 production cut: **T+90 days (2026-08-19)** · 2 banks live: T+180 |
| **Effort** | ~ 6.5 engineer-months across 8 tracks · 3 tracks parallelisable from T+0 |
| **Budget envelope** | ~$25k AWS / mo at launch · $7k / mo third-party vendors · $80k one-time pentest + 5k DR drill |
| **Critical path** | Track 1 (AWS landing zone) → Track 2 (data plane up) → Track 4 (CBS connectivity) → Track 7 (pentest) → Track 9 (go-live) |
| **Hard go/no-go gates** | (a) Pentest clean (zero unremediated Critical) · (b) DR game-day Green · (c) 5× load-test passes the green-light gate · (d) ISO 27001:2022 Stage-1 audit passed · (e) Steering committee sign-off |
| **Reversibility** | Every track has documented rollback. Feature flags + envelope-aware contracts let any sub-component swap to stub mode without SPA changes. |

**The 8 tracks (sequenced by critical-path dependency):**

| # | Track | Primary owner | T-start | Duration | Blocks |
|---|---|---|---|---|---|
| 1 | AWS landing zone + environments | agent-integration + SRE | T+0 | 3 weeks | 2, 3, 5, 8 |
| 2 | Data plane runtime (Aurora + MSK + S3) | agent-integration + agent-data | T+1w (after T1 IAM) | 4 weeks | 4, 5, 6 |
| 3 | EKS + service deploy + secrets | agent-integration + SRE | T+1w | 3 weeks | 5, 6, 7, 9 |
| 4 | Real bank integration connectivity (CBS / IFRS9 / AML / Bureau) | agent-integration + Risk-IT | T+3w (after T2 Aurora) | 6 weeks | 9 |
| 5 | Observability + SLO + alerting | SRE + agent-integration | T+2w (after T3 EKS) | 3 weeks | 7, 9 |
| 6 | Mobile RN final delivery | agent-ui + Risk-IT | T+0 (parallel) | 5 weeks | 9 |
| 7 | Pentest engagement + remediation | CISO + agent-integration | T+6w (after T5 observability) | 5 weeks | 9 |
| 8 | Load + stress + capacity tuning | agent-integration + SRE | T+6w (after T5) | 3 weeks | 9 |
| 9 | Go-live (tenant cutover + steady-state) | CTO + CISO + Risk-Ops | T+11w | 2 weeks | — |

Tracks 1, 3, 6 start in parallel at T+0. Track 4 has the longest blocking dependency chain (it can't begin until Aurora + MSK are live and the bank's IT team has provisioned VPN / API access; allow 4 weeks of bank-side lead time). Critical-path total: **11 weeks** of execution + 2 weeks of go-live = 13 weeks. The T+90 / 13-week calendar leaves 3 weeks of slack for the pentest + remediation + DR drill.

---

## 1. Track 1 — AWS landing zone + environments

**Owner:** agent-integration + SRE primary · **Duration:** 3 weeks · **Blocks:** every other track

Per `infra/terraform/00-landing-zone/` — the IaC exists; this is the apply + validate path.

### 1.1 Prerequisites

- AWS payer + 3 child accounts (`apex-ews-prod`, `apex-ews-staging`, `apex-ews-shared-services`) created by Finance ops.
- IAM Identity Center wired to the company SSO.
- KMS CMKs provisioned in `af-south-1` (primary) + `ap-south-1` (secondary per T5.2).
- `terraform apply` operator credentials issued + audited.

### 1.2 Deliverables (in order)

| Step | Deliverable | Owner | Duration |
|---|---|---|---|
| 1 | `terraform apply` 00-landing-zone (Org + 3 OUs + SCPs + 5 KMS CMKs + CloudTrail) | agent-integration | 2 days |
| 2 | `terraform apply` 10-network (3-AZ VPC + 3 tiers) in prod + staging | agent-integration | 3 days |
| 3 | IAM Identity Center permission sets per `infra/rbac/matrix.json` 5 roles | SRE | 2 days |
| 4 | Route53 zones + ACM certs for `*.apex-ews.example` | SRE | 2 days |
| 5 | AWS Backup vault + cross-region replication policies | SRE | 3 days |
| 6 | GitHub Actions OIDC federation to `apex-ews-prod-ci` role | agent-integration | 1 day |
| 7 | Cost Explorer + Budgets ($25k/mo prod soft alert at 80% → CTO; $30k hard cap) | SRE | 0.5 day |

### 1.3 Validation gate

- `aws sts get-caller-identity` from CI returns the `apex-ews-prod-ci` role via OIDC (no static credentials).
- `terraform plan` against prod is empty (idempotency).
- SCP smoke test — attempt a region-pin violation in a sandbox account; SCP blocks it.
- KMS rotation calendar entries logged in AWS Config (annual rotation).
- AWS Backup vault carries a successful test backup.

### 1.4 Risk + rollback

- **Risk:** SCP overreach blocks legitimate operations during day-2 ops. **Mitigation:** dry-run every new SCP in `apex-ews-shared-services` 7 days before applying to prod.
- **Risk:** OIDC federation misconfig grants CI broader access than intended. **Mitigation:** read-only audit by CISO at end of week 1.
- **Rollback:** All resources tagged `TerraformManaged=true`; `terraform destroy` per-layer with the documented dependency order (40-edge → 30-data → 20-eks → 10-network → 00-landing-zone). Never destroy 00-landing-zone — it has KMS keys with retention.

---

## 2. Track 2 — Data plane runtime (Aurora + MSK + S3)

**Owner:** agent-integration + agent-data · **Duration:** 4 weeks · **Blocks:** T4 integrations, T5 observability, T6 mobile (for live API), T8 load test

Per `infra/terraform/30-data/` — IaC exists; this brings up the real cluster + applies all 34 migrations + materialises the mart + seeds the feature store backfill.

### 2.1 Prerequisites

- Track 1.2 step 2 (VPC) complete.
- Aurora master credentials provisioned in Secrets Manager via Track 1.
- Schema Registry CI gate (`.github/workflows/schema-compat.yml`) green on main.

### 2.2 Deliverables

| Step | Deliverable | Owner | Duration |
|---|---|---|---|
| 1 | `terraform apply` 30-data — Aurora PG 16 Multi-AZ (writer + 2 readers) | agent-integration | 2 days |
| 2 | Apply all 34 migrations (`data/schema/001..034`) via `make migrate` against prod Aurora | agent-data | 1 day (incl. validation) |
| 3 | Apply Track 1 KMS CMK + envelope-encryption to Aurora storage at rest | SRE | 0.5 day |
| 4 | `terraform apply` MSK (3-broker, IAM auth) | agent-integration | 2 days |
| 5 | Provision 5 Kafka topics (`apex.cbs.events` / `apex.indicator.values` / `apex.regulatory.events` / `apex.case.events` / `apex.audit.events`) + register Glue schemas (BACKWARD compat enforced) | agent-integration | 1 day |
| 6 | S3 buckets — audit (Object Lock COMPLIANCE 7yr) + raw (365d lifecycle to IA after 90d) + curated | agent-integration | 1 day |
| 7 | Aurora Global Database provisioning to `ap-south-1` secondary region (`var.enable_aurora_autoscale = true`; T5.2 toggle on) | agent-integration | 2 days |
| 8 | S3 CRR + KMS re-encryption to secondary | agent-integration | 1 day |
| 9 | dbt seed + run against production (`data/dbt/scripts/validate_seed.sh`) — synthetic LOAD_TEST tenant only; real tenant data lands via Track 4 ingestion | agent-data | 2 days |
| 10 | feature_store backfill (`dbt run --select feat_values_backfill`) — populates the 24-month window per tenant | agent-data | 1 day per tenant |

### 2.3 Validation gate

- `psql` smoke against Aurora writer + reader endpoints; verify 9 schemas / 26 tables / row counts match the staging baseline.
- `dbt test` clean against the 10k-customer seed (79 tests + the new feature_store assertions).
- Topic schemas registered in Glue with `BACKWARD` compatibility; `infra/schema-registry/scripts/check_compat.py` clean.
- MSK `kafka-cluster:DescribeCluster` + IAM auth handshake succeed from a test EKS pod.
- Aurora Global writer→reader replication lag < 5 seconds at idle (the docs/slos.md tier-2 SLO baseline).
- `verifyChain()` returns `valid: true` after audit hash-chain bootstrap (genesis row + 10 test events).

### 2.4 Risk + rollback

- **Risk:** Migration 034 (feature_store) carries a 24-month retention semantics doc but the actual purge job isn't wired — uncontrolled table growth. **Mitigation:** Block production ingest until Track 2.10 backfill is complete AND a pg_cron / Lambda purge job is scheduled; daily monitoring on `feature_store.feature_values` row count.
- **Risk:** Schema Registry BACKWARD violation gets pushed in a hot-fix bypassing CI. **Mitigation:** Manual approval gate in GitHub Actions on any `infra/schema-registry/**` change to main.
- **Rollback:** Aurora has Point-In-Time-Recovery (default 7-day retention; production extends to 35 days). MSK doesn't roll back per se — schema rollback via Glue Schema Registry versions; data rollback via topic compaction OR a new replacement topic.

---

## 3. Track 3 — EKS + service deploy + secrets

**Owner:** agent-integration + SRE primary · **Duration:** 3 weeks · **Blocks:** T5, T7, T9

Per `infra/terraform/20-eks/` + `infra/k8s/*.yaml` — IaC + manifests exist; this brings up the cluster + deploys the 10 TS services + auth-svc + audit-svc + ai-copilot-svc.

### 3.1 Prerequisites

- Track 1 VPC + IAM done.
- Container images built + pushed to GHCR (or ECR) via `services-ci.yml` Track 1.6 OIDC.

### 3.2 Deliverables

| Step | Deliverable | Owner | Duration |
|---|---|---|---|
| 1 | `terraform apply` 20-eks — EKS 1.30 cluster + 3 managed node groups (general + ai-gpu + system) + IRSA | agent-integration | 2 days |
| 2 | Karpenter bootstrap per `infra/k8s/karpenter/README.md` (`var.enable_karpenter = true`; 5-step sequence — helm install + nodepool.yaml + scale down static groups) | agent-integration | 2 days |
| 3 | External Secrets Operator (ESO) + IRSA mapping → Aurora password, JWT signing key, vendor API keys (Anthropic, Africa's Talking, SES, FCM, APNS, PagerDuty, Slack, DefectDojo, Grafana, GitHub) | SRE | 3 days |
| 4 | ArgoCD bootstrap + Helm charts for the 10 services in apex-ews-prod namespace | agent-integration | 3 days |
| 5 | HPAs from `infra/k8s/hpa.yaml` applied (7 services with explicit CPU + memory targets) | SRE | 0.5 day |
| 6 | PDBs from `infra/k8s/pdb.yaml` applied | SRE | 0.5 day |
| 7 | ALB + WAF + CloudFront (`terraform apply` 40-edge) | agent-integration | 2 days |
| 8 | Per-service ConfigMaps wiring env vars: `BFF_PG_URL`, `AUTH_SVC_PG_URL`, `CASES_PG_URL`, `ALERTS_PG_URL`, `FEATURE_STORE_PG_URL`, `KAFKA_BROKERS`, `BFF_TELEMETRY_URL`, `BFF_TELEMETRY_TENANT`, `BFF_JWKS_URL` | SRE | 1 day |
| 9 | OAuth client_credentials provisioning for service-to-service auth (auth-svc `/oauth/token`) — one client per inter-service call (bff↔auth-svc, cases↔bff, alerts↔notification-svc, etc.) | agent-integration | 1 day |
| 10 | Service mesh decision — **deferred to Year-2 Theme H** (k8s NetworkPolicy + mTLS via IRSA is sufficient for launch; revisit Istio/Linkerd post-launch if east-west traffic complexity warrants it) | — | — |
| 11 | Smoke test: `make smoke` against the prod ALB + every `/healthz` returns 200 | SRE | 1 day |

### 3.3 Validation gate

- 12 pods Running across the 10 TS services + auth-svc + audit-svc + ai-copilot-svc.
- HPAs report `current = desired = min`; no pods CrashLoopBackOff.
- ALB + WAF + CloudFront responding 200 on `https://api.apex-ews.example/healthz`.
- ExternalSecrets all `SYNCED`; no `SecretSyncError` events.
- ArgoCD app-of-apps green; auto-sync on for non-prod, manual-sync for prod.
- Pod-to-Aurora connectivity: `kubectl exec` into a BFF pod + `psql $BFF_PG_URL -c "SELECT 1"` returns 1.
- Pod-to-MSK connectivity: `kubectl exec` into alerts-svc pod + `kafka-console-producer.sh` writes a test message.
- OAuth handshake: BFF acquires a service token from auth-svc; tenant claim matches the configured client.

### 3.4 Risk + rollback

- **Risk:** Karpenter consolidation aggressively recycles spot nodes during a Critical incident. **Mitigation:** Set `disruption.budgets[]` to 0% during incidents via runbook; PDBs ensure ≥ 1 (≥ 2 for regulatory-svc) pod stays available.
- **Risk:** ESO loses sync; pods restart with empty env vars. **Mitigation:** Pod readinessProbe on a route requiring secrets (e.g. auth-svc `/healthz/secrets-loaded`) prevents traffic routing to under-provisioned pods.
- **Risk:** ArgoCD auto-sync to prod accidentally applies a half-baked PR. **Mitigation:** Prod is manual-sync ONLY; staging is auto-sync from main.
- **Rollback:** ArgoCD app history allows instant revert to prior revision. Per-service Helm release rollback via `helm rollback <svc> <rev>`. Database migrations are NOT rolled back automatically — DBA-led recovery from PITR.

---

## 4. Track 4 — Real bank integration connectivity (CBS / IFRS9 / AML / Bureau)

**Owner:** agent-integration + Risk-IT lead + bank-side IT lead · **Duration:** 6 weeks · **Blocks:** T9

Per `services/bff/src/integrations/cbs_production.ts` (resilience framework shipped) + M14.1–M14.8 adapter contracts. This swaps stub adapters for real `HttpCbsClient` / `HttpIfrs9Adapter` / `HttpAmlAdapter` / `HttpBureauAdapter` impls.

### 4.1 Prerequisites

- Track 2 Aurora + MSK live.
- Track 3 EKS + ExternalSecrets ready to receive bank API credentials.
- **Bank-side prerequisites** (4-week lead time minimum, in parallel):
  - VPN tunnel or PrivateLink between ZorEWS VPC and the bank's CBS network.
  - API gateway access + scoped credentials (read-only on loan/repayment/account_profile; write on case_action).
  - DPA signed + sub-processor disclosure complete per `docs/vendor-accounts.md`.
  - Test customer set (~50 customers spanning all 4 risk levels + 3 IFRS9 stages).
  - SLA agreement: target p95 < 2s for inbound calls; weekly maintenance window.

### 4.2 Deliverables

| Step | Deliverable | Owner | Duration |
|---|---|---|---|
| 1 | Network connectivity (VPN site-to-site or PrivateLink) | bank-IT + agent-integration | 2 weeks |
| 2 | Implement `HttpCbsClient` satisfying the `CbsClient` interface from `cbs_production.ts` — REST/SOAP gateway per bank's API spec | agent-integration | 1 week |
| 3 | Wrap in `ResilientCbsClient` with the M15.1 AuditTrailStore-backed sink + tenant-tuned `RetryPolicy` (start with `DEFAULT_CBS_RETRY_POLICY`; adjust from week-1 traffic) | agent-integration | 0.5 week |
| 4 | Implement HTTP impls for `Ifrs9Adapter`, `AmlAdapter`, `BureauAdapter` against each upstream's real API | agent-integration | 1 week (parallel) |
| 5 | M3.1 ingestion registry — flip per-connector status from `degraded` to `healthy` only after a full end-to-end test load (50 customers × 30 days of history) | agent-data | 1 week |
| 6 | Reconciliation report for the first week — `cbs_sync.ts` ledger row counts vs CBS source counts; fail-loud on > 0.1% discrepancy | agent-data | 0.5 week |
| 7 | Per-tenant cutover plan — flag `INTEGRATION_MODE=stub|live` per tenant via M13.1 admin config; flip BIL pilot tenant first, BANK_DEMO stays stubbed until separate cutover | agent-integration | 0.5 week |
| 8 | M14.20 SLA breach event log lands its first real breach events from production traffic | agent-data | continuous |

### 4.3 Validation gate

- 50-customer end-to-end load: ingest from CBS → indicator-engine → rule evaluator → alert producer → routing → SPA SSE banner; latency budget per docs/slos.md tier-1 (p95 indicator → alert < 60s) met.
- `cbs_sync.ts` reconciliation report: rows offered vs accepted vs rejected matches CBS source within 0.1%.
- All M14 adapter health probes (`/v1/integrations/adapters/health`) report `up`; no `degraded` after 3-day soak.
- M14.26 SLA budget report (`/v1/integrations/adapters/sla-budget`) shows zero `over_budget_severe` adapters over a 24h window.
- Audit trail: every CBS call recorded in `audit.event_log` with action `cbs.call.<operation>` + correlation_id + tenant_id; M15.2 `verifyChain` returns valid=true.

### 4.4 Risk + rollback

- **Risk:** Bank API breaks under our 5× pilot traffic (their stated SLA may be lower than our hot-path needs). **Mitigation:** Pre-launch load test (Track 8) against the live integration; identify saturation point; circuit breaker auto-trips per `cbs_production.ts`.
- **Risk:** DPA sub-processor disclosure not aligned (e.g. customer's PII flows through an undisclosed vendor). **Mitigation:** Compliance officer sign-off on `docs/data-lineage.md` + `docs/vendor-accounts.md` sub-processor table BEFORE the cutover.
- **Risk:** Bank API credentials rotate without notice. **Mitigation:** Quarterly rotation calendar in `docs/bau-runbook.md` § monthly; ESO refresh on secret update.
- **Rollback:** Per-tenant flag `INTEGRATION_MODE=stub` flips that tenant back to the M14 stub adapters within 30 seconds. The stubs return deterministic synthetic data — the SPA + downstream stays functional but stale.

---

## 5. Track 5 — Observability + SLO + alerting

**Owner:** SRE primary + agent-integration · **Duration:** 3 weeks · **Blocks:** T7, T9

Per `docs/slos.md` (already shipped) + the 3-tier SLI/SLO/error-budget framework. This wires the actual observability stack.

### 5.1 Prerequisites

- Track 3 EKS up.
- Track 2 Aurora + MSK up (metric sources).

### 5.2 Deliverables

| Step | Deliverable | Owner | Duration |
|---|---|---|---|
| 1 | Prometheus + Grafana (Helm-deployed; self-hosted in EKS per Year-2 budget decision) | SRE | 2 days |
| 2 | Service-level metrics endpoints — every BFF route emits `http_req_duration_seconds` + `http_req_total{status}` via prom-client middleware | agent-integration | 3 days |
| 3 | Aurora exporter + MSK exporter + node-exporter daemonsets | SRE | 1 day |
| 4 | 6 SLO dashboards in Grafana (one per tier-1 SLO from `docs/slos.md`) + 1 fleet-status dashboard | SRE | 3 days |
| 5 | Alerting rules per `docs/slos.md` § two-window burn-rate — fast (1h, 5% budget) + slow (6h, 10%) + slow-slow (3d, 50%) | SRE | 2 days |
| 6 | PagerDuty integration (per `docs/vendor-accounts.md` § 2.6) — fast burns + ALL P0/P1 incidents page | SRE | 1 day |
| 7 | Slack #apex-ews-alerts integration — slow burns + every P2+ incident | SRE | 0.5 day |
| 8 | Distributed tracing — OpenTelemetry → AWS X-Ray for inter-service trace; sample at 1% prod | SRE | 2 days |
| 9 | Audit trail self-monitoring — daily cron calls `GET /v1/audit/integrity` per tenant; pages on `valid=false` | SRE | 0.5 day |
| 10 | Streaming latency monitor — daily cron calls `GET /v1/streaming/latency`; pages on `target_p95_60s_met=false` over a 24h window | SRE | 0.5 day |

### 5.3 Validation gate

- Every BFF route emits Prom metrics queryable from Grafana (random spot check ≥ 20 routes).
- Grafana dashboard URLs accessible from on-call + bookmarked in `docs/on-call-rota.md` § Tooling.
- Alert routing tested end-to-end: synthetic SLO breach in staging fires PagerDuty page within 2 minutes.
- X-Ray trace shows full path SPA → BFF → auth-svc → audit-svc for at least one request.
- Daily audit-integrity cron logged in CloudWatch; failed run pages CISO.

### 5.4 Risk + rollback

- **Risk:** Alert fatigue. Initial thresholds may be too tight, paging operators unnecessarily. **Mitigation:** Calibrate during week 1 of Track 5 — tune thresholds based on actual baseline; documented in `docs/slos.md` § recalibration triggers.
- **Risk:** Distributed tracing cardinality blows out X-Ray costs. **Mitigation:** 1% sampling at launch; rule-based sampling for error responses (sample 100% of 5xx).
- **Rollback:** Remove Grafana alert rules; on-call falls back to manual Grafana dashboard scan per `docs/bau-runbook.md` § daily.

---

## 6. Track 6 — Mobile RN final delivery

**Owner:** agent-ui + Risk-IT (TestFlight / Play Store distribution) · **Duration:** 5 weeks · **Blocks:** T9 (field-officer launch)

Per `mobile/` — T4.3.1 shipped auth store + GPS hook + 4 API modules; this builds the screens + Expo build pipeline + TestFlight / Play Store release.

### 6.1 Prerequisites

- BFF live in staging (Track 3 step 11).
- Track 4 step 2 — at least the CBS adapter wired so the mobile alert list shows real alerts.
- Apple Developer Program account ($99/yr, per `docs/vendor-accounts.md` § 2.5).
- Google Play Console account ($25 one-time per `docs/vendor-accounts.md`).
- iOS push certs + Firebase Cloud Messaging service-account JSON.

### 6.2 Deliverables

| Step | Deliverable | Owner | Duration |
|---|---|---|---|
| 1 | `mobile/App.tsx` entry + NavigationContainer + native-stack navigator | agent-ui | 0.5 week |
| 2 | LoginScreen wired to `AuthStore.setSession` + auth-svc `/auth/login` | agent-ui | 0.5 week |
| 3 | TOTP 2FA screen (handles `requires_2fa` partial-token flow from M1.1) | agent-ui | 0.5 week |
| 4 | AlertListScreen + pull-to-refresh + criticality-sort | agent-ui | 1 week |
| 5 | CaseDetailScreen + action-capture form (call / visit / SMS / email / note) | agent-ui | 1 week |
| 6 | GPS capture wired via `useLocation` hook into action.gps field | agent-ui | 0.5 week |
| 7 | Offline sync queue — actions captured offline replay when connectivity returns | agent-ui | 0.5 week |
| 8 | Expo EAS build pipeline — internal-distribution builds on every main commit | agent-ui | 0.5 week |
| 9 | TestFlight internal-track (Apple) + Play Console internal-test track (Google) | Risk-IT | 1 week (waiting on store review) |
| 10 | Pilot field-officer usability test (10 officers, 1 week) | Risk-IT + UX | 1 week |

### 6.3 Validation gate

- TestFlight build installs + runs on iPhone 12+ (iOS 16+).
- Play Console build installs + runs on Pixel 5+ (Android 12+).
- Login → 2FA → alert list → drill case → log action (with GPS) → submit succeeds end-to-end against staging BFF.
- Offline-mode test: airplane mode, log 3 actions, restore connectivity, verify all 3 sync to /v1/action.
- Pilot field-officer test: 10 officers × 5 actions = 50 actions captured; ≥ 95% sync success; no app crashes.

### 6.4 Risk + rollback

- **Risk:** Apple / Google review rejection (e.g. missing privacy disclosure on GPS use). **Mitigation:** Privacy manifest + permission strings reviewed by Compliance officer pre-submission; allow 2-week buffer for re-submission.
- **Risk:** Field officers can't authenticate when off-network (e.g. branch with weak signal). **Mitigation:** TOTP backup codes per M1.1; offline-mode sync queue per Track 6.7 above.
- **Risk:** Mobile app exposes API surface attackers can scrape. **Mitigation:** M1.3 API key middleware enforces RBAC; auth tokens scoped to `field_officer` only; sensitive endpoints (admin config, audit log) excluded from mobile API contract.
- **Rollback:** Pull from TestFlight / Play Console (immediate); field officers fall back to web SPA on tablet until next build.

---

## 7. Track 7 — Pentest engagement + remediation

**Owner:** CISO + agent-integration (remediator) · **Duration:** 5 weeks · **Blocks:** T9

Per `docs/pentest-brief.md` (engagement brief shipped) + `docs/pentest-remediation-playbook.md` (SLA matrix shipped).

### 7.1 Prerequisites

- Track 5 observability live so any test traffic is visible.
- Vendor selected (3-quote process; DefectDojo for SARIF intake per `docs/vendor-accounts.md` § 2.8).
- RoE (Rules of Engagement) signed T-2 weeks before kickoff.

### 7.2 Deliverables

| Step | Deliverable | Owner | Duration |
|---|---|---|---|
| 1 | Vendor selection + contract + RoE signed | CISO + Legal | 1 week |
| 2 | Staging environment hardened to match prod (Track 1 + 2 + 3 + 5 all green in staging) | SRE | 1 day |
| 3 | Pentest execution per `docs/pentest-brief.md` § 4-phase window (1wk recon → 2wk manual → 1wk priv-esc → 2wk report) — actually 4 weeks compressed for launch readiness | vendor | 4 weeks |
| 4 | Daily status email + 4h flash on Critical per `docs/pentest-remediation-playbook.md` | vendor → CISO | continuous |
| 5 | Findings triaged into DefectDojo + JIRA per `docs/pentest-remediation-playbook.md` § 9-step workflow | agent-integration | continuous |
| 6 | Critical findings remediated within 3-day SLA + retest validates | agent-integration + vendor | continuous |
| 7 | High findings remediated within 14-day SLA | agent-integration | continuous |
| 8 | Final report + retest report | vendor | end of week 4 |

### 7.3 Validation gate

- Zero unremediated Critical findings.
- Zero unremediated High findings open > 30 days.
- Medium findings: either remediated OR formally accepted by CISO with risk-acceptance log entry in `docs/risk-acceptance-log.md`.
- Vendor retest confirms every Critical + High fix is effective end-to-end.

### 7.4 Risk + rollback

- **Risk:** Critical finding requires architecture change (e.g. tenant isolation flaw needing schema rework). **Mitigation:** Per `docs/risk-register.md` R-005 — accepted risk; we accept go-live slip rather than ship a known Critical.
- **Risk:** Pentest finds zero findings (suspicious; vendor competence question). **Mitigation:** Independent secondary review of methodology + coverage matrix.
- **Rollback:** Cannot ship to prod without pentest clean — hard gate.

---

## 8. Track 8 — Load + stress + capacity tuning

**Owner:** agent-integration + SRE · **Duration:** 3 weeks · **Blocks:** T9

Per `infra/load-test/` — T4.5.1 k6 scripts shipped; this runs them + tunes.

### 8.1 Prerequisites

- Track 3 EKS + Track 5 observability ready (HPA scaling visible in Grafana).
- Track 4 step 1 (network) so the load test exercises the bank-API path realistically.
- LOAD_TEST tenant provisioned + 50k synthetic customers seeded via `scripts/seed-load-test-tenant.sh` (write this).
- k6 load-test JWT issuance script — admin-only operator token bound to LOAD_TEST tenant with 7-day expiry.

### 8.2 Deliverables

| Step | Deliverable | Owner | Duration |
|---|---|---|---|
| 1 | LOAD_TEST tenant provisioned + synthetic 50k customer seed | agent-data | 2 days |
| 2 | k6 load-test JWT issuance script + load-test API key per M1.2 | agent-integration | 1 day |
| 3 | Run each scenario in isolation against staging (alerts_list / streaming_ingest / customer_360 / feature_snapshot / scenario_run / reports_run) | SRE | 3 days |
| 4 | Tune thresholds per scenario based on observed p95 — update `docs/slos.md` if observed p95 < 800ms isn't realistic for any route | SRE | 1 day |
| 5 | **Green-light gate: run `pilot_5x_mix.js` for 15 minutes against staging** | SRE | 0.5 day |
| 6 | Capture Grafana metrics during the run: per-pod CPU / mem / HPA scaling events / Aurora reader CPU + IO / MSK broker disk pressure | SRE | continuous |
| 7 | 10× stretch test (identify saturation point) | SRE | 0.5 day |
| 8 | Capacity recommendations + cost projection for tenant 2-5 (does the current sizing cover 5 tenants? when does Aurora reader autoscale fire?) | SRE | 1 day |
| 9 | Production tuning — Aurora reader pool size / EKS node group min-replicas / Karpenter weights / MSK partition counts | SRE | 2 days |

### 8.3 Validation gate

- `pilot_5x_mix.js` passes all thresholds (15-minute green-light gate per `docs/charter.md` Year-2 success criterion).
- BFF p95 < 800ms across the mix.
- Aurora reader CPU avg < 60% (HPA threshold per T4.4); no pod CPU > 80%.
- Karpenter scales up at peak and down within 5 minutes after load drops.
- Streaming latency post-run: `target_p95_60s_met=true` over the 15-minute window.

### 8.4 Risk + rollback

- **Risk:** 10× stretch reveals a saturation point at 7-8× — production isn't comfortably headroomed for 2-3 BIL-tier banks. **Mitigation:** Up-size Aurora writer + readers; over-provision EKS nodes; revisit MSK partition count.
- **Risk:** k6 load test against staging accidentally hits production Bank API (network misconfig). **Mitigation:** Pre-flight check: confirm `BFF_BASE_URL` points to staging; bank API in staging routes to a dedicated bank-side test environment.
- **Rollback:** k6 run can be Ctrl-C'd; the load-test JWT auto-expires; the LOAD_TEST tenant is purged via `docs/data-lineage.md` § right-to-be-forgotten procedure.

---

## 9. Track 9 — Go-live (tenant cutover + steady-state)

**Owner:** CTO + CISO + Risk-Ops manager (sign-off) · **Duration:** 2 weeks · **Blocks:** —

### 9.1 Prerequisites — the hard gates

All five gates must be GREEN simultaneously:

| Gate | Reference | Owner |
|---|---|---|
| (a) Pentest clean — zero unremediated Critical | Track 7.3 + `docs/pentest-remediation-playbook.md` | CISO |
| (b) DR game-day Green | `docs/dr-game-day-plan.md` § quarterly | SRE lead |
| (c) 5× load-test passes | Track 8.3 | SRE lead |
| (d) ISO 27001:2022 Stage-1 audit passed | external auditor + `docs/compliance-mapping.md` | CISO + Legal |
| (e) Steering committee sign-off | `docs/charter.md` § governance | Steering chair (CTO) |

### 9.2 Deliverables

| Step | Deliverable | Owner | Duration |
|---|---|---|---|
| 1 | Steering committee go-live review meeting | Steering chair | 1 day |
| 2 | First-tenant cutover plan signed (BIL pilot; per-tenant flag flip from `INTEGRATION_MODE=stub` → `live`) | CTO + bank-IT lead | 1 day |
| 3 | On-call rota active (per `docs/on-call-rota.md` Mon 09:00 IST rotation; +1 manager-on-call during go-live week) | SRE lead | continuous |
| 4 | Tenant-1 cutover — flip BIL to live integration mode; soak for 48h with double-staffed on-call | CTO + CISO | 2 days |
| 5 | Customer notification + welcome email + onboarding session | Risk-Ops manager | 1 day |
| 6 | Hypercare week — daily 09:00 stand-up; T+7 retro; T+14 first BAU monthly checklist | CTO + SRE + Risk-Ops | 1 week |
| 7 | Year-2 backlog kickoff — first refinement session per `docs/year-2-backlog.md` themes | Steering chair | 0.5 day |

### 9.3 Validation gate

- Tenant-1 (BIL) is in production with `INTEGRATION_MODE=live` for ≥ 24 hours.
- All docs/slos.md tier-1 SLOs green over the soak window.
- Zero P0 / P1 incidents during the hypercare week.
- Tenant-1 stakeholder sign-off email captured in `docs/charter.md` § governance acceptance log.
- DR game-day audit + ISO 27001 Stage-1 audit report archived to the audit S3 bucket (Object Lock COMPLIANCE).

### 9.4 Risk + rollback

- **Risk:** P0 in hypercare week reveals an undetected bug not caught by pentest / load test (e.g. tenant-isolation flaw). **Mitigation:** Per `docs/risk-register.md` R-003 — instant rollback to `INTEGRATION_MODE=stub`; statement of position to bank IT lead within 1 hour; remediate + retest before re-cutover.
- **Risk:** Bank-side change (their CBS upgrade) breaks our integration during hypercare. **Mitigation:** Bank IT pre-coordination during go-live week (no upstream changes); freeze window per `docs/bau-runbook.md` § quarterly review.
- **Rollback:** Per-tenant integration-mode flag → stub. Tenant continues to receive synthetic data + the SPA stays functional but stale. Full per-tenant rollback in < 30 seconds (M13.1 admin config flip).

---

## 10. Cross-cutting tracks

These run continuously across every track.

### 10.1 Secrets management

| Item | Mechanism | Rotation cadence |
|---|---|---|
| Aurora master password | Secrets Manager + ESO | quarterly via `docs/bau-runbook.md` § monthly |
| JWT signing key (RS256) | Secrets Manager + KMS-encrypted | annually + immediately on suspected compromise |
| Bank API credentials (CBS / IFRS9 / AML / Bureau) | Secrets Manager + ESO; per-tenant | quarterly (or per bank contract) |
| Vendor API keys (Anthropic / SES / Africa's Talking / FCM / APNS / PagerDuty / Slack / DefectDojo / Grafana / GitHub) | per `docs/vendor-accounts.md` | per-vendor cadence (mostly quarterly) |
| Service-account API keys (M1.2 `apex_<prefix>.<secret>`) | Aurora `app_iam.service_clients` | per quarterly access review per `docs/access-review-evidence-log.md` |
| Webhook subscription secrets (HMAC-SHA256) | Aurora `app_bff.webhook_subscriptions` | per partner contract |

### 10.2 IAM (humans)

| Role | Scope | Provisioned via |
|---|---|---|
| admin | every operation per `infra/rbac/matrix.json` | IAM Identity Center → ZorEWS admin group |
| supervisor | per matrix | IAM Identity Center → supervisor group |
| risk_analyst | per matrix | IAM Identity Center → risk_analyst group |
| collection_officer | per matrix | IAM Identity Center → collection_officer group |
| field_officer | per matrix | IAM Identity Center → field_officer group (mobile-only access via Track 6) |

Quarterly access review per `docs/access-review-evidence-log.md` — first formal run T+90+1day (i.e. Q3 2026 cycle).

### 10.3 Compliance

| Framework | Stage | Calendar |
|---|---|---|
| ISO 27001:2022 | Stage-1 readiness audit | T+8w (gate for Track 9) |
| ISO 27001:2022 | Stage-2 certification audit | T+20w (post-launch) |
| ISO 27001:2022 | Annual surveillance audit | T+1yr |
| RBI Cyber Resilience Framework | Self-assessment + filing | annually Q1 |
| IRDAI Information Security | Self-assessment + filing | annually Q4 |
| DPA 2019 | Annual audit-trail review | annually Q2 |

### 10.4 Cost envelope (steady-state, single-tenant production)

| Line | Monthly | Notes |
|---|---|---|
| AWS — Aurora Multi-AZ writer + 2 readers | $4,500 | t4g.xlarge baseline |
| AWS — Aurora Global secondary region | $1,500 | warm standby |
| AWS — MSK 3-broker | $2,200 | kafka.m5.large |
| AWS — EKS + Karpenter spot/on-demand mix | $3,500 | scales with HPA |
| AWS — S3 (audit Object Lock + raw + curated) | $400 | 7-year retention on audit |
| AWS — CloudWatch + X-Ray | $300 | 1% sampling |
| AWS — ALB + WAF + CloudFront | $500 | |
| AWS — KMS + Secrets Manager | $200 | |
| AWS — Data transfer (intra-region + outbound) | $400 | |
| AWS — Backup vault + cross-region replication | $300 | |
| AWS — Bedrock if T2.9 NL→SQL flips on (deferred) | $0 (until enabled) | |
| Third-party — PagerDuty | $250 | $21/user × 12 |
| Third-party — Slack Business+ | $300 | $15/user × 20 |
| Third-party — Grafana (self-hosted in EKS) | $0 | bundled in EKS line |
| Third-party — DefectDojo (self-hosted) | $0 | |
| Third-party — Anthropic Claude (T2.9 stub) | $0 (until prod) | $1,500 cap when enabled |
| Third-party — SES + Africa's Talking + FCM/APNS | $500 | per `docs/vendor-accounts.md` caps |
| **Subtotal AWS** | **~$13,800** | |
| **Subtotal third-party** | **~$1,050** | |
| **Per-tenant subtotal** | **~$14,850/mo** | |
| One-time — pentest | $80k | annually |
| One-time — DR game-day | $5k | quarterly |
| One-time — ISO 27001:2022 Stage-2 cert | $40k | T+20w |

Multi-tenant amortisation: Aurora + MSK + EKS scale sublinearly. 5-tenant projection: ~$25k/mo total (~$5k/tenant — 3× efficiency vs single-tenant).

### 10.5 Observability — hard rules

- Every public route emits `http_req_duration_seconds` + `http_req_total{status}`.
- Every cross-service call propagates `X-Request-ID` + OpenTelemetry trace context.
- Every audit-relevant action writes to `audit.event_log` via the M15.1 hash-chain.
- Every retry / circuit-breaker event (per `cbs_production.ts` ResilientCbsClient) emits a structured log line + Prom metric.
- Every Kafka emit-failure → DLQ write + Prom counter increment.
- Every BFF route's tenant_id is in the trace + log; cross-tenant correlation forbidden.

### 10.6 Deployment hardening — hard rules

- Production deploy = manual ArgoCD sync only (auto-sync forbidden).
- Every prod deploy requires 2-person review (one engineer + CISO OR CTO) on the PR.
- Hotfix path: same PR review, manual ArgoCD sync, mandatory post-incident review within 7 days.
- Schema migrations are forward-compatible only (BACKWARD-compat in Glue Schema Registry; column-add-only in pg; no DROP COLUMN without a 2-deploy migration).
- No commits to main without `services-ci.yml` + `schema-compat.yml` + `terraform-ci.yml` + `rbac-matrix.yml` + `security-scan.yml` all green.

---

## 11. Critical-path Gantt

```
Week:        1   2   3   4   5   6   7   8   9   10  11  12  13
T1 AWS       ▓▓▓▓▓▓▓▓▓
T2 Data      ░░▓▓▓▓▓▓▓▓▓▓▓▓
T3 EKS       ░▓▓▓▓▓▓▓▓▓
T4 Bank API           ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
T5 Observ              ░░▓▓▓▓▓▓▓▓▓
T6 Mobile    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
T7 Pentest                       ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
T8 Load                          ▓▓▓▓▓▓▓▓▓
T9 Go-live                                       ▓▓▓▓▓▓
```

▓ = active · ░ = ramp-up dependency · empty = not started

**Critical path:** T1 → T2 → T4 → T7 → T9 = 3 + 4 + 6 + 5 + 2 = 20 weeks raw — **compressed to 13 weeks by parallelisation** (T6 and T3 run in parallel with T1+T2; T5 starts during T3; T8 starts during T7).

---

## 12. Go / no-go decision matrix

Steering committee meets at T+11w to decide go-live for tenant-1.

| Criterion | Go (green) | No-go (red) | Conditional (amber) |
|---|---|---|---|
| Pentest | Zero unremediated Critical | Any unremediated Critical | High findings open > 30 days but with CISO risk acceptance |
| DR game-day | Green per `docs/dr-game-day-plan.md` rubric | Red or Marginal | Marginal — re-run within 7 days |
| 5× load test | `pilot_5x_mix.js` passes all thresholds | Any threshold fail | One threshold fail but capacity plan documented |
| ISO 27001 Stage-1 | Audit passed | Audit failed | Conditional pass with corrective actions ≤ 60 days |
| Bank integration | E2E test 50 customers green for 3 consecutive days | Any tier-1 SLO red | Tier-2 issue with documented mitigation |
| Steering sign-off | All 5 signatures captured | Any opposition | Conditional with risk-acceptance log entry |

**3+ amber = no-go.** Roll back to T+11w + remediate.

---

## 13. Appendix — open work tracker (post-launch, not blocking go-live)

These items don't gate go-live but should be picked up in the first 90 days post-launch:

| Item | Source | Track |
|---|---|---|
| Airflow DAG calling `dbt run --select feat_values_backfill` daily | T2.1.3 Year-2 Theme E | post-launch |
| S3 offline-store sync for >24mo historical feature data | T2.1.3 Year-2 Theme E | post-launch |
| `ml/data/load_from_mart.py` swap to `as_of_date`-parameterised SELECT | T2.1.3 Year-2 Theme E | post-launch |
| MSK monitoring dashboards for DLQ depth + consumer lag | T2.12.2 Year-2 Theme D | post-launch (Track 5 stretch) |
| BFF routes for AML correlation (`POST /v1/aml/correlate/:match_id`) | T3.3.1 | post-launch |
| SPA per-customer-360 AML correlation panel | T3.3.1 | post-launch |
| Mobile screens (LoginScreen + AlertListScreen + CaseDetailScreen + ActionCaptureScreen) | T4.3.2 | merged into Track 6 |
| k6 nightly CI run with 7-day baseline regression Slack alert | T4.5.1 Year-2 | post-launch |
| T6 BIL platform expansion — remaining ~88 sub-phases | per `docs/year-2-backlog.md` Theme B | post-launch (~16-22 weeks at sustained pace) |
| Continuous-learning Airflow DAG calling `train_pd.py` quarterly | T5.1 Year-2 Theme E | post-launch |
| Real-time Kafka producer for indicator-update streaming (operational wire-up) | T2.12.2 Year-2 Theme D | post-launch |

---

**End of roadmap.** Next steering review: T+30d to validate Track 1 + Track 3 progress + early Track 4 bank-side prerequisites. Calendar invite + agenda will go out 5 business days ahead.
