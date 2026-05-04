-- 004_app_schemas.sql
-- APEX EWS — application-data schemas.
--
-- Created 2026-05-03 to give the operational stores (auth-svc, cases, alerts,
-- bff webhooks, scenario simulator) a real Postgres home. Up to today these
-- lived in process memory + NDJSON files; data was lost on every restart and
-- DBeaver showed nothing. This migration provisions the tables and the next
-- per-service migration wires reads/writes through these tables.
--
-- Schemas:
--   app_iam       : users, sessions, password history, auth audit
--   app_cases     : case state-machine records + action log
--   app_alerts    : alert queue + smart-queue assignments
--   app_bff       : webhook subscriptions + delivery log
--   app_scenario  : saved scenario runs (with full result JSONB)
--
-- Conventions (mirror the analytics schemas in 002_raw_tables.sql + dbt mart):
--   * TEXT primary keys (no autoincrement) — opaque domain identifiers.
--   * TIMESTAMPTZ everywhere; never naive timestamps.
--   * BIGSERIAL surrogate `id` only on append-only event-style tables
--     (sessions, audit, deliveries) where the natural key is "happened then".
--   * Cross-schema FKs are NOT declared — services may evolve their own
--     identifiers and we don't want a CASCADE through schema boundaries.
--   * Indexes only where the access pattern justifies them — added per table.

CREATE SCHEMA IF NOT EXISTS app_iam       AUTHORIZATION CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS app_cases     AUTHORIZATION CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS app_alerts    AUTHORIZATION CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS app_bff       AUTHORIZATION CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS app_scenario  AUTHORIZATION CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS app_audit     AUTHORIZATION CURRENT_USER;

COMMENT ON SCHEMA app_iam      IS 'Identity + access — users, sessions, password history, auth audit. Owned by services/auth-svc.';
COMMENT ON SCHEMA app_cases    IS 'Case state machine + action log. Owned by services/regulatory-svc/cases.';
COMMENT ON SCHEMA app_alerts   IS 'Alert queue + smart-queue assignments. Owned by services/regulatory-svc/alerts.';
COMMENT ON SCHEMA app_bff      IS 'BFF-owned data: outbound webhook subscriptions + delivery log. Owned by services/bff.';
COMMENT ON SCHEMA app_scenario IS 'Saved scenario simulation runs. Owned by services/bff scenario routes.';
COMMENT ON SCHEMA app_audit    IS 'Cross-cutting maker-checker approvals (T4.20, BAC-A §3.1.4). Distinct from `audit` (hash-chained immutable trail) — `app_audit.approvals` is mutable as approval state evolves (pending → approved/rejected/rework).';

-- =========================================================================
-- app_iam
-- =========================================================================

-- app_iam.users — operator accounts.
-- Mirrors services/auth-svc/src/users.ts DEMO_USERS shape but with the
-- production fields (must_change_password, terms_accepted_at, lockout state).
CREATE TABLE IF NOT EXISTS app_iam.users (
    user_id              TEXT        PRIMARY KEY,
    username             TEXT        NOT NULL UNIQUE,
    email                TEXT        NOT NULL UNIQUE,
    display_name         TEXT        NOT NULL,
    role                 TEXT        NOT NULL,
        -- admin / risk_analyst / supervisor / collection_officer / field_officer
    password_hash        TEXT        NOT NULL,        -- argon2id
    failed_login_count   INTEGER     NOT NULL DEFAULT 0,
    lockout_until        TIMESTAMPTZ,                 -- NULL = not locked
    must_change_password BOOLEAN     NOT NULL DEFAULT FALSE,
    terms_accepted_at    TIMESTAMPTZ,                 -- first-login wizard timestamp
    locked               BOOLEAN     NOT NULL DEFAULT FALSE,    -- admin-imposed lock
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at        TIMESTAMPTZ,
    CHECK (role IN ('admin','risk_analyst','supervisor','collection_officer','field_officer'))
);
CREATE INDEX IF NOT EXISTS ix_app_iam_users_role ON app_iam.users (role);

COMMENT ON TABLE app_iam.users IS
    'Operator accounts. Mirrors services/auth-svc/src/users.ts DEMO_USERS in production.';

