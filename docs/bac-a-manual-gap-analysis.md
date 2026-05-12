# ZorEWS — BAC-A Manual Gap Analysis

**Source:** `BAC A - EWS User Manual_v1.0` (CareEdge Risk Solutions, Jan 2023, 56 pages)
**Generated:** 2026-05-03
**Purpose:** Map the BAC-A commercial-EWS spec against the current apex-ews prototype to identify what's covered, what's partial, and what's missing — so prioritisation decisions are explicit rather than buried.

---

## TL;DR — Coverage Per Module

| Module (BAC-A §) | Coverage | Notes |
|---|---|---|
| §3.1.2 Dashboard widgets | 🟢 Mostly | Portfolio risk + KPIs + frequently-breached + tasks all exist; per-role widget chooser missing |
| §3.1.3 Borrower (Customer 360) | 🟡 Partial | Synthetic customer model exists; corporate/retail split + CIN + Tax Code + Debt Group missing |
| §3.1.4 Rule Library — Control/Trigger/Ruleset | 🟡 Partial | Rules + variables + backtest exist; no UI-driven Compute/Entry/Field placeholders, no Ruleset bundling for retail-vs-corporate, no per-trigger weight |
| §3.1.4 Maker–Checker workflow | 🟢 Done | T4.19 + T4.20 shipped 2026-05-03 — inline maker/checker on cas_records + caps; cross-cutting `app_audit.approvals` fan-out with `ApprovalsClient`; SLA timer column wired but not yet evaluated by code |
| §3.1.4.1.1 Breach Tracking + EWS Score | 🟡 Partial | Smart-queue + criticality_score exist, but not the manual's `Σ(weight × risk_score)` formula or `Highest Risk Score` benchmark |
| §3.1.5 Case Management — basic lifecycle | 🟢 Done | open → assigned → in_action → monitored → closed with action log (T4.15 wired to pg) |
| §3.1.5 **CAS (Causal Analysis Stage)** | 🟢 Done | T4.19 shipped 2026-05-03 — `app_cases.cas_records` + `submitCas`/`reviewCas` with maker-checker semantics |
| §3.1.5 **CAP (Corrective Action Plan)** | 🟢 Done | T4.19 shipped 2026-05-03 — `app_cases.caps` + propose/approve/close routes; case `close()` refuses with 409 while any CAP open |
| §3.1.5.1.3 Email notifications (3 events) | 🟡 Partial | SSE bell exists; no SMTP-style email notifications for case generation/escalation/closure |
| §3.1.6.1.1 Process Management UI | 🔴 Missing | Background processes exist as cron jobs; no admin UI to manually trigger |
| §3.1.6.1.2 Parameter Management (dynamic masters) | 🔴 Missing | Our enums are hard-coded TypeScript types; manual has runtime-editable Category + Parameter system |
| §3.1.6.1.5 Report Configuration (per-role + frequency) | 🟡 Partial | Reports exist; no admin UI to schedule + restrict by role + configure recipients |
| §3.1.6.1.6 Holiday List | 🔴 Missing | No bank-calendar concept; SLA + scheduler treat all days equally |
| §3.1.6.1.8 Data Exceptions | 🔴 Missing | No surfaced log of data-load failures (the dbt test outputs aren't exposed in the SPA) |
| §3.1.7 User/Role/Menu/UserRole/UserTeam Setup | 🟡 Partial | auth-svc has users + roles + admin lock/unlock; **User-Team grouping shipped 2026-05-03 (T4.21)** with `app_iam.user_teams` + members; per-user branch assignment via team membership; Role-Menu access matrix UI still missing (RBAC matrix.json is the source-of-truth, no admin UI to edit it) |
| §3.1.8 System Reports (canned) + Historical | 🟡 Partial | 4 canned reports exist (NPL/Quality/SLA/Activity); no current-vs-historical split, no auto-scheduled generation |
| §3.1.8 Custom Reports / Ad-Hoc SQL Query | 🔴 Missing | Could be either powerful (admin runs arbitrary SQL) or a security hole — needs careful sandboxing |
| §3.1.9.1.1–.2 Change Password + Policy | 🟢 Done | argon2id + 8-char + complexity + history-of-5 + lockout + 90-day forced rotate all in auth-svc |
| §3.1.9.1.3 Leave Cover Request | 🟢 Done | T4.22 shipped 2026-05-03 — `app_iam.leave_covers` + 4 routes (CRUD + `/auth/users/:id/active-cover` lookup); SPA auto-routes assignments via the lookup |
| §3.1.9.1.4 Dashboard Widget Configuration per role | 🟡 Partial | T4.23 shipped 2026-05-03 — backend (`app_iam.role_dashboard_widgets` + 2 routes) + SPA admin page at `/admin/dashboard-widgets`. The DashboardPage itself still renders the same widgets for every role; refactoring it into a widget catalogue + per-role filter is documented as a follow-up |
| §2.1.1 Workflow roles (RM / RM Checker / Head of BU / Debt Settlement Div) | 🔴 Missing | Our 5 roles (admin/risk_analyst/supervisor/collection_officer/field_officer) don't map 1:1 to BAC-A's hierarchical RM → Checker → Head escalation path |

**Summary:** ~35% directly covered, ~25% partial, ~40% missing. Implementing all 40% would be 4-8 weeks of engineering. The remaining gaps are independently valuable, so the right move is **prioritise** rather than ship the whole thing.

---

## Top 5 Prioritised Gaps (highest-value first)

### 1. ✅ **CAS + CAP proper modelling** — SHIPPED 2026-05-03 (T4.19)

**Why first:** This is the heart of the EWS workflow per the manual ("4. Conduct CAS to investigate" → "7. Propose CAP for cases"). Our current `actions` table is a granular call/visit/sms log, not the same thing as a CAS or CAP. Without this distinction, the prototype can't represent the BAC-A approval flow at all.

**Result:** Both schema tables live (`app_cases.cas_records`, `app_cases.caps`); 5 new service methods (`submitCas`/`reviewCas`/`proposeCap`/`approveCap`/`closeCap`) + 5 new HTTP routes + 5 new event types + 5 new RBAC ops. `close()` now refuses with HTTP 409 if any CAP is still open. 23 tests pass (15 in-memory + 8 pg integration). Manual smoke confirmed the full workflow including restart-survival of CAS + CAP rehydration.

The original schema spec from this gap analysis is what was implemented (with one tweak: `target_completion_date::text` cast in the SELECT query to dodge a pg-node DATE timezone bug):

**Schema:**
```sql
-- app_cases.cas_records — one or more per case; investigates the cause.
CREATE TABLE app_cases.cas_records (
    cas_id           TEXT PRIMARY KEY,
    case_id          TEXT NOT NULL REFERENCES app_cases.cases(case_id) ON DELETE CASCADE,
    cause_type       TEXT NOT NULL,         -- e.g. 'industry_downturn' / 'borrower_specific' / 'data_quality'
    cause_summary    TEXT NOT NULL,
    severity_assessment TEXT NOT NULL,      -- 'minor' / 'material' / 'severe'
    decision         TEXT NOT NULL,         -- 'close_case' / 'proceed_to_cap'
    submitted_by     TEXT NOT NULL,         -- maker
    submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by      TEXT,                  -- checker
    reviewed_at      TIMESTAMPTZ,
    review_status    TEXT NOT NULL DEFAULT 'pending',  -- 'pending' / 'approved' / 'rework'
    review_comments  TEXT,
    attachments      JSONB                  -- [{name, url, size}]
);

-- app_cases.caps — multiple per case; each is a corrective plan with an owner.
CREATE TABLE app_cases.caps (
    cap_id              TEXT PRIMARY KEY,
    case_id             TEXT NOT NULL REFERENCES app_cases.cases(case_id) ON DELETE CASCADE,
    cap_item            TEXT NOT NULL,                 -- 'Initiate legal action' / 'Freeze ad-hoc limits' / 'Restructure loan' / etc.
    issue_owner_group   TEXT NOT NULL,                 -- 'Issue Owner' / 'Debt Settlement' / etc.
    issue_owner         TEXT NOT NULL,                 -- username of the assigned officer
    issue_priority      TEXT NOT NULL,                 -- 'low_risk' / 'medium_risk' / 'high_risk'
    target_completion_date  DATE NOT NULL,
    status              TEXT NOT NULL DEFAULT 'open',  -- 'open' / 'in_progress' / 'closed' / 'overdue'
    proposed_by         TEXT NOT NULL,                 -- maker
    proposed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by         TEXT,                          -- checker
    approved_at         TIMESTAMPTZ,
    closed_at           TIMESTAMPTZ,
    closure_comments    TEXT,
    attachments         JSONB
);
```

**Service:** extend `services/regulatory-svc/cases/src/service.ts` with `submitCAS`, `reviewCAS`, `proposeCAP`, `reviewCAP`, `closeCAP`. Update `closeCase` to refuse if any CAP is open.

**Routes:** `POST /cases/:id/cas`, `POST /cases/:id/cas/:cas_id/review`, `POST /cases/:id/caps`, `POST /cases/:id/caps/:cap_id/close`, etc.

**SPA:** add CAS and CAP tabs to the case detail page (mockups in manual §3.1.5).

### 2. ✅ **Maker–Checker generic infrastructure** — SHIPPED 2026-05-03 (T4.20)

**Why:** The manual mentions maker-checker for: rule changes, CAS, CAP, user creation. Building it once as a reusable layer (one `app_audit.approvals` table + helper) is much cheaper than retrofitting it 4 times. Pairs naturally with #1.

**Result:** `app_audit.approvals` shipped with the schema below; `ApprovalsClient` (in `services/regulatory-svc/cases/src/approvals.ts`) provides `propose()` + `review()`; CAS submit/review and CAP propose/approve fan out into the table via the new ServiceDep. **Additive** — the inline maker/checker fields on cas_records and caps remain the source-of-truth; the approvals table is a cross-cutting view for admin "all pending approvals" queries + future SLA-breach alerting. 10 new tests pass (3 unit + 7 pg integration). The cross-cutting use case is proven by a test that does `GROUP BY subject_type` and confirms both CAS and CAP appear in one query.

**Future consumers (not implemented yet — adoption is per-service):** rule promotion (rules:promote could move from single-step to maker-checker via this table), user creation (auth-svc /auth/users could write proposals here for admin approval), scenario sharing. Each adoption is ~30 min of code: import `ApprovalsClient`, call `propose()` on the maker action, `review()` on the checker action.

**Schema (as shipped):**
```sql
CREATE TABLE app_audit.approvals (
    approval_id      TEXT PRIMARY KEY,
    subject_type     TEXT NOT NULL,        -- 'cas' / 'cap' / 'rule_promotion' / 'user_create' / 'user_role_change'
    subject_id       TEXT NOT NULL,        -- the cas_id / cap_id / rule_id / user_id
    action           TEXT NOT NULL,        -- 'submit' / 'propose' / 'create' / 'update' / 'delete' / 'state_transition'
    payload          JSONB NOT NULL,       -- the proposed change snapshot
    maker            TEXT NOT NULL,
    proposed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    checker          TEXT,
    reviewed_at      TIMESTAMPTZ,
    status           TEXT NOT NULL DEFAULT 'pending',  -- 'pending' / 'approved' / 'rejected' / 'rework'
    comments         TEXT,
    sla_due_at       TIMESTAMPTZ,           -- approval-step SLA timer (BAC-A §3.1.4) — wired in schema, no evaluator yet
    correlation_id   TEXT                   -- e.g. case_id when subject is cas/cap; queryable for full-case approval history
);
```

### 3. ✅ **Issue Owner Groups + branch assignment** — SHIPPED 2026-05-03 (T4.21)

**Why:** §3.1.7.1.5 user-team setup. CAPs need an `issue_owner_group` (a team) before the specific `issue_owner` (a person). Current auth-svc only had flat users + roles. Added a thin `app_iam.user_teams` + `app_iam.user_team_members` and the API to assign.

**Result:** 2 schema tables shipped (with FK CASCADE both ways + UNIQUE(name, branch)); `services/auth-svc/src/teams.ts` with `InMemoryTeamStore` + `PgTeamStore` + 5 routes (`GET /auth/teams` + `GET /:id` + `POST` + `POST /:id/members` + `DELETE /:id/members/:user_id` + `DELETE /:id`); 10 tests pass. Team leader is implicitly added to members on create; cannot be removed without first reassigning leadership (409). Per-user branch assignment now exists via team membership — a user is "in branch X" if they're a member of any team in branch X.

**Design choice — cases doesn't cross-validate teams.** The cases service does NOT validate `cap.issue_owner_group` against the team list. Adding a runtime auth-svc dependency to cases would couple two services that today share only a Postgres pool. The right shape is the SPA populating the `issue_owner_group` dropdown by calling `GET /auth/teams`, then the cases service trusting the value. Cross-service validation would only be worth it if there were a non-SPA caller of `POST /cases/:id/caps` — there isn't yet.

### 4. ✅ **Leave Cover Request** — SHIPPED 2026-05-03 (T4.22)

**Why:** §3.1.9.1.3. Useful UX even outside BAC-A spec — operators take leave. Schema: `app_iam.leave_covers (cover_id, applicant_user FK, leave_coverer FK, role, start_date DATE, end_date DATE, in_office BOOLEAN, comments, created_at, cancelled_at)` shipped with CHECK constraints `end_date >= start_date` AND `applicant_user <> leave_coverer`.

**Result:** 4 routes (`GET /auth/leave-covers` filters + scoping, `POST /auth/leave-covers` self-service, `DELETE /:cover_id` cancel, `GET /auth/users/:user_id/active-cover?date=` for SPA dropdown lookup). 7 tests (5 in-memory + 2 pg integration). Same SPA-layer-validation design choice as T4.21 — cases doesn't auto-route. The SPA assignment dropdown calls `/auth/users/:id/active-cover` before submitting `assign(case_id, user_id)` and substitutes the coverer.

**Behaviour notes documented in code:**
- Date-grained, both ends inclusive (matches HR semantics).
- Multiple overlapping covers for the same applicant resolve to the most-recently-created one (admin override pattern).
- `in_office=true` distinguishes "covering for an absent peer while still working" from `in_office=false` "I'm out, route everything to X".
- The lookup endpoint returns 204 (not 404) when no active cover — semantically "the user has no cover, you can route to them directly".

### 5. ⚠️ **Dashboard Widget Configuration per role** — PARTIALLY SHIPPED 2026-05-03 (T4.23)

**Why:** §3.1.9.1.4. The current SPA dashboard shows the same widgets to admin and field-officer; a debt-collection officer doesn't need the industry-wise risk panel. Schema: `app_iam.role_dashboard_widgets (role, widget_id, sort_order, is_visible)` + admin UI to drag-and-drop.

**Result (what shipped):**
- Backend complete: schema table with composite PK + CHECK constraint on role + atomic-replace transactional `replaceForRole()`; `/auth/dashboard-widgets/:role` GET + PUT routes; 8 tests pass.
- SPA admin page at `/admin/dashboard-widgets` with role selector + checkbox-and-numeric-sort-order table + Save button. No drag-and-drop polish (would need a drag-drop library and considered out-of-scope for prototype).
- API client methods + MSW handlers in the SPA so the contract is in place; all 204 SPA tests pass.

**Result (what's deferred):**
- The `DashboardPage` itself doesn't yet read this config. It still renders the same panels for every role. Refactoring into a widget catalogue + per-role render-filter is genuinely significant SPA work — the dashboard is one large composed page rather than a composition of named widgets. Tracked as a future task; the admin page lets ops curate the config so the contract is in place when the refactor lands.

**To finish this gap:** refactor `web/src/modules/dashboard/DashboardPage.tsx` to:
1. Extract each `<Panel>` into a named widget component with a `widget_id` matching the catalogue in `web/src/modules/admin/DashboardWidgetsPage.tsx`.
2. On mount, call `getDashboardWidgets(currentUserRole)`.
3. Render only widgets where `is_visible !== false` (catalogue defaults if no override exists), sorted by `sort_order`.
Estimated 2-3 h on top of what's shipped today.

---

## Things the Manual Specifies that Are Probably Out of Scope for the Prototype

These are real work items but unlikely to deliver demo value within reasonable time:

- **§3.1.6.1.2 Dynamic Parameter Management** — A runtime-editable system-master UI. Our enums (Severity, Role, IfrsStage, etc.) are TypeScript union types compiled into the bundle. Making them runtime-editable means a meta-data layer + cache invalidation + every type-narrowing call site becomes a runtime check. Several days of work for marginal prototype value.
- **§3.1.8 Ad-Hoc SQL Query** — Either a DB superuser handing out arbitrary read access (security hole) or a query-builder (large UI). Both are weeks of work.
- **§2.1.2 Core Banking + Card System interfaces** — Per `project_apex_ews_scope.md`, real bank integrations are explicitly out of scope. The synthetic seeds + dbt pipeline are the prototype substitute.
- **§3.1.6.1.6 Holiday List** — Can be added trivially (1 table + UI), but only matters if the SLA evaluator and scheduler actually subtract holidays. Both currently use calendar days; making them holiday-aware is a behavioural change on top of the table.
- **§3.1.4 Compute/Entry/Field placeholder UI** — Our rule engine takes JS-like predicates already (see `services/bff/src/rules/`); the manual's three-step builder is a UI layer on top. Significant frontend work for the prototype's rule team to find marginally useful since they can already write rules in the existing format.

---

## Recommended Next Action

All 5 BAC-A Top-5 gaps now shipped as T4.19–T4.23 on 2026-05-03. Gap #5 is partially deferred — backend + admin page complete, but the DashboardPage refactor to actually honour the per-role config is a follow-up.

**Top remaining follow-ups (in rough priority order):**

1. **Finish T4.23 — DashboardPage widget catalogue refactor** (~2-3 h). The admin page exists; the dashboard just doesn't read its config yet. Smallest item, closes the only Top-5 gap that's still partial.
2. **`app_audit.approvals.sla_due_at` evaluator** (~1-2 h, BAC-A §3.1.4 SLA). The column is wired but no code computes it. A periodic check that flips overdue `status='pending'` rows to `status='breached'` (or fires a notification) closes the SLA story.
3. **Adopt ApprovalsClient in a 2nd consumer** (~1 h per consumer). Most natural: `auth-svc` user creation flow (admin creates user → second admin approves). Once a 2nd service adopts it, extract to a shared `@apex-ews/approvals` package.
4. **Synthetic seeds for the 6 new tables** (~1 h). `data/schema/_generate_app_seeds.py` predates T4.19–T4.23. Extending it to generate ~10% of cases with CAS+CAP+approvals + a few teams + leave covers + per-role widget config would make SPA demos meaningful out of the box.
5. **Cross-service validation for CAP issue_owner_group + assignment cover-routing** — only worth doing if a non-SPA caller of `POST /cases/:id/caps` or `POST /cases/:id/assign` shows up. Today the SPA-layer-validation design (T4.21 + T4.22) is correct.

The user should explicitly OK the next priority before implementation begins.
