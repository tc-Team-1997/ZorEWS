-- 011_user_2fa.sql
-- APEX EWS — TOTP-based 2FA enrolment table (T5 Module 1.1).
--
-- First sub-phase of T5 (BIL 16-module expansion). Module 1 (Auth +
-- User Management) lists 35 APIs; most are already shipped via Phases
-- 1-12 of T4.24. This migration closes the 2FA gap — TOTP enrolment
-- per RFC 6238, mirrors what DataNetworks-EWS-Ver1.pdf §19 calls out
-- as "MFA & Login" and what BAC A user manual treats as standard.
--
-- One row per (user_id) — a user has at most one active TOTP secret
-- at a time. Re-enrolling overwrites; disable deletes. Production
-- swaps the in-table secret for KMS-encrypted-at-rest; for the
-- prototype we store base32 plaintext (the same TOTP secrets a user
-- has in their authenticator app — cleartext is acceptable inside
-- the auth-svc trust boundary).

CREATE TABLE IF NOT EXISTS app_iam.user_2fa_secrets (
    user_id          TEXT        PRIMARY KEY REFERENCES app_iam.users(user_id) ON DELETE CASCADE,
    secret_base32    TEXT        NOT NULL,
        -- TOTP shared secret (RFC 6238). 20-byte random encoded base32 →
        -- ~32 chars. Production: encrypt at rest with KMS envelope key.
    issuer           TEXT        NOT NULL DEFAULT 'APEX EWS',
        -- Shows up in the authenticator app entry name.
    algorithm        TEXT        NOT NULL DEFAULT 'SHA1',
        -- RFC 6238 default. SHA256 also valid; some authenticators
        -- (older Google Authenticator) only support SHA1.
    digits           INTEGER     NOT NULL DEFAULT 6 CHECK (digits IN (6, 8)),
    period_seconds   INTEGER     NOT NULL DEFAULT 30 CHECK (period_seconds > 0),
    enrolled_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- Set on completed enrolment (after the user has verified the
        -- first TOTP code). Pending-enrolment rows are deleted by the
        -- TTL job; only verified rows persist.
    last_used_at     TIMESTAMPTZ,
    backup_codes     TEXT[]      NOT NULL DEFAULT '{}',
        -- Single-use recovery codes (10 by default), hashed argon2id.
        -- NOT plaintext — the user gets the plaintext list once at
        -- enrolment; lost codes mean admin must disable 2FA.
    CHECK (cardinality(backup_codes) <= 50)
);

CREATE INDEX IF NOT EXISTS ix_app_iam_user_2fa_enrolled
    ON app_iam.user_2fa_secrets (enrolled_at);

COMMENT ON TABLE app_iam.user_2fa_secrets IS
    'TOTP enrolment per user. One row per user (re-enrol overwrites). Production swaps secret_base32 for KMS-encrypted bytes.';
