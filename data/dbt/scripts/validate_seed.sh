#!/usr/bin/env bash
# T2.1.3 — dbt seed + run validation harness.
#
# Validates the 10k-customer seed lands the expected mart row counts +
# the new feature_store backfill model materialises. Used by the
# follow-up open task in TASKS.md ("dbt seed + run against the 10k-
# customer seed").
#
# Prerequisites:
#   - apex-ews-pg container running on :55432 (make up)
#   - Migrations applied through 034_feature_store.sql (make migrate)
#   - dbt-postgres installed in the project venv
#
# Usage:
#   data/dbt/scripts/validate_seed.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DBT_DIR="$REPO_ROOT/data/dbt"

echo "▶ Activating venv..."
source "$REPO_ROOT/.venv/bin/activate"

cd "$DBT_DIR"

echo "▶ Step 1/4: dbt deps"
dbt deps

echo "▶ Step 2/4: dbt seed --full-refresh"
dbt seed --full-refresh

echo "▶ Step 3/4: dbt run"
dbt run

echo "▶ Step 4/4: dbt test"
dbt test

echo ""
echo "▶ Row-count validation:"

# Connect via DSN — matches what dbt itself uses from ~/.dbt/profiles.yml.
PSQL="psql postgres://apex:apex@localhost:55432/apex_ews"

# Each pair is (table_name, expected_row_count_lower_bound).
# Lower bound because the synthesiser is deterministic but minor seed
# regeneration can shift counts by ±5%.
declare -A CHECKS=(
    ["raw.seed_customer"]=9500
    ["raw.seed_loans"]=22000
    ["raw.seed_repayments"]=240000
    ["raw.seed_txns"]=280000
    ["raw.seed_bureau_score"]=9500
    ["mart.customer_360"]=9500
    ["mart.loan_360"]=22000
    ["mart.txn_features"]=9500
    ["mart.indicator_values"]=70000
)

PASS=0
FAIL=0
for tbl in "${!CHECKS[@]}"; do
    expected="${CHECKS[$tbl]}"
    count=$($PSQL -t -A -c "SELECT count(*) FROM $tbl" 2>/dev/null | tr -d ' \n' || echo "0")
    if (( count >= expected )); then
        printf "  ✓ %-30s %s rows (>= %s)\n" "$tbl" "$count" "$expected"
        PASS=$((PASS+1))
    else
        printf "  ✕ %-30s %s rows (expected >= %s)\n" "$tbl" "$count" "$expected"
        FAIL=$((FAIL+1))
    fi
done

# Feature store materialisation check.
FS_COUNT=$($PSQL -t -A -c "SELECT count(*) FROM feature_store.feat_values_backfill" 2>/dev/null | tr -d ' \n' || echo "0")
if (( FS_COUNT >= 60000 )); then
    printf "  ✓ %-30s %s rows (>= 60000)\n" "feature_store.feat_values_backfill" "$FS_COUNT"
    PASS=$((PASS+1))
else
    printf "  ✕ %-30s %s rows (expected >= 60000)\n" "feature_store.feat_values_backfill" "$FS_COUNT"
    FAIL=$((FAIL+1))
fi

echo ""
if (( FAIL == 0 )); then
    echo "✅ All $PASS row-count checks passed."
    exit 0
else
    echo "❌ $FAIL of $((PASS+FAIL)) checks failed."
    exit 1
fi
