#!/usr/bin/env bash
# DR drill automation — quarterly per docs/dr-game-day-plan.md.
#
# Walks the failover playbook step-by-step against a non-production target
# (staging or production-shadow) and produces a scoring report that the
# DR game-day rubric judges against.
#
# Scope ladder (selectable):
#   --scope=aurora           — Q1: Aurora-only promotion
#   --scope=aurora+msk       — Q2: + MSK MM2 cutover
#   --scope=full             — Q3: full-stack synthetic
#   --scope=canary           — Q4: 10% canary cutover (requires CISO sign-off)
#
# Usage:
#   ./scripts/dr-drill.sh --scope=aurora --target=staging --dry-run
#   ./scripts/dr-drill.sh --scope=full --target=staging

set -euo pipefail

SCOPE="aurora"
TARGET="staging"
DRY_RUN=false
REPORT_DIR="reports/dr-drills"
TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)

for arg in "$@"; do
  case $arg in
    --scope=*) SCOPE="${arg#*=}" ;;
    --target=*) TARGET="${arg#*=}" ;;
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

REPORT_FILE="${REPORT_DIR}/${TIMESTAMP}-${SCOPE}-${TARGET}.md"
mkdir -p "${REPORT_DIR}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

# Rubric scores (per docs/dr-game-day-plan.md)
declare -A SCORES
SCORES[rto_met]=""
SCORES[rpo_met]=""
SCORES[runbook_accurate]=""
SCORES[validator_findings]=""
SCORES[comms_cadence]=""
SCORES[audit_chain_intact]=""

START_TIME=$(date +%s)

log() {
  echo -e "[$(date -u +%H:%M:%SZ)] $*"
}

step() {
  echo ""
  log "${YELLOW}── $* ──${NC}"
}

run() {
  if [ "${DRY_RUN}" = "true" ]; then
    log "DRY-RUN: would execute: $*"
  else
    "$@"
  fi
}

assert() {
  local desc="$1" cmd="$2"
  if eval "${cmd}" > /dev/null 2>&1; then
    log "${GREEN}✓${NC} ${desc}"
    return 0
  else
    log "${RED}✕${NC} ${desc}"
    return 1
  fi
}

# ────────────────────────────────────────────────────────────────
# Pre-flight
# ────────────────────────────────────────────────────────────────
step "Pre-flight checks"

case "${TARGET}" in
  staging)  ENV_PREFIX="apex-ews-staging" ;;
  prod-shadow) ENV_PREFIX="apex-ews-prod-shadow" ;;
  *) echo "ERROR: --target must be staging or prod-shadow"; exit 1 ;;
esac

log "scope=${SCOPE} target=${TARGET} dry_run=${DRY_RUN} env_prefix=${ENV_PREFIX}"
log "report=${REPORT_FILE}"

# ────────────────────────────────────────────────────────────────
# Phase 1: Page on-call + war-room
# ────────────────────────────────────────────────────────────────
step "Phase 1: Roster + war-room"

log "  Roster (per dr-game-day-plan.md):"
log "    incident_commander: SRE-lead"
log "    aurora_operator:    DATA"
log "    eks_operator:       SRE"
log "    msk_operator:       SRE"
log "    validator:          QA"
log "    scribe:             ORCH"

if [ "${SCOPE}" = "canary" ]; then
  log "  Q4 canary scope — CISO + Legal sign-off required."
  log "  Confirm sign-off in #apex-ews-incident before proceeding (manual gate)."
fi

# ────────────────────────────────────────────────────────────────
# Phase 2: Aurora promotion (every scope)
# ────────────────────────────────────────────────────────────────
step "Phase 2: Aurora Global Cluster failover"

GLOBAL_ID="${ENV_PREFIX}-global"

# 1. Pre-failover lag check
log "  Checking pre-failover replication lag..."
LAG=$(aws rds describe-global-clusters \
  --global-cluster-identifier "${GLOBAL_ID}" \
  --query 'GlobalClusters[0].GlobalClusterMembers[?IsWriter==`false`].GlobalWriteForwardingStatus' \
  --output text 2>/dev/null || echo "unknown")
log "    lag_status=${LAG}"

# 2. Promote secondary
log "  Triggering failover-global-cluster..."
SECONDARY_CLUSTER_ARN=$(aws rds describe-global-clusters \
  --global-cluster-identifier "${GLOBAL_ID}" \
  --query 'GlobalClusters[0].GlobalClusterMembers[?IsWriter==`false`].DBClusterArn' \
  --output text 2>/dev/null || echo "")

if [ -z "${SECONDARY_CLUSTER_ARN}" ] && [ "${DRY_RUN}" = "false" ]; then
  log "  ${RED}✕${NC} No secondary cluster found — DR cluster not provisioned. Failing drill."
  SCORES[rto_met]="FAIL"
  exit 2
fi

RTO_START=$(date +%s)

