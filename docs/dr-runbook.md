# ZorEWS — Disaster Recovery Runbook

**Owner:** agent-integration · **Audience:** SRE on-call + Risk-IT lead · **Last reviewed:** 2026-05-20

> Companion to `dr-game-day-plan.md`. This document covers FAILOVER procedures; the game-day doc covers the rehearsal cadence + scoring rubric.

---

## 1. RTO / RPO targets

| Tier | Component | RTO | RPO | Notes |
|---|---|---|---|---|
| 0 | Aurora (Global DB) | **15 min** | **5 min** | Manual region promotion via console + Terraform `aws_rds_cluster` `failover_global_cluster` arg. |
| 0 | Audit S3 (Object Lock COMPLIANCE) | **N/A** | **0** | CRR keeps the secondary in sync; failover is a DNS swap on `audit.ews.example`. |
| 1 | MSK (Kafka topics) | **30 min** | **2 min** | MM2 lag is the canonical RPO metric (CloudWatch `kafka.ReplicationLatency`). Promote consumers to the secondary cluster's bootstrap brokers. |
| 1 | EKS workloads | **60 min** | **0** (stateless) | All services + BFF are stateless; rolling promotion via the secondary-region Helm install. |
| 2 | Glue Schema Registry | **120 min** | **0** | Re-create from `infra/schema-registry/` checked-in JSON. |
| 2 | Reporting S3 (raw, curated) | **240 min** | **15 min** | CRR replication interval — RPO loosened intentionally since reporting is reconstructable from raw. |

**Composite tenant-facing SLO** during DR: 99.0% (drops from 99.5% steady-state). Reset to 99.5% once failover is validated.

---

## 2. Failover decision tree

Triggering criteria — Risk-IT lead OR SRE-on-call decides:

1. **Primary region (af-south-1) hard-down** for > 10 min (no CloudWatch heartbeat from any AZ).
2. **Aurora writer unreachable** for > 5 min AND no Multi-AZ recovery in flight.
3. **MSK cluster degraded** to single-broker for > 15 min with no recovery ETA from AWS support.
4. **Regional regulatory action** (RBI / IRDAI) requiring traffic isolation — escalation handled by CISO + Legal, not on-call.

**Do NOT failover for:**
- Single-AZ degradation (Multi-AZ handles it).
- Application-layer bugs (roll back the deploy instead).
- Single tenant under attack (use tenant-level disable via `app_iam.tenants.active=false`).

---

## 3. Failover procedure (Aurora Global DB → secondary region)

**Pre-flight (≤ 2 min):**
1. Page Risk-IT lead + CISO + compliance-on-call via PagerDuty `apex-ews-critical`.
2. Open the DR-WAR-ROOM Slack channel.
3. Snapshot the current SLO state in Grafana (record incident timestamp + last-known-good RPO).
4. Verify the secondary region's Aurora cluster is in `Active` state with replication lag < 60s (CloudWatch `AuroraGlobalDBReplicationLag`).

**Step 1 — Aurora promotion (≤ 5 min):**
```bash
# From the SRE jumphost (not laptop — needs IRSA + KMS access)
aws rds failover-global-cluster \
  --global-cluster-identifier apex-ews-prod-global \
  --target-db-cluster-identifier arn:aws:rds:ap-south-1:<acct>:cluster:apex-ews-prod-aurora-secondary
```
Wait for `aws rds describe-global-clusters` to return `status=available` AND the target cluster to flip to `is-writer=true`.

**Step 2 — DNS swap (≤ 2 min):**
Update Route53 alias for `db.ews.example` to point at the new writer endpoint. TTL=30s means caches clear in ≤ 60s.

**Step 3 — EKS workloads (≤ 30 min):**
1. Scale up the secondary-region EKS node groups via Karpenter (or `kubectl scale --replicas=N`).
2. Apply Helm releases targeting secondary endpoints: `helm upgrade --install -n apex-ews -f values-dr.yaml`.
3. Verify each service's `/healthz` returns 200 + DB connectivity smoke.
4. Update BFF + auth-svc env vars: `BFF_PG_URL` + `AUTH_SVC_PG_URL` + `CASES_PG_URL` + `ALERTS_PG_URL` → secondary writer.

**Step 4 — MSK promotion (≤ 30 min):**
1. Halt MirrorMaker 2 (`systemctl stop mm2` on MM2 jumphost or scale-to-zero in the MM2 EKS namespace).
2. Promote secondary MSK cluster: confirm `ActiveControllerCount=1`.
3. Update consumer bootstrap brokers in app config to `b-1.apex-ews-prod-msk-secondary.kafka.ap-south-1.amazonaws.com:9098`.
4. Restart consumer pods.

**Step 5 — Validation (≤ 15 min):**
- Run `make smoke` against the secondary region (services should all return 200).
- Spot-check 10 alerts via `GET /v1/alerts` — confirm freshness.
- Verify hash-chain integrity via `GET /v1/audit/integrity` — chain must be intact (Object Lock + CRR preserve it).
- Confirm webhook subscriptions still fire (`POST /v1/webhooks/:id/test`).

**Step 6 — Externalise:**
- StatusPage incident update: "ZorEWS failed over to secondary region. Tenant-facing impact: <X minutes>. RPO observed: <Y minutes>."
- Email regulator-contact list (RBI + IRDAI) — required per BAC-A manual §4.2.3.

---

## 4. Failback procedure (return to primary)

Failback is more dangerous than failover (you're abandoning a working setup). DO NOT failback during a regulator-mandated lockout. Target window: weekend maintenance, low-traffic.

1. Wait until primary region has been stable for ≥ 24h.
2. Reverse-replicate: promote primary as the new Aurora Global DB target.
3. Repeat steps 2-5 above with primary endpoints.
4. Run a 1-hour shadow-write soak before flipping DNS.

---

## 5. Post-incident actions (within 5 business days)

- **Blameless postmortem** with Risk-IT, SRE, CISO. Template at `docs/postmortem-template.md` (to be authored).
- **RPO/RTO audit:** did we meet targets? Where did we miss?
- **CRR lag review:** S3 bucket-level metrics for the failover window.
- **Schema-chain validation:** re-run `python infra/schema-registry/scripts/check_compat.py` against any post-failover schema diff.
- **Audit-trail backfill:** if any audit events were written during failover-in-flight that didn't make CRR, re-emit them with `recovered=true` metadata.

---

## 6. References

- `docs/architecture.md` — primary + secondary region topology.
- `docs/dr-game-day-plan.md` — quarterly drill cadence + rubric.
- `docs/bau-runbook.md` — steady-state operations.
- `docs/slos.md` — SLI/SLO/error-budget definitions.
- `docs/compliance-mapping.md` — DPA 2019 + ISO 27001 controls touched by DR.
- `infra/terraform/30-data/global.tf` — Aurora Global DB + S3 CRR + MSK MirrorMaker 2 IaC.
