-- ZorEWS · 052 · Enterprise IAM — User Lifecycle Management layer
--
-- Adds the schema substrate for the 6 IAM features (status mgmt + password
-- governance + session enrichment + access review + approval workflow + audit
-- history). Strictly additive over the existing app_iam.users / app_iam.sessions
-- / app_iam.audit_events tables shipped in 004_app_schemas.sql.
--
-- IDEMPOTENT — every CREATE uses IF NOT EXISTS; every ALTER uses ADD COLUMN
-- IF NOT EXISTS; CHECK + FK additions wrapped in DO-blocks with EXCEPTION
-- WHEN duplicate_object so re-runs are no-ops.
--
-- BACKWARD COMPATIBILITY — no existing column dropped or renamed. New
-- app_iam.users.status is the canonical lifecycle state; the legacy
-- 'locked' boolean stays in place and is kept in sync via a BEFORE-UPDATE
-- trigger so every existing query against locked= still works.

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- 1. ADDITIVE columns on existing tables.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS app_iam.users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS department TEXT,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_logout_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS active_session_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  BEGIN
    ALTER TABLE app_iam.users
      ADD CONSTRAINT users_status_check
      CHECK (status IN ('active','inactive','suspended','locked','pending_approval'));
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END$$;

ALTER TABLE IF EXISTS app_iam.sessions
  ADD COLUMN IF NOT EXISTS browser TEXT,
  ADD COLUMN IF NOT EXISTS device TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS logout_at TIMESTAMPTZ;

-- Keep legacy `locked` boolean in sync with new canonical `status`. Either
-- side can be the source of truth; trigger reconciles before write.
CREATE OR REPLACE FUNCTION app_iam.sync_user_locked_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'locked' AND NEW.locked IS DISTINCT FROM TRUE THEN
    NEW.locked := TRUE;
  ELSIF NEW.status <> 'locked' AND NEW.locked IS DISTINCT FROM FALSE
        AND OLD.status <> 'locked' THEN
    -- only force locked=false when status changed away from locked
    NEW.locked := FALSE;
  END IF;
  -- mirror the other way: if caller flipped locked, reflect into status
  IF NEW.locked = TRUE AND NEW.status <> 'locked' THEN
    NEW.status := 'locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_sync_locked_status ON app_iam.users;
CREATE TRIGGER trg_users_sync_locked_status
  BEFORE UPDATE ON app_iam.users
  FOR EACH ROW EXECUTE FUNCTION app_iam.sync_user_locked_status();

-- ────────────────────────────────────────────────────────────────────
-- 2. NEW tables.
-- ────────────────────────────────────────────────────────────────────

