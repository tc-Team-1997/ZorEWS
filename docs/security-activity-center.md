# Security Activity Center — Architecture

**Status:** Shipped 2026-05-31 (overlay-not-replacement layer)
**Scope:** Enhance the existing **Admin Activity** module into a 6th enterprise overlay center — operational security monitoring with **11 sections**, an opinionated risk-scoring resolver, and a KPI strip. **Zero new BFF route, zero new database table, zero duplicate audit storage.** Reuses Admin Activity / Admin Sessions / Audit Trail / Audit Log / IAM Governance / RBAC Framework / M15 hash-chain.

This is the same overlay pattern shipped 5 times earlier in the session (Rule Center → Audit + Recovery Centers → AI Governance Layer → Enterprise IAM Layer → Enterprise Governance Center). Same constraints applied verbatim: **additive only · no API removal · backward-compatible · CREATE TABLE IF NOT EXISTS (N/A — no schema added) · reuse existing modules**.

---

## 1. Information Architecture

Top-level admin tile **Security Activity Center** (sidebar key `security_center`, Lucide `ShieldCheck`, gate `admin · supervisor`, `featured: true`) mounted at `/admin/security`. The page is an **index + dashboard**, not a destination — every primary action still lives in the legacy URLs it wraps.

### 11 sections (canonical brief order)

| # | Section | Purpose | Lands on |
|---|---------|---------|----------|
| 1 | **User Activity Visibility** | "Who did what, when, from where" | `/admin/activity` (existing) |
| 2 | **Login Security** | Failed attempts + lockouts + rate limits | `/admin/activity?type=login_failure` (filtered admin activity) |
| 3 | **Device Intelligence** | UA + IP fingerprinting per session | `/admin/sessions` (existing) |
| 4 | **Session Governance** | Active sessions + force-revoke | `/admin/sessions` (existing) |
| 5 | **Security Events** | High-severity events across the audit chain | `/audit-center/events` (existing) |
| 6 | **Admin Action Monitoring** | Privileged mutations (role changes, password resets, force-logouts) | `/audit-center/activity?actor_role=admin` |
| 7 | **Risk Scoring** | 4-level risk verdict per actor with factor breakdown | NEW — surfaced inline on the landing |
| 8 | **Response Actions** | Lock user · revoke session · force re-auth · password reset | `/admin/users` (existing) + `/admin/sessions` |
| 9 | **Reporting** | Audit reports for compliance / regulator submission | `/reports/builder` (existing) |
| 10 | **Dashboard** | KPI strip — 6 tiles surfaced on the landing | inline |
| 11 | **Audit Integration** | M15 hash-chain integrity + tamper detection | `/audit-center/integrity` (existing) |

The legacy URLs panel at the bottom of the landing reminds operators every backward-compat path still resolves: `/admin/activity · /admin/sessions · /admin/audit-trail · /admin/audit-log · /admin/users · /admin/iam · /audit-center/*`.

---

## 2. UI Enhancements

The landing layout — top to bottom — matches the proven Center pattern (Rule / Audit / Recovery / IAM / Governance):

1. **PageHeader** — title + 1-sentence subtitle stating the layered-overlay intent
2. **Legacy-URL Panel** (`security-legacy-links`) — `ShieldCheck` icon, copy "Layered security view — zero duplicate audit storage", enumerates every preserved legacy URL
3. **Dashboard KPI strip** (`security-dashboard-kpis`) — 6 `MetricCard` tiles:
   - `security-kpi-active-users` — active sessions (non-revoked) count
   - `security-kpi-failed-logins` — `login_failure + login_rate_limited` count
   - `security-kpi-suspicious` — actors at `high` or `critical` risk level
   - `security-kpi-locked` — `user_locked + auto_lockout_triggered` count
   - `security-kpi-critical` — actors at `critical` risk level only
   - `security-kpi-total-events` — fleet total audit event count