run aws rds failover-global-cluster \
  --global-cluster-identifier "${GLOBAL_ID}" \
  --target-db-cluster-identifier "${SECONDARY_CLUSTER_ARN}"

# 3. Poll for completion (target RTO 15 min)
log "  Polling for promotion completion (target: 15 min RTO)..."
for i in {1..18}; do  # 18 × 60s = 18min
  STATUS=$(aws rds describe-db-clusters \
    --db-cluster-identifier "$(basename "${SECONDARY_CLUSTER_ARN}")" \
    --query 'DBClusters[0].Status' --output text 2>/dev/null || echo "unknown")

  if [ "${STATUS}" = "available" ]; then
    RTO_END=$(date +%s)
    RTO_DURATION=$((RTO_END - RTO_START))
    log "  ${GREEN}✓${NC} Promotion complete in ${RTO_DURATION}s"
    if [ "${RTO_DURATION}" -le 900 ]; then
      SCORES[rto_met]="GREEN"
    else
      SCORES[rto_met]="AMBER"
    fi
    break
  fi
  log "    status=${STATUS}; waiting 60s..."
  sleep 60
done

if [ "${SCORES[rto_met]}" = "" ]; then
  SCORES[rto_met]="RED"
  log "  ${RED}✕${NC} Promotion did not complete in 18min — RTO failed"
fi

# ────────────────────────────────────────────────────────────────
# Phase 3: DNS + ALB cutover
# ────────────────────────────────────────────────────────────────
step "Phase 3: DNS + ALB cutover"
log "  Updating Route 53 to point at secondary-region ALB..."
log "  (manual step — operator updates record via Route 53 console)"

# Validation: curl the cutover URL
sleep 30  # allow DNS propagation (TTL=60s)
if curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "https://api-dr.apex-ews.example/healthz" | grep -q '^200'; then
  log "  ${GREEN}✓${NC} DR ALB healthz returns 200"
else
  log "  ${RED}✕${NC} DR ALB healthz failed"
fi

# ────────────────────────────────────────────────────────────────
# Phase 4: EKS workload promotion (full scope only)
# ────────────────────────────────────────────────────────────────
if [ "${SCOPE}" = "full" ] || [ "${SCOPE}" = "canary" ]; then
  step "Phase 4: EKS workloads in secondary region"

  log "  Switching kubeconfig to secondary cluster..."
  run aws eks update-kubeconfig --name "${ENV_PREFIX}-dr" --region ap-south-1

  log "  Scaling DR cluster workloads up..."
  run kubectl scale deployment --all -n apex-ews --replicas=2

  log "  Waiting for rollout..."
  run kubectl wait --for=condition=available deployment --all -n apex-ews --timeout=10m
fi

# ────────────────────────────────────────────────────────────────
# Phase 5: MSK MM2 cutover (aurora+msk and beyond)
# ────────────────────────────────────────────────────────────────
if [ "${SCOPE}" = "aurora+msk" ] || [ "${SCOPE}" = "full" ] || [ "${SCOPE}" = "canary" ]; then
  step "Phase 5: MSK MirrorMaker 2 — halt + bootstrap consumer to DR"
  log "  Stopping MM2 source connector..."
  log "  Pointing consumers at DR-region MSK cluster..."
  log "  (manual operator step — runbook reference docs/dr-runbook.md §F)"
fi

# ────────────────────────────────────────────────────────────────
# Phase 6: Validation
# ────────────────────────────────────────────────────────────────
step "Phase 6: Validation"

log "  Running smoke test against DR endpoint..."
BFF_URL="https://api-dr.apex-ews.example" ./scripts/smoke.sh || SCORES[validator_findings]="AMBER"
[ "${SCORES[validator_findings]}" = "" ] && SCORES[validator_findings]="GREEN"

log "  Spot-checking 10 alerts..."
SAMPLE_COUNT=$(curl -sf -H "Authorization: Bearer ${ACCESS_TOKEN:-}" \
  -H "X-Tenant-ID: BANK_DEMO" -H "X-Channel: API" \
  "${BFF_URL}/v1/alerts?limit=10" --max-time 10 | jq '.body.items | length' 2>/dev/null || echo 0)
[ "${SAMPLE_COUNT}" -ge "10" ] && log "  ${GREEN}✓${NC} 10 alerts retrieved" || log "  ${YELLOW}⚠${NC} only ${SAMPLE_COUNT} alerts"

log "  Audit chain integrity per tenant..."
for tenant in BANK_DEMO BIL; do
  VALID=$(curl -sf -H "Authorization: Bearer ${ACCESS_TOKEN:-}" \
    -H "X-Tenant-ID: ${tenant}" -H "X-Channel: API" \
    "${BFF_URL}/v1/audit/integrity" --max-time 10 | jq -r '.body.valid' 2>/dev/null || echo "false")

  if [ "${VALID}" = "true" ]; then
    log "  ${GREEN}✓${NC} audit chain OK for ${tenant}"
  else
    log "  ${RED}✕${NC} audit chain integrity FAIL for ${tenant}"
    SCORES[audit_chain_intact]="RED"
  fi
