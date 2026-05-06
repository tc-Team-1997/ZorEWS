-- 015_ews_rules_versions.sql
--
-- EWS Rules-Plus (RP-1) — version snapshots + approval ledger.
--
-- Layered ON TOP of the EWS-1..5 rules engine. The existing
-- app.ews_rules + app.ews_rule_executions tables (012_ews_rules.sql)
-- stay frozen. Two new tables.
--
-- Forward-looking schema; runtime stays in-memory in the prototype.

CREATE SCHEMA IF NOT EXISTS app;

-- ─── ews_rule_versions ────────────────────────────────────────────────
--
-- One row per rule edit. Captures the FULL rule body at that moment so
-- the SPA's Diff Viewer can compare any two SemVer points.

CREATE TABLE IF NOT EXISTS app.ews_rule_versions (
    version_id    UUID         PRIMARY KEY,
    rule_id       TEXT         NOT NULL,
    tenant_id     TEXT         NOT NULL,
    semver        TEXT         NOT NULL,
        -- format: X.Y.Z (SemVer)
    snapshot      JSONB        NOT NULL,
        -- the entire EwsRule body at the time of recording
    created_by    TEXT         NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    reason        TEXT,

    UNIQUE (tenant_id, rule_id, semver),
    FOREIGN KEY (tenant_id, rule_id) REFERENCES app.ews_rules(tenant_id, rule_id)
        ON DELETE CASCADE,
    CHECK (semver ~ '^[0-9]+\.[0-9]+\.[0-9]+$')
);

CREATE INDEX IF NOT EXISTS ix_ews_rule_versions_rule
  ON app.ews_rule_versions (tenant_id, rule_id, created_at DESC);

COMMENT ON TABLE app.ews_rule_versions IS
    'Per-rule SemVer snapshot history. Cap 50 versions per rule with FIFO eviction in the prototype runtime; production retention is configurable.';

-- ─── ews_rule_approvals ───────────────────────────────────────────────
--
-- Maker-checker ledger. Every /submit creates a `pending` row;
-- /approve flips it to `approved` (refusing if approver === maker);
-- /reject flips it to `rejected` with a reason. Re-submitting an
-- already-pending rule withdraws the prior submission.

CREATE TABLE IF NOT EXISTS app.ews_rule_approvals (
    approval_id          UUID         PRIMARY KEY,
    rule_id              TEXT         NOT NULL,
    tenant_id            TEXT         NOT NULL,
    maker_username       TEXT         NOT NULL,
    approver_username    TEXT,
        -- NULL until the approval is decided
    decision             TEXT         NOT NULL,
        -- pending / approved / rejected / withdrawn
    reason               TEXT,
    submitted_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    decided_at           TIMESTAMPTZ,

    FOREIGN KEY (tenant_id, rule_id) REFERENCES app.ews_rules(tenant_id, rule_id)
        ON DELETE CASCADE,
    CHECK (decision IN ('pending','approved','rejected','withdrawn')),
    -- A pending row must have NULL approver + decided_at; non-pending
    -- rows must have BOTH set (approver_username + decided_at).
    CHECK (
        (decision = 'pending' AND approver_username IS NULL AND decided_at IS NULL) OR
        (decision IN ('approved','rejected') AND approver_username IS NOT NULL AND decided_at IS NOT NULL) OR
        (decision = 'withdrawn' AND decided_at IS NOT NULL)
    ),
    -- 4-eyes: when decided, approver must NOT equal maker.
    CHECK (
        approver_username IS NULL OR approver_username <> maker_username
    )
);

CREATE INDEX IF NOT EXISTS ix_ews_rule_approvals_rule
  ON app.ews_rule_approvals (tenant_id, rule_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS ix_ews_rule_approvals_pending
  ON app.ews_rule_approvals (tenant_id, rule_id)
  WHERE decision = 'pending';

COMMENT ON TABLE app.ews_rule_approvals IS
    'Maker-checker ledger for rule activation. The approver_username <> maker_username CHECK enforces the 4-eyes principle at the DB layer in addition to the application layer.';
