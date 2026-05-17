# ZorEWS — Backend Database Schema

**Last updated:** 2026-05-03 (post 10k-scale-up + app schemas)
**Database:** PostgreSQL 16 (local: `zorews-pg` on `:55432`, db `zorews`; production: Aurora PostgreSQL 16 Multi-AZ via `infra/terraform/30-data`)
**Live row count:** ~731,500 across 9 schemas / 26 tables

This document is the canonical reference for every persisted table in the prototype. Source of truth is the SQL + dbt files; this doc is regenerated from those.

## Schema overview

| Layer | Schema | Owner | Purpose | Source |
|---|---|---|---|---|
| Landing zone (synthetic CSVs) | [`raw`](#schema-raw) | dbt seed | 5 tables loaded from `data/dbt/seeds/*.csv`; production target is the cbs_* loader (T1.4b) | [`data/schema/002_raw_tables.sql`](../data/schema/002_raw_tables.sql) + [`data/dbt/seeds/`](../data/dbt/seeds/) |
| Staging (cleaned views) | [`staging`](#schema-staging) | dbt | Type-cast, trimmed, deduped 1:1 with `raw`; views (no storage) | [`data/dbt/models/staging/`](../data/dbt/models/staging/) |
| Mart (business tables) | [`mart`](#schema-mart) | dbt | 360-degree rollups consumed by indicator engine + AI training + UI | [`data/dbt/models/marts/`](../data/dbt/models/marts/) |
| Audit (immutable log) | [`audit`](#schema-audit) | every service (target) | Append-only, hash-chained event log; updates + deletes trigger-blocked | [`data/schema/003_audit_table.sql`](../data/schema/003_audit_table.sql) |
| **Identity + access** | [`app_iam`](#schema-app_iam) | services/auth-svc (target) | Operators, sessions, password history, auth audit | [`data/schema/004_app_schemas.sql`](../data/schema/004_app_schemas.sql) |
| **Case management** | [`app_cases`](#schema-app_cases) | services/regulatory-svc/cases (target) | Case state-machine + action log | [`data/schema/004_app_schemas.sql`](../data/schema/004_app_schemas.sql) |
| **Alerts queue** | [`app_alerts`](#schema-app_alerts) | services/regulatory-svc/alerts (target) | Alert queue + smart-queue assignments | [`data/schema/004_app_schemas.sql`](../data/schema/004_app_schemas.sql) |
| **BFF data** | [`app_bff`](#schema-app_bff) | services/bff (target) | Outbound webhook subscriptions + delivery log | [`data/schema/004_app_schemas.sql`](../data/schema/004_app_schemas.sql) |
| **Scenario simulator** | [`app_scenario`](#schema-app_scenario) | services/bff scenario routes (target) | Saved scenario runs (full result JSONB) | [`data/schema/004_app_schemas.sql`](../data/schema/004_app_schemas.sql) |

> **"target" = these schemas exist + are populated with synthetic data; the listed services don't yet write to them at runtime. Service-wiring is the next session's work — see [database-gap-analysis.md](database-gap-analysis.md).**

## Live row counts (2026-05-03)

| Schema | Table | Rows |
|---|---|---:|
| `raw` | seed_customers | 10,000 |
| `raw` | seed_loans | 24,000 |
| `raw` | seed_repayments | 247,550 |
| `raw` | seed_transactions | 289,819 |
| `raw` | seed_bureau_score | 10,000 |
| `staging` | (5 views — computed on query) | n/a |
| `mart` | customer_360 | 10,000 |
| `mart` | loan_360 | 24,000 |
| `mart` | txn_features | 10,000 |
| `mart` | indicator_values | 80,000 |
| `audit` | event_log | 4 (verify smoke only) |
| `app_iam` | users | 505 |
| `app_iam` | sessions | 3,105 |
| `app_iam` | password_history | 1,445 |
| `app_iam` | audit_events | 12,000 |
| `app_cases` | cases | 528 |
| `app_cases` | actions | 1,568 |
| `app_alerts` | alerts | 2,527 |
| `app_alerts` | queue_assignments | 3,431 |
| `app_bff` | webhook_subscriptions | 25 |
| `app_bff` | webhook_deliveries | 915 |
| `app_scenario` | saved_scenarios | 120 |
| **Total** | | **~731,542** |

**Conventions** that apply across all 9 schemas:

- `customer_id`, `loan_id`, `account_id`, `txn_id`, `repayment_id`, `case_id`, `alert_id`, `user_id`, `subscription_id` are all `TEXT` — opaque identifiers. No numeric autoincrement primary keys for entities.
- `BIGSERIAL` surrogate ids only on append-only event-style tables (sessions, audit, deliveries, password history) where the natural key is "happened then".
- All monetary amounts: `NUMERIC(18,2)` — 18 digits, 2 decimal. Currency is a separate `CHAR(3)` ISO 4217 code, default `'KES'`.
- Timestamps use `TIMESTAMPTZ` everywhere. Dates use `DATE`.
- `JSONB` for free-form payloads (audit detail, webhook delivery payload, saved scenario result, raw payload reservation).
- Cross-schema FKs are NOT declared — services may evolve their own identifiers; intra-schema FKs use `ON DELETE CASCADE` where appropriate (sessions → users, actions → cases, deliveries → subscriptions).
- Indexes only where the access pattern justifies them — added per table.

---

## Schema: `raw`

Landing zone — populated by `dbt seed` from CSVs in [`data/dbt/seeds/`](../data/dbt/seeds/). 5 tables, ~580k total rows. Production target is the CBS-ingest Airflow loader (T1.4b) writing to `raw.cbs_*` — that pipeline is not yet running, so the prototype reads from these `seed_*` tables instead. The `seed_*` → `cbs_*` swap is documented in [`data/dbt/models/sources.yml`](../data/dbt/models/sources.yml).

> **2026-05-03 update:** the previously-defined `raw.cbs_*` tables (5 detailed CDC-shaped tables in [`002_raw_tables.sql`](../data/schema/002_raw_tables.sql)) were dropped because they sat empty for the entire prototype lifecycle. The file now declares only the `seed_*` tables that actually carry data. Original `cbs_*` schemas are preserved in git history for reinstatement when T1.4b ships.

### `raw.seed_customers` (10,000 rows)

Customer master records. PK = `customer_id` (TEXT, format `C00001`).

| Column | Type | Notes |
|---|---|---|
| `source_event_id` | `TEXT` | Format `EV-CUST-<customer_id>`; for idempotent reseeds |
| `customer_id` | `TEXT` | **PK**; format `C00001` |
| `full_name` | `TEXT` | Synthetic — `Customer 00001` |
| `national_id` | `TEXT` | `NID<8 digits>` |
| `date_of_birth` | `DATE` | 1960..2003 |
| `gender` | `TEXT` | `male` / `female` |
| `marital_status` | `TEXT` | `single` / `married` / `divorced` |
| `employment_status` | `TEXT` | `employed` / `self-employed` / `business-owner` / `unemployed` |
| `monthly_income` | `NUMERIC(18,2)` | KES; segment-dependent (retail 15k–90k / sme 180k–750k / corp 700k–3M) |
| `branch_code` | `TEXT` | 7 branches: `NBO-001` / `NBO-002` / `NBO-003` / `MSA-010` / `KSM-020` / `ELD-030` / `NKR-040` |
| `segment` | `TEXT` | `retail` (70%) / `sme` (25%) / `corp` (5%) |
| `onboarded_at` | `TIMESTAMPTZ` | 2018..2025 |
| `kyc_status` | `TEXT` | `verified` (92%) / `pending` (6%) / `rejected` (2%) |
| `risk_rating` | `TEXT` | `low` (60%) / `medium` (30%) / `high` (10%) |
| `payload` | `TEXT` | Reserved for future JSONB upgrade (`'{}'` today) |

### `raw.seed_loans` (24,000 rows)

Loan master snapshots. PK = `loan_id` (`L000001`). FK customer_id → `seed_customers`. ~4.25% NPA ratio (1,019 of 24,000 loans).

| Column | Type | Notes |
|---|---|---|
| `source_event_id` | `TEXT` | `EV-LOAN-<loan_id>` |
| `loan_id` | `TEXT` | **PK**; format `L000001` |
| `customer_id` | `TEXT` | FK → `seed_customers.customer_id` |
| `product_code` | `TEXT` | `PL_RET` / `AUTO_RET` / `WC_SME` / `INV_SME` / `CORP_TL` |
| `currency` | `CHAR(3)` | `KES` |
| `principal_amount` | `NUMERIC(18,2)` | Product-dependent range |
| `outstanding_amount` | `NUMERIC(18,2)` | Tested `≥ 0` in staging |
| `interest_rate` | `NUMERIC(7,4)` | Annualised, decimal (0.1500 = 15%) |
| `tenor_months` | `INTEGER` | 12..84 depending on product |
| `disbursed_at` | `TIMESTAMPTZ` | 2023..2026; dedup tiebreaker (latest wins in staging) |
| `maturity_date` | `DATE` | `disbursed_at + tenor_months × 30 days` |
| `npa_status` | `TEXT` | `PERFORMING` / `WATCH` / `SUBSTANDARD` / `DOUBTFUL` / `LOSS` |
| `days_past_due` | `INTEGER` | 0..720 |
| `last_repayment_at` | `TIMESTAMPTZ` | |
| `collateral_value` | `NUMERIC(18,2)` | NULL for retail loans, present for SME/corp |
| `branch_code` | `TEXT` | inherited from customer |
| `payload` | `TEXT` | reserved |

### `raw.seed_repayments` (~247,550 rows)

Repayment events (one row per receipt). PK = `repayment_id` (`R0000001`). Indexed by loan_id + customer_id + repayment_date.

| Column | Type | Notes |
|---|---|---|
| `source_event_id` | `TEXT` | `EV-REP-<repayment_id>` |
| `repayment_id` | `TEXT` | **PK** |
| `loan_id` | `TEXT` | FK → `seed_loans.loan_id` |
| `customer_id` | `TEXT` | FK → `seed_customers.customer_id` |
| `repayment_date` | `DATE` | Used by 30/60/90-day window aggs |
| `scheduled_amount` | `NUMERIC(18,2)` | EMI / contractual installment |
| `paid_amount` | `NUMERIC(18,2)` | Tested `≥ 0` |
| `principal_paid` | `NUMERIC(18,2)` | |
| `interest_paid` | `NUMERIC(18,2)` | |
| `fees_paid` | `NUMERIC(18,2)` | |
| `currency` | `CHAR(3)` | `KES` |
| `channel` | `TEXT` | `mpesa` / `branch` / `standing-order` / `card` |
| `is_arrears_payment` | `BOOLEAN` | Marks payments made AFTER the contractual due date |
| `payload` | `TEXT` | reserved |

### `raw.seed_transactions` (~289,819 rows)

Account-level transaction events. PK = `txn_id` (`T00000001`). Indexed by `(customer_id, txn_timestamp DESC)` + `txn_category`.

| Column | Type | Notes |
|---|---|---|
| `source_event_id` | `TEXT` | `EV-TXN-<txn_id>` |
| `txn_id` | `TEXT` | **PK** |
| `customer_id` | `TEXT` | FK → `seed_customers.customer_id` |
| `account_id` | `TEXT` | `A<customer_id_suffix>-01` |
| `txn_timestamp` | `TIMESTAMPTZ` | Composite-indexed |
| `txn_type` | `TEXT` | `credit` / `debit` |
| `txn_category` | `TEXT` | `salary` / `mpesa` / `atm` / `pos` / `standing-order` / `loan-disb` / `loan-repay` / `biller` |
| `amount` | `NUMERIC(18,2)` | |
| `currency` | `CHAR(3)` | `KES` |
| `balance_after` | `NUMERIC(18,2)` | |
| `counterparty` | `TEXT` | `CP-<4 digits>` |
| `channel` | `TEXT` | |
| `payload` | `TEXT` | reserved |

### `raw.seed_bureau_score` (10,000 rows — one snapshot per customer)

Bureau (CRB) snapshots. PK = `customer_id`. ~6% defaulted cohort scored 280–520; the rest 540–850.

| Column | Type | Notes |
|---|---|---|
| `source_event_id` | `TEXT` | `EV-BUR-<customer_id>` |
| `customer_id` | `TEXT` | **PK + FK** → `seed_customers.customer_id` |
| `bureau_name` | `TEXT` | `Metropol` / `TransUnion` / `CreditInfo` |
| `score` | `INTEGER` | 200..900 |
| `score_band` | `TEXT` | `A` (≥720) / `B` (600–720) / `C` (500–600) / `D` (400–500) / `E` (<400) |
| `score_as_of` | `DATE` | |
| `delinquencies_12m` | `INTEGER` | 0..2 for performing, 3..9 for defaulted |
| `open_facilities` | `INTEGER` | 1..7 |
| `total_exposure` | `NUMERIC(18,2)` | |
| `enquiries_3m` | `INTEGER` | 0..4 |
| `payload` | `TEXT` | reserved |


## Schema: `staging`

dbt **views** (no storage cost). Read 1:1 from `raw.*`, type-cast, trim, lower/upper as appropriate, dedup. The dedup keeps the row with the latest tiebreaker timestamp (`onboarded_at` for customers, `disbursed_at` for loans, `score_as_of` for bureau).

| View | Source | Dedup tiebreaker | Notes |
|---|---|---|---|
| `staging.stg_customer` | `raw.cbs_customer_profile` | `onboarded_at DESC` | Lower-cases `gender`, `marital_status`, `employment_status`, `kyc_status`, `risk_rating`, `segment` |
| `staging.stg_loans` | `raw.cbs_loans` | `disbursed_at DESC` | Adds `is_npa BOOLEAN` (computed identically to the raw stored column) |
| `staging.stg_repayments` | `raw.cbs_repayments` | none (event log) | Adds `shortfall_amount = GREATEST(scheduled - paid, 0)` |
| `staging.stg_txns` | `raw.cbs_transactions` | none (event log) | Adds `txn_date`, `is_inflow`, `inflow_amount`, `outflow_amount` |
| `staging.stg_bureau_score` | `raw.bureau_score` | `score_as_of DESC` | One row per customer (latest only) |

### `staging.stg_customer`

| Column | Type | Notes |
|---|---|---|
| `customer_id` | `TEXT` | **Unique, not-null** |
| `full_name` | `TEXT` | trimmed, NULLs preserved |
| `national_id` | `TEXT` | |
| `date_of_birth` | `DATE` | |
| `gender` | `TEXT` | `male` / `female` / `other` |
| `marital_status` | `TEXT` | |
| `employment_status` | `TEXT` | |
| `monthly_income` | `NUMERIC(18,2)` | |
| `branch_code` | `TEXT` | |
| `segment` | `TEXT` | |
| `onboarded_at` | `TIMESTAMPTZ` | |
| `kyc_status` | `TEXT` | `verified` / `pending` / `rejected` |
| `risk_rating` | `TEXT` | `low` / `medium` / `high` |

### `staging.stg_loans`

All columns from `raw.cbs_loans` (deduped on `loan_id`) plus:

| Column | Type | Notes |
|---|---|---|
| `is_npa` | `BOOLEAN` | `(npa_status IN ('SUBSTANDARD','DOUBTFUL','LOSS'))` |

`loan_id` is unique-not-null; `customer_id` references `stg_customer.customer_id` (dbt relationships test).

### `staging.stg_repayments`

All columns from `raw.cbs_repayments` plus:

| Column | Type | Notes |
|---|---|---|
| `shortfall_amount` | `NUMERIC(18,2)` | `GREATEST(scheduled_amount - paid_amount, 0)` — useful as a behavioural feature |

`repayment_id` is unique-not-null; `loan_id` references `stg_loans.loan_id`.

### `staging.stg_txns`

All columns from `raw.cbs_transactions` plus:

| Column | Type | Notes |
|---|---|---|
| `txn_date` | `DATE` | `txn_timestamp::date` for window joins |
| `is_inflow` | `BOOLEAN` | `(txn_type = 'credit')` |
| `inflow_amount` | `NUMERIC(18,2)` | `amount` if credit, else `0` |
| `outflow_amount` | `NUMERIC(18,2)` | `amount` if debit, else `0` |

`txn_id` is unique-not-null; `customer_id` references `stg_customer.customer_id`.

### `staging.stg_bureau_score`

One row per customer (the latest score). Columns identical to `raw.bureau_score` minus `payload` and the ingest envelope. `customer_id` is unique-not-null; `score` tested in `[200, 900]`.

---

## Schema: `mart`

dbt **tables** (materialised). The "business" surface — what indicator engines, AI training, the rule engine, and the SPA all read.

| Table | Grain | Refresh |
|---|---|---|
| [`mart.customer_360`](#martcustomer_360) | one row per customer | full rebuild per dbt run |
| [`mart.loan_360`](#martloan_360) | one row per loan | full rebuild per dbt run |
| [`mart.txn_features`](#marttxn_features) | one row per `(customer_id, as_of)` snapshot | snapshot per dbt run; production DAG partitions by `as_of` |
| [`mart.indicator_values`](#martindicator_values) | one row per `(customer_id, snapshot_date, indicator_id)` | per dbt run; covers 8 of 30 catalog indicators (the rest are computed at request-time by `services/regulatory-svc/indicators`) |

### `mart.customer_360`

The single most-read table in the system. Joined from `stg_customer` + aggregates of `stg_loans`, `stg_repayments`, `stg_txns`, `stg_bureau_score`. Drives the Customer Risk Profile UI page, AI/PD training (`ml/data/load_from_mart.py`), and the `services/regulatory-svc/indicators` engine.

| Column | Type | Source | Notes |
|---|---|---|---|
| `customer_id` | `TEXT` | `stg_customer` | **PK in spirit** |
| `full_name` | `TEXT` | `stg_customer` | |
| `segment` | `TEXT` | `stg_customer` | |
| `branch_code` | `TEXT` | `stg_customer` | |
| `kyc_status` | `TEXT` | `stg_customer` | |
| `risk_rating` | `TEXT` | `stg_customer` | |
| `monthly_income` | `NUMERIC(18,2)` | `stg_customer` | Used as the income denominator for ratios |
| `onboarded_at` | `TIMESTAMPTZ` | `stg_customer` | Tenure derived from this in `ml/data/load_from_mart.py` |
| `active_loan_count` | `INTEGER` | `stg_loans` agg | `COUNT(*)` |
| `total_outstanding` | `NUMERIC(18,2)` | `stg_loans` agg | `SUM(outstanding_amount)` |
| `total_disbursed` | `NUMERIC(18,2)` | `stg_loans` agg | `SUM(principal_amount)` |
| `worst_dpd` | `INTEGER` | `stg_loans` agg | `MAX(days_past_due)` — **headline DPD on the Risk Profile** |
| `npa_outstanding` | `NUMERIC(18,2)` | `stg_loans` agg | Sum of `outstanding_amount` where `is_npa` |
| `has_npa` | `BOOLEAN` | `stg_loans` agg | `BOOL_OR(is_npa)` — **co-linear with `worst_dpd > 0` in the synthetic seed; documented leakage caveat in BOOTSTRAP §4** |
| `last_disbursed_at` | `TIMESTAMPTZ` | `stg_loans` agg | |
| `last_repayment_at` | `TIMESTAMPTZ` | coalesce(`stg_loans`, `stg_repayments`) | |
| `repayment_count_lifetime` | `INTEGER` | `stg_repayments` agg | |
| `arrears_repayment_count` | `INTEGER` | `stg_repayments` agg | Count where `is_arrears_payment` |
| `lifetime_shortfall` | `NUMERIC(18,2)` | `stg_repayments` agg | `SUM(shortfall_amount)` |
| `lifetime_inflow` | `NUMERIC(18,2)` | `stg_txns` agg | |
| `lifetime_outflow` | `NUMERIC(18,2)` | `stg_txns` agg | |
| `last_txn_at` | `TIMESTAMPTZ` | `stg_txns` agg | |
| `bureau_score` | `INTEGER` | `stg_bureau_score` | |
| `bureau_score_band` | `TEXT` | `stg_bureau_score` | |
| `bureau_as_of` | `DATE` | `stg_bureau_score` | |
| `delinquencies_12m` | `INTEGER` | `stg_bureau_score` | |
| `open_facilities` | `INTEGER` | `stg_bureau_score` | |
| `enquiries_3m` | `INTEGER` | `stg_bureau_score` | |
| `exposure_to_income_ratio` | `NUMERIC` | derived | `ROUND(total_outstanding / monthly_income, 4)`; NULL when income is 0 or NULL |
| `as_of` | `TIMESTAMPTZ` | `current_timestamp` | When the dbt run produced this row |

### `mart.loan_360`

| Column | Type | Source | Notes |
|---|---|---|---|
| `loan_id` | `TEXT` | `stg_loans` | **PK in spirit** |
| `customer_id` | `TEXT` | `stg_loans` | |
| `segment` | `TEXT` | join `stg_customer` | |
| `branch_code` | `TEXT` | join `stg_customer` | |
| `product_code` | `TEXT` | `stg_loans` | |
| `currency` | `CHAR(3)` | `stg_loans` | |
| `principal_amount` | `NUMERIC(18,2)` | `stg_loans` | |
| `outstanding_amount` | `NUMERIC(18,2)` | `stg_loans` | |
| `interest_rate` | `NUMERIC(7,4)` | `stg_loans` | |
| `tenor_months` | `INTEGER` | `stg_loans` | |
| `disbursed_at` | `TIMESTAMPTZ` | `stg_loans` | |
| `maturity_date` | `DATE` | `stg_loans` | |
| `npa_status` | `TEXT` | `stg_loans` | |
| `is_npa` | `BOOLEAN` | `stg_loans` | |
| `days_past_due` | `INTEGER` | `stg_loans` | |
| `dpd_bucket` | `TEXT` | derived | `0` / `1-30` / `31-60` / `61-90` / `91-180` / `180+` |
| `last_repayment_at` | `TIMESTAMPTZ` | `stg_loans` | |
| `last_repayment_date` | `DATE` | coalesce repay-agg / loan | |
| `repayment_count` | `INTEGER` | `stg_repayments` agg | |
| `total_paid` | `NUMERIC(18,2)` | `stg_repayments` agg | |
| `total_shortfall` | `NUMERIC(18,2)` | `stg_repayments` agg | |
| `arrears_payment_count` | `INTEGER` | `stg_repayments` agg | |
| `ltv_ratio` | `NUMERIC` | derived | `ROUND(outstanding_amount / collateral_value, 4)`; NULL when collateral is 0 |
| `as_of` | `TIMESTAMPTZ` | `current_timestamp` | |

### `mart.txn_features`

Rolling 7/30/90-day inflow + outflow + count aggregates per customer. Window sizes are configurable via dbt vars: `txn_window_short` (7), `txn_window_med` (30), `txn_window_long` (90).

| Column | Type | Notes |
|---|---|---|
| `customer_id` | `TEXT` | |
| `as_of` | `DATE` | `current_date` at run time; production DAG partitions on this |
| `inflow_7d` / `outflow_7d` / `txn_count_7d` | `NUMERIC(18,2)` / `NUMERIC(18,2)` / `INTEGER` | 7-day windows |
| `net_flow_7d` | `NUMERIC(18,2)` | `inflow_7d - outflow_7d` |
| `inflow_30d` / `outflow_30d` / `txn_count_30d` | same | 30-day windows |
| `net_flow_30d` | `NUMERIC(18,2)` | |
| `inflow_90d` / `outflow_90d` / `txn_count_90d` | same | 90-day windows |
| `net_flow_90d` | `NUMERIC(18,2)` | |
| `burn_ratio_30d` | `NUMERIC` | `outflow_30d / inflow_30d`; NULL when inflow is 0 |
| `inflow_velocity_ratio` | `NUMERIC` | `inflow_30d / (inflow_90d / 3)`; >1 means inflow accelerating |

### `mart.indicator_values`

Long-format indicator output. One row per `(customer_id, snapshot_date, indicator_id)`. Consumed by the rule engine — predicates filter rows by `indicator_id` and read `value` / `breached`.

| Column | Type | Notes |
|---|---|---|
| `customer_id` | `TEXT` | |
| `snapshot_date` | `DATE` | `current_date` at run time |
| `indicator_id` | `TEXT` | One of the 8 dbt-materialised indicators (see below) |
| `value` | `NUMERIC` | Indicator-specific; NULL when input data is missing |
| `breached` | `BOOLEAN` | Computed by the per-indicator threshold (see table below) |
| `severity` | `TEXT` | `low` / `medium` / `high` / `critical` derived from the catalog's severity weight |
| `computed_at` | `TIMESTAMPTZ` | When the dbt run produced this row |

**The 8 indicators that this dbt model materialises** (the other 22 from [`services/regulatory-svc/indicators/catalog.json`](../services/regulatory-svc/indicators/catalog.json) are computed at request-time by `POST /indicators/compute`):

| `indicator_id` | Family | Value formula | Breach threshold | Weight |
|---|---|---|---|---|
| `TXN-001` | TXN | `outflow_30d / max(inflow_30d, 1)` | `value ≥ 1.2` | 0.55 |
| `FIN-005` | FIN | `(inflow_30d − outflow_30d) / monthly_income` | `value < 0.5` | 0.65 |
| `FIN-007` | FIN | `exposure_to_income_ratio / 12` (monthly LTI) | `value ≥ 0.5` | 0.60 |
| `CRD-006` | CRD | `worst_dpd` (raw days) | `value ≥ 30` | 0.95 |
| `CRD-007` | CRD | `sum_collateral / sum_outstanding` | `value < 1` | 0.50 |
| `BEH-002` | BEH | trailing arrears-payment streak | `value ≥ 2` | 0.80 |
| `BEH-003` | BEH | partial-repayment count last 90d / total | `value ≥ 0.4` | 0.65 |
| `TXN-005` | TXN | full-miss repayment count last 60d | `value ≥ 1` | 0.85 |

**Severity buckets** (consistent with the JSON catalog):

| Weight | Severity |
|---|---|
| `≥ 0.85` | `critical` |
| `≥ 0.65` | `high` |
| `≥ 0.45` | `medium` |
| `< 0.45` | `low` |

---

## Schema: `audit`

Append-only, hash-chained event log. Single table; updates and deletes are blocked by trigger. Required by NFR-AUDIT (7-year retention).

### `audit.event_log`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `event_id` | `BIGSERIAL` | NO | auto | **PK** |
| `event_ts` | `TIMESTAMPTZ` | NO | `now()` | Indexed |
| `event_type` | `TEXT` | NO | — | `INGEST` / `TRANSFORM` / `RULE_FIRE` / `ALERT` / `CASE` / `LOGIN` / etc.; indexed |
| `actor` | `TEXT` | NO | — | Service name or username |
| `subject_id` | `TEXT` | YES | — | `customer_id` / `loan_id` / `case_id` / …; indexed |
| `correlation_id` | `TEXT` | YES | — | Optional cross-service trace id |
| `source_ip` | `INET` | YES | — | |
| `payload` | `JSONB` | NO | — | Canonical event payload |
| `prev_hash` | `BYTEA` | NO | — | `octet_length = 32`; SHA-256 of the previous row (zeros for genesis) |
| `event_hash` | `BYTEA` | NO | — | `octet_length = 32`; computed by the chain trigger |

**Constraints:** `CHECK (octet_length(prev_hash) = 32)` · `CHECK (octet_length(event_hash) = 32)`
**Indexes:** `ix_audit_event_log_ts (event_ts)` · `ix_audit_event_log_subject (subject_id)` · `ix_audit_event_log_type (event_type)`

**Triggers:**

- `trg_event_log_chain` (BEFORE INSERT) — enforces the hash chain. If `prev_hash` is NULL, the trigger fills it from the latest row (or the genesis zero-hash). If supplied, the trigger raises if it doesn't match. `event_hash` is computed as `sha256(prev_hash || canonical(event_ts || event_type || actor || subject_id || payload::text))` and compared if supplied.
- `trg_event_log_no_update` (BEFORE UPDATE) — raises immediately. Audit log is append-only.
- `trg_event_log_no_delete` (BEFORE DELETE) — raises immediately.

**Required extension:** `pgcrypto` (provides `digest()`).

**Verification path:** the Python service `services/audit-svc` exposes `GET /audit/verify` which walks the entire chain top-to-bottom and re-computes each `event_hash`, returning `{ok: true}` only when every link verifies. Tampering with any historical row by direct SQL (e.g. `UPDATE audit.event_log SET payload = … WHERE event_id = …`) is blocked by the `trg_event_log_no_update` trigger; tampering at a lower layer (writing to the underlying table file) breaks the chain on the next `verify` call.

**Current state:** only 4 rows from `make verify` smoke tests. The hash chain works but no service writes to it yet. The next-session work wires `services/auth-svc` (16 event types) and `services/regulatory-svc/cases` (state transitions) to write here in addition to their service-local audit tables.

---

## Schema: `app_iam`

Operator identity + access. Owned by `services/auth-svc` (target — service does not yet write at runtime; this schema holds synthetic data so DBeaver shows the full picture).

### `app_iam.users` (505 rows)

Operator accounts (admin / risk_analyst / supervisor / collection_officer / field_officer). The 5 demo accounts from `services/auth-svc/src/users.ts` are present verbatim with PKs `u-001`..`u-005`; the rest are synthetic.

| Column | Type | Notes |
|---|---|---|
| `user_id` | `TEXT` | **PK**; format `u-<12 hex>` for synthetic, `u-001`..`u-005` for demos |
| `username` | `TEXT` | UNIQUE; format `firstname.lastname<NNN>` |
| `email` | `TEXT` | UNIQUE; `<username>@apex-ews.test` |
| `display_name` | `TEXT` | |
| `role` | `TEXT` | CHECK ∈ {admin, risk_analyst, supervisor, collection_officer, field_officer} |
| `password_hash` | `TEXT` | argon2id format |
| `failed_login_count` | `INTEGER` | 0..5; reset on successful login |
| `lockout_until` | `TIMESTAMPTZ` | NULL = not locked |
| `must_change_password` | `BOOLEAN` | Drives the first-login wizard; ~2% of synthetic users |
| `terms_accepted_at` | `TIMESTAMPTZ` | First-login wizard completion |
| `locked` | `BOOLEAN` | Admin-imposed lock; ~0.5% of synthetic users |
| `created_at` | `TIMESTAMPTZ` | |
| `last_login_at` | `TIMESTAMPTZ` | NULL for accounts that never logged in |

### `app_iam.sessions` (3,105 rows)

Server-tracked login sessions. The `sid` JWT claim references this row; `/auth/refresh` and `/auth/me` check `revoked` here.

| Column | Type | Notes |
|---|---|---|
| `sid` | `TEXT` | **PK**; format `s-<16 hex>` |
| `user_id` | `TEXT` | FK → `app_iam.users.user_id` (CASCADE) |
| `issued_at` | `TIMESTAMPTZ` | |
| `last_seen_at` | `TIMESTAMPTZ` | Updated on every authenticated request |
| `expires_at` | `TIMESTAMPTZ` | issued_at + 12h/24h/48h/168h |
| `ip` | `INET` | |
| `user_agent` | `TEXT` | Chrome/Firefox/Mobile/Safari mix |
| `revoked` | `BOOLEAN` | ~35% of sessions |
| `revoked_at` | `TIMESTAMPTZ` | |
| `revoked_reason` | `TEXT` | `user_logout` / `admin_revoke` / `idle_timeout` / `session_replaced` |

### `app_iam.password_history` (1,445 rows)

Last 5 password hashes per user. Insert-only; auth-svc trims rows beyond the 5-most-recent at password-change time.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` | **PK** (event-style surrogate) |
| `user_id` | `TEXT` | FK → `app_iam.users.user_id` (CASCADE) |
| `password_hash` | `TEXT` | argon2id |
| `set_at` | `TIMESTAMPTZ` | |

### `app_iam.audit_events` (12,000 rows)

Auth-svc audit log. Mirrors the in-memory `AuthAuditLog` ring buffer; production also forwards to `audit.event_log` for the hash-chained regulatory trail.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` | **PK** |
| `event_type` | `TEXT` | login_success (45%) / login_failure (20%) / password_change (5%) / session_revoked (8%) / rate_limited (4%) / captcha_failed (3%) / account_locked / account_unlocked / first_login_completed / password_reset_requested / password_reset_completed / forbidden_endpoint / user_created / role_changed |
| `actor_username` | `TEXT` | NULL for unauthenticated events (failed login on unknown user) |
| `target_username` | `TEXT` | Whose state changed (often = actor) |
| `ip` | `INET` | |
| `user_agent` | `TEXT` | |
| `occurred_at` | `TIMESTAMPTZ` | |
| `detail` | `JSONB` | Free-form (e.g. `{"attempt": 3}` for failed login) |

---

## Schema: `app_cases`

Case state machine + action log. Owned by `services/regulatory-svc/cases` (target).

### `app_cases.cases` (528 rows)

One row per case. Mirrors the in-memory `CaseStore` from `services/regulatory-svc/cases`. The 528 rows match the 528-customer defaulted cohort from the seed.

| Column | Type | Notes |
|---|---|---|
| `case_id` | `TEXT` | **PK**; format `case-<10 hex>` |
| `alert_id` | `TEXT` | Origin alert — deterministic from `(alert_id, customer_id)` per FR-CASE-2 |
| `customer_id` | `TEXT` | Denormalised — full customer record in `mart.customer_360` |
| `customer_name` | `TEXT` | |
| `severity` | `TEXT` | CHECK ∈ {low, medium, high, critical} |
| `rule_id` / `rule_name` | `TEXT` | The triggering rule |
| `state` | `TEXT` | CHECK ∈ {open, assigned, in_action, monitored, closed} |
| `assignee` | `TEXT` | Username of the case officer; NULL when state = open |
| `loan_id` | `TEXT` | Optional — loan tied to the alert |
| `reason_summary` | `TEXT` | Short human-readable reason |
| `outcome` | `TEXT` | CHECK ∈ {cured, cured_temp, defaulted}; only set on close |
| `created_at` | `TIMESTAMPTZ` | |
| `updated_at` | `TIMESTAMPTZ` | Bumped on every state transition or action |
| `closed_at` | `TIMESTAMPTZ` | |
| `sla_status` | `TEXT` | CHECK ∈ {on_track, approaching, breached, closed}. Indexed (partial — only approaching/breached). |

### `app_cases.actions` (1,568 rows)

Append-only action log. Each row is a call/visit/sms/email/note logged against a case by the assigned officer. `gps_*` columns populated for `visit` actions from the mobile app.

| Column | Type | Notes |
|---|---|---|
| `action_id` | `TEXT` | **PK**; format `act-<10 hex>` |
| `case_id` | `TEXT` | FK → `app_cases.cases.case_id` (CASCADE) |
| `kind` | `TEXT` | CHECK ∈ {call, visit, sms, email, note} |
| `officer_id` | `TEXT` | Username |
| `occurred_at` | `TIMESTAMPTZ` | |
| `outcome_note` | `TEXT` | Free-form ("Customer promised payment by Friday", "No answer; left voicemail", ...) |
| `gps_lat` / `gps_lng` | `NUMERIC(9,6)` | Centred on Nairobi (-1.29, 36.82) ± 0.1° |
| `gps_accuracy_m` | `NUMERIC(7,2)` | 5..25 m |

---

## Schema: `app_alerts`

Alert queue + smart-queue assignments. Owned by `services/regulatory-svc/alerts` (target).

### `app_alerts.alerts` (2,527 rows)

Denormalised alert rows. Mirrors what the BFF maps from canonical `apex.regulatory.events.v2`, plus the criticality-prioritization fields added 2026-05-02.

| Column | Type | Notes |
|---|---|---|
| `alert_id` | `TEXT` | **PK**; format `a-<10 hex>` |
| `severity` | `TEXT` | CHECK ∈ {critical, high, medium, low} |
| `customer_id` / `customer_name` | `TEXT` | Joined from customer service |
| `rule_id` / `rule_name` | `TEXT` | Joined from rule registry |
| `indicators` | `TEXT[]` | Array of indicator IDs that fired (e.g. `{IND_BEH_03, IND_TXN_07}`) |
| `confidence` | `NUMERIC(4,3)` | 0..1; model probability the alert is actionable |
| `customer_exposure_kes` | `NUMERIC(18,2)` | Sum of outstanding from `mart.loan_360` |
| `criticality_score` | `NUMERIC(8,2)` | `severityWeight × confidence × log10(exposure/100k) × ageBoost` — formula in `web/src/lib/criticality.ts` |
| `assignee` | `TEXT` | `risk` / `field` / username / NULL |
| `status` | `TEXT` | CHECK ∈ {open (60%), acked (25%), closed (15%)} |
| `created_at` | `TIMESTAMPTZ` | |
| `acked_at` / `closed_at` | `TIMESTAMPTZ` | |

### `app_alerts.queue_assignments` (3,431 rows)

Append-only assignment log. More rows than alerts because of reassignments (avg ~1.4 assignments per alert). Used for replaying queue history + auditing officer workload.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` | **PK** |
| `alert_id` | `TEXT` | FK → `app_alerts.alerts.alert_id` (CASCADE) |
| `queue` | `TEXT` | CHECK ∈ {critical, medium, low} (the SmartQueue tier) |
| `assigned_to` | `TEXT` | NULL = currently unassigned in queue |
| `assigned_at` | `TIMESTAMPTZ` | |
| `assigned_by` | `TEXT` | `system` for auto-routing, else username (supervisor / admin) |

---

## Schema: `app_bff`

Outbound webhook subscriptions + delivery log. Owned by `services/bff` (target — `WebhookSubscriptionStore` + `WebhookDispatcher` currently in-memory).

### `app_bff.webhook_subscriptions` (25 rows)

Admin-managed outbound webhook configs. The `secret` is the HMAC key used for the `X-APEX-Signature` header — only readable when the row is first created (auth-svc returns it once via the admin UI). 22 of 25 active; 3 deactivated.

| Column | Type | Notes |
|---|---|---|
| `subscription_id` | `TEXT` | **PK**; format `wh-<8 hex>` |
| `name` | `TEXT` | "AML Hub primary", "Branch ops dashboard", "PagerDuty critical", ... |
| `url` | `TEXT` | https URL of the receiver |
| `secret` | `TEXT` | hex-encoded HMAC key; never returned via list/get APIs |
| `events` | `TEXT[]` | `{alert.created, scenario.run}` — subset of the 6 event types |
| `active` | `BOOLEAN` | When false, dispatcher skips this subscription |
| `created_at` | `TIMESTAMPTZ` | |
| `last_delivery_at` | `TIMESTAMPTZ` | Updated by dispatcher on each fire attempt |
| `last_delivery_status` | `TEXT` | success / failed |

### `app_bff.webhook_deliveries` (915 rows)

Per-attempt delivery log. The dispatcher writes one row per delivery (success or failure) with the response status + truncated body for debugging. ~92% success rate in seed data.

| Column | Type | Notes |
|---|---|---|
| `delivery_id` | `TEXT` | **PK**; format `wd-<8 hex>` |
| `subscription_id` | `TEXT` | FK → `app_bff.webhook_subscriptions.subscription_id` (CASCADE) |
| `event_type` | `TEXT` | The fired event |
| `payload` | `JSONB` | The signed body actually POSTed |
| `attempts` | `INTEGER` | 1 (success) or 1..3 (after retries) |
| `status` | `TEXT` | success (92%) / failed (8%) |
| `response_status` | `INTEGER` | HTTP code; 0 = network error |
| `response_body` | `TEXT` | Truncated to 200 chars |
| `created_at` / `completed_at` | `TIMESTAMPTZ` | |

---

## Schema: `app_scenario`

Saved scenario simulator runs. Owned by `services/bff` scenario routes (target — currently lives in browser localStorage at `apex.ews.saved_scenarios`).

### `app_scenario.saved_scenarios` (120 rows)

Saved-scenario records from the SPA's `/scenario` page. The full result snapshot is preserved verbatim so a reload shows the saved numbers, not a re-run (engine elasticities may have changed since save).

| Column | Type | Notes |
|---|---|---|
| `scenario_id` | `TEXT` | **PK**; format `s-<12 hex>` |
| `name` | `TEXT` | "Severe recession 2026 (Q3 2026)", "COVID-like demand cliff (Q1 2025)", ... |
| `saved_by` | `TEXT` | Username (admin / supervisor / risk_analyst) |
| `saved_at` | `TIMESTAMPTZ` | |
| `gdp_shock_pct` | `NUMERIC(6,2)` | Macro inputs |
| `rate_shock_bps` | `INTEGER` | |
| `fx_shock_pct` | `NUMERIC(6,2)` | |
| `result` | `JSONB` | Full ScenarioResult — `inputs`, `portfolio_size`, `baseline_ecl_kes`, `stressed_ecl_kes`, `baseline_portfolio_pd`, `stressed_portfolio_pd` (and more in the real ScenarioResult shape) |

---

## Seed data (synthetic, prototype only)

Two generators produce the synthetic data; both are deterministic (seed 42 / 43 respectively):

### Raw seed CSVs ([`data/dbt/seeds/`](../data/dbt/seeds/))

`_generate_seeds.py` produces 5 CSVs that `dbt seed` loads into `raw.seed_*`. Scaled up 2026-05-03 from 220 → 10,000 customers.

| Seed | Rows | Maps to |
|---|---|---|
| `seed_customers.csv` | 10,000 | `raw.seed_customers` |
| `seed_loans.csv` | 24,000 | `raw.seed_loans` |
| `seed_repayments.csv` | 247,550 | `raw.seed_repayments` |
| `seed_transactions.csv` | 289,819 | `raw.seed_transactions` |
| `seed_bureau_score.csv` | 10,000 | `raw.seed_bureau_score` |

Portfolio characteristics:

- **NPA rate**: ~4.25% (1,019 of 24,000 loans in `SUBSTANDARD`/`DOUBTFUL`/`LOSS`); 528 unique defaulted customers
- **Average exposure**: ~KES 1.25M per customer
- **Bureau score distribution**: roughly normal centred ~620, range 280–880
- **Monthly income**: log-normal, range KES 8k–3M (segment-dependent)
- **Channel mix on transactions**: `mpesa` 40% / `branch` 25% / `pos` 15% / `atm` 12% / `standing-order` 8%

### App-data SQL ([`data/schema/_generate_app_seeds.py`](../data/schema/_generate_app_seeds.py))

Produces `app_seeds.sql` that `psql -f` loads into the `app_*` schemas. Generated rows:

| Table | Rows | Notes |
|---|---|---|
| `app_iam.users` | 505 | 5 demo accounts (`u-001`..`u-005` matching auth-svc/users.ts) + 500 synthetic |
| `app_iam.sessions` | 3,105 | avg ~6 per user; ~35% revoked |
| `app_iam.password_history` | 1,445 | avg 2-3 historical hashes per user |
| `app_iam.audit_events` | 12,000 | 14 event types across last 120 days |
| `app_cases.cases` | 528 | one per defaulted customer |
| `app_cases.actions` | 1,568 | avg ~3 actions per case (call/visit/sms/email/note) |
| `app_alerts.alerts` | 2,527 | defaulted cohort + 50% of WATCH-status loans |
| `app_alerts.queue_assignments` | 3,431 | ~1.4 assignments per alert (reassignment history) |
| `app_bff.webhook_subscriptions` | 25 | 22 active, 3 deactivated |
| `app_bff.webhook_deliveries` | 915 | avg ~32 per active subscription, ~92% success |
| `app_scenario.saved_scenarios` | 120 | 12 named templates × ~10 variants each |

**Re-running the generators** is byte-deterministic — re-runs produce identical files, so `dbt seed --full-refresh` + `psql -f app_seeds.sql` reliably restore state.

---

## Out-of-Postgres state (for completeness)

The prototype keeps several stores **in-memory** rather than in Postgres. They are not part of the database schema but are documented here so consumers know where state lives.

| Service | Store | Backing |
|---|---|---|
| `services/auth-svc` | Users, sessions, password history, audit log, captcha challenges, failure counters, rate-limit windows | In-memory; lost on restart. Production: Aurora `apex_iam.*` tables (per `docs/architecture.md`) |
| `services/regulatory-svc/cases` | Case records + state-machine transitions + action log | NDJSON file (`.store/cases.ndjson` in dev) + in-memory cache. Production: Aurora `apex_cases.*` |
| `services/regulatory-svc/alerts` | Alerts + SmartQueue assignments | NDJSON outbox (`.outbox/apex.regulatory.events-*.ndjson`) + in-memory queue. Production: Aurora `apex_alerts.*` + MSK |
| `services/regulatory-svc/indicators` | Per-customer indicator values (computed on demand) | Stateless — reads from `mart.*` |
| `services/bff` | Webhook subscriptions + delivery log; cached lookups | In-memory; lost on restart. Production: Aurora `apex_bff.*` |
| `services/collection-adapter` | Routed-case dedup set | NDJSON outbox + in-memory set. Production: MSK + Aurora `apex_collection.*` |
| `services/notification-svc` | None (transient) | — |
| `services/audit-svc` | Hash-chain verification cache | In-memory; chain itself is in `audit.event_log` |
| Web SPA (browser) | Auth blob, idle state, language, saved scenarios, time-range selection | `localStorage`: `apex.ews.user`, `apex.ews.token`, `apex.ews.lang`, `apex.ews.saved_scenarios`, plus URL query params for filters/tabs/range |

---

## Migration runbook

Local Postgres lifecycle is in [`data/schema/Makefile`](../data/schema/Makefile):

```sh
cd data/schema
make up        # docker run zorews-pg (postgres:16) on :55432
make migrate   # psql -f 001_init_schemas.sql 002_raw_tables.sql 003_audit_table.sql
make verify    # smoke: 4 schemas, audit-trigger reject test

# 2026-05-03 additions — apply once, idempotent on subsequent runs:
PGPASSWORD=apex psql -h localhost -p 55432 -U zorews_user -d zorews \
  -v ON_ERROR_STOP=1 -f 004_app_schemas.sql

make down      # stop + remove the container
```

Then dbt builds the staging views + mart tables:

```sh
source .venv/bin/activate
cd data/dbt
dbt deps && dbt seed && dbt run && dbt test
# → 79 tests pass; 5 seed CSVs into raw.seed_*; 9 dbt models built
# (10k customers · 24k loans · 247k repayments · 290k txns · 10k bureau)
```

Then load the synthetic app data:

```sh
cd data/schema
python3 _generate_app_seeds.py    # writes app_seeds.sql (~26k rows)
PGPASSWORD=apex psql -h localhost -p 55432 -U zorews_user -d zorews \
  -v ON_ERROR_STOP=1 -f app_seeds.sql
```

Final state: ~731,500 rows across 9 schemas / 26 tables.

Production deploys via Terraform — `infra/terraform/30-data` provisions Aurora PostgreSQL 16 Multi-AZ + the same schemas via the `001`/`002`/`003`/`004` bootstrap on first deploy. dbt runs as a Fargate task on the `feature_build` Airflow DAG. The `app_seeds.sql` synthetic data is **not** loaded in production — services write the real rows themselves once T-wiring (next-session work) lands.

---

## Cross-references

- Source SQL: [`data/schema/`](../data/schema/) (3 files)
- Source dbt models: [`data/dbt/models/`](../data/dbt/models/) (10 files)
- Schema tests: [`data/dbt/models/staging/schema.yml`](../data/dbt/models/staging/schema.yml), [`data/dbt/models/marts/schema.yml`](../data/dbt/models/marts/schema.yml) — 79 pass
- Seed generator: [`data/dbt/seeds/_generate_seeds.py`](../data/dbt/seeds/_generate_seeds.py)
- Terraform (production Aurora + KMS): [`infra/terraform/30-data/`](../infra/terraform/30-data/)
- Indicator catalog (drives `indicator_values`): [`services/regulatory-svc/indicators/catalog.json`](../services/regulatory-svc/indicators/catalog.json)
- Verification matrix (proves all of the above runs end-to-end): [`STATUS.md`](../STATUS.md)
