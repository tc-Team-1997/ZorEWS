-- 003_audit_table.sql
-- APEX EWS — append-only, hash-chained audit log (NFR-AUDIT).
-- Every write to audit.event_log carries:
--   * prev_hash  — sha256 of the previous row in the chain (or 64 zeros for genesis).
--   * payload    — canonical jsonb describing the event.
--   * event_hash — sha256(prev_hash || canonical(payload) || event_ts || actor || event_type).
-- A trigger enforces the chain at INSERT time and refuses UPDATEs / DELETEs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS audit.event_log (
    event_id        BIGSERIAL PRIMARY KEY,
    event_ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type      TEXT        NOT NULL,   -- INGEST / TRANSFORM / RULE_FIRE / ALERT / CASE / LOGIN / etc.
    actor           TEXT        NOT NULL,   -- service name or username
    subject_id      TEXT,                   -- customer_id / loan_id / case_id / …
    correlation_id  TEXT,
    source_ip       INET,
    payload         JSONB       NOT NULL,
    prev_hash       BYTEA       NOT NULL,
    event_hash      BYTEA       NOT NULL,
    CHECK (octet_length(prev_hash)  = 32),
    CHECK (octet_length(event_hash) = 32)
);

CREATE INDEX IF NOT EXISTS ix_audit_event_log_ts
    ON audit.event_log (event_ts);
CREATE INDEX IF NOT EXISTS ix_audit_event_log_subject
    ON audit.event_log (subject_id);
CREATE INDEX IF NOT EXISTS ix_audit_event_log_type
    ON audit.event_log (event_type);

COMMENT ON TABLE audit.event_log IS
    'Append-only hash-chained audit log. Updates and deletes are blocked by trigger.';

-- ---------------------------------------------------------------
-- Hash-chain enforcement trigger
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.fn_event_log_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    last_hash  BYTEA;
    expected   BYTEA;
    canonical  TEXT;
BEGIN
    SELECT event_hash
      INTO last_hash
      FROM audit.event_log
     ORDER BY event_id DESC
     LIMIT 1;

    IF last_hash IS NULL THEN
        last_hash := decode(repeat('0', 64), 'hex');  -- genesis
    END IF;

    IF NEW.prev_hash IS NULL THEN
        NEW.prev_hash := last_hash;
    ELSIF NEW.prev_hash <> last_hash THEN
        RAISE EXCEPTION
          'audit.event_log chain broken: expected prev_hash=%, got=%',
          encode(last_hash,'hex'), encode(NEW.prev_hash,'hex');
    END IF;

    canonical := NEW.event_ts::text
              || '|' || NEW.event_type
              || '|' || NEW.actor
              || '|' || COALESCE(NEW.subject_id,'')
              || '|' || NEW.payload::text;

    expected := digest(NEW.prev_hash || canonical::bytea, 'sha256');

    IF NEW.event_hash IS NULL THEN
        NEW.event_hash := expected;
    ELSIF NEW.event_hash <> expected THEN
        RAISE EXCEPTION
          'audit.event_log hash mismatch (computed=%, supplied=%)',
          encode(expected,'hex'), encode(NEW.event_hash,'hex');
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_log_chain ON audit.event_log;
CREATE TRIGGER trg_event_log_chain
BEFORE INSERT ON audit.event_log
FOR EACH ROW
EXECUTE FUNCTION audit.fn_event_log_chain();

-- ---------------------------------------------------------------
-- Block updates and deletes
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.fn_event_log_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit.event_log is append-only (% blocked)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_log_no_update ON audit.event_log;
CREATE TRIGGER trg_event_log_no_update
BEFORE UPDATE ON audit.event_log
FOR EACH ROW EXECUTE FUNCTION audit.fn_event_log_immutable();

DROP TRIGGER IF EXISTS trg_event_log_no_delete ON audit.event_log;
CREATE TRIGGER trg_event_log_no_delete
BEFORE DELETE ON audit.event_log
FOR EACH ROW EXECUTE FUNCTION audit.fn_event_log_immutable();