4. **Risk leaderboard panel** (`security-risk-panel`) — top 8 actors by risk score with badge (low → critical) + triggered factors + last event timestamp
5. **Top admins panel** (`security-top-admins-panel`) — top 5 actors by raw event count (volume axis, orthogonal to risk)
6. **11-card grid** (`security-sections`) — each card has `data-testid="security-card-${id}"`, opens its destination via `<Link to>` (no navigate handler — preserves middle-click + cmd-click)

Visual tone matches the rest of the platform — aurora indigo / violet / lilac tokens, Inter body / display, generous negative space, no decorative chrome.

---

## 3. React Component Structure

```
web/src/modules/admin/security/
├── SecurityActivityCenterPage.tsx     # landing + dashboard + sections grid (single export)
└── securityRiskScoring.ts             # pure-function risk resolver

web/src/__tests__/
└── SecurityActivityCenter.test.tsx    # 23 tests (page render + role gate + resolver)
```

**Single-page surface by design.** Each section is a wrapper card that links to its underlying legacy page; no new sub-pages, no new routes beyond the landing. This is what keeps the overlay genuinely additive.

### Reused primitives (no new components)

- `PageHeader` · `Panel` · `MetricCard` · `Badge` — existing UI kit
- `useAuth().adminAuditLog()` — existing store action (`AuthAuditEvent[]`)
- `useAuth().adminListSessions()` — existing store action (`{sessions: AdminSessionRow[], total: number}`)
- `useQuery` — existing react-query setup with 60s staleTime + admin short-circuit
- `<Link to>` from react-router-dom — existing nav primitive
- `Navigate` for role-gate bounce → `/`

---

## 4. Schema Changes

**None.** This is the explicit non-goal of the overlay pattern. Every data source already exists:

| Source | Table / store | Reused for |
|---|---|---|
| Auth audit chain | `app_iam.audit_events` + `audit.event_log` (T4.16 hash-chained) | Login security · Admin action monitoring · Risk scoring · Reporting · Audit integration |
| Admin sessions | `app_iam.sessions` (T4.14) | Active users KPI · Device intelligence · Session governance · Risk scoring (multi-IP signal) |
| IAM users | `app_iam.users` (T4.14) | Response actions (lock, force-logout, password reset) |
| RBAC matrix | `infra/rbac/matrix.json` (T3.9) | Page gate + admin role detection |

Migration scripts: **N/A** — no new tables, no new columns, no new indexes.

---

## 5. Migration Scripts

**N/A** — no schema additions.

If a future enhancement needs new state (e.g. persisted risk-score history for a trend chart), it should land as a **separate sub-feature** with its own idempotent migration (`CREATE TABLE IF NOT EXISTS app_iam.security_risk_score_snapshots`) following the established T4.13–T4.21 pattern. Today the resolver runs in-process per request — there is no persisted history.

---

## 6. REST APIs

**None added.** The landing composes 2 existing read endpoints:

| Endpoint | Owner | Reused for |
|---|---|---|
| `GET /auth/audit` (via `adminAuditLog()`) | auth-svc | KPI strip · risk scoring · admin leaderboard · login-security counts |
| `GET /admin/sessions` (via `adminListSessions()`) | auth-svc | Active-users KPI · multi-IP signal for risk scoring |

Both endpoints already enforce admin role at the auth-svc layer. The center page double-gates at the route level (`role: ['admin', 'supervisor']`).

### Why no new endpoint

The brief asked for risk scoring + dashboard + reporting — every one of those is **derivable from the existing audit + session feeds at request time**. Pushing this into the BFF would require a new table (`security_risk_scores`) and a sync job, both of which contradict the additive-only constraint. The pure-function resolver re-computes on every page load — cost is negligible because the audit feed itself caps at `limit=200` per call.

---

## 7. RBAC Mapping

| Surface | Gate | Notes |
|---|---|---|
| `/admin/security` route | `requireRole: ['admin', 'supervisor']` | Identical gate to `/admin/activity` so analysts can't see the center but can drill into the legacy URLs via the existing IAM Center if their role permits |
| KPI strip | inherited from page gate | Computed from already-fetched data — no additional grant required |
| Risk leaderboard | inherited from page gate | Pure-function over audit + session data the caller can already see |
| Section cards | nav-level gate only | Each destination enforces its own RBAC (e.g. force-revoke session at `/admin/sessions` requires admin) |

