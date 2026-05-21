#!/usr/bin/env bash
# Infrastructure health check — runs in BAU daily checklist + after every
# infrastructure change. Walks every AWS-side production-readiness row from
# docs/operationalization/readiness-checklists.md §2.

set -euo pipefail

ENV="${ENV:-prod}"
REGION="${REGION:-af-south-1}"
NAME_PREFIX="${NAME_PREFIX:-apex-ews}"
CLUSTER_NAME="${NAME_PREFIX}-${ENV}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

PASS=0; FAIL=0
fail() { echo -e "  ${RED}✕${NC} $1"; FAIL=$((FAIL+1)); }
pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }

heading() { echo ""; echo "── $1 ──"; }

# ────────────────────────────────────────────────────────────────
heading "VPC + network"

VPC_ID=$(aws ec2 describe-vpcs --region "${REGION}" \
  --filters "Name=tag:Name,Values=${NAME_PREFIX}-${ENV}" \
  --query 'Vpcs[0].VpcId' --output text)

[ "${VPC_ID}" != "None" ] && pass "VPC ${VPC_ID}" || fail "VPC not found"

SUBNETS=$(aws ec2 describe-subnets --region "${REGION}" \
  --filters "Name=vpc-id,Values=${VPC_ID}" \
  --query 'length(Subnets)' --output text)
[ "${SUBNETS}" -ge 9 ] && pass "9+ subnets (have ${SUBNETS})" || fail "Only ${SUBNETS} subnets (expected 9+)"

NAT_COUNT=$(aws ec2 describe-nat-gateways --region "${REGION}" \
  --filter "Name=vpc-id,Values=${VPC_ID}" "Name=state,Values=available" \
  --query 'length(NatGateways)' --output text)
[ "${NAT_COUNT}" -ge 3 ] && pass "${NAT_COUNT} NAT gateways available" || fail "Only ${NAT_COUNT} NAT gateways"

# ────────────────────────────────────────────────────────────────
heading "VPN to bank"

VPN_TUNNELS_UP=$(aws ec2 describe-vpn-connections --region "${REGION}" \
  --filters "Name=tag:Name,Values=${NAME_PREFIX}-bank-vpn" \
  --query 'VpnConnections[0].VgwTelemetry[?Status==`UP`] | length(@)' --output text 2>/dev/null || echo 0)

if [ "${VPN_TUNNELS_UP}" = "2" ]; then
  pass "Both VPN tunnels UP"
elif [ "${VPN_TUNNELS_UP}" = "1" ]; then
  echo -e "  ${YELLOW}⚠${NC} Only 1 VPN tunnel UP — investigate"
elif [ "${VPN_TUNNELS_UP}" = "0" ]; then
  fail "Both VPN tunnels DOWN — INTEGRATIONS_MODE fallback engaged"
else
  echo -e "  ${YELLOW}⚠${NC} No VPN configured yet (pre-T4-P1)"
fi

# ────────────────────────────────────────────────────────────────
heading "Aurora"

AURORA_STATUS=$(aws rds describe-db-clusters --region "${REGION}" \
  --db-cluster-identifier "${NAME_PREFIX}-${ENV}" \
  --query 'DBClusters[0].Status' --output text 2>/dev/null || echo "missing")

[ "${AURORA_STATUS}" = "available" ] && pass "Aurora cluster available" || fail "Aurora status=${AURORA_STATUS}"

AURORA_MEMBERS=$(aws rds describe-db-clusters --region "${REGION}" \
  --db-cluster-identifier "${NAME_PREFIX}-${ENV}" \
  --query 'length(DBClusters[0].DBClusterMembers)' --output text 2>/dev/null || echo 0)
[ "${AURORA_MEMBERS}" -ge 3 ] && pass "${AURORA_MEMBERS} cluster members (writer + readers)" \
  || fail "Only ${AURORA_MEMBERS} cluster members"

