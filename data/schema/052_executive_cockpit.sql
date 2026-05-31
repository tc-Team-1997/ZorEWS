-- data/schema/052_executive_cockpit.sql
--
-- Executive Risk Cockpit — schema extension.
-- Additive over migration 051_dashboard_engine.sql.
--
-- Introduces:
--   * app_iam.executive_reports        — generated board / regulatory / executive reports
--   * app_iam.executive_briefings      — daily / weekly / monthly AI briefing cache
--   * app_iam.executive_kpi_snapshots  — point-in-time strategic KPI snapshots
--
-- Design contract:
--   * No parallel audit table — every cockpit action fans out to
--     audit.event_log via the existing M15 auditTrailStore.
--   * Briefings + snapshots are CACHED outputs of the pure resolvers in
--     web/src/modules/executive/{executiveBriefing,executiveCockpitEngine}.ts.
--     The cache lets executives compare today's briefing against last
--     month's; without it the resolver is stateless deterministic.
--   * Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--     Re-runs are safe.
--   * Apply AFTER 004_app_schemas.sql (which created app_iam) and 051.

-- =========================================================================
-- 1. Executive Reports (generated PDF / Excel / CSV report artefacts)
-- =========================================================================
CREATE TABLE IF NOT EXISTS app_iam.executive_reports (
    report_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    template_id        TEXT         NOT NULL,
    /** Closed enum — matches REPORT_FORMATS in executiveBriefing.ts. */
    format             TEXT         NOT NULL,
    /** Closed enum — matches REPORT_TEMPLATES.id in executiveBriefing.ts. */
    period_start       TIMESTAMPTZ,
    period_end         TIMESTAMPTZ,
    generated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    generated_by       TEXT         NOT NULL,
    /** S3 / object-store key (or NULL for in-flight). */
    storage_key        TEXT,
    /** Closed enum — pending / generating / ready / failed. */
    status             TEXT         NOT NULL DEFAULT 'pending',
    error_message      TEXT,
    /** Optional caller-supplied parameters echoed back in the report header. */
    parameters         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    /** Cross-reference back to the M15 audit chain entry that fired the export. */
    correlation_id     UUID,

    CONSTRAINT exec_reports_template_chk CHECK (template_id IN (
        'executive_summary',
        'quarterly_board_pack',
        'regulatory_rbi_quarterly',
        'regulatory_irdai_quarterly',
        'risk_profile_snapshot',
        'recovery_performance',
        'fraud_investigation_summary'
    )),
    CONSTRAINT exec_reports_format_chk CHECK (format IN ('pdf', 'xlsx', 'csv')),
    CONSTRAINT exec_reports_status_chk CHECK (status IN ('pending', 'generating', 'ready', 'failed')),
    CONSTRAINT exec_reports_period_chk CHECK (
        period_start IS NULL OR period_end IS NULL OR period_start <= period_end
    ),
    CONSTRAINT exec_reports_error_pair CHECK (
        (status = 'failed' AND error_message IS NOT NULL)
        OR (status <> 'failed')
    )
);

