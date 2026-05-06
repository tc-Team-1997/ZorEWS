-- 013_cms_cases.sql
--
-- EWS Case Management System (CMS-1).
--
-- Per the architecture mapping (docs/ews-cms-mapping.md), this is a
-- NEW richer case-management surface alongside the existing M9.x
-- `app_cases.cases` / `cas_records` / `caps` tables — additive only.
-- Runtime stays in-memory in the prototype; this migration is the
-- forward-looking schema for production swap-in.
--
-- 5 tables:
--   app_cases.cms_cases             — case envelope
--   app_cases.cms_case_notes        — note thread per case
--   app_cases.cms_case_attachments  — file metadata + virus_scan_status
--   app_cases.cms_case_assignments  — assignment history (one row per
--                                     assign event)
--   app_cases.cms_case_history      — immutable per-case audit slice
--
-- The existing app_cases.cases table is NOT touched.

CREATE SCHEMA IF NOT EXISTS app_cases;

-- ─── cms_cases ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_cases.cms_cases (
    case_id              UUID         PRIMARY KEY,
    case_number          TEXT         NOT NULL,
        -- Format: EWS-YYYY-NNNNN. Per-tenant per-year monotonic.
    tenant_id            TEXT         NOT NULL,
    title                TEXT         NOT NULL,
    description          TEXT         NOT NULL DEFAULT '',
    alert_id             TEXT,         -- soft FK; alerts table varies
    status               TEXT         NOT NULL DEFAULT 'OPEN',
        -- OPEN / ASSIGNED / INVESTIGATING / PENDING_APPROVAL /
        -- ESCALATED / CLOSED / REOPENED
    priority             TEXT         NOT NULL,        -- P1 / P2 / P3 / P4
    assigned_to          TEXT,
    created_by           TEXT         NOT NULL,
    sla_due_at           TIMESTAMPTZ  NOT NULL,
    resolved_at          TIMESTAMPTZ,
    resolution_category  TEXT,
        -- false_positive / confirmed_risk / mitigated; NULL until close
    resolution_notes     TEXT         NOT NULL DEFAULT '',
    tags                 TEXT[]       NOT NULL DEFAULT '{}',
    is_locked            BOOLEAN      NOT NULL DEFAULT FALSE,
        -- TRUE on close; cleared on reopen
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, case_number),
    CHECK (case_number ~ '^EWS-[0-9]{4}-[0-9]{5}$'),
    CHECK (status IN ('OPEN','ASSIGNED','INVESTIGATING','PENDING_APPROVAL',
                      'ESCALATED','CLOSED','REOPENED')),
    CHECK (priority IN ('P1','P2','P3','P4')),
    CHECK (
        resolution_category IS NULL OR
        resolution_category IN ('false_positive','confirmed_risk','mitigated')
    ),
    -- Closed cases must carry a resolution; non-closed must NOT have one.
    CHECK (
        (status = 'CLOSED' AND resolution_category IS NOT NULL) OR
        (status <> 'CLOSED' AND resolution_category IS NULL)
    ),
    -- is_locked is derived from status; keep them in lock-step.
    CHECK (
        (status = 'CLOSED' AND is_locked = TRUE) OR
        (status <> 'CLOSED' AND is_locked = FALSE)
    )
);

CREATE INDEX IF NOT EXISTS ix_cms_cases_tenant_status
  ON app_cases.cms_cases (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_cms_cases_tenant_assignee
  ON app_cases.cms_cases (tenant_id, assigned_to)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_cms_cases_tenant_sla
  ON app_cases.cms_cases (tenant_id, sla_due_at)
  WHERE status NOT IN ('CLOSED');
CREATE INDEX IF NOT EXISTS ix_cms_cases_alert
  ON app_cases.cms_cases (tenant_id, alert_id)
  WHERE alert_id IS NOT NULL;

COMMENT ON TABLE app_cases.cms_cases IS
    'EWS Case Management System — case envelope. Lives alongside the existing app_cases.cases table; new richer lifecycle per the brief. See docs/ews-cms-mapping.md.';

-- ─── cms_case_notes ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_cases.cms_case_notes (
    note_id     UUID         PRIMARY KEY,
    case_id     UUID         NOT NULL REFERENCES app_cases.cms_cases(case_id) ON DELETE CASCADE,
    tenant_id   TEXT         NOT NULL,
    user_id     TEXT         NOT NULL,
    note_text   TEXT         NOT NULL,
    is_internal BOOLEAN      NOT NULL DEFAULT TRUE,
        -- TRUE = staff-only; FALSE = visible to customer in their portal
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_cms_notes_case_time
  ON app_cases.cms_case_notes (case_id, created_at DESC);

-- ─── cms_case_attachments ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_cases.cms_case_attachments (
    attachment_id      UUID         PRIMARY KEY,
    case_id            UUID         NOT NULL REFERENCES app_cases.cms_cases(case_id) ON DELETE CASCADE,
    tenant_id          TEXT         NOT NULL,
    file_name          TEXT         NOT NULL,
    file_url           TEXT         NOT NULL,
        -- prototype: in-memory blob URL (cms://attachment_id);
        -- production: s3://bucket/path
    file_size          BIGINT       NOT NULL,
    mime_type          TEXT         NOT NULL,
    uploaded_by        TEXT         NOT NULL,
    virus_scan_status  TEXT         NOT NULL DEFAULT 'pending',
        -- pending / clean / infected / failed
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CHECK (virus_scan_status IN ('pending','clean','infected','failed')),
    CHECK (file_size > 0 AND file_size <= 20971520)  -- 20 MB
);

CREATE INDEX IF NOT EXISTS ix_cms_attach_case
  ON app_cases.cms_case_attachments (case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_cms_attach_scan_pending
  ON app_cases.cms_case_attachments (tenant_id, created_at DESC)
  WHERE virus_scan_status = 'pending';

-- ─── cms_case_assignments ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_cases.cms_case_assignments (
    assignment_id   UUID         PRIMARY KEY,
    case_id         UUID         NOT NULL REFERENCES app_cases.cms_cases(case_id) ON DELETE CASCADE,
    tenant_id       TEXT         NOT NULL,
    assigned_to     TEXT         NOT NULL,
    assigned_by     TEXT         NOT NULL,
    assigned_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    unassigned_at   TIMESTAMPTZ,
        -- Set when this assignment is superseded; NULL = currently active
    reason          TEXT
);

CREATE INDEX IF NOT EXISTS ix_cms_assignments_case_time
  ON app_cases.cms_case_assignments (case_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS ix_cms_assignments_active
  ON app_cases.cms_case_assignments (tenant_id, assigned_to)
  WHERE unassigned_at IS NULL;

-- ─── cms_case_history ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_cases.cms_case_history (
    history_id    UUID         PRIMARY KEY,
    case_id       UUID         NOT NULL REFERENCES app_cases.cms_cases(case_id) ON DELETE CASCADE,
    tenant_id     TEXT         NOT NULL,
    action_type   TEXT         NOT NULL,
        -- create / update / transition / assign / unassign / escalate /
        -- close / reopen / note_added / attachment_added / attachment_deleted
    old_value     JSONB,
    new_value     JSONB,
    performed_by  TEXT         NOT NULL,
    performed_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_cms_history_case_time
  ON app_cases.cms_case_history (case_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS ix_cms_history_tenant_time
  ON app_cases.cms_case_history (tenant_id, performed_at DESC);

COMMENT ON TABLE app_cases.cms_case_history IS
    'Per-case immutable audit slice. Mirrors entries in the M9.4 case-event journal but keyed on case_id for fast per-case timelines. Retain 7 years per banking compliance.';
