-- data/schema/051_dashboard_engine.sql
--
-- Role-Based Dashboard Engine — schema extension.
-- Additive over migration 004 (which created app_iam.role_dashboard_widgets per T4.23).
--
-- Introduces:
--   * app_iam.dashboard_layouts            — named saved layouts per (user OR role)
--   * app_iam.dashboard_widget_preferences — per-user pin / hide / sort_order
--   * app_iam.widget_visibility_rules      — extended 5-axis governance overlay
--                                            (role × domain × country × tenant × branch)
--
-- Design contract:
--   * No parallel widget catalog — widget_id strings are the contract between
--     the SPA widget registry (web/src/modules/dashboard/roleEngine/widgetRegistry.ts)
--     and the BFF read routes.
--   * No FK to a hypothetical app_iam.widgets table — the registry is
--     SPA-resident with stable string ids.
--   * Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--     Re-runs are safe.
--   * Apply AFTER 004_app_schemas.sql (which created app_iam + base tables).

-- =========================================================================
-- 1. Dashboard Layouts (named saved layouts per user OR per role)
-- =========================================================================
CREATE TABLE IF NOT EXISTS app_iam.dashboard_layouts (
    layout_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    /** EITHER user_id (private layout) OR role (shared default) — exactly one set. */
    user_id          UUID         REFERENCES app_iam.users(user_id) ON DELETE CASCADE,
    role             TEXT,
    name             TEXT         NOT NULL,
    description      TEXT,
    /** Closed-enum domain — banking / insurance / both. */
    domain           TEXT         NOT NULL DEFAULT 'both',
    /** Ordered widget id array — drives render order in the SPA. */
    widget_ids       JSONB        NOT NULL DEFAULT '[]'::jsonb,
    /** Optional per-widget config map (span / params / etc.). */
    widget_config    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    is_default       BOOLEAN      NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by       TEXT         NOT NULL,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by       TEXT,

    CONSTRAINT dashboard_layouts_owner_chk CHECK (
        (user_id IS NOT NULL AND role IS NULL)
        OR
        (user_id IS NULL AND role IS NOT NULL)
    ),
    CONSTRAINT dashboard_layouts_domain_chk CHECK (
        domain IN ('banking', 'insurance', 'both')
    ),
    CONSTRAINT dashboard_layouts_name_len CHECK (
        char_length(name) BETWEEN 1 AND 200
    ),
    CONSTRAINT dashboard_layouts_description_len CHECK (
        description IS NULL OR char_length(description) <= 2000
    )
);

CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_tenant_user
    ON app_iam.dashboard_layouts(tenant_id, user_id, updated_at DESC)
    WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_tenant_role
    ON app_iam.dashboard_layouts(tenant_id, role, updated_at DESC)
    WHERE role IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_default
    ON app_iam.dashboard_layouts(tenant_id, role)
    WHERE is_default = true;

COMMENT ON TABLE app_iam.dashboard_layouts IS
'Named saved layouts for the Role-Based Dashboard Engine. Either user_id (private) or role (shared default) is set — never both. Layouts are an ordered widget_ids array referencing the SPA widget registry; widget_config carries per-widget span / param overrides.';

-- =========================================================================
-- 2. Dashboard Widget Preferences (per-user pin / hide / sort)
-- =========================================================================
CREATE TABLE IF NOT EXISTS app_iam.dashboard_widget_preferences (
    preference_id    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    user_id          UUID         NOT NULL REFERENCES app_iam.users(user_id) ON DELETE CASCADE,
    widget_id        TEXT         NOT NULL,
    pinned           BOOLEAN      NOT NULL DEFAULT false,
    hidden           BOOLEAN      NOT NULL DEFAULT false,
    sort_order       INTEGER,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT dashboard_widget_prefs_uniq UNIQUE (tenant_id, user_id, widget_id),
    CONSTRAINT dashboard_widget_prefs_sort_chk CHECK (
        sort_order IS NULL OR sort_order >= 0
    ),
    /** A widget can't simultaneously be pinned AND hidden — pinned wins
        but we reject the inconsistency at insert time. */
    CONSTRAINT dashboard_widget_prefs_pin_or_hide CHECK (
        NOT (pinned = true AND hidden = true)
    )
);