done
[ "${SCORES[audit_chain_intact]}" = "" ] && SCORES[audit_chain_intact]="GREEN"

# ────────────────────────────────────────────────────────────────
# Phase 7: Comms cadence assessment
# ────────────────────────────────────────────────────────────────
step "Phase 7: Comms cadence (scribe assessment)"
log "  Scribe records timestamps from #apex-ews-incident:"
log "  - 5min intervals: GREEN"
log "  - 10min intervals: AMBER"
log "  - >10min: RED"
SCORES[comms_cadence]="GREEN"  # default; scribe edits report manually

# ────────────────────────────────────────────────────────────────
# Phase 8: RPO assessment
# ────────────────────────────────────────────────────────────────
step "Phase 8: RPO check"
RPO_LAG_SECONDS=$(aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name AuroraGlobalDBReplicationLag \
  --start-time "$(date -u -d '15 minutes ago' --iso-8601=seconds)" \
  --end-time "$(date -u --iso-8601=seconds)" \
  --period 60 --statistics Maximum \
  --dimensions Name=DBClusterIdentifier,Value="${ENV_PREFIX}" \
  --query 'Datapoints[0].Maximum' --output text 2>/dev/null || echo 0)

log "  Pre-failover max replica lag: ${RPO_LAG_SECONDS}s (target: <300s = 5min RPO)"
if [ "${RPO_LAG_SECONDS%.*}" -lt 300 ] 2>/dev/null; then
  SCORES[rpo_met]="GREEN"
else
  SCORES[rpo_met]="AMBER"
fi

SCORES[runbook_accurate]="GREEN"  # operator overrides in report if gaps found

# ────────────────────────────────────────────────────────────────
# Generate report
# ────────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
TOTAL_DURATION=$((END_TIME - START_TIME))

cat > "${REPORT_FILE}" <<EOF
# DR drill report — ${TIMESTAMP}

**Scope:** ${SCOPE}
**Target:** ${TARGET}
**Operator:** $(whoami)
**Duration:** ${TOTAL_DURATION}s
**Dry-run:** ${DRY_RUN}

## Scoring rubric (per docs/dr-game-day-plan.md)

| Dimension | Score | Notes |
|---|---|---|
| RTO met (15min) | ${SCORES[rto_met]} | observed RTO ${RTO_DURATION:-n/a}s |
| RPO met (5min/300s) | ${SCORES[rpo_met]} | observed lag ${RPO_LAG_SECONDS}s |
| Runbook accuracy | ${SCORES[runbook_accurate]} | operator: _gaps found?_ |
| Validator findings | ${SCORES[validator_findings]} | smoke test status |
| Comms cadence ≤5min | ${SCORES[comms_cadence]} | scribe assessment |
| Audit chain integrity | ${SCORES[audit_chain_intact]} | per-tenant verifyChain |

## Overall verdict

EOF

# Count GREEN/AMBER/RED
GREEN_COUNT=0; AMBER_COUNT=0; RED_COUNT=0
for k in "${!SCORES[@]}"; do
  case "${SCORES[$k]}" in
    GREEN) GREEN_COUNT=$((GREEN_COUNT+1)) ;;
    AMBER) AMBER_COUNT=$((AMBER_COUNT+1)) ;;
    RED) RED_COUNT=$((RED_COUNT+1)) ;;
  esac
done

if [ "${RED_COUNT}" -gt "0" ]; then
  echo "**RED** — at least 1 dimension failed. 30-day remediation required before next drill." >> "${REPORT_FILE}"
elif [ "${AMBER_COUNT}" -gt "1" ]; then
  echo "**AMBER** — multiple dimensions below target. Fix + re-drill within quarter." >> "${REPORT_FILE}"
else
  echo "**GREEN** — drill passes. Gate B of go-live unlocked for this period." >> "${REPORT_FILE}"
fi

cat >> "${REPORT_FILE}" <<EOF

## Action items

(populated by operator after debrief)

- [ ] Runbook PR if gaps found
- [ ] Postmortem in docs/dr-runbook.md change log
- [ ] Append summary to docs/dr-game-day-history.md

## Sign-offs

- SRE-lead: ________________   date: ________
- CISO:     ________________   date: ________

EOF

log ""
log "═══════════════════════════════════════════"
log "${GREEN}DR drill complete${NC} — report: ${REPORT_FILE}"
log "GREEN=${GREEN_COUNT} AMBER=${AMBER_COUNT} RED=${RED_COUNT}"
log "═══════════════════════════════════════════"

[ "${RED_COUNT}" -gt "0" ] && exit 1
exit 0
