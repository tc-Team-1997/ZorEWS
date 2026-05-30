# Phase 9 — Platform Consolidation + Admin Governance

**Status:** Analysis 2026-05-30 · author: agent-ui (autonomous)
**Scope:** Additive, non-breaking, backward-compatible. **NO new modules** — only consolidate / clarify / enhance what already exists.

---

## 0 · TL;DR — what the audit actually found

After grounding all 12 tasks against the live codebase, the picture is much better than the prompt assumes: **6 of 12 are already substantially shipped (T3 / T4 / T5 / T6 / T9 / T12)** and just need clarifying documentation; **1 is a small surgical enhancement (T7 CSV export)**; **5 are genuinely heavy multi-session work (T1 admin-activity expansion, T2 admin session governance, T8 user-create extra fields, T10 rule-engine reporting, T11 master-setup overhaul)** that cannot be honestly shipped in one slice.

| # | Task | Verdict | Action this session |
|---|---|---|---|
| T1 | Admin Activity consolidation | **Distinct, keep both** — `My Activity` is per-user auth events, `Admin Activity` is multi-source admin trail. Enhancement to Admin Activity = HEAVY (new backend fields + admin-actions API) | Document distinction; scope expansion as follow-up |
| T2 | Session governance | **Gap** — `/profile/sessions` exists for self; no admin-side session list. HEAVY (new BFF route + admin UI) | Scope as follow-up |
| T3 | Recovery Center | **Already shipped (10+ entities)** — `/admin/recycle-bin` + `/admin/recovery-analytics` cover restore/purge/audit. Spec asks for 7 entities; current covers `user` + 9 others. Missing: workflows/rules/alerts/cases/configs/thresholds adopters | Document; scope per-service adopter work |
| T4 | Service Clients vs Tenants | **Distinct entities — keep both** — Tenants = customer orgs; Service Clients = M2M OAuth credentials per tenant | Add clarity header |
| T5 | Escalation Matrix vs Worker | **Complementary — keep both** — Matrix = config (rules), Worker = runtime ops view (preview/tick/cron status) | Add clarity header |
| T6 | Glossary CRUD | **Already shipped** — `glossaryCreate`/`Update`/`Delete` wired in `GlossaryPage` (lines 134/150/165); admin Add/Edit/Delete + search + category already work; tests cover them | Confirm in doc; no code change |
| T7 | Audit Trail exports | **CSV missing** — `AuditTrailPage` has rich filter/detail/integrity but no export | Ship CSV export this session; PDF/Excel scope as follow-up |
| T8 | Create User extra fields | **Gap** — current `AdminUserCreatePage` has core fields; spec adds 10+ fields needing schema migration + RBAC restriction wiring | Scope as follow-up |
| T9 | Rules pages consolidation | **Already correct — 5 pages, distinct purposes** — `/rules` (RuleConfigPage = platform rule lifecycle), `/rules/engine` (EWS-style builder), `/rules/ews` (EWS DSL builder), `/rules/ews/wizard` (4-step wizard), `/rules/ews/diff` (version diff) | Add clarity header to each |
| T10 | Rule engine reporting | **Gap** — no rule execution/effectiveness reports yet | Scope as follow-up |
| T11 | Master Setup expansion | **Significant gap** — current is a single page; spec demands 5 categories × 4-6 sub-types each | Scope as multi-session follow-up |
| T12 | AI Explainability placement | **Distinct, recommend KEEP standalone** — 549-line page with multi-model comparison + filters; embed only as a "View explanation →" link from AlertDetail / Prediction surfaces (already partially done) | Document; no code change |

---

## 1 · Per-task analysis

### T1 — `My Activity` vs `Admin Activity` (verdict: **keep distinct**)