CREATE INDEX IF NOT EXISTS idx_exec_reports_tenant_generated
    ON app_iam.executive_reports(tenant_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_exec_reports_template
    ON app_iam.executive_reports(tenant_id, template_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_exec_reports_generator
    ON app_iam.executive_reports(tenant_id, generated_by, generated_at DESC);

COMMENT ON TABLE app_iam.executive_reports IS
'Generated executive + regulatory + board-pack report artefacts. Reuses the T4.6 self-service report builder pipeline (CSV / PDF / Excel). Storage_key points at S3 (or local outbox in dev). Every generation event also fans out to audit.event_log via the M15 chain.';

-- =========================================================================
-- 2. Executive Briefings (daily / weekly / monthly summary cache)
-- =========================================================================
CREATE TABLE IF NOT EXISTS app_iam.executive_briefings (
    briefing_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    /** Closed enum — daily / weekly / monthly. */
    cadence            TEXT         NOT NULL,
    period_start       TIMESTAMPTZ  NOT NULL,
    period_end         TIMESTAMPTZ  NOT NULL,
    /** Headline single-sentence summary. */
    headline           TEXT         NOT NULL,
    /** Highlight cards [{metric, direction, detail, drill_to?}]. */
    highlights         JSONB        NOT NULL DEFAULT '[]'::jsonb,
    /** Recommended next action for the executive. */
    recommended_action TEXT,
    /** Whether the briefing was generated heuristically or by an LLM. */
    source             TEXT         NOT NULL DEFAULT 'heuristic',
    generated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    generated_by       TEXT         NOT NULL DEFAULT 'system',

    CONSTRAINT exec_briefings_cadence_chk CHECK (cadence IN ('daily', 'weekly', 'monthly')),
    CONSTRAINT exec_briefings_source_chk CHECK (source IN ('heuristic', 'claude', 'bedrock', 'manual')),
    CONSTRAINT exec_briefings_period_chk CHECK (period_start <= period_end),
    CONSTRAINT exec_briefings_headline_len CHECK (char_length(headline) BETWEEN 5 AND 500),
    CONSTRAINT exec_briefings_action_len CHECK (recommended_action IS NULL OR char_length(recommended_action) <= 1000),
    /** Idempotent insert per (tenant, cadence, period_start) so re-runs
        update rather than duplicate. */
    CONSTRAINT exec_briefings_period_uniq UNIQUE (tenant_id, cadence, period_start)
);

CREATE INDEX IF NOT EXISTS idx_exec_briefings_tenant_cadence
    ON app_iam.executive_briefings(tenant_id, cadence, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_exec_briefings_generated
    ON app_iam.executive_briefings(tenant_id, generated_at DESC);

COMMENT ON TABLE app_iam.executive_briefings IS
'Cached AI briefing output keyed by (tenant, cadence, period_start). Today populated by the heuristic generator in executiveBriefing.ts; production swap = Claude / Bedrock messages call returning the same JSON shape. The cache lets executives compare today vs last-month briefings without re-running the generator.';

-- =========================================================================
-- 3. Executive KPI Snapshots (point-in-time strategic KPIs)
-- =========================================================================
CREATE TABLE IF NOT EXISTS app_iam.executive_kpi_snapshots (
    snapshot_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    captured_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    /** Closed enum — matches StrategicKpiId in executiveCockpitEngine.ts. */
    kpi_id             TEXT         NOT NULL,
    /** Stored as TEXT to preserve presentation ("16.4%", "₹14.2 Cr"). */
    value_text         TEXT         NOT NULL,
    /** Parsed numeric value when meaningful (for trend math). */
    value_numeric      NUMERIC,
    /** Closed-enum band — green / amber / red. */
    band               TEXT,
    /** % delta vs prior snapshot, signed. */
    delta_pct          NUMERIC,
    /** Closed-enum trend — rising / falling / flat. */
    trend              TEXT,
    /** Optional metadata (e.g. weight set, forecast horizon, ML model id). */
    metadata           JSONB        NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT exec_kpi_band_chk CHECK (band IS NULL OR band IN ('green', 'amber', 'red')),
    CONSTRAINT exec_kpi_trend_chk CHECK (trend IS NULL OR trend IN ('rising', 'falling', 'flat')),
    CONSTRAINT exec_kpi_kpi_id_chk CHECK (kpi_id IN (
        'risk_adjusted_return',
        'capital_at_risk',
        'portfolio_stability_index',
        'recovery_efficiency',
        'compliance_health',
        'fraud_loss_avoidance'
    )),
    CONSTRAINT exec_kpi_value_len CHECK (char_length(value_text) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_exec_kpi_tenant_kpi_time
    ON app_iam.executive_kpi_snapshots(tenant_id, kpi_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_exec_kpi_band_red
    ON app_iam.executive_kpi_snapshots(tenant_id, captured_at DESC)
    WHERE band = 'red';

COMMENT ON TABLE app_iam.executive_kpi_snapshots IS
'Point-in-time snapshots of the 6 strategic KPIs from executiveCockpitEngine.ts. Persisted so the cockpit can render historical trend lines + the board pack can quote period-over-period values without re-deriving from raw mart.';

-- =========================================================================
-- 4. No new triggers (briefings + reports + snapshots are append-mostly;
--    no updated_at column on snapshots / briefings beyond generated_at).
--
-- No data seeded — briefings + snapshots are populated lazily by the
-- resolvers on first cockpit load per tenant.
-- =========================================================================
