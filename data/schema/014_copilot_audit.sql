-- 014_copilot_audit.sql
--
-- EWS AI Copilot — conversation persistence + audit log (Copilot-1).
--
-- Forward-looking schema; runtime stays in-memory in the prototype
-- (matches recent CMS / EWS Rules / M9.4 posture). 3 tables under a
-- new app_copilot schema so they don't collide with the existing
-- app.audit_events surface.

CREATE SCHEMA IF NOT EXISTS app_copilot;

-- ─── conversations ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_copilot.conversations (
    conversation_id    UUID         PRIMARY KEY,
    tenant_id          TEXT         NOT NULL,
    user_id            TEXT         NOT NULL,
    started_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_message_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    message_count      INTEGER      NOT NULL DEFAULT 0,
    initial_page       TEXT,
    initial_entity_id  TEXT
);
CREATE INDEX IF NOT EXISTS ix_copilot_conv_tenant_user
  ON app_copilot.conversations (tenant_id, user_id, last_message_at DESC);

COMMENT ON TABLE app_copilot.conversations IS
    'Per-(tenant, user) chat sessions. message_count + last_message_at maintained on append. Cap 1000 / tenant in the prototype with FIFO eviction.';

-- ─── messages ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_copilot.messages (
    message_id        UUID         PRIMARY KEY,
    conversation_id   UUID         NOT NULL REFERENCES app_copilot.conversations(conversation_id) ON DELETE CASCADE,
    tenant_id         TEXT         NOT NULL,
    role              TEXT         NOT NULL,    -- user | assistant
    text              TEXT         NOT NULL,    -- ALREADY MASKED for role=user
    matched_intent    TEXT,
    ts                TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CHECK (role IN ('user','assistant'))
);
CREATE INDEX IF NOT EXISTS ix_copilot_msg_conv_ts
  ON app_copilot.messages (conversation_id, ts);

COMMENT ON COLUMN app_copilot.messages.text IS
    'For role=user this is the MASKED text — PII tokens replaced with [EMAIL]/[PHONE]/etc placeholders before persistence so the audit trail is safe to re-read.';

-- ─── audit_log ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_copilot.audit_log (
    audit_id           UUID         PRIMARY KEY,
    sequence_no        BIGINT       NOT NULL,
        -- per-tenant monotonic; stable across FIFO eviction
    tenant_id          TEXT         NOT NULL,
    user_id            TEXT         NOT NULL,
    conversation_id    UUID,         -- nullable when query couldn't be tied to a session
    intent             TEXT,
    page               TEXT,
    entity_type        TEXT,
    entity_id          TEXT,
    message_length     INTEGER      NOT NULL,
    masked_pii_kinds   TEXT[]       NOT NULL DEFAULT '{}',
    used_llm           BOOLEAN      NOT NULL DEFAULT FALSE,
    occurred_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_copilot_audit_tenant_time
  ON app_copilot.audit_log (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_copilot_audit_user_time
  ON app_copilot.audit_log (tenant_id, user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_copilot_audit_pii
  ON app_copilot.audit_log (tenant_id, occurred_at DESC)
  WHERE array_length(masked_pii_kinds, 1) > 0;

COMMENT ON TABLE app_copilot.audit_log IS
    'Compliance audit trail — one row per copilot query. masked_pii_kinds enumerates which PII patterns the masker detected; used_llm distinguishes templated vs LLM-routed responses for cost attribution.';
