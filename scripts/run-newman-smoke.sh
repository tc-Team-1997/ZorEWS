#!/usr/bin/env bash
# scripts/run-newman-smoke.sh
#
# Runs newman against each of the 10 Postman collections' "00 — Smoke tests"
# folder. Fast (<5s total) — happy-path + 1-2 negative tests per collection.
# Suitable as a CI gate after `make up`.
#
# Outputs:
#   reports/newman/<Tag>.json   per-collection summary report (newman JSON)
#
# Usage:
#   npm run newman:smoke
#
# Prerequisites:
#   - Local stack up: `make up`
#   - Postman artefacts generated: `npm run postman:generate`
#   - newman installed: `npm install` (devDep at repo root)

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
if [ ! -f "$ENV" ]; then
    echo "✕ environment missing. Run: npm run postman:generate"
    exit 1
fi

# Verify the local stack is up
if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:8084/healthz 2>/dev/null | grep -q "^200$"; then
    echo "✕ BFF not reachable on :8084. Run: make up"
    exit 1
fi

mkdir -p "$REPORT_DIR"

TOTAL_REQUESTS=0
TOTAL_ASSERTS=0
TOTAL_FAILED=0

for COL in "$REPO_ROOT"/docs/postman/ZorEWS-*.postman_collection.json; do
    TAG=$(basename "$COL" .postman_collection.json | sed 's/ZorEWS-//')
    echo ""
    echo "▶ $TAG — Smoke tests"

    "$NEWMAN" run "$COL" \
        -e "$ENV" \
        --folder "00 — Smoke tests" \
        --reporters cli,json \
        --reporter-json-export "$REPORT_DIR/${TAG}.json" \
        --reporter-cli-no-banner \
        --color off \
        --timeout-request 5000 || true

    if [ -f "$REPORT_DIR/${TAG}.json" ]; then
        REQS=$(python3 -c "import json; print(json.load(open('$REPORT_DIR/${TAG}.json'))['run']['stats']['requests']['total'])" 2>/dev/null || echo 0)
        ASRT=$(python3 -c "import json; print(json.load(open('$REPORT_DIR/${TAG}.json'))['run']['stats']['assertions']['total'])" 2>/dev/null || echo 0)
        FAIL=$(python3 -c "import json; print(json.load(open('$REPORT_DIR/${TAG}.json'))['run']['stats']['assertions']['failed'])" 2>/dev/null || echo 0)
        TOTAL_REQUESTS=$((TOTAL_REQUESTS + REQS))
        TOTAL_ASSERTS=$((TOTAL_ASSERTS + ASRT))
        TOTAL_FAILED=$((TOTAL_FAILED + FAIL))
    fi
done

echo ""
echo "============================================================"
echo "TOTAL: ${TOTAL_REQUESTS} requests · $((TOTAL_ASSERTS - TOTAL_FAILED))/${TOTAL_ASSERTS} assertions · ${TOTAL_FAILED} failed"
echo "Reports written to: ${REPORT_DIR}"
echo "============================================================"

if [ "$TOTAL_FAILED" -gt 0 ]; then
    exit 1
fi
exit 0
