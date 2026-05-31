-- ZorEWS · 053 · Enterprise Governance Center — Business Calendars
--
-- Additive substrate for the Governance Center's Section 10 (Business
-- Calendar). The T11 master framework (data/schema/048_master_setup.sql)
-- already provides generic master_entities + master_entity_rows tables,
-- and the new `regions` + `business-calendars` schemas land there via
-- the registry. This migration adds the SPECIALISED holiday-resolution
-- helper table that lets SLA + escalation timers do business-day math
-- without re-parsing the master row's CSV on every query.
--
-- IDEMPOTENT — CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Re-runs are no-ops.
--
-- BACKWARD COMPATIBILITY — no existing column dropped or renamed. The
-- T11 master framework continues to be the source of truth for the
-- editable representation; this table is a derived view, populated on
-- master save via the existing master_audit fan-out hook (production
-- swap is one trigger; the prototype hydrates on read).

BEGIN;

-- Per-tenant, per-calendar resolved holiday list. Joins back to the
-- T11 master row via (tenant_id, calendar_code). Populated by the
-- BFF on calendar save; queried by SLA + escalation business-day
-- calculators.
CREATE TABLE IF NOT EXISTS app_iam.business_calendar_holidays (
  tenant_id      TEXT NOT NULL DEFAULT 'BANK_DEMO' REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  calendar_code  TEXT NOT NULL,
  holiday_date   DATE NOT NULL,
  description    TEXT CHECK (description IS NULL OR char_length(description) <= 500),
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by       TEXT,
  PRIMARY KEY (tenant_id, calendar_code, holiday_date)
);
CREATE INDEX IF NOT EXISTS ix_business_calendar_holidays_date
  ON app_iam.business_calendar_holidays (tenant_id, holiday_date);
CREATE INDEX IF NOT EXISTS ix_business_calendar_holidays_calendar
  ON app_iam.business_calendar_holidays (tenant_id, calendar_code);

-- Governance change ledger — captures cross-section governance edits
-- (regions / calendars / domain config / role templates) for the
-- compliance-officer "what changed in governance this quarter" pack.
-- Distinct from the T11 master_audit table (per-entity row-level) +
-- the M15 audit chain (cryptographic per-action ledger) — this is the
-- governance-domain rollup that the Governance Center surfaces.
CREATE TABLE IF NOT EXISTS app_iam.governance_change_ledger (
  ledger_id       BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'BANK_DEMO' REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  section         TEXT NOT NULL CHECK (section IN (
    'organization','domain','tenant','role','risk','alert',
    'escalation','sla','notification','calendar','approval'
  )),
  entity          TEXT NOT NULL,
  entity_id       TEXT,
  action          TEXT NOT NULL CHECK (action IN ('create','update','delete','approve','reject','enable','disable')),
  actor           TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  before_state    JSONB,
  after_state     JSONB,
  comments        TEXT CHECK (comments IS NULL OR char_length(comments) <= 4000),
  correlation_id  TEXT
);
CREATE INDEX IF NOT EXISTS ix_governance_change_ledger_tenant_section
  ON app_iam.governance_change_ledger (tenant_id, section, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_governance_change_ledger_entity
  ON app_iam.governance_change_ledger (tenant_id, entity, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_governance_change_ledger_actor
  ON app_iam.governance_change_ledger (actor, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_governance_change_ledger_correlation
  ON app_iam.governance_change_ledger (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMIT;
