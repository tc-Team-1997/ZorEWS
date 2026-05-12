# ZorEWS — Bootstrap & Verify

> Run these commands in a normal macOS/Linux terminal (the agent sandbox couldn't execute them). Order matters — later steps depend on earlier outputs. Stop at the first failure and check `logs/<agent>.md` for that agent.

## 0. Prereqs (one-time)

```bash
# Toolchain
brew install python@3.12 node@20 terraform docker awscli postgresql@16 libomp
# `libomp` is required by xgboost on macOS arm64 — without it the wheel imports but throws at fit time.

# Optional: dbt-postgres in a venv
python3 -m venv .venv && source .venv/bin/activate
pip install "dbt-postgres==1.8.*" "pandas" "numpy" "scikit-learn" "xgboost" "shap" "joblib" "fastapi" "uvicorn" "pyarrow" "pytest" "sqlalchemy>=2.0" "psycopg2-binary"
```

`sqlalchemy` + `psycopg2-binary` are needed by `ml/data/load_from_mart.py` (step 4 alt path).

## 1. Generate full synthetic seed data (agent-data)

```bash
cd /Users/taniya/apex-ews/data/dbt/seeds
python3 _generate_seeds.py     # ~220 customers, ~520 loans, ~6000 txns, ~6% NPA
```

## 2. Bring up Postgres + apply schema (agent-data)

```bash
cd /Users/taniya/apex-ews/data/schema
make up                         # docker run apex-ews-pg (postgres:16) on :55432
make migrate                    # 001..011 SQL — full app schema
make verify                     # row counts + audit-trigger smoke
```

**Connection details for any client (DBeaver / TablePlus / pgAdmin / VS Code):**

| Field | Value |
|-------|-------|
| Host | `localhost` |
| Port | `55432` |
| Database | `apex_ews` |
| User | `apex` |
| Password | `apex` |
| URL | `postgres://apex:apex@localhost:55432/apex_ews` |

**Apply migrations 012-015 + load 26k synthetic operator rows + 8 CMS demo cases:**

```bash
# 012-015 weren't part of `make migrate` — apply them manually:
for f in 012_ews_rules.sql 013_cms_cases.sql 014_copilot_audit.sql 015_ews_rules_versions.sql; do
  PGPASSWORD=apex psql -h localhost -p 55432 -U apex -d apex_ews -v ON_ERROR_STOP=1 -f "$f"
done

# Or, if psql isn't on PATH, run via the container:
for f in 012_ews_rules.sql 013_cms_cases.sql 014_copilot_audit.sql 015_ews_rules_versions.sql; do
  docker exec -i apex-ews-pg psql -U apex -d apex_ews -v ON_ERROR_STOP=1 -q < "$f"
done

# 26k synthetic operator rows (users + sessions + audit + cases + alerts + …):
source ../../.venv/bin/activate
python3 _generate_app_seeds.py
docker cp app_seeds.sql apex-ews-pg:/tmp/app_seeds.sql
docker exec -i apex-ews-pg psql -U apex -d apex_ews -v ON_ERROR_STOP=1 -f /tmp/app_seeds.sql

# 10 brief-mandated EWS rules into the BIL tenant:
docker cp seed_ews_rules.sql apex-ews-pg:/tmp/seed_ews_rules.sql
docker exec -i apex-ews-pg psql -U apex -d apex_ews -v ON_ERROR_STOP=1 -f /tmp/seed_ews_rules.sql
```

After this you'll have ~26k application rows across 9 schemas. The BFF additionally seeds 8 demo CMS cases + 10 EWS rules into its in-memory stores at cold start, so even with the database unwired the SPA pages render.

**Wire services to Postgres** (turns on the PG-backed code paths):

```bash
PG=postgres://apex:apex@localhost:55432/apex_ews
CASES_PG_URL=$PG ALERTS_PG_URL=$PG BFF_PG_URL=$PG make up
```

`cases-svc` reads/writes `app_cases.cases`; `alerts-svc` reads/writes `app_alerts.alerts`; the BFF's scenario + webhook stores swap to `app_scenario.saved_scenarios` + `app_bff.webhook_*`. Without these env vars all four are in-memory.

## 3. Run dbt (agent-data)

```bash
cd /Users/taniya/apex-ews/data/dbt
cp profiles.yml.example ~/.dbt/profiles.yml   # adjust host/port
dbt deps && dbt seed && dbt parse && dbt run && dbt test
```
**Expect:** `mart.customer_360`, `mart.loan_360`, `mart.txn_features` materialised; all tests green.

**Required project bits (already in tree — flagged here so re-creation from scratch doesn't trip):**
- `data/dbt/macros/generate_schema_name.sql` — literal-schema override macro. Without it dbt prefixes `<target>_<custom>` and seeds land in `staging_raw` instead of `raw`.
- `data/dbt/packages.yml` uses YAML-list `version:` syntax (required by dbt-1.11; the old single-line string form fails to resolve).
- `data/dbt/models/marts/schema.yml` uses `config: { where: "..." }` instead of `row_condition` on `dbt_utils.accepted_range` tests (`bureau_score`, `exposure_to_income_ratio`, `burn_ratio_30d`). `row_condition` was silently dropped in older dbt and now raises.

## 4. Train the PD model (agent-ai)

```bash
cd /Users/taniya/apex-ews
python ml/data/generate_synthetic.py --out ml/data --n 5000 --seed 42
python ml/pipelines/train_pd.py
# Then promote
python -m ml.registry.cli register --name pd_xgboost --version 0.1.0 --status challenger \
        --metrics-file ml/models/pd/v0.1.0/metrics.json --artifact ml/models/pd/v0.1.0
python -m ml.registry.cli promote --name pd_xgboost --version 0.1.0
cat ml/models/pd/v0.1.0/metrics.json | python -m json.tool
```
**Expect:** `metrics.json.holdout_auc >= 0.78`. Script exits non-zero otherwise.

**`train_pd.py` behaviour to know about:**
- **Version resolution** — by default, if `v<N>` already exists on disk or in `ml/registry/registry.json`, the patch component is auto-bumped (with a warning) and a fresh entry is created. Pass `--overwrite` for the old in-place behaviour.
- **Low-positive auto-profile** — when the training set has <20 positives the script switches to `min_child_weight=1`, `n_estimators=300`, and isotonic→sigmoid calibration. Triggered automatically on small mart pulls.

**Optional — train against the dbt mart instead of synthetic data:**

```bash
python ml/data/load_from_mart.py --start 2026-04-27 --end 2026-04-27
python ml/pipelines/train_pd.py
```

`ml/data/load_from_mart.py` projects mart columns into the contracted feature names: `worst_dpd → dpd_max_90d`, `exposure_to_income_ratio → utilization`, `arrears_repayment_count → repayment_delay_streak`, `tenure_months` derived from `customer_360.onboarded_at`, `txn_volume_zscore_90d` derived population-wise from `txn_features`, `loan_360.product_code` mapped to `PRODUCT_LEVELS`, `monthly_income` banded to `INCOME_LEVELS`, `has_npa::int → defaulted_within_60d`.

**⚠️ Leakage caveat on the mart-trained model:** in the current 220-customer seed, `mart.customer_360.has_npa` is by-construction co-linear with the `dpd_max_90d` feature (both derive from `days_past_due`), so the mart-trained challenger lands at AUC=1.0. Don't quote that as a quality signal — the synthetic-trained 0.8822 model remains champion. To get an honest mart-split AUC, either (a) decouple `has_npa` from DPD or (b) bump `data/dbt/seeds/_generate_seeds.py:N_CUSTOMERS` from 220 to a few thousand.

## 5. ai-copilot-svc tests (agent-ai)

```bash
cd services/ai-copilot-svc
pytest -q
```

## 6. Rule engine simulator (agent-rule)

```bash
cd /Users/taniya/apex-ews/services/regulatory-svc/rules
npm install
npm run gen-history             # writes 12 months of synthetic indicator history (input for simulate)
npm run simulate                # writes rules/sim/report.json with empirical FP rates
npm test                        # Jest — DSL, lifecycle, simulator
```
**Expect:** mean FP ≤ 25% across the 30 seed rules; Jest green.

## 7. auth-svc + audit-svc (agent-integration)

```bash
cd /Users/taniya/apex-ews/services/auth-svc
npm install && npm test
cd ../audit-svc
# audit-svc has no requirements.txt — run from the project venv set up in step 0
# (which already has fastapi/uvicorn/pytest). If you're outside the venv:
#   pip install fastapi uvicorn pytest
pytest -q
```

## 8. Web SPA (agent-ui)

```bash
cd /Users/taniya/apex-ews/web
npm install
npx msw init public/ --save     # generates public/mockServiceWorker.js (required — main.tsx calls worker.start() in DEV when MSW is on)
npm run build          # vite build (also runs tsc --noEmit — there is no separate `typecheck` script)
npm test               # vitest
npm run dev            # http://localhost:5173 — log in with alice.admin / Admin!Pass1 (TOTP from auth-svc seed)
```

The `mockServiceWorker.js` step is easy to miss — vitest+jsdom never exercises MSW's service-worker registration, so the test suite stays green even when the file is absent, but the SPA bundle never mounts in the browser because `worker.start()` throws.

**To switch the SPA from MSW to the live BFF / auth-svc:**

```bash
cat > web/.env.development.local <<'EOF'
VITE_USE_MSW=false
VITE_API_BASE_URL=/
EOF
make web-dev
```

`vite.config.ts` proxies `/api/*` and `/v1/*` to BFF (`:8084`) and `/auth/*` to auth-svc (`:8080`), so the SPA hits same-origin and CORS isn't a problem. To go back to the offline MSW demo, delete `web/.env.development.local`. **Also keep `make up` running in another shell** — the SPA expects all 7 services up; check with `make smoke`.

## 9. Terraform (agent-integration) — fmt + validate only, no apply

```bash
cd /Users/taniya/apex-ews/infra/terraform
terraform fmt -recursive .
for layer in 00-landing-zone 10-network 20-eks 30-data 40-edge; do
  pushd "$layer" >/dev/null
  terraform init -backend=false -input=false
  terraform validate
  popd >/dev/null
done
```

## 10. Update STATUS.md

After steps 1–9 pass, edit `STATUS.md` KPI snapshot with measured numbers:
- PD model AUC (holdout) — from `ml/models/pd/v0.1.0/metrics.json`.
- Rules live — count of `live` files in `rules/seed/` after promotion.
- Empirical mean FP from `rules/sim/report.json`.
- `npm test` / `pytest` / `terraform validate` all green → tick the verification checklist.

## What is NOT verified by this bootstrap

- Real AWS deploy (Terraform `apply`) — out of prototype scope.
- Real CBS/IFRS9/AML/Collection integrations — only OpenAPI mocks at `integrations/<sys>/openapi.yaml`.
- DR drill, pen-test, ISO 27001 audit — Phase 5 items, deferred.
- Mobile app build — RN shell only ships in Phase 4.
