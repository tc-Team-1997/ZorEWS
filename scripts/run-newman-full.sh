#!/usr/bin/env bash
# scripts/run-newman-full.sh
#
# Runs newman against the ENTIRE Postman collection set (all 774 ops, not
# just the smoke folders). Slow (~2-5 min). Many requests will return
# 401/403/404 because the env doesn't have test-tenant-specific resource
# ids — the per-request smoke assertion ("documented status range") still
# passes because every BFF route returns the proper error envelope.
#
# Use this AFTER `newman:smoke` is green to spot any route that returns
# unexpected status codes or response shapes.
#
# Outputs:
#   reports/newman/<Tag>-full.json   per-collection full-run JSON
#
# Usage:
#   npm run newman:full

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

NEWMAN="${REPO_ROOT}/node_modules/.bin/newman"
ENV="${REPO_ROOT}/docs/postman/local.postman_environment.json"
REPORT_DIR="${REPO_ROOT}/reports/newman"

if [ ! -x "$NEWMAN" ]; then
    echo "✕ newman not installed. Run: npm install"
    exit 1
fi

if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:8084/healthz 2>/dev/null | grep -q "^200$"; then
    echo "✕ BFF not reachable on :8084. Run: make up"
    exit 1
fi

mkdir -p "$REPORT_DIR"

TOTAL_REQUESTS=0
TOTAL_ASSERTS=0
TOTAL_FAILED=0

# Step 1: capture an auth token by running the Auth smoke folder first.
# Subsequent collections will inherit access_token from the env file's
# in-memory state — but newman by default starts with a fresh env each run.
# We use --export-environment to persist + --environment to re-import.

ENV_RUNNING="${REPORT_DIR}/.env-running.json"
cp "$ENV" "$ENV_RUNNING"

echo "▶ Step 1/2 — capture auth token via Auth smoke folder"
"$NEWMAN" run "$REPO_ROOT/docs/postman/ZorEWS-Auth.postman_collection.json" \
    -e "$ENV_RUNNING" \
    --folder "00 — Smoke tests" \
    --export-environment "$ENV_RUNNING" \
    --reporters cli \
    --reporter-cli-no-banner \
    --color off

echo ""
echo "▶ Step 2/2 — full-collection runs (one collection at a time)"

for COL in "$REPO_ROOT"/docs/postman/ZorEWS-*.postman_collection.json; do
    TAG=$(basename "$COL" .postman_collection.json | sed 's/ZorEWS-//')
    echo ""
    echo "  — $TAG (full)"

    "$NEWMAN" run "$COL" \
        -e "$ENV_RUNNING" \
        --reporters json \
        --reporter-json-export "$REPORT_DIR/${TAG}-full.json" \
        --color off \
        --timeout-request 5000 \
        --bail false 2>&1 | tail -1 || true

    if [ -f "$REPORT_DIR/${TAG}-full.json" ]; then
        REQS=$(python3 -c "import json; print(json.load(open('$REPORT_DIR/${TAG}-full.json'))['run']['stats']['requests']['total'])" 2>/dev/null || echo 0)
        ASRT=$(python3 -c "import json; print(json.load(open('$REPORT_DIR/${TAG}-full.json'))['run']['stats']['assertions']['total'])" 2>/dev/null || echo 0)
        FAIL=$(python3 -c "import json; print(json.load(open('$REPORT_DIR/${TAG}-full.json'))['run']['stats']['assertions']['failed'])" 2>/dev/null || echo 0)
        TOTAL_REQUESTS=$((TOTAL_REQUESTS + REQS))
        TOTAL_ASSERTS=$((TOTAL_ASSERTS + ASRT))
        TOTAL_FAILED=$((TOTAL_FAILED + FAIL))
        printf "    %4d requests · %4d asserts · %4d failed\n" "$REQS" "$ASRT" "$FAIL"
    fi
done

rm -f "$ENV_RUNNING"

echo ""
echo "============================================================"
echo "TOTAL: ${TOTAL_REQUESTS} requests · $((TOTAL_ASSERTS - TOTAL_FAILED))/${TOTAL_ASSERTS} assertions · ${TOTAL_FAILED} failed"
echo "Reports: ${REPORT_DIR}/*-full.json"
echo "============================================================"