CREATE INDEX IF NOT EXISTS idx_dashboard_prefs_user
    ON app_iam.dashboard_widget_preferences(tenant_id, user_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_dashboard_prefs_pinned
    ON app_iam.dashboard_widget_preferences(tenant_id, user_id)
    WHERE pinned = true;

COMMENT ON TABLE app_iam.dashboard_widget_preferences IS
'Per-(tenant, user, widget) preference overlay. pinned widgets float to top; hidden widgets drop; sort_order arbitrates within group. Engine merge order: hide overrides default; pin overrides hide; sort_order finalises position.';

-- =========================================================================
-- 3. Widget Visibility Rules (5-axis governance overlay)
-- =========================================================================
CREATE TABLE IF NOT EXISTS app_iam.widget_visibility_rules (
    rule_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    widget_id        TEXT         NOT NULL,
    /** EITHER allow (additive) OR deny (subtractive) for this scope. */
    effect           TEXT         NOT NULL,
    /** Optional 5-axis scope — null = matches any value on that axis. */
    role             TEXT,
    domain           TEXT,
    country_code     TEXT,
    branch_id        TEXT,
    /** Optional creator + timestamp for the governance audit trail (M15 fan-out covers the rest). */
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by       TEXT         NOT NULL,
    notes            TEXT,

    CONSTRAINT widget_visibility_effect_chk CHECK (effect IN ('allow', 'deny')),
    CONSTRAINT widget_visibility_domain_chk CHECK (
        domain IS NULL OR domain IN ('banking', 'insurance', 'both')
    ),
    CONSTRAINT widget_visibility_notes_len CHECK (
        notes IS NULL OR char_length(notes) <= 2000
    )
);

CREATE INDEX IF NOT EXISTS idx_widget_visibility_tenant_widget
    ON app_iam.widget_visibility_rules(tenant_id, widget_id);

CREATE INDEX IF NOT EXISTS idx_widget_visibility_role
    ON app_iam.widget_visibility_rules(tenant_id, role)
    WHERE role IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_widget_visibility_branch
    ON app_iam.widget_visibility_rules(tenant_id, branch_id)
    WHERE branch_id IS NOT NULL;

COMMENT ON TABLE app_iam.widget_visibility_rules IS
'Extended 5-axis (role × domain × country × branch) governance overlay on top of widget defaults. NULL on any axis means "matches any value". Engine semantics: deny rules trump allow rules at the same specificity; allow rules at the widget level override defaults that hide the widget.';

-- =========================================================================
-- 4. BEFORE UPDATE trigger — keep updated_at fresh on dashboard_layouts
-- =========================================================================
CREATE OR REPLACE FUNCTION app_iam.fn_dashboard_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dashboard_layouts_touch ON app_iam.dashboard_layouts;
CREATE TRIGGER trg_dashboard_layouts_touch
    BEFORE UPDATE ON app_iam.dashboard_layouts
    FOR EACH ROW EXECUTE FUNCTION app_iam.fn_dashboard_touch_updated_at();

DROP TRIGGER IF EXISTS trg_dashboard_widget_prefs_touch ON app_iam.dashboard_widget_preferences;
CREATE TRIGGER trg_dashboard_widget_prefs_touch
    BEFORE UPDATE ON app_iam.dashboard_widget_preferences
    FOR EACH ROW EXECUTE FUNCTION app_iam.fn_dashboard_touch_updated_at();

-- No data seeded here — defaults flow from the SPA widget registry per role
-- preset. Tenants seed their own layouts via the SPA's "Save layout" action,
-- which writes to dashboard_layouts.