-- app_iam.sessions — server-tracked login sessions (the `sid` JWT claim
-- references this row). Refresh + /auth/me check the revoked flag here.
CREATE TABLE IF NOT EXISTS app_iam.sessions (
    sid              TEXT        PRIMARY KEY,
    user_id          TEXT        NOT NULL REFERENCES app_iam.users(user_id) ON DELETE CASCADE,
    issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL,
    ip               INET,
    user_agent       TEXT,
    revoked          BOOLEAN     NOT NULL DEFAULT FALSE,
    revoked_at       TIMESTAMPTZ,
    revoked_reason   TEXT
);
CREATE INDEX IF NOT EXISTS ix_app_iam_sessions_user ON app_iam.sessions (user_id);
CREATE INDEX IF NOT EXISTS ix_app_iam_sessions_active ON app_iam.sessions (user_id) WHERE NOT revoked;

COMMENT ON TABLE app_iam.sessions IS
    'Active + historical login sessions. The sid JWT claim is the PK; refresh + /auth/me check `revoked`.';

-- app_iam.password_history — last 5 argon2 hashes per user. Insert-only;
-- the auth-svc trims old rows beyond the 5-most-recent at password-change time.
CREATE TABLE IF NOT EXISTS app_iam.password_history (
    id          BIGSERIAL   PRIMARY KEY,
    user_id     TEXT        NOT NULL REFERENCES app_iam.users(user_id) ON DELETE CASCADE,
    password_hash TEXT      NOT NULL,
    set_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_app_iam_pwd_history_user ON app_iam.password_history (user_id, set_at DESC);

-- app_iam.audit_events — auth-svc audit log (login_success, login_failure,
-- password_change, session_revoke, etc.). Mirrors the in-memory AuthAuditLog.
-- Production also forwards each row to audit.event_log for the hash-chained
-- regulatory trail; this table is the queryable mirror.
CREATE TABLE IF NOT EXISTS app_iam.audit_events (
    id               BIGSERIAL   PRIMARY KEY,
    event_type       TEXT        NOT NULL,
        -- login_success / login_failure / password_change / password_reset_requested /
        -- password_reset_completed / session_revoked / sessions_revoked_other /
        -- account_locked / account_unlocked / first_login_completed / captcha_failed /
        -- rate_limited / forbidden_endpoint / role_changed / user_created / user_deactivated
    actor_username   TEXT,                  -- NULL for unauthenticated events
    target_username  TEXT,                  -- whose state changed (often = actor)
    ip               INET,
    user_agent       TEXT,
    occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    detail           JSONB                  -- free-form; e.g. {captcha_id, attempt_count}
);
CREATE INDEX IF NOT EXISTS ix_app_iam_audit_target ON app_iam.audit_events (target_username, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_app_iam_audit_type   ON app_iam.audit_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_app_iam_audit_time   ON app_iam.audit_events (occurred_at DESC);

-- app_iam.user_teams — Issue Owner Groups + branch-scoped team rosters
-- (T4.21, BAC-A manual §3.1.7.1.5). CAPs use issue_owner_group to assign
-- work; without a team table, the field is a free-text string and ops
-- can't ask "who's on the legal team in branch X?". Mandatory fields
-- per the manual: name, branch, role, team_leader. Optional: email,
-- description, sub_team (folded into a future hierarchy if needed).
CREATE TABLE IF NOT EXISTS app_iam.user_teams (
    team_id        TEXT        PRIMARY KEY,
    name           TEXT        NOT NULL,
    branch         TEXT        NOT NULL,
    role           TEXT        NOT NULL,
        -- e.g. 'issue_owner' / 'debt_settlement' / 'legal' / 'credit'
    team_leader    TEXT        NOT NULL REFERENCES app_iam.users(user_id) ON DELETE RESTRICT,
    email          TEXT,
    description    TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (name, branch)
);
CREATE INDEX IF NOT EXISTS ix_app_iam_teams_branch ON app_iam.user_teams (branch);
CREATE INDEX IF NOT EXISTS ix_app_iam_teams_role   ON app_iam.user_teams (role);
CREATE INDEX IF NOT EXISTS ix_app_iam_teams_leader ON app_iam.user_teams (team_leader);

COMMENT ON TABLE app_iam.user_teams IS
    'Issue Owner Groups + branch teams (BAC-A §3.1.7.1.5). Used by CAPs to assign work to a group → specific user.';

-- app_iam.user_team_members — many-to-many. A user can be on multiple
-- teams (e.g. an RM in both their home branch team and a special-projects
-- team). FK CASCADE on both sides — deleting a user or a team removes the
-- membership rows automatically.
CREATE TABLE IF NOT EXISTS app_iam.user_team_members (
    id          BIGSERIAL   PRIMARY KEY,
    team_id     TEXT        NOT NULL REFERENCES app_iam.user_teams(team_id) ON DELETE CASCADE,
    user_id     TEXT        NOT NULL REFERENCES app_iam.users(user_id) ON DELETE CASCADE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_app_iam_team_members_user ON app_iam.user_team_members (user_id);
CREATE INDEX IF NOT EXISTS ix_app_iam_team_members_team ON app_iam.user_team_members (team_id);

-- app_iam.leave_covers — task-delegation during operator absence
-- (T4.22, BAC-A manual §3.1.9.1.3). Per the manual: a user "assigns
-- his/her tasks for a time period to another user". During the cover
-- window, callers querying "who's covering for alice today?" get the
-- coverer's username back; the SPA's assignment dropdown uses this to
-- auto-route work without involving the case service in cross-service
-- lookup logic (same design choice as T4.21 teams — see gap doc).
--
-- in_office=true means the applicant is still working but covering for
-- a specific role/scope (e.g. covering an absent peer); in_office=false
-- is the classic "I'm out, route my tasks to X" case.
CREATE TABLE IF NOT EXISTS app_iam.leave_covers (
    cover_id          TEXT        PRIMARY KEY,
    applicant_user    TEXT        NOT NULL REFERENCES app_iam.users(user_id) ON DELETE CASCADE,
    leave_coverer     TEXT        NOT NULL REFERENCES app_iam.users(user_id) ON DELETE CASCADE,
    role              TEXT        NOT NULL,           -- the role/scope being covered
    start_date        DATE        NOT NULL,
    end_date          DATE        NOT NULL,
    in_office         BOOLEAN     NOT NULL DEFAULT FALSE,
    comments          TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at      TIMESTAMPTZ,                    -- NULL = active; non-NULL = cancelled
    CHECK (end_date >= start_date),
    CHECK (applicant_user <> leave_coverer)
);
CREATE INDEX IF NOT EXISTS ix_app_iam_leave_covers_applicant_active ON app_iam.leave_covers (applicant_user, end_date)
    WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_app_iam_leave_covers_coverer ON app_iam.leave_covers (leave_coverer);

COMMENT ON TABLE app_iam.leave_covers IS
    'Operator leave-cover delegations (BAC-A §3.1.9.1.3). Used by the SPA assignment dropdown to auto-route work to the coverer when the applicant is on cover.';

-- app_iam.role_dashboard_widgets — per-role dashboard widget visibility +
-- ordering (T4.23, BAC-A manual §3.1.9.1.4). The SPA dashboard renders a
-- fixed catalogue of widgets (Portfolio Risk, Industry Risk, Risk Profile,
-- Frequently Breached, Trend Analysis, Task — the widget_ids are
-- catalogued in web/src/modules/dashboard/widgetCatalogue.ts). Without
-- this table every role sees every widget; admins want to hide irrelevant
-- panels for collection_officer / field_officer + reorder priority.
--
-- Composite PK keeps "one row per (role, widget_id)" without a surrogate.
-- An empty config for a role means "show defaults" (the SPA falls back to
-- the catalogue's `default_visible` flag).
CREATE TABLE IF NOT EXISTS app_iam.role_dashboard_widgets (
    role         TEXT        NOT NULL,
    widget_id    TEXT        NOT NULL,
    sort_order   INTEGER     NOT NULL DEFAULT 0,
    is_visible   BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by   TEXT,
    PRIMARY KEY (role, widget_id),
    CHECK (role IN ('admin','risk_analyst','supervisor','collection_officer','field_officer'))
);
CREATE INDEX IF NOT EXISTS ix_app_iam_role_widgets_role ON app_iam.role_dashboard_widgets (role, sort_order);

COMMENT ON TABLE app_iam.role_dashboard_widgets IS
    'Per-role dashboard widget visibility + ordering (BAC-A §3.1.9.1.4). Empty config for a role = SPA falls back to the catalogue defaults.';

-- =========================================================================
-- app_cases
-- =========================================================================

-- app_cases.cases — one row per case (alert → case → assigned → in_action
-- → monitored → closed lifecycle). Mirrors services/regulatory-svc/cases
-- in-memory CaseStore.
CREATE TABLE IF NOT EXISTS app_cases.cases (
    case_id         TEXT        PRIMARY KEY,
    alert_id        TEXT        NOT NULL,        -- origin alert (deterministic from alert_id+customer_id)
    customer_id     TEXT        NOT NULL,        -- denormalised; mart.customer_360 has the full record
    customer_name   TEXT        NOT NULL,
    severity        TEXT        NOT NULL,
    rule_id         TEXT        NOT NULL,
    rule_name       TEXT        NOT NULL,
    state           TEXT        NOT NULL,
        -- open / assigned / in_action / monitored / closed
    assignee        TEXT,                        -- username of the case officer
    loan_id         TEXT,                        -- optional — loan tied to the alert
    reason_summary  TEXT,                        -- short human-readable reason
    outcome         TEXT,                        -- cured / cured_temp / defaulted (set on close)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ,
    sla_status      TEXT        NOT NULL DEFAULT 'on_track',
        -- on_track / approaching / breached / closed
    CHECK (severity IN ('low','medium','high','critical')),
    CHECK (state IN ('open','assigned','in_action','monitored','closed')),
    CHECK (outcome IS NULL OR outcome IN ('cured','cured_temp','defaulted')),
    CHECK (sla_status IN ('on_track','approaching','breached','closed'))
);
CREATE INDEX IF NOT EXISTS ix_app_cases_state    ON app_cases.cases (state);
CREATE INDEX IF NOT EXISTS ix_app_cases_assignee ON app_cases.cases (assignee);
CREATE INDEX IF NOT EXISTS ix_app_cases_customer ON app_cases.cases (customer_id);
CREATE INDEX IF NOT EXISTS ix_app_cases_sla      ON app_cases.cases (sla_status) WHERE sla_status IN ('approaching','breached');

COMMENT ON TABLE app_cases.cases IS
    'Case state-machine records. State transitions are owned by services/regulatory-svc/cases.';

-- app_cases.actions — append-only action log. Each row is a call/visit/sms/
-- email/note logged against a case by the assigned officer.
CREATE TABLE IF NOT EXISTS app_cases.actions (
    action_id     TEXT        PRIMARY KEY,
    case_id       TEXT        NOT NULL REFERENCES app_cases.cases(case_id) ON DELETE CASCADE,
    kind          TEXT        NOT NULL,
        -- call / visit / sms / email / note
    officer_id    TEXT        NOT NULL,        -- username
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    outcome_note  TEXT,
    gps_lat       NUMERIC(9,6),                -- present for `visit` actions from mobile
    gps_lng       NUMERIC(9,6),
    gps_accuracy_m NUMERIC(7,2),
    CHECK (kind IN ('call','visit','sms','email','note'))
);
CREATE INDEX IF NOT EXISTS ix_app_cases_actions_case ON app_cases.actions (case_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_app_cases_actions_officer ON app_cases.actions (officer_id, occurred_at DESC);

-- app_cases.cas_records — Causal Analysis Stage. Per BAC-A manual §3.1.5,
-- after a case is assigned the RM investigates the cause and proposes either
-- (a) close the case if not severe, or (b) proceed to a Corrective Action
-- Plan. The submission goes through maker → checker (RM Checker / Head of
-- BU per the manual's workflow). One case may have multiple CAS records
-- if the first is reworked or new triggers reopen the analysis.
CREATE TABLE IF NOT EXISTS app_cases.cas_records (
    cas_id              TEXT        PRIMARY KEY,
    case_id             TEXT        NOT NULL REFERENCES app_cases.cases(case_id) ON DELETE CASCADE,
    cause_type          TEXT        NOT NULL,
        -- 'industry_downturn' / 'borrower_specific' / 'data_quality' /
        -- 'macro_shock' / 'fraud_suspected' / 'other'
    cause_summary       TEXT        NOT NULL,
    severity_assessment TEXT        NOT NULL,
        -- 'minor' / 'material' / 'severe'
    decision            TEXT        NOT NULL,
        -- 'close_case' (CAS rejects the alert as non-actionable) /
        -- 'proceed_to_cap' (CAS confirms the alert; CAPs need to be created)
    submitted_by        TEXT        NOT NULL,         -- maker username
    submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by         TEXT,                         -- checker username
    reviewed_at         TIMESTAMPTZ,
    review_status       TEXT        NOT NULL DEFAULT 'pending',
        -- 'pending' / 'approved' / 'rework' / 'rejected'
    review_comments     TEXT,
    attachments         JSONB,                        -- [{name, url, size}]
    CHECK (severity_assessment IN ('minor','material','severe')),
    CHECK (decision IN ('close_case','proceed_to_cap')),
    CHECK (review_status IN ('pending','approved','rework','rejected'))
);
CREATE INDEX IF NOT EXISTS ix_app_cases_cas_case   ON app_cases.cas_records (case_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS ix_app_cases_cas_status ON app_cases.cas_records (review_status) WHERE review_status = 'pending';

COMMENT ON TABLE app_cases.cas_records IS
    'Causal Analysis Stage records. Maker (RM) submits; Checker (RM Checker / Head of BU) approves or returns for rework.';

-- app_cases.caps — Corrective Action Plans. Per BAC-A manual §3.1.5,
-- after CAS approves "proceed_to_cap" the RM proposes one or more CAPs;
-- each CAP has a target completion date and is assigned to an Issue
-- Owner Group → specific Issue Owner. A case can ONLY close when every
-- CAP is closed. Distinct from app_cases.actions, which is the
-- granular call/visit/sms log under each CAP.
CREATE TABLE IF NOT EXISTS app_cases.caps (
    cap_id                  TEXT        PRIMARY KEY,
    case_id                 TEXT        NOT NULL REFERENCES app_cases.cases(case_id) ON DELETE CASCADE,
    cap_item                TEXT        NOT NULL,
        -- 'initiate_legal_action' / 'freeze_ad_hoc_limits' / 'restructure_loan' /
        -- 'request_additional_collateral' / 'increase_monitoring_frequency' / etc.
    issue_owner_group       TEXT        NOT NULL,
        -- 'issue_owner' (RM team) / 'debt_settlement' / 'legal' / 'credit'
    issue_owner             TEXT        NOT NULL,    -- username inside the group
    issue_priority          TEXT        NOT NULL,
        -- 'low_risk' / 'medium_risk' / 'high_risk'
    target_completion_date  DATE        NOT NULL,
    status                  TEXT        NOT NULL DEFAULT 'open',
        -- 'open' (proposed, awaiting checker) / 'in_progress' (approved, owner working) /
        -- 'closed' (owner marked done) / 'overdue' (past target_completion_date and not closed)
    proposed_by             TEXT        NOT NULL,    -- maker username
    proposed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by             TEXT,                    -- checker username
    approved_at             TIMESTAMPTZ,
    closed_at               TIMESTAMPTZ,
    closure_comments        TEXT,
    attachments             JSONB,                    -- [{name, url, size}]
    CHECK (issue_priority IN ('low_risk','medium_risk','high_risk')),
    CHECK (status IN ('open','in_progress','closed','overdue'))
);
CREATE INDEX IF NOT EXISTS ix_app_cases_caps_case   ON app_cases.caps (case_id, proposed_at DESC);
CREATE INDEX IF NOT EXISTS ix_app_cases_caps_owner  ON app_cases.caps (issue_owner) WHERE status IN ('open','in_progress');
CREATE INDEX IF NOT EXISTS ix_app_cases_caps_status ON app_cases.caps (status, target_completion_date)
    WHERE status IN ('open','in_progress');

COMMENT ON TABLE app_cases.caps IS
    'Corrective Action Plans. Maker (RM) proposes; Checker approves; Issue Owner closes when implemented. Case cannot close while any CAP is open.';

-- =========================================================================
-- app_alerts
-- =========================================================================

-- app_alerts.alerts — denormalised alert rows. Mirrors what the BFF maps
-- from canonical apex.regulatory.events.v2 + the prioritization fields
-- (criticality_score, confidence, customer_exposure_kes) added 2026-05-02.
CREATE TABLE IF NOT EXISTS app_alerts.alerts (
    alert_id            TEXT        PRIMARY KEY,
    severity            TEXT        NOT NULL,        -- critical / high / medium / low
    customer_id         TEXT        NOT NULL,
    customer_name       TEXT        NOT NULL,
    rule_id             TEXT        NOT NULL,
    rule_name           TEXT        NOT NULL,
    indicators          TEXT[]      NOT NULL DEFAULT '{}',  -- IND_TXN_*, IND_BEH_* etc.
    confidence          NUMERIC(4,3) NOT NULL,             -- 0..1
    customer_exposure_kes NUMERIC(18,2) NOT NULL,
    criticality_score   NUMERIC(8,2) NOT NULL,
    assignee            TEXT,                              -- 'risk' / 'field' / specific username
    status              TEXT        NOT NULL DEFAULT 'open',
        -- open / acked / closed
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    acked_at            TIMESTAMPTZ,
    closed_at           TIMESTAMPTZ,
    CHECK (severity IN ('critical','high','medium','low')),
    CHECK (status IN ('open','acked','closed')),
    CHECK (confidence >= 0 AND confidence <= 1)
);
CREATE INDEX IF NOT EXISTS ix_app_alerts_severity ON app_alerts.alerts (severity);
CREATE INDEX IF NOT EXISTS ix_app_alerts_customer ON app_alerts.alerts (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_app_alerts_status   ON app_alerts.alerts (status, criticality_score DESC) WHERE status = 'open';

COMMENT ON TABLE app_alerts.alerts IS
    'Alert queue (denormalised). Joins customer + rule names + criticality fields onto the canonical alert event.';

-- app_alerts.queue_assignments — append-only assignment log. Useful for
-- replaying queue history + auditing officer workload.
CREATE TABLE IF NOT EXISTS app_alerts.queue_assignments (
    id              BIGSERIAL   PRIMARY KEY,
    alert_id        TEXT        NOT NULL REFERENCES app_alerts.alerts(alert_id) ON DELETE CASCADE,
    queue           TEXT        NOT NULL,           -- critical / medium / low
    assigned_to     TEXT,                           -- NULL = unassigned in queue
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by     TEXT,                           -- 'system' for auto, else username
    CHECK (queue IN ('critical','medium','low'))
);
CREATE INDEX IF NOT EXISTS ix_app_alerts_assign_alert ON app_alerts.queue_assignments (alert_id, assigned_at DESC);

-- =========================================================================
-- app_bff
-- =========================================================================

-- app_bff.webhook_subscriptions — admin-managed outbound webhook configs.
-- Mirrors services/bff/src/webhooks/store.ts WebhookSubscription. The secret
-- column is hex-encoded HMAC key used for X-APEX-Signature; only readable
-- when the row is first created (auth-svc returns it once via the admin UI).
CREATE TABLE IF NOT EXISTS app_bff.webhook_subscriptions (
    subscription_id      TEXT        PRIMARY KEY,
    name                 TEXT        NOT NULL,
    url                  TEXT        NOT NULL,
    secret               TEXT        NOT NULL,        -- hex; never returned again after create
    events               TEXT[]      NOT NULL,        -- alert.created / scenario.run / etc.
    active               BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_delivery_at     TIMESTAMPTZ,
    last_delivery_status TEXT,                        -- success / failed
    CHECK (last_delivery_status IS NULL OR last_delivery_status IN ('success','failed'))
);
CREATE INDEX IF NOT EXISTS ix_app_bff_webhooks_active ON app_bff.webhook_subscriptions (active);

COMMENT ON TABLE app_bff.webhook_subscriptions IS
    'Outbound webhook subscriptions. Secret is the HMAC key for X-APEX-Signature; never returned via list/get APIs.';

-- app_bff.webhook_deliveries — per-attempt log. The dispatcher writes one
-- row per delivery (success or failure), with the response status + truncated
-- body for debugging.
CREATE TABLE IF NOT EXISTS app_bff.webhook_deliveries (
    delivery_id      TEXT        PRIMARY KEY,
    subscription_id  TEXT        NOT NULL REFERENCES app_bff.webhook_subscriptions(subscription_id) ON DELETE CASCADE,
    event_type       TEXT        NOT NULL,
    payload          JSONB       NOT NULL,
    attempts         INTEGER     NOT NULL,
    status           TEXT        NOT NULL,           -- success / failed
    response_status  INTEGER     NOT NULL,           -- HTTP code; 0 = network error
    response_body    TEXT,                           -- truncated to 200 chars
    created_at       TIMESTAMPTZ NOT NULL,
    completed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status IN ('success','failed'))
);
CREATE INDEX IF NOT EXISTS ix_app_bff_deliveries_sub ON app_bff.webhook_deliveries (subscription_id, completed_at DESC);

-- =========================================================================
-- app_scenario
-- =========================================================================

-- app_scenario.saved_scenarios — saved-scenario records from the SPA's
-- /scenario page. Today this lives in browser localStorage; this table is
-- the production target so saved scenarios survive cache clears + are
-- shareable across users.
CREATE TABLE IF NOT EXISTS app_scenario.saved_scenarios (
    scenario_id    TEXT        PRIMARY KEY,
    name           TEXT        NOT NULL,
    saved_by       TEXT        NOT NULL,            -- username
    saved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- macro shock inputs
    gdp_shock_pct  NUMERIC(6,2) NOT NULL,
    rate_shock_bps INTEGER     NOT NULL,
    fx_shock_pct   NUMERIC(6,2) NOT NULL,
    -- full result snapshot — preserved verbatim so reload shows exact
    -- numbers even if engine elasticities later change.
    result         JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_app_scenario_saved_user ON app_scenario.saved_scenarios (saved_by, saved_at DESC);

COMMENT ON TABLE app_scenario.saved_scenarios IS
    'Saved scenario simulator runs. Result is a full ScenarioResult JSONB; reloading shows the saved numbers, not a re-run.';

-- =========================================================================
-- app_audit
-- =========================================================================

-- app_audit.approvals — cross-cutting maker-checker log (T4.20, BAC-A §3.1.4).
--
-- Currently a fan-out target from CAS submit/review and CAP propose/approve
-- (T4.19 keeps the inline maker/checker fields on cas_records and caps as
-- the source-of-truth for the case workflow; this table is the cross-
-- cutting view that future code — rule promotion, user creation, etc. —
-- can also write to so "show me all pending approvals across the system"
-- becomes a single query). Mutable; status changes as the approval
-- progresses. Distinct from `audit.event_log` which is immutable + hash-
-- chained.
CREATE TABLE IF NOT EXISTS app_audit.approvals (
    approval_id     TEXT        PRIMARY KEY,
    subject_type    TEXT        NOT NULL,
        -- 'cas' / 'cap' / 'rule_promotion' / 'user_create' / 'user_role_change' / etc.
    subject_id      TEXT        NOT NULL,        -- the cas_id / cap_id / rule_id / user_id
    action          TEXT        NOT NULL,
        -- 'submit' / 'propose' / 'state_transition' / 'create' / 'update' / 'delete'
    payload         JSONB       NOT NULL,        -- the proposed change snapshot
    maker           TEXT        NOT NULL,        -- username
    proposed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    checker         TEXT,                        -- username; NULL until reviewed
    reviewed_at     TIMESTAMPTZ,
    status          TEXT        NOT NULL DEFAULT 'pending',
        -- 'pending' / 'approved' / 'rejected' / 'rework'
    comments        TEXT,
    sla_due_at      TIMESTAMPTZ,                 -- approval-step SLA timer (BAC-A §3.1.4)
    correlation_id  TEXT,                        -- e.g. case_id when subject is cas/cap
    CHECK (status IN ('pending','approved','rejected','rework'))
);
CREATE INDEX IF NOT EXISTS ix_app_audit_approvals_subject  ON app_audit.approvals (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS ix_app_audit_approvals_pending  ON app_audit.approvals (status, sla_due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_app_audit_approvals_maker    ON app_audit.approvals (maker, proposed_at DESC);
CREATE INDEX IF NOT EXISTS ix_app_audit_approvals_corr     ON app_audit.approvals (correlation_id) WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE app_audit.approvals IS
    'Cross-cutting maker-checker approval log. Every two-step approval (CAS, CAP, future rule promotion / user create) writes a row here so admins can query all pending approvals from one place.';
