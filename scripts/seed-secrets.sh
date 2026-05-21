#!/usr/bin/env bash
# Bootstrap AWS Secrets Manager with every secret the ExternalSecret
# manifests in infra/k8s/external-secrets/*.yaml expect to find.
#
# IDEMPOTENT — uses `create-secret` then catches AlreadyExistsException
# and switches to `update-secret`. Re-runnable safely.
#
# Usage:
#   ENV=prod ./scripts/seed-secrets.sh                # production
#   ENV=staging DRY_RUN=true ./scripts/seed-secrets.sh # dry-run staging
#
# Each secret value is sourced from:
#   - env-var (highest precedence; CI runners pass them in)
#   - openssl rand -hex (for new random secrets like JWT_KID)
#   - prompt (interactive fallback when terminal is attached)
#   - REFUSE (for secrets that MUST come from operator manually, e.g.
#     vendor API keys that already exist out-of-band)

set -euo pipefail

ENV="${ENV:-prod}"
REGION="${REGION:-af-south-1}"
KMS_KEY_ID="${KMS_KEY_ID:-alias/apex-ews-secrets}"
DRY_RUN="${DRY_RUN:-false}"
NAME_PREFIX="apex-ews/${ENV}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

# Manifest of every secret the ESO manifests expect (mapped to source).
# Format: <secrets-manager-key>:<source>
#
# source options:
#   env:<VAR_NAME>     — read from env var (preferred for CI runners)
#   rand:<bytes>       — generate via openssl rand -hex
#   refuse             — must be operator-provided out-of-band; script
#                        prints WARN and skips create
#   prompt             — interactive read
SECRETS=(
  # BFF
  "bff/pg-url:env:BFF_PG_URL"
  "bff/anthropic-api-key:refuse"            # T0.6 vendor account, operator-provisioned
  "bff/kafka-brokers:env:KAFKA_BROKERS"
  "bff/jwks-url:env:BFF_JWKS_URL"
  "bff/cases-url:env:APEX_CASES_URL"

  # auth-svc — JWT signing keys generated locally then uploaded
  "auth-svc/pg-url:env:AUTH_SVC_PG_URL"
  "auth-svc/jwt-private-key:rand:keypair"   # generates RS256 keypair
  "auth-svc/jwt-public-key:keypair_public"  # paired with above
  "auth-svc/jwt-kid:rand:16"

  # audit-svc
  "audit-svc/pg-url:env:AUDIT_SVC_PG_URL"

  # regulatory-svc family
  "regulatory-svc-cases/pg-url:env:CASES_PG_URL"
  "regulatory-svc-cases/audit-url:env:APEX_AUDIT_URL"
  "regulatory-svc-alerts/pg-url:env:ALERTS_PG_URL"
  "regulatory-svc-alerts/kafka-brokers:env:KAFKA_BROKERS"
  "regulatory-svc-alerts/cases-url:env:APEX_CASES_URL"
  "regulatory-svc-rules/pg-url:env:RULES_PG_URL"
  "regulatory-svc-indicators/pg-url:env:INDICATORS_PG_URL"
  "regulatory-svc-indicators/kafka-brokers:env:KAFKA_BROKERS"

  # notification-svc — vendor accounts per docs/vendor-accounts.md
  "notification-svc/ses-from-address:env:SES_FROM_ADDRESS"
  "notification-svc/at-api-key:refuse"
  "notification-svc/at-username:refuse"
  "notification-svc/fcm-service-account:refuse"
  "notification-svc/apns-key-id:refuse"
  "notification-svc/apns-team-id:refuse"
  "notification-svc/apns-key:refuse"

  # collection-adapter mTLS
  "collection-adapter/cases-url:env:APEX_CASES_URL"
  "collection-adapter/mtls-client-cert:refuse"   # bank-side CA provides
  "collection-adapter/mtls-client-key:refuse"

  # ai-copilot-svc
  "ai-copilot-svc/pg-url:env:AI_COPILOT_PG_URL"
  "ai-copilot-svc/anthropic-api-key:refuse"

  # VPN tunnel PSKs (separate from ESO; consumed by terraform 05-vpn)
  "vpn/tunnel1-psk:rand:32"
  "vpn/tunnel2-psk:rand:32"

  # Smoke-test admin credentials (used by scripts/smoke.sh)
  "admin-smoke-credentials:prompt"
)

GENERATED_KEYS_FILE=""
trap 'rm -f "${GENERATED_KEYS_FILE:-}"' EXIT