AURORA_ENCRYPTED=$(aws rds describe-db-clusters --region "${REGION}" \
  --db-cluster-identifier "${NAME_PREFIX}-${ENV}" \
  --query 'DBClusters[0].StorageEncrypted' --output text 2>/dev/null || echo "false")
[ "${AURORA_ENCRYPTED}" = "True" ] && pass "Aurora encrypted at rest" || fail "Aurora NOT encrypted"

# Backup retention
BACKUP_RETENTION=$(aws rds describe-db-clusters --region "${REGION}" \
  --db-cluster-identifier "${NAME_PREFIX}-${ENV}" \
  --query 'DBClusters[0].BackupRetentionPeriod' --output text 2>/dev/null || echo 0)
[ "${BACKUP_RETENTION}" -ge 30 ] && pass "Aurora backup retention ${BACKUP_RETENTION}d (≥30d)" \
  || fail "Aurora backup retention only ${BACKUP_RETENTION}d (expected ≥30d)"

# ────────────────────────────────────────────────────────────────
heading "MSK"

MSK_STATE=$(aws kafka list-clusters --region "${REGION}" \
  --cluster-name-filter "${NAME_PREFIX}" \
  --query 'ClusterInfoList[0].State' --output text 2>/dev/null || echo "missing")
[ "${MSK_STATE}" = "ACTIVE" ] && pass "MSK cluster ACTIVE" || fail "MSK state=${MSK_STATE}"

MSK_ARN=$(aws kafka list-clusters --region "${REGION}" \
  --cluster-name-filter "${NAME_PREFIX}" \
  --query 'ClusterInfoList[0].ClusterArn' --output text 2>/dev/null || echo "")

if [ -n "${MSK_ARN}" ] && [ "${MSK_ARN}" != "None" ]; then
  IAM_AUTH=$(aws kafka describe-cluster --cluster-arn "${MSK_ARN}" --region "${REGION}" \
    --query 'ClusterInfo.ClientAuthentication.Sasl.Iam.Enabled' --output text 2>/dev/null || echo "false")
  [ "${IAM_AUTH}" = "True" ] && pass "MSK IAM auth enabled" || fail "MSK IAM auth disabled"
fi

# ────────────────────────────────────────────────────────────────
heading "S3 audit bucket — Object Lock"

OBJECT_LOCK=$(aws s3api get-object-lock-configuration \
  --bucket "${NAME_PREFIX}-audit-logs" \
  --query 'ObjectLockConfiguration.ObjectLockEnabled' --output text 2>/dev/null || echo "missing")

[ "${OBJECT_LOCK}" = "Enabled" ] && pass "S3 audit bucket Object Lock enabled" \
  || fail "S3 audit bucket Object Lock NOT enabled"

LOCK_MODE=$(aws s3api get-object-lock-configuration \
  --bucket "${NAME_PREFIX}-audit-logs" \
  --query 'ObjectLockConfiguration.Rule.DefaultRetention.Mode' --output text 2>/dev/null || echo "")

[ "${LOCK_MODE}" = "COMPLIANCE" ] && pass "Object Lock mode COMPLIANCE" \
  || fail "Object Lock mode is ${LOCK_MODE} (expected COMPLIANCE)"

PUBLIC_BLOCK=$(aws s3api get-public-access-block \
  --bucket "${NAME_PREFIX}-audit-logs" \
  --query 'PublicAccessBlockConfiguration.BlockPublicAcls && PublicAccessBlockConfiguration.BlockPublicPolicy && PublicAccessBlockConfiguration.IgnorePublicAcls && PublicAccessBlockConfiguration.RestrictPublicBuckets' \
  --output text 2>/dev/null || echo "false")

[ "${PUBLIC_BLOCK}" = "True" ] && pass "S3 audit bucket all-public-blocked" \
  || fail "S3 audit bucket public-block incomplete"

# ────────────────────────────────────────────────────────────────
heading "EKS cluster + Karpenter"