-- F1 — append-only status transition ledger.
CREATE TABLE IF NOT EXISTS app_iam.user_status_history (
  history_id     BIGSERIAL PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES app_iam.users(id) ON DELETE CASCADE,
  tenant_id      TEXT NOT NULL DEFAULT 'BANK_DEMO' REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  prev_status    TEXT CHECK (prev_status IN ('active','inactive','suspended','locked','pending_approval')),
  new_status     TEXT NOT NULL CHECK (new_status IN ('active','inactive','suspended','locked','pending_approval')),
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by     TEXT,
  reason         TEXT CHECK (reason IS NULL OR char_length(reason) <= 2000),
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_user_status_history_user
  ON app_iam.user_status_history (user_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS ix_user_status_history_tenant_status
  ON app_iam.user_status_history (tenant_id, new_status, changed_at DESC);

-- F2a — per-tenant password policy override.
CREATE TABLE IF NOT EXISTS app_iam.password_policies (
  tenant_id                   TEXT PRIMARY KEY REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  min_len                     INTEGER NOT NULL DEFAULT 12 CHECK (min_len BETWEEN 8 AND 128),
  require_upper               BOOLEAN NOT NULL DEFAULT TRUE,
  require_lower               BOOLEAN NOT NULL DEFAULT TRUE,
  require_digit               BOOLEAN NOT NULL DEFAULT TRUE,
  require_symbol              BOOLEAN NOT NULL DEFAULT TRUE,
  expiry_days                 INTEGER NOT NULL DEFAULT 90  CHECK (expiry_days BETWEEN 0 AND 730),
  history_count               INTEGER NOT NULL DEFAULT 5   CHECK (history_count BETWEEN 0 AND 50),
  lockout_threshold           INTEGER NOT NULL DEFAULT 5   CHECK (lockout_threshold BETWEEN 3 AND 20),
  lockout_window_min          INTEGER NOT NULL DEFAULT 15  CHECK (lockout_window_min BETWEEN 1 AND 1440),
  reminder_days_before_expiry INTEGER NOT NULL DEFAULT 7   CHECK (reminder_days_before_expiry BETWEEN 0 AND 60),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                  TEXT
);

-- F2b — per-user password lifecycle metadata.
CREATE TABLE IF NOT EXISTS app_iam.user_password_metadata (
  user_id            TEXT PRIMARY KEY REFERENCES app_iam.users(id) ON DELETE CASCADE,
  last_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ,
  must_reset         BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_sent_at   TIMESTAMPTZ,
  force_reset_at     TIMESTAMPTZ,
  force_reset_by     TEXT,
  force_reset_reason TEXT CHECK (force_reset_reason IS NULL OR char_length(force_reset_reason) <= 1000),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_user_password_metadata_expires
  ON app_iam.user_password_metadata (expires_at)
  WHERE expires_at IS NOT NULL AND must_reset = FALSE;
CREATE INDEX IF NOT EXISTS ix_user_password_metadata_must_reset
  ON app_iam.user_password_metadata (must_reset)
  WHERE must_reset = TRUE;

-- F5 — IAM maker-checker queue (distinct from app_audit.approvals which is
-- generic; this one carries richer per-user payload + auto-execute on approve).
CREATE TABLE IF NOT EXISTS app_iam.user_approvals (
  approval_id       TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  tenant_id         TEXT NOT NULL DEFAULT 'BANK_DEMO' REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  action_type       TEXT NOT NULL CHECK (action_type IN ('user_create','user_role_change','user_status_change','user_delete','user_access_grant','password_force_reset')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','expired')),
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by      TEXT NOT NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_comments  TEXT CHECK (request_comments IS NULL OR char_length(request_comments) <= 4000),
  approver          TEXT,
  approval_date     TIMESTAMPTZ,
  decision_comments TEXT CHECK (decision_comments IS NULL OR char_length(decision_comments) <= 4000),
  expires_at        TIMESTAMPTZ,
  CONSTRAINT user_approvals_no_self_approval CHECK (approver IS NULL OR approver <> requested_by)
);
CREATE INDEX IF NOT EXISTS ix_user_approvals_status
  ON app_iam.user_approvals (tenant_id, status, requested_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_user_approvals_user
  ON app_iam.user_approvals (user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS ix_user_approvals_action_type
  ON app_iam.user_approvals (tenant_id, action_type, status);
CREATE INDEX IF NOT EXISTS ix_user_approvals_approver
  ON app_iam.user_approvals (approver, approval_date DESC)
  WHERE approver IS NOT NULL;

-- F6 — per-user event timeline with before/after JSON snapshots. Fans out to
-- the M15 audit.event_log hash-chain via audit_event_log.ts at write time.
CREATE TABLE IF NOT EXISTS app_iam.user_audit_history (
  audit_id       BIGSERIAL PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES app_iam.users(id) ON DELETE CASCADE,
  tenant_id      TEXT NOT NULL DEFAULT 'BANK_DEMO' REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL CHECK (event_type IN (
    'user_created','user_updated','password_reset','role_changed',
    'access_changed','status_changed','approval_requested','approval_decided',
    'session_terminated','profile_updated','lifecycle_bulk_update'
  )),
  before_state   JSONB,
  after_state    JSONB,
  actor          TEXT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  comments       TEXT CHECK (comments IS NULL OR char_length(comments) <= 4000),
  correlation_id TEXT,
  ip_address     TEXT
);
CREATE INDEX IF NOT EXISTS ix_user_audit_history_user
  ON app_iam.user_audit_history (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_user_audit_history_tenant_event
  ON app_iam.user_audit_history (tenant_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_user_audit_history_actor
  ON app_iam.user_audit_history (actor, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_user_audit_history_correlation
  ON app_iam.user_audit_history (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMIT;