put_secret() {
  local key="$1" value="$2"

  if [ "${DRY_RUN}" = "true" ]; then
    echo -e "  ${YELLOW}DRY-RUN${NC} would put ${NAME_PREFIX}/${key} (len=${#value})"
    return 0
  fi

  if aws secretsmanager describe-secret \
       --secret-id "${NAME_PREFIX}/${key}" --region "${REGION}" \
       > /dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --secret-id "${NAME_PREFIX}/${key}" \
      --secret-string "${value}" \
      --region "${REGION}" \
      > /dev/null
    echo -e "  ${GREEN}↻${NC} updated ${NAME_PREFIX}/${key}"
  else
    aws secretsmanager create-secret \
      --name "${NAME_PREFIX}/${key}" \
      --secret-string "${value}" \
      --kms-key-id "${KMS_KEY_ID}" \
      --region "${REGION}" \
      --description "ZorEWS ${ENV} ${key} — managed by scripts/seed-secrets.sh" \
      > /dev/null
    echo -e "  ${GREEN}+${NC} created ${NAME_PREFIX}/${key}"
  fi
}

generate_keypair() {
  # Generate RS256 keypair and stash for the paired call
  GENERATED_KEYS_FILE=$(mktemp)
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${GENERATED_KEYS_FILE}" 2>/dev/null
  openssl rsa -in "${GENERATED_KEYS_FILE}" -pubout -out "${GENERATED_KEYS_FILE}.pub" 2>/dev/null
  cat "${GENERATED_KEYS_FILE}"
}

generated_public() {
  cat "${GENERATED_KEYS_FILE}.pub"
}

resolve_secret_value() {
  local key="$1" source="$2"

  case "${source}" in
    env:*)
      local var_name="${source#env:}"
      local val="${!var_name:-}"
      if [ -z "${val}" ]; then
        echo -e "    ${RED}✕${NC} env var ${var_name} not set — skipping" >&2
        return 1
      fi
      echo "${val}"
      ;;
    rand:keypair)
      generate_keypair
      ;;
    keypair_public)
      if [ ! -f "${GENERATED_KEYS_FILE}.pub" ]; then
        echo -e "    ${RED}✕${NC} keypair_public requested but no prior rand:keypair generated" >&2
        return 1
      fi
      generated_public
      ;;
    rand:*)
      local bytes="${source#rand:}"
      openssl rand -hex "${bytes}"
      ;;
    refuse)
      echo -e "    ${YELLOW}⚠${NC} ${key} — operator must provision out-of-band; skipping" >&2
      return 1
      ;;
    prompt)
      if [ -t 0 ]; then
        echo -n "    Enter value for ${key}: " >&2
        read -rs val
        echo >&2
        if [ -z "${val}" ]; then
          echo -e "    ${RED}✕${NC} empty value — skipping" >&2
          return 1
        fi
        echo "${val}"
      else
        echo -e "    ${RED}✕${NC} ${key} requires interactive prompt — skipping" >&2
        return 1
      fi
      ;;
    *)
      echo -e "    ${RED}✕${NC} unknown source: ${source}" >&2
      return 1
      ;;
  esac
}

echo "════════════════════════════════════════════════════"
echo "Secrets Manager bootstrap for environment=${ENV}"
echo "Region: ${REGION}  KMS: ${KMS_KEY_ID}  Dry-run: ${DRY_RUN}"
echo "════════════════════════════════════════════════════"

# Verify KMS key exists before we start
if [ "${DRY_RUN}" != "true" ]; then
  aws kms describe-key --key-id "${KMS_KEY_ID}" --region "${REGION}" \
    > /dev/null 2>&1 || {
      echo -e "${RED}ERROR: KMS key ${KMS_KEY_ID} not found in ${REGION}.${NC}"
      echo "Run terraform on infra/terraform/00-landing-zone first."
      exit 1
    }
fi

CREATED=0
SKIPPED=0

for entry in "${SECRETS[@]}"; do
  key="${entry%%:*}"
  source="${entry#*:}"

  echo ""
  echo "──  ${key}  ──"

  if value=$(resolve_secret_value "${key}" "${source}" 2>/dev/null); then
    if put_secret "${key}" "${value}"; then
      CREATED=$((CREATED+1))
    else
      SKIPPED=$((SKIPPED+1))
    fi
  else
    resolve_secret_value "${key}" "${source}" 2>&1 | grep -E '✕|⚠' >&2 || true
    SKIPPED=$((SKIPPED+1))
  fi
done

echo ""
echo "════════════════════════════════════════════════════"
echo -e "Created/updated: ${GREEN}${CREATED}${NC}  Skipped: ${YELLOW}${SKIPPED}${NC}"
echo "════════════════════════════════════════════════════"
echo ""

if [ "${SKIPPED}" -gt 0 ]; then
  echo "Skipped secrets need manual provisioning. Source per key:"
  echo "  - 'refuse' = vendor account credentials (see docs/vendor-accounts.md)"
  echo "  - 'prompt' = interactive only (run with TTY)"
  echo "  - 'env:X'  = set X in your shell or CI runner"
  echo ""
  echo "Run again with the missing env vars set, or use:"
  echo "  aws secretsmanager create-secret --name apex-ews/${ENV}/<key> --secret-string <value>"
fi

echo ""
echo "Verify with:"
echo "  aws secretsmanager list-secrets --region ${REGION} \\"
echo "    --filters Key=name,Values=apex-ews/${ENV} \\"
echo "    --query 'SecretList[].Name'"