EKS_STATUS=$(aws eks describe-cluster --name "${CLUSTER_NAME}" --region "${REGION}" \
  --query 'cluster.status' --output text 2>/dev/null || echo "missing")
[ "${EKS_STATUS}" = "ACTIVE" ] && pass "EKS cluster ACTIVE" || fail "EKS status=${EKS_STATUS}"

EKS_ENDPOINT_PUBLIC=$(aws eks describe-cluster --name "${CLUSTER_NAME}" --region "${REGION}" \
  --query 'cluster.resourcesVpcConfig.endpointPublicAccess' --output text 2>/dev/null || echo "true")
[ "${EKS_ENDPOINT_PUBLIC}" = "False" ] && pass "EKS endpoint private" \
  || echo -e "  ${YELLOW}⚠${NC} EKS endpoint is PUBLIC (acceptable if restricted by source IP)"

# Karpenter — check pod is running
KARPENTER_PODS=$(kubectl get pods -n karpenter -l app.kubernetes.io/name=karpenter --no-headers 2>/dev/null | grep Running | wc -l | xargs)
[ "${KARPENTER_PODS}" -ge 1 ] && pass "Karpenter pods Running (${KARPENTER_PODS})" \
  || fail "No Karpenter pods Running"

KARPENTER_NODEPOOLS=$(kubectl get nodepools --no-headers 2>/dev/null | wc -l | xargs)
[ "${KARPENTER_NODEPOOLS}" -ge 2 ] && pass "${KARPENTER_NODEPOOLS} Karpenter NodePools" \
  || fail "Only ${KARPENTER_NODEPOOLS} NodePools"

# ────────────────────────────────────────────────────────────────
heading "GuardDuty + Security Hub + Config"

GD_STATUS=$(aws guardduty list-detectors --region "${REGION}" \
  --query 'length(DetectorIds)' --output text 2>/dev/null || echo 0)
[ "${GD_STATUS}" -ge 1 ] && pass "GuardDuty detector active" || fail "No GuardDuty detector"

SH_STATUS=$(aws securityhub describe-hub --region "${REGION}" 2>/dev/null && echo "enabled" || echo "disabled")
[ "${SH_STATUS}" = "enabled" ] && pass "Security Hub enabled" || fail "Security Hub not enabled"

CONFIG_RECORDER=$(aws configservice describe-configuration-recorder-status --region "${REGION}" \
  --query 'ConfigurationRecordersStatus[0].recording' --output text 2>/dev/null || echo "false")
[ "${CONFIG_RECORDER}" = "True" ] && pass "AWS Config recording" \
  || echo -e "  ${YELLOW}⚠${NC} AWS Config recorder not active (set var.enable_aws_config=true)"

# ────────────────────────────────────────────────────────────────
heading "KMS rotation"

for alias in apex-ews-aurora apex-ews-msk apex-ews-s3 apex-ews-secrets apex-ews-audit; do
  ROTATION=$(aws kms get-key-rotation-status --region "${REGION}" \
    --key-id "alias/${alias}" \
    --query 'KeyRotationEnabled' --output text 2>/dev/null || echo "missing")
  [ "${ROTATION}" = "True" ] && pass "KMS ${alias} rotation enabled" \
    || fail "KMS ${alias} rotation status=${ROTATION}"
done

# ────────────────────────────────────────────────────────────────
heading "ALB + WAF"

WAF_ID=$(aws wafv2 list-web-acls --scope REGIONAL --region "${REGION}" \
  --query "WebACLs[?Name=='${NAME_PREFIX}-${ENV}'].Id | [0]" --output text 2>/dev/null || echo "")
[ -n "${WAF_ID}" ] && [ "${WAF_ID}" != "None" ] && pass "WAF Web ACL attached" || fail "WAF Web ACL missing"

# ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "Infra health: ${GREEN}PASS=${PASS}${NC} ${RED}FAIL=${FAIL}${NC}"
echo "═══════════════════════════════════════════"

[ "${FAIL}" -gt 0 ] && exit 1 || exit 0