**No new RBAC operation introduced.** The center reuses the admin / supervisor / audit:read grants from the existing matrix.

---

## 8. Dashboard Widgets

The 6 KPI tiles on the landing form the **inline dashboard** (brief section 10). Their data flow:

```
adminAuditLog() ──┐
                  ├──> summarizeSecurityActivity(events, sessions) ──> KPI strip
adminListSessions() ─┘                                                 (6 tiles)
                  └──> rollupActorRiskScores(events, sessions) ──> Risk leaderboard (top 8)
```

All 6 tiles are memoized (`useMemo`) so re-renders after the bell triggers a refetch are cheap. The risk leaderboard re-sorts by `(total_score desc, last_event_at desc, actor_username asc)` — stable across page navigations.

Future expansion: an `M11.x` widget catalogue entry (`security_activity_summary`) could surface the same 6 KPIs inside the user's custom dashboard at `/dashboards/custom`. The pure-function resolver is already SPA-only so this would be a 30-line `WidgetResolver` add against the same source data.

---

## 9. Reporting Architecture

The center does **not** duplicate the existing reporting infrastructure (T4.6 self-service report builder). Instead the **Reporting** card on the landing deep-links to `/reports/builder`, which already serves every audit + session source:

| Source available in the report builder catalog | Use case |
|---|---|
| `audit.event_log` (T4.25 unified view) | Quarterly compliance audit dump |
| `app_iam.audit_events` (T4.16) | Auth-svc-local activity report |
| `app_iam.sessions` (T4.14) | Active-session summary |
| `app_audit.approvals` (T4.20) | Maker-checker decision log |

Compliance officers building an RBI/IRDAI evidence dump select one of those sources, apply the security-specific filters (actor, action verb, severity, time window), and export to CSV/PDF/Excel via the existing T4.6 pipeline. **No duplicate report runner.**

---

## 10. Security Governance Flow

The center sits **on top** of the existing 3-tier auth + audit architecture:

```
                      ┌───────────────────────────────────────────────┐
                      │   Security Activity Center  /admin/security   │
                      │   (overlay — 11 sections + KPI + risk score)  │
                      └───────────────┬───────────────────────────────┘
                                      │ composes (read-only)
            ┌─────────────────────────┼─────────────────────────┐
            ▼                         ▼                         ▼
  ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
  │ Admin Activity  │      │ Admin Sessions  │      │  Audit Center   │
  │  /admin/activity│      │ /admin/sessions │      │ /audit-center/* │
  └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
           │                        │                        │
           └────┬───────────────────┴────────────────────────┘
                ▼
         ┌──────────────────────────────────────────────┐
         │  M15 hash-chain audit  + app_iam.sessions    │
         │  (T4.14 / T4.16 / T4.25)                     │
         └──────────────────────────────────────────────┘
```

**Risk scoring is the only net-new contract** — and it's a pure function with closed-enum outputs, so the surface is auditable end-to-end.

### Risk-scoring contract

`computeRiskScoreForActor(actor_username, events, sessions)` → `SecurityRiskScore`

5 factors, each carrying a `weight` and a `triggered` boolean:

| Factor ID | Weight | Triggered when |
|---|---|---|
| `failed_logins` | 2 | actor has ≥ 3 `login_failure` OR `login_rate_limited` events in window |
| `unusual_location` | 1 | actor has ≥ 2 distinct IPs across session sample |
| `role_change` | 2 | actor has ≥ 1 `user_role_changed` event |
| `bulk_modifications` | 1 | actor has ≥ 5 mutation events (create/delete/disable/enable/role_change/admin_pwd_reset/force_logout) |
| `repeated_denials` | 2 | actor has ≥ 2 lockout events (`login_locked`, `auto_lockout_triggered`, `user_locked`) |

