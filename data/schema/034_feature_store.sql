-- T2.1.3 — Feature Store persistence (Aurora schema).
--
-- Production swap for the T2.1.1 surface-layer in-memory store
-- (services/bff/src/feature_store.ts). The BFF query interface stays
-- unchanged — getFeatureSnapshot / getFeatureHistory / buildFeature-
-- CoverageStats — and the PgFeatureStore impl satisfies the same
-- shape against this table.
--
-- The 8 PD-model features stored here mirror ml/data/load_from_mart.py
-- so the training pipeline can pivot from "current mart snapshot" to
-- "as-of point-in-time" by reading `feature_store.feature_values`
-- with an as_of_date parameter instead of joining mart.customer_360.
--
-- Multi-tenant by composite key (tenant_id, entity_id, feature_name,
-- observed_at). 24-month retention enforced by an INDEX + scheduled
-- purge (the purge job runs against this index oldest-first).
--
-- Activation: `make migrate` picks this up after 033 in numerical order.
-- The BFF auto-switches to the PG impl when FEATURE_STORE_PG_URL is
-- set (see services/bff/src/feature_store.ts factory).

CREATE SCHEMA IF NOT EXISTS feature_store;

-- ── Catalog table — closed-enum metadata about each feature ────────
--
-- Mirrors FEATURE_CATALOG in services/bff/src/feature_store.ts.
-- Populated once via the seed file; future feature additions go
-- through a migration so the BFF + dbt + ML pipeline all stay in sync.

CREATE TABLE IF NOT EXISTS feature_store.feature_catalog (
    feature_name        TEXT PRIMARY KEY,
    display_name        TEXT NOT NULL,
    description         TEXT NOT NULL,
    value_type          TEXT NOT NULL CHECK (value_type IN ('number', 'integer', 'enum')),
    range_min           NUMERIC NOT NULL,
    range_max           NUMERIC NOT NULL CHECK (range_max >= range_min),
    enum_labels         TEXT[]  NOT NULL DEFAULT '{}',
    risk_polarity       TEXT NOT NULL CHECK (risk_polarity IN ('higher_is_worse', 'lower_is_worse', 'neutral')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Feature values — append-only time-series ────────────────────────
--
-- Composite uniqueness: (tenant, entity, feature, observed_at).
-- Same (tenant, entity, feature) on the same UTC-day are upserted —
-- production data sources typically write 1-per-day; if multiple,
-- last-write-wins via the unique constraint + ON CONFLICT DO UPDATE.
--
-- value is NUMERIC to handle both number + integer + enum-encoded
-- values uniformly (enum values store the integer index per the
-- catalog's enum_labels array).

CREATE TABLE IF NOT EXISTS feature_store.feature_values (
    tenant_id           TEXT        NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
    entity_id           TEXT        NOT NULL,
    feature_name        TEXT        NOT NULL REFERENCES feature_store.feature_catalog(feature_name) ON DELETE RESTRICT,
    observed_at         TIMESTAMPTZ NOT NULL,
    value               NUMERIC     NOT NULL,
    source_run_id       TEXT,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, entity_id, feature_name, observed_at)
);

-- ── Indexes ─────────────────────────────────────────────────────────
--
-- Hot paths:
--  1. Per-customer snapshot at a given as-of date — composite PK already covers.
--  2. Per-customer feature history over a window — (tenant, entity, feature, observed_at) range scan.
--  3. 24-month retention purge — oldest-first across all tenants.

CREATE INDEX IF NOT EXISTS idx_feature_values_window
    ON feature_store.feature_values (tenant_id, entity_id, feature_name, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_feature_values_purge
    ON feature_store.feature_values (observed_at);

CREATE INDEX IF NOT EXISTS idx_feature_values_recorded
    ON feature_store.feature_values (recorded_at DESC);

-- ── 24-month retention policy ──────────────────────────────────────
--
-- Documented marker; the actual purge runs as a scheduled job (Airflow /
-- pg_cron / Lambda) calling:
--
--   DELETE FROM feature_store.feature_values
--    WHERE observed_at < (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 months';
--
-- 24 months matches MAX_HISTORY_WINDOW_DAYS = 744 in
-- services/bff/src/feature_store.ts (24 × 31). Anything older is
-- archived to S3 by the offline-store pipeline (Year-2 Theme E).

COMMENT ON TABLE feature_store.feature_values IS
    '24-month rolling time series of PD-model features. Retention purge runs daily.';

-- ── Touch trigger keeping catalog.updated_at fresh ─────────────────

CREATE OR REPLACE FUNCTION feature_store.fn_catalog_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_feature_catalog_touch ON feature_store.feature_catalog;
CREATE TRIGGER trg_feature_catalog_touch
    BEFORE UPDATE ON feature_store.feature_catalog
    FOR EACH ROW
    EXECUTE FUNCTION feature_store.fn_catalog_touch_updated_at();

-- ── Seed the catalog with the 8 PD-model features ──────────────────
--
-- ON CONFLICT DO NOTHING so this migration is idempotent.

INSERT INTO feature_store.feature_catalog
    (feature_name, display_name, description, value_type, range_min, range_max, enum_labels, risk_polarity)
VALUES
    ('utilization',            'Exposure-to-income utilization',     'Credit exposure / monthly income, clamped to [0, 1.5].', 'number',  0,    1.5,  '{}',                                          'higher_is_worse'),
    ('dpd_max_90d',            'Max DPD (90d)',                      'Worst days-past-due in trailing 90 days.',                'integer', 0,    180,  '{}',                                          'higher_is_worse'),
    ('bureau_score',           'Bureau score',                       'Credit bureau score (300..900 typical band).',            'integer', 300,  900,  '{}',                                          'lower_is_worse'),
    ('repayment_delay_streak', 'Repayment delay streak',             'Consecutive months with late payment.',                   'integer', 0,    24,   '{}',                                          'higher_is_worse'),
    ('txn_volume_zscore_90d',  'Transaction-volume z-score (90d)',   'Z-score of monthly txn volume vs 90d.',                   'number', -3,    3,    '{}',                                          'lower_is_worse'),
    ('tenure_months',          'Tenure months',                      'Months since customer onboarding.',                       'integer', 0,    240,  '{}',                                          'lower_is_worse'),
    ('product_level',          'Product type (encoded)',             'Categorical encoding of the loan product family.',        'enum',    0,    4,    '{PL_RET,AUTO_RET,INV_SME,WC_SME,CORP_TL}',    'neutral'),
    ('income_level',           'Income band (encoded)',              'Categorical encoding of monthly income band.',            'enum',    0,    4,    '{"<25k","25-50k","50-100k","100-250k","250k+"}', 'neutral')
ON CONFLICT (feature_name) DO NOTHING;