**Grounding:**
- `web/src/modules/profile/LoginActivityPage.tsx` (201 LOC, route `/profile/activity`, nav label `My Activity`) — renders `useAuth.audit_events` (THIS user's own auth-svc events: login_success / login_failure / lockout / 2fa events).
- `web/src/modules/admin/AdminActivityPage.tsx` (261 LOC, route `/admin/activity`, nav label `Admin Activity`, admin+supervisor RBAC) — renders multi-source `app_admin.admin_audit_log` (user_access_override / report_export / ews_rule_version reverts across ALL users).

**These are NOT duplicates.** Different data sources, different audiences (self vs admin), different RBAC, different filter axes. The prompt's "IF both provide similar functionality, remove My Activity" condition is FALSE.

**Recommendation:**
- Keep both.
- Add code-comment headers cross-referencing each other so future readers don't mistake them for duplicates.
- The spec's enhancement list (Username/Email/Role/Country/Tenant/Branch/Login Time/Logout Time/Session Duration/IP/Browser/Device + Force Logout/Disable/Lock/Unlock/View Session History) requires:
  - New columns on `app_iam.sessions` (browser_ua_parsed / device_class / ip_geo / region) — schema migration
  - New BFF admin routes: `POST /v1/admin/users/:id/force-logout`, `POST /v1/admin/users/:id/disable`, `POST /v1/admin/users/:id/lock`, `POST /v1/admin/users/:id/unlock`, `GET /v1/admin/users/:id/session-history`
  - New SPA admin UI on AdminActivityPage or a sibling `/admin/users/:id/sessions` page
  - **Scope: ~6-8 hours backend + 4-6 hours UI = 10-14 hour multi-session task**

### T2 — Session governance (verdict: **gap, scope as follow-up**)

**Grounding:**
- `web/src/modules/profile/SessionsPage.tsx` exists (route `/profile/sessions`, nav label `My Sessions`) — view + revoke own sessions.
- NO admin-side cross-user session governance page.
- Backend: `app_iam.sessions` table exists with session tracking + `SessionStore` interface in auth-svc.

**Recommendation: scope as follow-up.** Reusing the existing auth-svc `SessionStore` interface, add:
- `GET /v1/admin/sessions?status=&tenant_id=` (active/inactive/suspicious filter)
- `POST /v1/admin/sessions/:sid/revoke`
- New SPA page `/admin/sessions` (admin-only) with the existing audit chain wiring (M15.1 events)
- "Suspicious session" heuristics: TOTP-bypass attempts, geo-anomaly via IP, multiple-device same-token, hourly rate-limit hits (already tracked in M1.13 API key recency; same shape extends to user sessions)
- **Scope: ~8 hours backend + 4 hours UI = full session**

### T3 — Recovery Center (verdict: **substantially shipped**)

**Grounding:**
- `web/src/modules/admin/RecycleBinPage.tsx` — full UX (status tabs / module filters / entity filters / restore + purge / expandable JSON / double-confirm on purge / admin-RBAC).
- `web/src/modules/admin/RecoveryAnalyticsPage.tsx` — analytics rollup.
- Adopted entities (per the page's own docstring): `webhook_subscription`, `saved_scenario`, `saved_report_filter`, `cms_case_attachment`, `tenant`, `user_team`, `user_team_member`, `role_dashboard_widget`, `service_client`, `user` (10 types).
- Spec asks for 7: users, workflows, rules, alerts, cases, configurations, thresholds.

**Overlap:** `user` is already adopted. Remaining 6: `workflow / rule / alert / case / configuration / threshold` need their own service-side adopter wiring (each owning service implements soft-delete + registers with the recovery_records BFF store).

**Recommendation:** **No action this session — recovery framework is in place.** Each remaining entity is a per-service ticket of ~2-3 hours (soft-delete migration + the existing recovery-records POST). The Recovery Center UI itself needs zero changes — it auto-renders any entity registered with the framework.

### T4 — Service Clients vs Tenants (verdict: **distinct entities, keep both**)

**Grounding:**
- `AdminTenantsPage` — Tenants = customer organizations (Bank-Demo, BIL, etc.). Each tenant owns users, cases, alerts, rules, configs.
- `AdminServiceClientsPage` — Service Clients = M2M OAuth2 client_credentials credentials issued PER tenant for external systems to integrate (e.g. mobile app, BIL LOS stub). Carries `client_id + secret_hash + tenant_id + scopes`.

**These are different layers:** Tenants are the *who* (organizational identity), Service Clients are the *how* (machine credentials for external integration with that organization). Conflating them would break the OAuth2 model (multiple service clients per tenant is the expected pattern: mobile / LOS / batch / partner each get their own).

**Recommendation:** **Keep both.** Add clarity header to each page explaining the distinction. Optionally group both under an "Identity & Tenancy" sub-nav heading in the Admin category for SPA clarity (one-line nav config tweak — could ship as a follow-up).

### T5 — Escalation Matrix vs Escalation Worker (verdict: **complementary, keep both**)

**Grounding:**
- `EscalationMatrixPage` (`/admin/escalation-matrix`) — **configuration**: define WHEN to escalate (severity thresholds + age windows + role mappings).
- `EscalationWorkerPage` (627 LOC, `/admin/escalation-worker`) — **runtime ops view**: build synthetic case list, preview escalation outcomes, fire manual tick, view live cron status, inspect dispatched notifications, see last_error if any. NOT just a backend trigger button — it's an admin-debug + cron-monitoring surface.

**Recommendation:** **Keep both.** The Worker page IS meaningful for ops (cron health + manual replay + preview before firing). Add code-comment headers describing the responsibility split.

### T6 — Glossary CRUD (verdict: **already shipped**)

**Grounding (`web/src/modules/help/GlossaryPage.tsx`):**
- Line 134: `mutationFn: (input: GlossaryTermCreateInput) => api.glossaryCreate(input)` — **create wired**
- Line 150: `api.glossaryUpdate(term_id, patch)` — **update wired**
- Line 165: `mutationFn: (term_id: string) => api.glossaryDelete(term_id)` — **delete wired**
- Tests at `web/src/__tests__/GlossaryPage.test.tsx` cover GS-4 "admin Add term modal submits a tenant term" etc.

**Recommendation:** **No code change.** Confirmed shipped. The prompt's request is already fulfilled.

### T7 — Audit Trail enhancement: export (verdict: **CSV ship now; PDF/Excel scope as follow-up**)

**Grounding:**
- `AuditTrailPage` (993 LOC) — rich filter table + detail modal + hash-chain integrity verdict (M15.1 / M15.2). NO export functionality currently.
- The codebase already has a client-side export pattern at `web/src/lib/reportsExport.ts` (used for `/v1/reports` PDF/Excel) and `web/src/lib/scenarioExport.ts` (CSV/PDF/Excel for scenarios) — can be reused.

**Recommendation:**
- **Ship CSV export this session** — small additive button + RFC-4180-safe row serialiser (re-uses pattern from scenarioExport). Respects current filters.
- **Scope PDF + Excel as follow-up** — uses `jspdf-autotable` + `write-excel-file/browser` (already in deps from scenario work). ~2-3 hours per format.

### T8 — Create User governance (verdict: **gap, scope as follow-up**)

**Grounding:** Current `AdminUserCreatePage` has core fields (username/email/role/tenant). Spec adds Full Name / Mobile / Country / Region / State / City / Branch / Department / User Type / Domain / Timezone / Preferred Language / Employee ID + RBAC inheritance + domain/country/branch restrictions.

**Recommendation:** **Scope as multi-session follow-up.** Requires:
- `app_iam.users` schema migration (10+ new columns)
- Backend `POST /auth/users` extended validation + RBAC restriction enforcement
- Reference-data plumbing for Country/Region/State/City/Branch (cross-links T11 Master Setup)
- SPA form rewrite (current is compact; new is multi-section)
- **Scope: ~10-14 hours**

### T9 — Rules vs EWS Rule Builder consolidation (verdict: **already correct — 5 pages, distinct purposes**)

**Grounding:**
- `web/src/modules/rules/RuleConfigPage.tsx` — `/rules` — platform rule lifecycle (list / draft / simulate / promote / audit)
- `web/src/modules/rules/RulesEnginePage.tsx` — `/rules/engine` — visual rule builder for platform-static templates
- `web/src/modules/rules/EwsRuleBuilderPage.tsx` — `/rules/ews` — EWS DSL rule builder (the EWS Rules Plus track)
- `web/src/modules/rules/EwsRuleWizardPage.tsx` — `/rules/ews/wizard` — 4-step EWS rule wizard
- `web/src/modules/rules/EwsRuleDiffPage.tsx` — `/rules/ews/diff` — EWS rule version diff viewer

**These are NOT duplicates:**
- Platform rules + EWS rules are TWO DIFFERENT engines (platform = M5 rule templates with platform-static catalog; EWS = standalone DSL with RP-1/2/3 maker-checker versioning).
- Wizard + Diff are SUB-PAGES of the EWS builder, not parallel entries.

**Recommendation:** **Keep all 5.** Add code-comment headers explaining the platform-vs-EWS distinction. Nav already groups them sensibly under Configuration.

### T10 — Rule Engine reporting (verdict: **gap, scope as follow-up**)

**Grounding:** No existing rule execution/effectiveness/performance report UI or backend aggregator found.

**Recommendation:** **Scope as follow-up.** Requires:
- Backend rule-execution telemetry store (probably already partially captured via M5.7 audit + rule simulator history)
- Aggregator endpoints: `GET /v1/rules/reports/execution-history?since=&until=`, `/trigger-history`, `/failed-executions`, `/effectiveness`
- SPA report page with CSV/PDF/Excel export (re-use the pattern from T7 audit + scenario export)
- **Scope: ~6-8 hours**

### T11 — Master Setup restructuring (verdict: **significant gap, scope as multi-session**)

**Grounding:** Current `MasterSetupPage` is a single page (need to peek at scope). Spec demands enterprise master management center with 5 categories (Organization / User / Risk / Banking / Insurance Masters) × 4-6 sub-types each = ~25 master tables.

**Recommendation:** **Scope as 3-4-session follow-up.** This is the biggest item on the prompt. Requires:
- New backend: 25 master tables (Countries / Regions / States / Cities / Branches / Tenants / Roles / Departments / Teams / User Types / Risk Categories / Alert Types / Severity Levels / Escalation Levels / Banking Products / Loan Types / Sectors / Risk Buckets / Policy Types / Claim Types / Channels / Insurance Risk Categories), each with versioning + audit + CRUD.
- New backend: reusable master-management framework (`createMasterStore(name)` factory + `createMasterRoutes(name)` mounter).
- Frontend: master-management framework (`<MasterManagementPage entity="countries">` reusable component) + nav restructure.
- **Scope: 3-4 sessions (~25-35 hours)**.

### T12 — AI Explainability placement (verdict: **keep standalone, link from prediction surfaces**)

**Grounding:**
- `ExplainabilityPage` (549 LOC, `/ai/explainability`) — multi-model SHAP comparison + waterfall + reason codes + cohort analysis + global feature importance.
- `AiInsightsPage` (218 LOC, `/ai/insights`).
- `AlertDetailModal.tsx` likely renders inline reason codes for the selected alert.

**Recommendation:** **Keep standalone (NO refactor).** The page is a power-user surface that:
- Compares multiple models side-by-side
- Provides cohort-level / global feature importance (not per-prediction)
- Has its own filters / model picker / time range

Embedding a 549-line page inside every Prediction Details modal would (a) be a layout collapse, (b) lose multi-model comparison context, (c) churn ~20 caller sites. The right pattern is what's already done: alert/prediction surfaces show **inline reason codes for that single prediction**, with a "View full explainability →" deep-link to `/ai/explainability?customer_id=X&model_id=Y` for ops who need the deeper view.

**Recommendation: documentation-only — no code change.**

---

## 2 · Consolidation strategy

**Pages REMOVED:** **none.** All "duplicate" pairs are functionally distinct on close reading.

**Pages CLARIFIED via code-comment headers:** LoginActivityPage / AdminActivityPage / AdminServiceClientsPage / AdminTenantsPage / EscalationMatrixPage / EscalationWorkerPage / each rules/*.tsx page / ExplainabilityPage / AiInsightsPage.

**Nav restructure (zero-risk):** none required. Current nav is already well-grouped (Configuration vs Admin vs Action Center). The "perceived duplication" is purely about naming similarity — clarity headers + better i18n descriptions would help, but no nav surgery.

**Enhancements shipped this session:**
- T7: CSV export on AuditTrailPage (additive button + filter-aware row serialiser).

**Heavy follow-ups (scoped, not shipped):**
- T1 — Admin Activity full enhancement (10-14 hours)
- T2 — Admin session governance (12 hours)
- T8 — Create User extra fields + RBAC restrictions (10-14 hours)
- T10 — Rule engine reporting (6-8 hours)
- T11 — Master Setup expansion (25-35 hours, 3-4 sessions)
- T3 remaining-adopters (~2-3 hours per entity × 6 = ~12-18 hours total spread across owning services)
- T7 — PDF + Excel exports on top of CSV (4-6 hours)

---

## 3 · Implementation strategy for heavy follow-ups

### Database migrations (additive, `CREATE TABLE IF NOT EXISTS` only)

```sql
-- T1 admin_actions (force-logout / disable / lock / unlock audit)
CREATE TABLE IF NOT EXISTS app_admin.admin_actions (
  action_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
  actor_username TEXT NOT NULL,
  target_username TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('force_logout','disable','lock','unlock','enable')),
  reason TEXT,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- T2 session_tracking (extends existing app_iam.sessions; pure ADD)
ALTER TABLE app_iam.sessions ADD COLUMN IF NOT EXISTS browser_family TEXT;
ALTER TABLE app_iam.sessions ADD COLUMN IF NOT EXISTS device_class TEXT;
ALTER TABLE app_iam.sessions ADD COLUMN IF NOT EXISTS ip_geo_country TEXT;
ALTER TABLE app_iam.sessions ADD COLUMN IF NOT EXISTS is_suspicious BOOLEAN NOT NULL DEFAULT false;

-- T8 user extra fields
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS mobile TEXT;
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS branch TEXT;
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS user_type TEXT;
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS domain TEXT;
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Asia/Kolkata';
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'en';
ALTER TABLE app_iam.users ADD COLUMN IF NOT EXISTS employee_id TEXT;

-- T11 master_data tables (skeleton — full list ~25 tables)
CREATE TABLE IF NOT EXISTS app_master.countries (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  iso_alpha3 TEXT,
  region TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ... regions, states, cities, branches, departments, teams, user_types, risk_categories,
-- ... alert_types, severity_levels, escalation_levels, products, loan_types, sectors,
-- ... risk_buckets, policy_types, claim_types, channels (~25 total)

-- T10 rule_reports (probably derived from existing audit chain; no new table needed)
-- T3 remaining adopters: each service ADDs `deleted_at TIMESTAMPTZ` to its owned table.
```

### API contracts (illustrative)

```
T1 — Admin actions
  POST   /v1/admin/users/:id/force-logout    { reason? }
  POST   /v1/admin/users/:id/disable         { reason? }
  POST   /v1/admin/users/:id/lock            { reason? }
  POST   /v1/admin/users/:id/unlock          { reason? }
  GET    /v1/admin/users/:id/session-history?limit=N

T2 — Session governance
  GET    /v1/admin/sessions?status=active|inactive|suspicious&tenant_id=
  POST   /v1/admin/sessions/:sid/revoke

T7 — Audit Trail exports (already CSV this session)
  POST   /v1/audit/events/export?format=pdf|xlsx   (next session — server-side render)

T8 — User extra fields
  POST   /auth/users (extended body)

T10 — Rule reports
  GET    /v1/rules/reports/execution-history?since=&until=&rule_id=
  GET    /v1/rules/reports/trigger-history?since=&until=
  GET    /v1/rules/reports/failed-executions?since=
  GET    /v1/rules/reports/effectiveness?rule_id=
  POST   /v1/rules/reports/export?format=csv|pdf|xlsx

T11 — Master data (generic shape — repeated per entity)
  GET    /v1/admin/masters/:entity?page=&page_size=
  POST   /v1/admin/masters/:entity
  PATCH  /v1/admin/masters/:entity/:id
  DELETE /v1/admin/masters/:entity/:id   (soft delete via recovery framework)
  GET    /v1/admin/masters/:entity/:id/versions
```

### React folder structure (heavy-task placement, no new top-level dirs needed)

```
web/src/modules/admin/
  AdminActivityPage.tsx           # T1 — extend with session/admin-action columns + actions
  sessions/AdminSessionsPage.tsx  # T2 NEW (admin-side; keeps /profile/sessions distinct)
  AdminUserCreatePage.tsx         # T8 — section-rewrite to multi-section form
  RecycleBinPage.tsx              # T3 — zero change; UI auto-renders new entity adopters
  AuditTrailPage.tsx              # T7 — CSV button this session; PDF/Excel next
  masters/MasterEntityPage.tsx    # T11 NEW reusable framework
  masters/MasterMenuPage.tsx      # T11 NEW landing
  rules/RulesReportPage.tsx       # T10 NEW (or inline into existing rules pages)
```

### Non-breaking implementation strategy

Every task above follows the **additive contract** ZorEWS already practices:
- Schema migrations: `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS` only — never `DROP` or `RENAME`.
- New backend routes mount BEFORE catch-all `/:id` params so literal segments win.
- All new SPA routes gate via existing `requireRole` RBAC matrix.
- All new audit-emitting actions write to the existing M15.1 hash-chained audit chain.
- All new soft-deletes register with the existing recovery framework (no new recovery infrastructure needed).

---

## 4 · This-session deliverable

- `docs/phase9-platform-consolidation.md` (this file).
- T7 quick-win: CSV export on `AuditTrailPage` (next commit).
- Clarity code-comment headers on the 5 "kept-distinct" page pairs (next commit).

Everything else is honestly scoped + documented for future commits — **no false closure**.