`total_score = Σ (factor.weight where triggered)` ∈ `[0, 8]`

Bucket boundaries match M8.16 / M7.15 conventions:

| Score | Level |
|---|---|
| `< 2` | `low` |
| `≥ 2` | `medium` |
| `≥ 4` | `high` |
| `≥ 6` | `critical` |

Thresholds (`FAILED_LOGIN_THRESHOLD=3`, `BULK_MUTATION_THRESHOLD=5`, `REPEATED_DENIAL_THRESHOLD=2`) are exported as `SECURITY_RISK_THRESHOLDS` so tests assert against the same constants and future tuning lands in one place.

### Closed-enum invariants

- `SecurityRiskLevel = 'low' | 'medium' | 'high' | 'critical'` exported as `ALL_SECURITY_RISK_LEVELS`
- `RiskFactor.id` is a 5-value union (compile-time enforced)
- `SECURITY_CARDS` array is `as const` so the 11-section list is type-checked at the call site

---

## Tests

`web/src/__tests__/SecurityActivityCenter.test.tsx` — **23 tests, all passing**:

- **Page render + role gate (6):** admin sees page, supervisor sees page, risk_analyst bounced, field_officer bounced, all 11 cards present in canonical order, legacy-URL panel + risk panel + top-admins panel present
- **Closed enum (2):** `ALL_SECURITY_RISK_LEVELS` order, `SECURITY_RISK_THRESHOLDS` constants
- **`computeRiskScoreForActor` (8):** zero events → low+0; each factor trigger fires correctly; single-IP doesn't flag unusual location; all 5 factors together → critical+8
- **`rollupActorRiskScores` (3):** empty input, dedup, sort order (score desc → recent activity → username asc)
- **`summarizeSecurityActivity` (3):** empty input, failed_logins counter, critical_actors surfacing

### Sibling regression

- AdminActivityPage / AdminSessionsPage / AuditTrailPage / IamCenterPage / GovernanceCenterPage all green (69/70 across 5 files)
- AppShellNavGroups has 1 pre-existing failure (the AI Governance Layer commit `727ebd0` renamed `/ai/explainability` → `/ai/workbench/explainability` but didn't update this test) — confirmed pre-existing via `git stash` round-trip, not introduced by this change

### Build

`vite build` → clean (4.62s, ~745 kB gzip — no regression vs baseline)

---

## What's deliberately NOT here

- **No persisted risk-score history** — the resolver runs in-process. Adding history is a separate sub-feature with its own migration.
- **No geo-IP lookup** — `unusual_location` uses distinct-IP-count as a proxy. Real geo would need a new dependency (`maxmind/geoip` or similar) and an external dataset.
- **No bulk-action UI** — Response Actions section deep-links into `/admin/users` + `/admin/sessions` where the existing actions live. No duplicate destructive-action UI.
- **No new BFF route** — every data point is derived from `GET /auth/audit` + `GET /admin/sessions` at request time.
- **No new database table** — explicit non-goal. Future history would land in `app_iam.security_risk_score_snapshots` per separate ticket.

---

## Pattern coda — 6 overlay centers shipped this session

1. **Rule Center** (commit `61ae37c`) — 4 scattered rule modules → 1 hub
2. **Audit Center + Recovery Center** (commit `1689032`) — 6 modules → 2 hubs
3. **AI Governance Layer** (commit `727ebd0`) — 6 sub-sections under AI Workbench
4. **Enterprise IAM Layer** (commit `b7539d7`) — 6 features for IAM
5. **Enterprise Governance Center** (commit `e776639`) — 11 sections for Master Setup
6. **Security Activity Center** (this commit) — 11 sections for Admin Activity

Same pattern every time: a landing page composes existing reads, presents a card grid, and reserves a small slot for net-new derived data (e.g. risk scoring here, lint engine on the Rule Center). Cost stays linear in number of sections; backward compat is preserved by treating the landing as a sibling, not a replacement.
