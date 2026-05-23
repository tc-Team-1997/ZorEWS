# BFF OpenAPI 3.1 — API Reference

> Auto-generated from `services/bff/src/server.ts` + `services/auth-svc/src/**` on **2026-05-23T16:46:18.230Z**. Hand-edits are overwritten on next `scripts/gen-openapi.js` run.

## Specification artefacts

| File | Format | Purpose |
|---|---|---|
| [`swagger.json`](./swagger.json) | OpenAPI 3.1 JSON | Machine-readable; import to Postman / Insomnia / Stoplight |
| [`swagger.yaml`](./swagger.yaml) | OpenAPI 3.1 YAML | Human-readable canonical form |
| [`openapi.md`](./openapi.md) | Markdown | This file — quick navigation + curl examples |

## Coverage

- **775** route declarations auto-discovered: 734 from BFF + 41 from auth-svc
- Grouped into **10** tag buckets (Auth · Users · Dashboard · Borrower · EWS · Alerts · Workflow · AI · Reports · Config)
- **Bearer auth** required on all routes except: `/healthz`, `/oauth/token`, `/.well-known/jwks.json`, `/auth/login`, `/auth/refresh`, `/auth/captcha`
- **`X-Tenant-ID` + `X-Channel`** headers required on every `/v1/*` route (BFF tenant middleware)

## Authentication

Two parallel schemes supported on every guarded route:

### `bearerAuth` — JWT (user sessions)

```
Authorization: Bearer <RS256 JWT>
X-Tenant-ID: BANK_DEMO
X-Channel: API
```

Issue via `POST /auth/login` (user + password) or `POST /oauth/token` (`grant_type=client_credentials`). Signature verified against `GET /.well-known/jwks.json`.

### `apiKeyAuth` — service-account keys

```
Authorization: Bearer apex_<prefix>.<secret>
```

Minted via `POST /v1/admin/api-keys`; secret returned ONCE. Scoped to a subset of `alerts:read | cases:read | audit:read | reports:read | notifications:send | webhooks:dispatch | integrations:read | recovery:archive_internal`. Tenant binding baked into the key — `X-Tenant-ID` overrides are ignored.

## Response envelope

Every `/v1/*` route returns the bank-grade envelope per Banking API Integration §6:

```json
{
  "header": {
    "status": "success",
    "code": "EWS_200",
    "message": "Processed Successfully",
    "requestId": "8f4e5a90-2a55-4f8e-9c63-bc4e5e1d3a91",
    "timestamp": "2026-05-23T12:00:00.000Z"
  },
  "body": "<route-specific payload>"
}
```

Errors carry the same header + an `error: { code, message, severity, detail? }` block. Codes route by status: `EWS_400_<reason>` / `EWS_404_<resource>` / `EWS_409_<conflict>` / `EWS_500`. SPA-internal `/api/*` routes return raw JSON (no envelope) and are documented but not enveloped.

## Pagination

Every paginated list route accepts `?page=N&page_size=N` and returns:

```
{ "items": [...], "page": 1, "page_size": 50, "total": 1234 }
```

`page_size` is silently clamped — see the per-route schema for the cap (typically 200 or 500).

## Endpoints by tag

### Auth

_Authentication, OAuth, 2FA, API key provisioning, sessions_

**33 routes.** Routes sorted by path.

| Method | Path | Summary |
|---|---|---|
| `GET` | `/.well-known/jwks.json` | JWKS publication (T4.24 Phase 7) |
| `DELETE` | `/auth/2fa` | DELETE /auth/2fa |
| `POST` | `/auth/2fa/setup` | POST /auth/2fa/setup |
| `GET` | `/auth/2fa/status` | GET /auth/2fa/status |
| `POST` | `/auth/2fa/verify` | POST /auth/2fa/verify |
| `GET` | `/auth/captcha/challenge` | GET /auth/captcha/challenge |
| `POST` | `/auth/login` |  |
| `POST` | `/auth/refresh` |  |
| `POST` | `/oauth/token` | POST /oauth/token |
| `GET` | `/v1/admin/api-keys` |  |
| `POST` | `/v1/admin/api-keys` |  |
| `DELETE` | `/v1/admin/api-keys/:key_id` |  |
| `GET` | `/v1/admin/api-keys/:key_id` |  |
| `POST` | `/v1/admin/api-keys/:key_id/revoke` |  |
| `GET` | `/v1/admin/api-keys/by-creator` | view over the M1.2 redacted ApiKeyEntry surface. Per-creator row |
| `GET` | `/v1/admin/api-keys/creator-lifecycle-matrix` | 2D cross-tab combining M1.10 lifecycle stages × M1.6 creators. |
| `GET` | `/v1/admin/api-keys/creator-scope-matrix` | cross-tab combining M1.6 creators × M1.5 scopes. Rows = creators |
| `GET` | `/v1/admin/api-keys/creator-status-matrix` | key_ids[] cap 50 sorted asc}. Per-col {status, total, by_creator |
| `GET` | `/v1/admin/api-keys/daily-volume` | LINE view of API key creations across the last N UTC days. |
| `GET` | `/v1/admin/api-keys/expiry-forecast` | looking timeline of API key expirations across the next N days. |
| `GET` | `/v1/admin/api-keys/lifecycle-distribution` | per-key lifecycle stage classification. 7 canonical stages in |
| `GET` | `/v1/admin/api-keys/lifecycle-scope-matrix` | scope dedup via Set + closed-enum filter via VALID_SCOPES. |
| `GET` | `/v1/admin/api-keys/revocation-daily-volume` | — TREND-LINE over `revoked_at` (vs M1.9's `created_at`). Same |
| `GET` | `/v1/admin/api-keys/revoker-rollup` | pivot over the M1.2 redacted ApiKeyEntry surface. Mirror of M1.6 |
| `GET` | `/v1/admin/api-keys/scope-creator-matrix` | cross-tab combining 7 closed ApiKeyScope × N creators (open). |
| `GET` | `/v1/admin/api-keys/scope-distribution` | pivot over the M1.2 store (inverts M1.4's BY-KEY view). Per |
| `GET` | `/v1/admin/api-keys/scope-status-matrix` | key scope dedup. Per-row {scope, total, by_status (every status |
| `GET` | `/v1/admin/api-keys/time-to-revocation-histogram` | (revoked_at − created_at). Answers "what's our typical key |
| `GET` | `/v1/admin/api-keys/usage` | over the M1.2 API key store. Per-key row carries days_since_last_use |
| `GET` | `/v1/admin/api-keys/usage-recency-histogram` | pure time-based recency histogram over the M1.2 ApiKeyEntry list. |
| `GET` | `/v1/svc/audit/integrity` | the M15.2 chain-verification surface. Requires `audit:read` |
| `POST` | `/v1/svc/recovery/archive` | source_action?:   string, |
| `GET` | `/v1/svc/whoami` | Requires only that the caller be authenticated (no scope). */ |

### Users

_User management, profile, dashboard-widget config_

**31 routes.** Routes sorted by path.

| Method | Path | Summary |
|---|---|---|
| `GET` | `/auth/audit-log` | GET /auth/audit-log?type=...&target_username=...&limit=... |
| `GET` | `/auth/dashboard-widgets/:role` | Dashboard widgets per-role config (T4.23, BAC-A §3.1.9.1.4) |
| `PUT` | `/auth/dashboard-widgets/:role` | PUT /auth/dashboard-widgets/:role |
| `POST` | `/auth/first-login/complete` | POST /auth/first-login/complete |
| `GET` | `/auth/leave-covers` | GET /auth/leave-covers?applicant_user=&leave_coverer=&active_on=&active_only= |
| `POST` | `/auth/leave-covers` | POST /auth/leave-covers |
| `DELETE` | `/auth/leave-covers/:cover_id` | DELETE /auth/leave-covers/:cover_id — cancel a cover. |
| `POST` | `/auth/login/verify-2fa` | POST /auth/login/verify-2fa |
| `GET` | `/auth/me` |  |
| `GET` | `/auth/me/activity` | GET /auth/me/activity?limit=... |
| `POST` | `/auth/password/admin-reset` | POST /auth/password/admin-reset |
| `POST` | `/auth/password/reset-confirm` | POST /auth/password/reset-confirm |
| `POST` | `/auth/password/reset-request` | POST /auth/password/reset-request |
| `POST` | `/auth/recovery/restore` | Body:    { entity_type, original_id, payload } |
| `POST` | `/auth/register` |  |
| `GET` | `/auth/service-clients` | Service-client CRUD (T4.24 Phase 11) |
| `POST` | `/auth/service-clients` | POST /auth/service-clients |
| `DELETE` | `/auth/service-clients/:tenant_id/:client_id` | DELETE /auth/service-clients/:tenant_id/:client_id |
| `DELETE` | `/auth/sessions` | DELETE /auth/sessions?except=current |
| `GET` | `/auth/sessions` | GET /auth/sessions |
| `DELETE` | `/auth/sessions/:sid` | DELETE /auth/sessions/:sid |
| `GET` | `/auth/teams` | Teams (Issue Owner Groups + branch teams, T4.21) |
| `POST` | `/auth/teams` | POST /auth/teams |
| `DELETE` | `/auth/teams/:team_id` | DELETE /auth/teams/:team_id |
| `GET` | `/auth/teams/:team_id` | GET /auth/teams/:team_id |
| `POST` | `/auth/teams/:team_id/members` | POST /auth/teams/:team_id/members |
| `DELETE` | `/auth/teams/:team_id/members/:user_id` | DELETE /auth/teams/:team_id/members/:user_id |
| `GET` | `/auth/users` | GET /auth/users |
| `POST` | `/auth/users` | POST /auth/users |
| `GET` | `/auth/users/:user_id/active-cover` | GET /auth/users/:user_id/active-cover?date=YYYY-MM-DD |
| `DELETE` | `/auth/users/:username` | DELETE /auth/users/:username |

### Dashboard

_Executive + Operational + Claims + Underwriting + Agent dashboards (SPA-facing aggregations)_

**26 routes.** Routes sorted by path.

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/dashboard/summary` | Dashboard KPI summary used by the SPA's home page. Aggregates from |
| `GET` | `/v1/dashboards/bil/agent` | M11.3 — Agent Dashboard. Performance leaderboard, risk-contribution |
| `GET` | `/v1/dashboards/bil/claims` | BIL dashboards (T6 M11.1+) — DataNetworks-EWS-Ver1.pdf §14 |
| `GET` | `/v1/dashboards/bil/executive` | BIL Executive Watchlist (T6 M11.5) |
| `GET` | `/v1/dashboards/bil/operational` | M11.4 — Operational Dashboard. UW delay breakdown by branch + |
| `GET` | `/v1/dashboards/bil/underwriting` | M11.2 — Underwriting Dashboard. High-risk proposals, churn trend |
| `GET` | `/v1/dashboards/custom` |  |
| `POST` | `/v1/dashboards/custom` |  |
| `DELETE` | `/v1/dashboards/custom/:dashboard_id` |  |
| `GET` | `/v1/dashboards/custom/:dashboard_id` |  |
| `PUT` | `/v1/dashboards/custom/:dashboard_id` |  |
| `GET` | `/v1/dashboards/custom/:dashboard_id/lint` | pure lint pass over a saved layout. Returns LintReport with |
| `POST` | `/v1/dashboards/custom/:dashboard_id/resolve` | resolve every widget on a saved dashboard in one shot. */ |
| `GET` | `/v1/dashboards/custom/authorship` | CREATED_BY rollup over saved dashboards. Per author: |
| `POST` | `/v1/dashboards/custom/export` | into a versioned JSON envelope. body { dashboard_ids: string[] }. |
| `GET` | `/v1/dashboards/custom/fleet-lint` | M11.10 lint reports across every saved dashboard in the |
| `GET` | `/v1/dashboards/custom/freshness` | M11.18) — per-dashboard layout freshness rollup. Each row carries |
| `POST` | `/v1/dashboards/custom/import` | into the caller's tenant. body { bundle: DashboardBundle, |
| `GET` | `/v1/dashboards/custom/starter-packs` | curated starter dashboard layouts ("Daily ops", "Executive |
| `GET` | `/v1/dashboards/custom/widget-count-histogram` | Strict-< upper bounds (4 widgets exactly → medium not small). |
| `GET` | `/v1/dashboards/custom/widget-creator-matrix` | 2D cross-tab combining 7 WidgetType (closed) × N creators (open). |
| `GET` | `/v1/dashboards/widgets/catalog` |  |
| `GET` | `/v1/dashboards/widgets/config-keys` | index over the WIDGET_CATALOG.config_keys[] arrays. For each |
| `GET` | `/v1/dashboards/widgets/defaults` | default config seed for the SPA's "Add widget" wizard. Returns |
| `POST` | `/v1/dashboards/widgets/resolve` | single ad-hoc widget. Body { widget_type, position, span, config }. */ |
| `GET` | `/v1/dashboards/widgets/usage` | tenant's saved dashboards. For each widget_type in WIDGET_CATALOG |

### Borrower

_Customer-centric reads: risk profile, exposure, history, drill-throughs_

**8 routes.** Routes sorted by path.

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/customers` | /api/customers — list of monitored customers (SPA Customers page). |
| `GET` | `/api/customers/:id/risk` | /api/customers/:id/risk — full risk profile for the SPA Customer 360 page. |
| `GET` | `/v1/customers/:customer_id/360` | Per-customer 360 drill-through (T6 M11.6) |
| `GET` | `/v1/risk-profile/:customer_id` | GET /v1/risk-profile/:customer_id — T4.24 envelope + tenant. |
| `GET` | `/v1/watchlist` |  |
| `POST` | `/v1/watchlist` | body { customer_id, reason, vertical? }. */ |
| `DELETE` | `/v1/watchlist/:customer_id` |  |
| `POST` | `/v1/watchlist/scan` | every watched customer. Empty watchlist returns an empty |

### EWS

_Early-warning surface — indicators, rules, streaming alert path, feature store_

**80 routes.** Routes sorted by path.

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/rules` | /api/rules — list of rules in the SPA's RuleSummary shape (sourced from BFF rules seed). |
| `POST` | `/v1/ews/evaluate` | Response envelope (success): |
| `GET` | `/v1/ews/rules` |  |
| `POST` | `/v1/ews/rules` |  |
| `DELETE` | `/v1/ews/rules/:rule_id` |  |
| `GET` | `/v1/ews/rules/:rule_id` |  |
| `PUT` | `/v1/ews/rules/:rule_id` |  |
| `POST` | `/v1/ews/rules/:rule_id/activate` |  |
| `GET` | `/v1/ews/rules/:rule_id/approvals` |  |
| `POST` | `/v1/ews/rules/:rule_id/approve` | 4-eyes activate. Refuses if approver === maker. */ |
| `POST` | `/v1/ews/rules/:rule_id/clone` | body { new_rule_id, new_name? } → 201 fresh DRAFT v0.1.0. */ |
| `GET` | `/v1/ews/rules/:rule_id/hits` |  |
| `POST` | `/v1/ews/rules/:rule_id/reject` | 4-eyes reject. body { reason } required. */ |
| `POST` | `/v1/ews/rules/:rule_id/submit` | body { reason? } → 200 with rule (PENDING_REVIEW). Records the |
| `POST` | `/v1/ews/rules/:rule_id/test` | sample values (does NOT record telemetry). */ |
| `GET` | `/v1/ews/rules/:rule_id/versions` |  |
| `GET` | `/v1/ews/rules/:rule_id/versions/:semver` |  |
| `POST` | `/v1/ews/rules/:rule_id/versions/:semver/revert` | body { reason? } → creates a new version whose snapshot equals the |
| `POST` | `/v1/ews/rules/:rule_id/versions/diff` | body { from, to, format? } |
| `POST` | `/v1/ews/rules/evaluate` | all active rules. Body { entity_type, entity_id, values }. */ |
| `GET` | `/v1/ews/rules/indicators` |  |
| `GET` | `/v1/feature-store/catalog` | features matching `ml/data/load_from_mart.py`). Platform-static. */ |
| `GET` | `/v1/feature-store/coverage` | size + earliest/latest observed_at window + 24-month cap. */ |
| `GET` | `/v1/feature-store/customers/:customer_id/history` |  |
| `GET` | `/v1/feature-store/customers/:customer_id/snapshot` | point-in-time row of every catalog feature for this customer. */ |
| `POST` | `/v1/indicators/backtest` | BIL indicator backtest (T6 M4.2) |
| `POST` | `/v1/indicators/backtest/compare` | between two BacktestResult objects. Caller runs both backtests |
| `GET` | `/v1/indicators/catalog-stats` | rollup over the M6.2 STUB_CATALOG. Per-vertical (banking + |
| `GET` | `/v1/indicators/overrides/vertical-family-matrix` | the OVERRIDE surface (vs M4.16's platform CATALOG). Per-row |
| `POST` | `/v1/indicators/scan-customer` | applicable indicator values for a customer, run each through |
| `POST` | `/v1/indicators/scan-customers` | M4.5: scan up to 50 customers in one shot, return ranked |
| `GET` | `/v1/indicators/thresholds` |  |
| `DELETE` | `/v1/indicators/thresholds/:indicator_id` | → revert to platform default. 204 / 404. */ |
| `GET` | `/v1/indicators/thresholds/:indicator_id` | resolved through tenant overrides (M4.4 wires getEffectiveThreshold). */ |
| `PUT` | `/v1/indicators/thresholds/:indicator_id` | per-tenant override. Body { yellow_at, orange_at, red_at } — |
| `POST` | `/v1/indicators/thresholds/:indicator_id/suggest` | body { values[], polarity? } — derives suggested {yellow, orange, |
| `GET` | `/v1/indicators/thresholds/band-gap` | LIBRARY DEFAULTS themselves. Per-row: {indicator_id, vertical, |
| `POST` | `/v1/indicators/thresholds/check` | classify a value into green\|yellow\|orange\|red. */ |
| `GET` | `/v1/indicators/thresholds/drift` | drift score over the M4.4 override store. Per-row: band-by |
| `GET` | `/v1/indicators/thresholds/effective` | (T6 M4.9) — every platform indicator's effective threshold for the |
| `GET` | `/v1/indicators/thresholds/overrides` | overrides (T6 M4.4). Declared BEFORE /:indicator_id. */ |
| `GET` | `/v1/indicators/thresholds/shift-analysis` | DIRECTION-aware shift view over per-tenant M4.4 threshold |
| `GET` | `/v1/indicators/usage` | for every indicator in the M6.2 catalog: which rule templates |
| `GET` | `/v1/indicators/vertical-family-matrix` | cross-tab elevating M4.13's nested by_family view. Rows = 2 |
| `GET` | `/v1/indicators/vertical-weight-matrix` | cross-tab combining M4.13 vertical axis × M4.15 weight buckets. |
| `GET` | `/v1/indicators/weight-histogram` | distribution histogram over the M6.2 STUB_CATALOG. 5 canonical |
| `GET` | `/v1/rules` |  |
| `GET` | `/v1/rules/:id` |  |
| `POST` | `/v1/rules/:id/backtest` |  |
| `GET` | `/v1/rules/:id/performance` |  |
| `POST` | `/v1/rules/:id/transition` |  |
| `POST` | `/v1/rules/simulate` | Rule simulation against scenario (T6 M5.3) |
| `POST` | `/v1/rules/simulate/bundle` |  |
| `GET` | `/v1/rules/templates` |  |
| `GET` | `/v1/rules/templates/:id` |  |
| `GET` | `/v1/rules/templates/:template_id/clones-in-tenant` | — back-reference query: for this library template, list every |
| `GET` | `/v1/rules/templates/action-inventory` | index from `recommended_action` enum to the templates that |
| `GET` | `/v1/rules/templates/action-severity-matrix` | absent), severities_without[]}. Per-col {severity, total, by_action |
| `POST` | `/v1/rules/templates/bulk-clone` | POST /v1/rules/templates/bulk-clone |
| `GET` | `/v1/rules/templates/categories` |  |
| `GET` | `/v1/rules/templates/category-vertical-matrix` | 2D cross-tab over RULE_TEMPLATES. Rows = 5 RuleTemplateCategory |
| `GET` | `/v1/rules/templates/custom` |  |
| `POST` | `/v1/rules/templates/custom` |  |
| `DELETE` | `/v1/rules/templates/custom/:template_id` | T6 M5.8 — writes rule.delete audit event. */ |
| `PUT` | `/v1/rules/templates/custom/:template_id` | mutable fields. Writes rule.update audit event with metadata. */ |
| `GET` | `/v1/rules/templates/custom/:template_id/history` | — slim audit-history view filtered to rule events for this id. */ |
| `GET` | `/v1/rules/templates/custom/:template_id/versions` | — version snapshots oldest-first. Cap 20 per template; restored |
| `POST` | `/v1/rules/templates/custom/:template_id/versions/:version/restore` | (T6 M5.12) — restore the live template to the captured version. |
| `POST` | `/v1/rules/templates/custom/bulk-clone-from-library` | body { template_ids[], name_prefix? } — iterates M5.9 single-clone |
| `POST` | `/v1/rules/templates/custom/clone-from-library` | body { source_template_id, name? } — reads a library template and |
| `POST` | `/v1/rules/templates/custom/export-bundle` | body { template_ids: string[] } → bundle envelope. */ |
| `POST` | `/v1/rules/templates/custom/import-bundle` | body { bundle, name_prefix? } → per-row import outcomes. */ |
| `POST` | `/v1/rules/templates/diff` | comparison of two templates. Declared BEFORE /:id so the |
| `GET` | `/v1/rules/templates/indicator-count-histogram` | histogram bucketing every M5.1 template by its supporting_indicators |
| `GET` | `/v1/rules/templates/indicator-coverage` | reference each rule template's supporting_indicators against |
| `GET` | `/v1/rules/templates/severity-distribution` | templates grouped by recommended_severity (critical/high/ |
| `GET` | `/v1/rules/variables` |  |
| `GET` | `/v1/streaming/events` |  |
| `POST` | `/v1/streaming/indicator-events` | a single event. Per-event record written to the streaming ledger |
| `GET` | `/v1/streaming/latency` | + by_indicator rollup over the recent ledger. */ |

### Alerts

_Alert ledger, routing, classification, ack/unack, escalation matrix_

**54 routes.** Routes sorted by path.

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/alerts` | /api (internal BFF — T3.10) |
| `GET` | `/v1/alerts` | /v1/alerts — same data + filters as /api/alerts; T4.24 wraps the |
| `GET` | `/v1/alerts/:alert_id/ack` | (an alert that was never touched returns status='open'). */ |
| `POST` | `/v1/alerts/:alert_id/ack` |  |
| `GET` | `/v1/alerts/:alert_id/ack/history` |  |
| `POST` | `/v1/alerts/:alert_id/unack` |  |
| `GET` | `/v1/alerts/ack-time/histogram` | ABSOLUTE wall-clock ack-time histogram over the M8.6 routing |
| `GET` | `/v1/alerts/ack/actor-activity` | over the M8.3 AlertAckStore. For each operator: total_actions, |
| `POST` | `/v1/alerts/auto-ack/evaluate` | — return matching rule (if any). */ |
| `GET` | `/v1/alerts/auto-ack/rules` |  |
| `POST` | `/v1/alerts/auto-ack/rules` |  |
| `DELETE` | `/v1/alerts/auto-ack/rules/:rule_id` |  |
| `GET` | `/v1/alerts/by-class/:class` | GET /v1/alerts/by-class/:class |
| `GET` | `/v1/alerts/channel-distribution` | pivot the M8.6 routing ledger by NotificationChannel. Per |
| `GET` | `/v1/alerts/class-channel-matrix` | 2D cross-tab over the M8.6 routing ledger combining class |
| `GET` | `/v1/alerts/classification/spec` |  |
| `POST` | `/v1/alerts/classify` | POST /v1/alerts/classify |
| `GET` | `/v1/alerts/daily-volume` | over the M8.6 alert routing ledger. Per UTC calendar day across |
| `GET` | `/v1/alerts/dow-hour-heatmap` | INTRADAY heatmap over the M8.6 routing ledger. For each routed |
| `POST` | `/v1/alerts/ingest` | auto-ack it if a tenant rule matches. body |
| `GET` | `/v1/alerts/quiet-hours-muted/analytics` | — tenant-wide rollup over the M10.8 quiet-hours mute event log: |
| `DELETE` | `/v1/alerts/quiet-hours-muted/me` | caller's quiet-hours-mute audit history (e.g. after the user |
| `GET` | `/v1/alerts/quiet-hours-muted/me` | list alerts auto-muted for the calling user during their quiet |
| `GET` | `/v1/alerts/routing/analytics` | routing performance over the recent window: class mix, channel |
| `GET` | `/v1/alerts/routing/channel-coverage` | validator: for each routing rule, check whether every channel |
| `POST` | `/v1/alerts/routing/decide` | POST /v1/alerts/routing/decide |
| `GET` | `/v1/alerts/routing/diff` | tenant's effective routing rule and DEFAULT_RULES. Per-class: |
| `GET` | `/v1/alerts/routing/matrix` | matrix snapshot for the tenant + SHA-256 fingerprint of the |
| `POST` | `/v1/alerts/routing/preview` | decorates the M8.2 routing decision with computed sla_deadline |
| `GET` | `/v1/alerts/routing/rules` |  |
| `DELETE` | `/v1/alerts/routing/rules/:class` |  |
| `PUT` | `/v1/alerts/routing/rules/:class` | PUT /v1/alerts/routing/rules/:class |
| `GET` | `/v1/alerts/sla-breaches/detail` | per-alert SLA breach detail over the recent ledger window. |
| `GET` | `/v1/alerts/sla-compliance-by-class` | PER-CLASS SLA compliance rate over the M8.6 routing ledger. |
| `POST` | `/v1/aml/correlate/:match_id` | POST /v1/aml/correlate/:match_id |
| `POST` | `/v1/aml/correlate/by-alert/:alert_id` | POST /v1/aml/correlate/by-alert/:alert_id |
| `GET` | `/v1/aml/correlation/entity/:kind/:id` |  |
| `GET` | `/v1/aml/correlation/enums` |  |
| `GET` | `/v1/aml/correlation/links` |  |
| `POST` | `/v1/aml/correlation/links` |  |
| `DELETE` | `/v1/aml/correlation/links/:link_id` |  |
| `GET` | `/v1/aml/correlation/links/:link_id` |  |
| `GET` | `/v1/aml/correlation/summary` |  |
| `POST` | `/v1/aml/correlation/timeline` |  |
| `POST` | `/v1/aml/correlation/traverse` |  |
| `GET` | `/v1/aml/dashboard` |  |
| `GET` | `/v1/aml/str-reports` |  |
| `POST` | `/v1/aml/str-reports` |  |
| `DELETE` | `/v1/aml/str-reports/:str_id` | (only allowed in draft / ready_for_review per FIU-IND retention). */ |
| `GET` | `/v1/aml/str-reports/:str_id` |  |
| `PATCH` | `/v1/aml/str-reports/:str_id` |  |
| `POST` | `/v1/aml/str-reports/:str_id/transition` |  |
| `GET` | `/v1/aml/str-reports/summary` |  |
| `GET` | `/v1/aml/str-reports/taxonomy` |  |

### Workflow

_Cases, investigations, maker-checker approvals, action log, tenant onboarding_

**92 routes.** Routes sorted by path.

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/cases` | /api/cases — list of cases for the SPA Cases page. |
| `GET` | `/api/cases/:id` | /api/cases/:id — single case detail |
| `POST` | `/v1/action` | POST /v1/action — T4.24 envelope + tenant. |
| `GET` | `/v1/cases/:case_id/events` |  |
| `GET` | `/v1/cases/:case_id/timeline` | full state-transition ladder from the M9.4 event journal. Returns |
| `GET` | `/v1/cases/events` |  |
| `POST` | `/v1/cases/events` | body { case_id, action, actor, payload? }. */ |
| `GET` | `/v1/cases/events/:event_id` |  |
| `GET` | `/v1/cases/events/action-distribution` | ACTION 1D rollup over the M9.4 case event journal. 9 canonical |
| `GET` | `/v1/cases/events/transition-matrix` | state_change event with payload {from, to}, pivot into a 2D |
| `GET` | `/v1/cases/maker-checker` | GET /v1/cases/maker-checker?status=&action_type=&case_id=&maker_username=& |
| `POST` | `/v1/cases/maker-checker` |  |
| `GET` | `/v1/cases/maker-checker/:action_id` |  |
| `POST` | `/v1/cases/maker-checker/:action_id/approve` |  |
| `POST` | `/v1/cases/maker-checker/:action_id/reject` |  |
| `GET` | `/v1/cases/maker-checker/reviewer-rollup` | CHECKER pivot over M9.3 sensitive case actions. Counts only |
| `GET` | `/v1/cases/sla-breaches` | state timeline from the M9.4 event journal, compare time-in-state |
| `GET` | `/v1/cases/sla-summary` | End CMS-3 routes |
| `GET` | `/v1/cases/states/graph` | catalog. Per state: {state, sla_hours_default, terminal, |
| `POST` | `/v1/cms/automation/auto-create-from-alert` | body { alert_id, alert_severity, customer_id?, rule_id?, rule_name?, context? } |
| `GET` | `/v1/cms/automation/inactive-cases` | Cases with status != CLOSED + updated_at older than threshold, |
| `GET` | `/v1/cms/automation/pool` |  |
| `PUT` | `/v1/cms/automation/pool` |  |
| `GET` | `/v1/cms/cases` |  |
| `POST` | `/v1/cms/cases` |  |
| `GET` | `/v1/cms/cases/:case_id` |  |
| `PATCH` | `/v1/cms/cases/:case_id` |  |
| `POST` | `/v1/cms/cases/:case_id/assign` |  |
| `POST` | `/v1/cms/cases/:case_id/assign-from-pool` | Round-robin from the tenant's assignee pool. Updates last |
| `GET` | `/v1/cms/cases/:case_id/attachments` |  |
| `POST` | `/v1/cms/cases/:case_id/attachments` | { file_name, file_size, mime_type } — registers metadata. */ |
| `DELETE` | `/v1/cms/cases/:case_id/attachments/:attachment_id` |  |
| `GET` | `/v1/cms/cases/:case_id/attachments/:attachment_id` | attachment metadata (the prototype's "download" surfaces metadata |
| `PATCH` | `/v1/cms/cases/:case_id/category` | Closes the loop on migration 019's heuristic backfill: rows that |
| `POST` | `/v1/cms/cases/:case_id/close` |  |
| `POST` | `/v1/cms/cases/:case_id/escalate` |  |
| `GET` | `/v1/cms/cases/:case_id/history` |  |
| `GET` | `/v1/cms/cases/:case_id/notes` |  |
| `POST` | `/v1/cms/cases/:case_id/notes` |  |
| `GET` | `/v1/cms/cases/:case_id/tracking` | Per-case tracking timeline — wraps the existing history rows with |
| `POST` | `/v1/cms/cases/:case_id/transition` |  |
| `POST` | `/v1/cms/cases/bulk-assign` |  |
| `GET` | `/v1/cms/cases/sla-breaches` | sorted by overshoot (most-overdue first). */ |
| `GET` | `/v1/cms/cases/stats` |  |
| `GET` | `/v1/field/officers/:officer_id/today` | — visits logged "today" in the requested zone. */ |
| `GET` | `/v1/field/operations/analytics` | rollup over the M14.10 visit ledger: outcome mix, distinct |
| `GET` | `/v1/field/visits` | ?customer_id=&officer_id=&outcome=&since=ISO&until=ISO. */ |
| `POST` | `/v1/field/visits` | {officer_id, customer_id, visit_at, outcome, note, location?}. */ |
| `GET` | `/v1/field/visits/dow-hour-heatmap` | week × hour-of-day matrix over the M14.10 visit ledger. ISO Mon=0 |
| `GET` | `/v1/field/visits/geo-clusters` | — greedy Haversine clustering of field visits with GPS pins. |
| `GET` | `/v1/investigations` |  |
| `POST` | `/v1/investigations` | POST /v1/investigations body: { case_id, customer_id, checklist_template_id? } |
| `GET` | `/v1/investigations/:id` |  |
| `GET` | `/v1/investigations/:id/notes` |  |
| `POST` | `/v1/investigations/:id/notes` | POST /v1/investigations/:id/notes body: { body } |
| `PATCH` | `/v1/investigations/:id/status` | PATCH /v1/investigations/:id/status body: { status, decision? } |
| `GET` | `/v1/investigations/:id/step-progress` | step progress card: counts + completion rate + oldest pending + |
| `POST` | `/v1/investigations/:id/steps/:step_id/complete` | POST /v1/investigations/:id/steps/:step_id/complete body: { evidence_link? } |
| `GET` | `/v1/investigations/age-distribution` | of open + closed investigations by age bucket (< 24h / 1-3d / |
| `GET` | `/v1/investigations/age-status-matrix` | combining M9.11 age buckets × M9.8 cohort status. Per-cell count |
| `GET` | `/v1/investigations/checklists` |  |
| `POST` | `/v1/investigations/checklists` | POST /v1/investigations/checklists body: CreateTemplateInput |
| `DELETE` | `/v1/investigations/checklists/:id` | DELETE /v1/investigations/checklists/:id — delete a custom template. |
| `GET` | `/v1/investigations/checklists/:id` |  |
| `GET` | `/v1/investigations/duration-histogram` | 30d → 30d_plus; matches M8.12 / M9.11 boundary convention). |
| `GET` | `/v1/investigations/note-authorship` | rollup over investigation notes. Per-author row {author_username, |
| `GET` | `/v1/investigations/notes/daily-volume` | per-UTC-day count of notes added across all investigations in |
| `GET` | `/v1/investigations/notes/search` | cross-investigation substring search over the notes thread. |
| `GET` | `/v1/investigations/outcome-by-template` | groups investigations by `checklist_template_id` to answer |
| `GET` | `/v1/investigations/step-backlog` | per-step backlog. For each step_id seen across the cohort |
| `GET` | `/v1/investigations/summary` | rollup over ALL investigations in the tenant. Returns per-status |
| `GET` | `/v1/tenants/:tenant_id/onboarding` |  |
| `GET` | `/v1/tenants/:tenant_id/onboarding/readiness` | lookup of any tenant's readiness. Mounted BEFORE the catch-all |
| `POST` | `/v1/tenants/:tenant_id/onboarding/reset` |  |
| `POST` | `/v1/tenants/:tenant_id/onboarding/steps/:step_id` |  |
| `POST` | `/v1/tenants/:tenant_id/onboarding/steps/:step_id/skip` | body { reason }. Forces status=skipped and captures the regulatory/ |
| `GET` | `/v1/tenants/me/onboarding` |  |
| `GET` | `/v1/tenants/me/onboarding/actors` | view: each user who touched a step grouped with their completed + |
| `GET` | `/v1/tenants/me/onboarding/eta` | projection: per-step minute estimates → remaining_minutes + |
| `GET` | `/v1/tenants/me/onboarding/milestone` | milestone classification (starting → in_progress → near_done |
| `GET` | `/v1/tenants/me/onboarding/overview` | payload combining M2.6 readiness + M2.7 skip-history + M2.8 |
| `GET` | `/v1/tenants/me/onboarding/readiness` | readiness score derived from the M2.2 onboarding state. Weighted |
| `GET` | `/v1/tenants/me/onboarding/skip-history` | view of just the caller's tenant skipped onboarding steps with |
| `GET` | `/v1/tenants/onboarding/actor-fleet` | per-actor onboarding contribution. Distinct from M2.10 (per-tenant |
| `GET` | `/v1/tenants/onboarding/completion-timeline` | TREND-LINE view: across all tenants in the registry, count step |
| `GET` | `/v1/tenants/onboarding/fleet` | admin view returning onboarding posture for EVERY configured |
| `GET` | `/v1/tenants/onboarding/skip-reason-analytics` | cross-tenant fleet rollup over the M2.5 skip_reason capture. |
| `GET` | `/v1/tenants/onboarding/stage-vertical-matrix` | {stage, label, total, by_vertical (every vertical at 0 — stable |
| `GET` | `/v1/tenants/onboarding/step-completion` | PER-STEP cross-tenant completion rollup. M2.12 pivots BY-TENANT |
| `GET` | `/v1/tenants/onboarding/step-vertical-matrix` | asc) × cols = 2 verticals (banking → insurance) = 16 cells. |
| `GET` | `/v1/tenants/onboarding/steps` |  |
| `GET` | `/v1/tenants/onboarding/velocity` | upper bound semantics. Per-bucket {count, sample_tenant_ids cap |

### AI

_AI/ML model registry, scoring, promotions, retraining, copilot, predictions_

**71 routes.** Routes sorted by path.

| Method | Path | Summary |
|---|---|---|
| `GET` | `/v1/ai/models` |  |
| `GET` | `/v1/ai/models/:model_id` |  |
| `GET` | `/v1/ai/models/:model_id/metrics` |  |
| `GET` | `/v1/ai/models/:model_id/performance` | — list raw entries, newest-first by recorded_at. */ |
| `POST` | `/v1/ai/models/:model_id/performance` | observation. body { metric, value, sample_size, notes? }. */ |
| `GET` | `/v1/ai/models/:model_id/performance/outliers` | (T6 M7.7) — z-score-based outlier detection over the M7.5 ledger. |
| `GET` | `/v1/ai/models/:model_id/performance/summary` | per-metric latest + mean/p50/p95 over the queried window |
| `GET` | `/v1/ai/models/:model_id/performance/summary.txt` | — printable plain-text summary suitable for browser print-to-PDF. |
| `GET` | `/v1/ai/models/:model_id/performance/trend` | (T6 M7.8) — linear-regression slope over a single metric's |
| `POST` | `/v1/ai/models/:model_id/promotion-gate/auto-promote` | body: { from_status, target_status, thresholds?, request_notes? } |
| `POST` | `/v1/ai/models/:model_id/promotion-gate/evaluate` | body: { target_status: ModelStatus, thresholds?: GateThresholds, since?, until? } */ |
| `GET` | `/v1/ai/models/:model_id/promotion-timeline` | per-model promotion-request audit trail. Drains the M7.2 |
| `POST` | `/v1/ai/models/:model_id/score` | POST /v1/ai/models/:model_id/score body: InferenceInput |
| `POST` | `/v1/ai/models/ab-test` | against TWO models and return both + a delta summary. */ |
| `POST` | `/v1/ai/models/ab-test/batch` | across N customers; aggregate delta + band-match rate. */ |
| `GET` | `/v1/ai/models/by-type/:type` |  |
| `GET` | `/v1/ai/models/deployment-age` | histogram over non-retired models by days_since_deployed |
| `GET` | `/v1/ai/models/framework-distribution` | PIVOT-BY-FRAMEWORK view over the M7.1 registry. Orthogonal to |
| `GET` | `/v1/ai/models/framework-type-matrix` | M7.13 (framework distribution). Rows = 5 ModelFramework |
| `GET` | `/v1/ai/models/performance-freshness` | (T6 M7.18) — per-model freshness rollup. For each model in the |
| `GET` | `/v1/ai/models/promotion-fleet` | promotion-request rollup. Walks the M7.1 registry + drains the |
| `GET` | `/v1/ai/models/retirement-candidates` | (T6 M7.9) — non-retired models with deployment age past |
| `GET` | `/v1/ai/models/type-coverage` | coverage matrix over the M7.1 registry. Per BIL model type |
| `GET` | `/v1/ai/models/types` |  |
| `GET` | `/v1/ai/predictions` | AI prediction log (pg-ai-predictions) |
| `GET` | `/v1/ai/predictions/:prediction_id` |  |
| `GET` | `/v1/ai/promotions` |  |
| `POST` | `/v1/ai/promotions` |  |
| `GET` | `/v1/ai/promotions/:request_id` |  |
| `POST` | `/v1/ai/promotions/:request_id/approve` |  |
| `POST` | `/v1/ai/promotions/:request_id/reject` |  |
| `GET` | `/v1/ai/promotions/daily-volume` | day: {date, total, by_status (every PromotionRequestStatus at 0: |
| `GET` | `/v1/ai/promotions/latency-histogram` | approval-latency distribution over decided requests + still-pending |
| `GET` | `/v1/ai/promotions/reviewer-rollup` | pivot over M7.2 promotion requests. Counts only decided requests |
| `GET` | `/v1/ai/retraining/outcomes` |  |
| `POST` | `/v1/ai/retraining/outcomes` | completed retrain (success/failure/rolled_back/in_progress). On |
| `GET` | `/v1/ai/retraining/schedules` |  |
| `POST` | `/v1/ai/retraining/schedules` |  |
| `DELETE` | `/v1/ai/retraining/schedules/:schedule_id` |  |
| `GET` | `/v1/ai/retraining/schedules/:schedule_id` |  |
| `PATCH` | `/v1/ai/retraining/schedules/:schedule_id` |  |
| `GET` | `/v1/ai/retraining/status` | last outcome + is_overdue flag + 30d success rate. */ |
| `POST` | `/v1/copilot/chat` | POST /v1/copilot/chat — T4.24 envelope + tenant. |
| `POST` | `/v1/copilot/nl-to-sql` | Pattern-matches the question against ~10 known analytics intents |
| `GET` | `/v1/copilot/v2/audit` |  |
| `POST` | `/v1/copilot/v2/chat` | body { message, conversation_id?, context?: { page, entity, role } } |
| `GET` | `/v1/copilot/v2/conversations` |  |
| `GET` | `/v1/copilot/v2/conversations/:conversation_id` | Returns conversation header + messages oldest-first. */ |
| `GET` | `/v1/copilot/v2/quota` |  |
| `GET` | `/v1/scoring/presets` |  |
| `GET` | `/v1/scoring/presets/:id` |  |
| `GET` | `/v1/scoring/presets/:preset_id/effective-weights` | (T6 M6.10) — per-indicator effective weights view. Walks the |
| `GET` | `/v1/scoring/presets/custom` |  |
| `POST` | `/v1/scoring/presets/custom` |  |
| `DELETE` | `/v1/scoring/presets/custom/:preset_id` |  |
| `POST` | `/v1/scoring/presets/custom/bulk-clone-from-library` | body { source_preset_ids[], name_prefix? } — clone N library |
| `POST` | `/v1/scoring/presets/custom/clone-from-library` | body { source_preset_id, name? } — reads a library weight preset |
| `GET` | `/v1/scoring/presets/custom/multiplier-histogram` | Per-row {preset_id, name, mode, vertical, total_multipliers, |
| `GET` | `/v1/scoring/presets/diff` | structural diff between two presets (library OR custom). |
| `GET` | `/v1/scoring/presets/family-matrix` | by_family (9 keys at 0 when absent — stable grid), families_without |
| `GET` | `/v1/scoring/presets/inventory` | inventory: 3 modes × 2 verticals with per-cell library + custom |
| `GET` | `/v1/scoring/presets/multiplier-histogram` | per-library-preset histogram of explicit weight_multipliers |
| `POST` | `/v1/scoring/risk` | BIL Σ(W×V) risk-scoring engine (T6 M6.1) |
| `POST` | `/v1/scoring/risk/by-indicators` | BIL scoring with catalog weight lookup (T6 M6.2) |
| `POST` | `/v1/scoring/risk/by-preset` | the preset's multipliers on top of catalog defaults. */ |
| `POST` | `/v1/scoring/risk/by-preset/backtest` | labeled samples through a preset and report precision / recall / |
| `POST` | `/v1/scoring/risk/by-preset/batch` | with the same preset; aggregate band distribution. */ |
| `POST` | `/v1/scoring/risk/by-preset/compare` | presets to the same items[]; return left + right + delta. */ |
| `POST` | `/v1/scoring/sensitivity` | (T6 M6.13) — perturb each indicator value by ±perturbation |
| `POST` | `/v1/scoring/weights/preview` | Phase E.3 — Drag-drop weight adjustment preview |
| `POST` | `/v1/scoring/what-if` | fan one indicator input set across every M6.3 library preset |

### Reports

_Report catalog, scheduled jobs, builder, scenario library, exports_

**71 routes.** Routes sorted by path.

| Method | Path | Summary |
|---|---|---|
| `GET` | `/v1/reports/:type` | GET /v1/reports/:type?period={week\|month\|quarter}&format={json\|csv} |
| `POST` | `/v1/reports/builder/export.csv` | as RFC 4180 CSV with attachment Content-Disposition. */ |
| `POST` | `/v1/reports/builder/preview` | definition (filters + group_by + metrics + sort) into a safe |
| `POST` | `/v1/reports/builder/run` | ReportDefinition. Returns rows + projection + aggregates + |
| `GET` | `/v1/reports/builder/saved` | for the caller. Filters: ?visibility=&source_id=&created_by=&tag=. */ |
| `POST` | `/v1/reports/builder/saved` | visibility='role' additionally requires reports:share scope. */ |
| `DELETE` | `/v1/reports/builder/saved/:report_id` | 404 on miss or cross-tenant. */ |
| `GET` | `/v1/reports/builder/saved/:report_id` | 404 if not visible OR cross-tenant. */ |
| `PATCH` | `/v1/reports/builder/saved/:report_id` | fields. visibility transitions to 'role' require reports:share. */ |
| `POST` | `/v1/reports/builder/saved/:report_id/run` | saved report. Tenant + visibility checked (cross-tenant or |
| `GET` | `/v1/reports/builder/sources` | catalog. Returns every queryable mart + app_* surface with field |
| `GET` | `/v1/reports/builder/sources/:source_id` | source lookup. 404 EWS_404_unknown_source on miss. */ |
| `GET` | `/v1/reports/catalog` |  |
| `GET` | `/v1/reports/catalog/:id` |  |
| `GET` | `/v1/reports/jobs` | GET /v1/reports/jobs?status=&report_id=&requested_by=&page=&page_size= |
| `POST` | `/v1/reports/jobs` | POST /v1/reports/jobs body: ReportJobInput |
| `GET` | `/v1/reports/jobs/:job_id` |  |
| `GET` | `/v1/reports/jobs/analytics` | over the M12.1 reports-job ledger: status mix, format mix, |
| `GET` | `/v1/reports/jobs/daily-volume` | timeline over the M12.1 ReportJobStore. Per UTC day across N |
| `GET` | `/v1/reports/jobs/error-patterns` | FORENSICS view over the M12.1 job store. Clusters failed jobs by |
| `GET` | `/v1/reports/jobs/format-distribution` | ReportJobs by format (json / csv / pdf / xlsx). Per-format row: |
| `GET` | `/v1/reports/jobs/format-status-matrix` | (every status at 0 when absent), statuses_without[] canonical |
| `GET` | `/v1/reports/jobs/hourly-volume` | distribution: every job in the tenant's history bucketed by UTC |
| `GET` | `/v1/reports/jobs/per-requester` | rollup over the M12.1 job store. Per requester: total_jobs, |
| `GET` | `/v1/reports/jobs/processing-time-histogram` | — completion buckets sort duration desc (slowest first); failed |
| `GET` | `/v1/reports/jobs/runtime-trend` | least-squares slope of processing_ms over time. Per-row: |
| `GET` | `/v1/reports/schedules` |  |
| `POST` | `/v1/reports/schedules` |  |
| `DELETE` | `/v1/reports/schedules/:schedule_id` |  |
| `GET` | `/v1/reports/schedules/:schedule_id` |  |
| `PATCH` | `/v1/reports/schedules/:schedule_id` |  |
| `POST` | `/v1/reports/schedules/:schedule_id/mark-run` |  |
| `GET` | `/v1/reports/schedules/:schedule_id/preview` | (T6 M12.6) — project the next N firings of a saved schedule by |
| `GET` | `/v1/reports/schedules/cadence-format-matrix` | ScheduleCadence × 4 ReportFormat = 20 cells. Each schedule lives |
| `GET` | `/v1/reports/schedules/cadence-stats` | pivoted rollup over the M12.2 schedule store. Per-cadence: |
| `GET` | `/v1/reports/schedules/conflicts` | (T6 M12.8) — finds pairs of DIFFERENT schedules whose fire_at |
| `GET` | `/v1/reports/schedules/due` | Declared BEFORE /:schedule_id so the literal "due" wins. */ |
| `GET` | `/v1/reports/schedules/recipient-distribution` | per-recipient pivot over the M12.2 schedule store. Per email: |
| `GET` | `/v1/reports/schedules/upcoming` | — fleet-wide calendar view: walks every ENABLED schedule in |
| `POST` | `/v1/scenario/run` | POST /v1/scenario/run — T4.24 envelope + tenant. |
| `GET` | `/v1/scenarios` |  |
| `POST` | `/v1/scenarios` |  |
| `DELETE` | `/v1/scenarios/:id` |  |
| `GET` | `/v1/scenarios/:id` | Custom user-defined scenario presets (T6 M16.4) |
| `POST` | `/v1/scenarios/bulk-run` | BIL scenario bulk-run + comparison (T6 M16.2) |
| `POST` | `/v1/scenarios/diff` | Scenario diff (T6 M16.3) |
| `GET` | `/v1/scenarios/library` |  |
| `GET` | `/v1/scenarios/library/:id` |  |
| `GET` | `/v1/scenarios/library/:preset_id/clones-in-tenant` | — back-reference query: for this library scenario preset, list |
| `GET` | `/v1/scenarios/library/categories` |  |
| `GET` | `/v1/scenarios/library/coverage-matrix` | rollup over the M16.1 library showing per-(category, |
| `GET` | `/v1/scenarios/library/custom` |  |
| `POST` | `/v1/scenarios/library/custom` |  |
| `DELETE` | `/v1/scenarios/library/custom/:preset_id` |  |
| `PUT` | `/v1/scenarios/library/custom/:preset_id` | mutable fields. Writes scenario.update audit event with metadata. */ |
| `GET` | `/v1/scenarios/library/custom/:preset_id/history` | — slim audit-history view filtered to scenario events for this id. */ |
| `POST` | `/v1/scenarios/library/custom/:preset_id/restore/:version` | — apply a prior snapshot as the live state. Records a new |
| `GET` | `/v1/scenarios/library/custom/:preset_id/versions` | — version snapshots in oldest-first order. Cap 20 per preset. */ |
| `GET` | `/v1/scenarios/library/custom/:preset_id/versions/diff` | (T6 M16.11) — field-by-field diff between two snapshots. Mirrors |
| `POST` | `/v1/scenarios/library/custom/bulk-clone-from-library` | body { preset_ids[], name_prefix? } — iterates M16.8 single-clone |
| `POST` | `/v1/scenarios/library/custom/bulk-delete` | up to 10 custom presets in one call. Per-row outcomes so a partial |
| `POST` | `/v1/scenarios/library/custom/clone-from-library` | body { source_preset_id, name? } — reads a library preset and |
| `POST` | `/v1/scenarios/library/custom/export-bundle` | versioned JSON envelope for migrating N custom scenario presets |
| `POST` | `/v1/scenarios/library/custom/import-bundle` | replay an export-bundle into the caller's tenant. Body |
| `GET` | `/v1/scenarios/library/inventory` | pivot of M16.1 library + M16.4 custom by category × severity. |
| `GET` | `/v1/scenarios/library/magnitude` | severity score per preset (mean of per-axis normalised |
| `GET` | `/v1/scenarios/library/narratives` | human-readable one-liner per scenario preset. Combines the |
| `GET` | `/v1/scenarios/library/regulator-severity-matrix` | — 2D pivot combining 3 ScenarioRegulator rows (RBI / IRDAI / |
| `GET` | `/v1/scenarios/library/shock-axis-histogram` | AXIS-pivoted view over SCENARIO_PRESETS. For each of 3 shock |
| `GET` | `/v1/scenarios/library/shock-directions` | pivot by SIGN of the shock (positive / negative / zero). Distinct |
| `GET` | `/v1/scenarios/library/shock-vectors` | every library preset's GDP/rate/FX shocks onto [-1, 1] using the |

### Config

_Admin configuration, webhooks, integrations, audit trail, recovery, FinOps_

**309 routes.** Routes sorted by path.

| Method | Path | Summary |
|---|---|---|
| `GET` | `/healthz` |  |
| `GET` | `/healthz` |  |
| `GET` | `/v1/admin/adoption-metrics` | rollup answering "how engaged is this tenant?". Covers DAU/WAU/MAU |
| `GET` | `/v1/admin/audit-activity` | audit timeline backed by unified.audit_activity (UNIONs |
| `POST` | `/v1/admin/audit-activity/benchmark` | the canonical /v1/admin/audit-activity query latency |
| `GET` | `/v1/admin/audit-activity/correlation/:correlation_id` | (v1.5 B3) — full cross-source ladder for one workflow, |
| `GET` | `/v1/admin/audit-retention` |  |
| `POST` | `/v1/admin/audit-retention` |  |
| `DELETE` | `/v1/admin/audit-retention/:policy_id` |  |
| `GET` | `/v1/admin/audit-retention/:policy_id` |  |
| `PATCH` | `/v1/admin/audit-retention/:policy_id` |  |
| `GET` | `/v1/admin/audit-retention/active/:scope` |  |
| `GET` | `/v1/admin/audit-retention/strategies` |  |
| `GET` | `/v1/admin/config` |  |
| `POST` | `/v1/admin/config/_clone` | overrides into the caller's tenant. Body { source_tenant_id, |
| `POST` | `/v1/admin/config/_clone/selective` | listed keys from the source tenant's overrides into the caller's |
| `GET` | `/v1/admin/config/_diff` | per-key comparison of two tenants' override states. Admin-only. |
| `GET` | `/v1/admin/config/_export` |  |
| `POST` | `/v1/admin/config/_import` |  |
| `POST` | `/v1/admin/config/_reset-category` | every tenant override in a category back to its platform default. |
| `DELETE` | `/v1/admin/config/:key` | DELETE /v1/admin/config/:key — clear override → revert to default. |
| `GET` | `/v1/admin/config/:key` |  |
| `PUT` | `/v1/admin/config/:key` | PUT /v1/admin/config/:key |
| `GET` | `/v1/admin/config/:key/history` | GET /v1/admin/config/:key/history?limit=50 |
| `POST` | `/v1/admin/config/:key/rollback` | POST /v1/admin/config/:key/rollback body { to_event_id } |
| `GET` | `/v1/admin/config/actor-rollup` | over the M13.1 config store. M13.11 pivots overrides by AGE; |
| `GET` | `/v1/admin/config/catalog` | config registry: per-key {key, category, type, default_value, |
| `GET` | `/v1/admin/config/categories` |  |
| `GET` | `/v1/admin/config/category-actor-matrix` | Per-row {category, total_overrides, by_actor (compact), distinct_actors, |
| `GET` | `/v1/admin/config/change-daily-volume` | Every successful PUT/DELETE on /v1/admin/config/:key writes a |
| `GET` | `/v1/admin/config/feature-adoption` | pivot over the features.* boolean toggles. Per-feature row: |
| `GET` | `/v1/admin/config/override-ages` | — per-override age tracker. For each tenant override, compute |
| `GET` | `/v1/admin/config/override-rate` | rollup over the config registry showing per-category default-vs |
| `GET` | `/v1/admin/config/schema.md` | export of the M13.1 platform schema (NOT tenant overrides; just |
| `GET` | `/v1/admin/config/summary.txt` | summary of every config key with effective value + override |
| `GET` | `/v1/admin/config/type-matrix` | the static DEFAULTS schema: rows = category, cols = type. Per-row |
| `GET` | `/v1/admin/data-quality/orphan-references` | Diagnostic surface — surfaces FK-style references that fail to |
| `GET` | `/v1/admin/field-masking` |  |
| `POST` | `/v1/admin/field-masking` |  |
| `DELETE` | `/v1/admin/field-masking/:policy_id` |  |
| `GET` | `/v1/admin/field-masking/:policy_id` |  |
| `PATCH` | `/v1/admin/field-masking/:policy_id` |  |
| `GET` | `/v1/admin/field-masking/strategies` |  |
| `GET` | `/v1/analytics/alert-resolution` |  |
| `GET` | `/v1/analytics/pd-distribution` |  |
| `GET` | `/v1/analytics/risk-trend` |  |
| `GET` | `/v1/analytics/stage-migration` |  |
| `GET` | `/v1/audit/action-prefix-distribution` | the audit chain by ACTION PREFIX (everything before the first |
| `GET` | `/v1/audit/action-resource-matrix` | axis is OPEN (any action verb from observed events); resource_type |
| `GET` | `/v1/audit/actions` |  |
| `GET` | `/v1/audit/activity-heatmap` | of-week × hour-of-day heatmap of audit events. Mirror of M14.22 |
| `GET` | `/v1/audit/catalog` | For each distinct action emitted by this tenant, returns the |
| `GET` | `/v1/audit/correlation-duration-histogram` | duration distribution over the M15.10 correlation rollup. 5 |
| `GET` | `/v1/audit/correlations` | rollup. Groups every audit event with a non-null correlation_id |
| `GET` | `/v1/audit/daily-volume` | across N consecutive UTC calendar days. Complements M15.7 |
| `GET` | `/v1/audit/events` | GET /v1/audit/events?actor_username=&action=&resource_type=&outcome=& |
| `POST` | `/v1/audit/events` | BIL Audit & Compliance trail (T6 M15.1) |
| `GET` | `/v1/audit/events/:event_id` |  |
| `GET` | `/v1/audit/evidence` | newest-first. */ |
| `POST` | `/v1/audit/evidence` | action?, resource_type?, resource_id?, outcome?, severity? } — |
| `GET` | `/v1/audit/evidence/:package_id` |  |
| `GET` | `/v1/audit/evidence/:package_id/summary.txt` | — printable plain-text summary suitable for browser print-to-PDF. |
| `GET` | `/v1/audit/integrity` | GET /v1/audit/integrity — recompute the chain hash and report |
| `GET` | `/v1/audit/integrity/sample` | the newest N events. Cheaper than M15.2's full-chain walk for |
| `GET` | `/v1/audit/per-actor-activity` | rollup over the audit chain. Per-actor: total_events, |
| `GET` | `/v1/audit/resource-hotspots` | (resource_type, resource_id) hot-spot pivot over the audit chain. |
| `GET` | `/v1/audit/resource-severity-matrix` | total, by_severity (every severity at 0 when absent), |
| `GET` | `/v1/audit/resource-type-distribution` | the audit chain by resource_type (10-key axis). Per-type row: |
| `GET` | `/v1/audit/severity-distribution` | pivoted rollup. Per-severity: total_count + by_resource_type |
| `GET` | `/v1/audit/severity-outcome-matrix` | AuditSeverity (canonical critical → warning → info) × cols = 3 |
| `GET` | `/v1/audit/summary` | GET /v1/audit/summary?days=30 |
| `GET` | `/v1/dashboard/sla-breach-matrix` |  |
| `POST` | `/v1/dashboard/sla-breach-matrix/preview` | POST /v1/dashboard/sla-breach-matrix/preview — show the impact of |
| `GET` | `/v1/dq/dashboard` |  |
| `GET` | `/v1/dq/executions` |  |
| `GET` | `/v1/dq/executions/:execution_id` |  |
| `GET` | `/v1/dq/rule-kinds` |  |
| `GET` | `/v1/dq/rules` |  |
| `POST` | `/v1/dq/rules` |  |
| `DELETE` | `/v1/dq/rules/:rule_id` |  |
| `GET` | `/v1/dq/rules/:rule_id` |  |
| `PATCH` | `/v1/dq/rules/:rule_id` |  |
| `POST` | `/v1/dq/rules/:rule_id/run` | record set. Returns the recorded DqExecution. |
| `GET` | `/v1/dr/game-days` |  |
| `POST` | `/v1/dr/game-days` |  |
| `DELETE` | `/v1/dr/game-days/:record_id` |  |
| `GET` | `/v1/dr/game-days/:record_id` |  |
| `PATCH` | `/v1/dr/game-days/:record_id` |  |
| `GET` | `/v1/dr/runbook` |  |
| `GET` | `/v1/finops/dashboard` | + cost-per-alert + cost-per-customer efficiency metrics per |
| `GET` | `/v1/fraud/dashboard` |  |
| `GET` | `/v1/ifrs9/ecl-overrides` |  |
| `POST` | `/v1/ifrs9/ecl-overrides` |  |
| `DELETE` | `/v1/ifrs9/ecl-overrides/:override_id` |  |
| `GET` | `/v1/ifrs9/ecl-overrides/:override_id` |  |
| `PATCH` | `/v1/ifrs9/ecl-overrides/:override_id` |  |
| `GET` | `/v1/ifrs9/ecl-overrides/active/:customer_id` |  |
| `POST` | `/v1/ifrs9/ecl/compute` |  |
| `GET` | `/v1/ifrs9/enums` |  |
| `GET` | `/v1/ifrs9/movements` |  |
| `POST` | `/v1/ifrs9/movements` |  |
| `DELETE` | `/v1/ifrs9/movements/:movement_id` |  |
| `GET` | `/v1/ifrs9/movements/:movement_id` |  |
| `GET` | `/v1/ifrs9/movements/current/:customer_id` |  |
| `GET` | `/v1/ifrs9/portfolio` |  |
| `DELETE` | `/v1/ingestion/adapters/sla-breaches` | tenant's audit history. Returns { cleared: N }. */ |
| `GET` | `/v1/ingestion/adapters/sla-breaches` | — list recorded breach events newest-first. */ |
| `POST` | `/v1/ingestion/adapters/sla-breaches/:event_id/acknowledge` | — operator acknowledges a recorded breach event so downstream |
| `GET` | `/v1/ingestion/adapters/sla-breaches/analytics` | (T6 M14.20) — tenant-wide rollup over the M14.13 adapter SLA |
| `GET` | `/v1/ingestion/adapters/sla-dashboard` | SLA dashboard. Runs M3.5 analytics across every connector for the |
| `POST` | `/v1/ingestion/adapters/sla-snapshot` | the current dashboard + record one event per breached row to the |
| `DELETE` | `/v1/ingestion/adapters/sla-targets` | tenant override; subsequent dashboard calls fall back to the |
| `GET` | `/v1/ingestion/adapters/sla-targets` | caller's tenant SLA targets. When the tenant has no override, |
| `PUT` | `/v1/ingestion/adapters/sla-targets` | tenant override. Body { min_success_rate, max_p95_latency_ms }. |
| `GET` | `/v1/ingestion/connectors` |  |
| `GET` | `/v1/ingestion/connectors/:id` |  |
| `POST` | `/v1/ingestion/connectors/:id/pause` | POST /v1/ingestion/connectors/:id/{pause,resume} |
| `POST` | `/v1/ingestion/connectors/:id/resume` |  |
| `POST` | `/v1/ingestion/connectors/:id/run` | POST /v1/ingestion/connectors/:id/run |
| `GET` | `/v1/ingestion/connectors/:id/runs` |  |
| `GET` | `/v1/ingestion/connectors/:id/runs/analytics` | — aggregate metrics: success rate, mean/p50/p95 latency, |
| `GET` | `/v1/ingestion/connectors/:id/runs/failure-patterns` | (T6 M3.6) — cluster failed/partial runs by normalized error |
| `GET` | `/v1/ingestion/connectors/:id/schema` |  |
| `POST` | `/v1/ingestion/connectors/:id/schema/compare` | forward-looking compat check: given a candidate schema, report |
| `GET` | `/v1/ingestion/connectors/:id/schema/effective` |  |
| `GET` | `/v1/ingestion/connectors/:id/schema/overrides` |  |
| `POST` | `/v1/ingestion/connectors/:id/schema/overrides` |  |
| `DELETE` | `/v1/ingestion/connectors/:id/schema/overrides/:field_name` |  |
| `GET` | `/v1/ingestion/connectors/:id/schema/source-map` | per-field source attribution (platform vs tenant_addition). |
| `POST` | `/v1/ingestion/connectors/:id/schema/validate` | pure-function validator. Always 200 (valid: true \| false in body) |
| `GET` | `/v1/ingestion/freshness-alert` | data-freshness detector. Compares `last_run_at` against schedule |
| `GET` | `/v1/ingestion/health` |  |
| `GET` | `/v1/ingestion/retry-policies` | hand-calibrated retry strategy (max_retries, backoff curve, |
| `GET` | `/v1/ingestion/run-latency-histogram` | duration distribution over ConnectorRun entries. 6 canonical |
| `GET` | `/v1/ingestion/run-volume/daily` | wide TREND view across the trailing-N-day window (default 30, |
| `GET` | `/v1/ingestion/run-volume/hourly` | histogram of connector runs bucketed by UTC hour-of-day 0..23. |
| `GET` | `/v1/ingestion/schema/field-count-histogram` | bucket field-count histogram over the M3.2 schema catalog |
| `GET` | `/v1/ingestion/schema/field-index` | over every connector's fields. For each unique field_name across |
| `GET` | `/v1/ingestion/schema/record-format-distribution` | PIVOT-BY-RECORD_FORMAT over the M3.2 connector schema catalog. |
| `GET` | `/v1/ingestion/schema/required-matrix` | ALL_FIELD_TYPES order) × cols = 2 (required, optional) = 14 cells. |
| `GET` | `/v1/ingestion/schema/type-matrix` | per-connector × per-FieldType counts plus required/optional |
| `GET` | `/v1/ingestion/type-distribution` | rollup over the M3.1 registry. 5 ConnectorTypes (kafka_stream / |
| `GET` | `/v1/integrations/adapters` |  |
| `GET` | `/v1/integrations/adapters/health` |  |
| `GET` | `/v1/integrations/adapters/id-catalog` | adapter entity ID format catalog (entity, id_field, |
| `GET` | `/v1/integrations/adapters/operations` | adapter operation catalog (operation_id, method, path, |
| `GET` | `/v1/integrations/adapters/operations/location-distribution` | (T6 M14.30) — orthogonal pivot of the M14.24 operation catalog |
| `GET` | `/v1/integrations/adapters/operations/matrix` | method (canonical GET/POST/PATCH/DELETE), cols = adapter (8 BIL |
| `GET` | `/v1/integrations/adapters/operations/method-distribution` | (T6 M14.27) — orthogonal pivot of the M14.24 operation catalog |
| `GET` | `/v1/integrations/adapters/operations/param-type-required-matrix` | (T6 M14.29) — 2D pivot ACROSS every parameter in the M14.24 |
| `GET` | `/v1/integrations/adapters/sla-budget` | M14.9 fleet probe + M14.23 SLA catalog. Per-adapter |
| `GET` | `/v1/integrations/adapters/sla-catalog` | adapter expected SLA targets (latency p95, freshness, rate |
| `GET` | `/v1/integrations/agent/agents` |  |
| `GET` | `/v1/integrations/agent/agents/:agent_id` |  |
| `GET` | `/v1/integrations/agent/agents/:agent_id/productivity` | GET /v1/integrations/agent/agents/:agent_id/productivity[?period=YYYY-MM] |
| `GET` | `/v1/integrations/agent/agents/:agent_id/productivity/history` | GET /v1/integrations/agent/agents/:agent_id/productivity/history?months=12 |
| `GET` | `/v1/integrations/aml/matches` |  |
| `GET` | `/v1/integrations/aml/matches/:match_id` |  |
| `PATCH` | `/v1/integrations/aml/matches/:match_id` | PATCH /v1/integrations/aml/matches/:match_id body: { status } |
| `POST` | `/v1/integrations/aml/screen` | AML Watchlist adapter (T6 M14.3) |
| `POST` | `/v1/integrations/bureau/pull` | POST /v1/integrations/bureau/pull body: { customer_id, bureau_type } |
| `GET` | `/v1/integrations/bureau/reports` |  |
| `GET` | `/v1/integrations/bureau/reports/:report_id` |  |
| `GET` | `/v1/integrations/bureau/types` |  |
| `GET` | `/v1/integrations/cbs/enums` |  |
| `GET` | `/v1/integrations/cbs/summary` |  |
| `GET` | `/v1/integrations/cbs/sync-jobs` |  |
| `POST` | `/v1/integrations/cbs/sync-jobs` |  |
| `DELETE` | `/v1/integrations/cbs/sync-jobs/:job_id` |  |
| `GET` | `/v1/integrations/cbs/sync-jobs/:job_id` |  |
| `POST` | `/v1/integrations/cbs/sync-jobs/:job_id/transition` |  |
| `GET` | `/v1/integrations/cbs/sync-jobs/by-key/:idempotency_key` |  |
| `GET` | `/v1/integrations/dms/document-types` |  |
| `GET` | `/v1/integrations/dms/documents` | GET /v1/integrations/dms/documents?customer_id=&case_id= |
| `GET` | `/v1/integrations/dms/documents/:document_id` |  |
| `PATCH` | `/v1/integrations/dms/documents/:document_id/status` | PATCH /v1/integrations/dms/documents/:document_id/status body: { status } |
| `GET` | `/v1/integrations/finance/accounts` |  |
| `GET` | `/v1/integrations/finance/accounts/:account_id` |  |
| `GET` | `/v1/integrations/finance/accounts/:account_id/ledger` | GET /v1/integrations/finance/accounts/:account_id/ledger?since=&until=&page=&page_size= |
| `GET` | `/v1/integrations/health` |  |
| `GET` | `/v1/integrations/hr/employees` |  |
| `GET` | `/v1/integrations/hr/employees/:employee_id` |  |
| `GET` | `/v1/integrations/hr/employees/:employee_id/leave-balance` |  |
| `GET` | `/v1/integrations/ifrs9/stages` | GET /v1/integrations/ifrs9/stages?stage=2&page=1&page_size=50 |
| `GET` | `/v1/integrations/ifrs9/stages/:customer_id` |  |
| `GET` | `/v1/integrations/insurance/claims` |  |
| `GET` | `/v1/integrations/insurance/claims/:claim_id` |  |
| `GET` | `/v1/integrations/insurance/policies` |  |
| `GET` | `/v1/integrations/insurance/policies/:policy_id` |  |
| `GET` | `/v1/master/accounts` |  |
| `POST` | `/v1/master/accounts` |  |
| `DELETE` | `/v1/master/accounts/:account_type_id` |  |
| `GET` | `/v1/master/accounts/:account_type_id` |  |
| `PATCH` | `/v1/master/accounts/:account_type_id` |  |
| `GET` | `/v1/master/accounts/categories` |  |
| `GET` | `/v1/master/bureaus` |  |
| `POST` | `/v1/master/bureaus` |  |
| `DELETE` | `/v1/master/bureaus/:bureau_id` |  |
| `GET` | `/v1/master/bureaus/:bureau_id` |  |
| `PATCH` | `/v1/master/bureaus/:bureau_id` |  |
| `GET` | `/v1/master/bureaus/types` |  |
| `GET` | `/v1/master/bureaus/weight-overlay` | map for the M6.x scoring overlay; SPA shows the effective |
| `GET` | `/v1/master/customers` |  |
| `POST` | `/v1/master/customers` |  |
| `DELETE` | `/v1/master/customers/:customer_id` |  |
| `GET` | `/v1/master/customers/:customer_id` |  |
| `PATCH` | `/v1/master/customers/:customer_id` |  |
| `GET` | `/v1/master/customers/kyc-expiring` | hot-list: customers whose KYC is within N days of expiry OR |
| `GET` | `/v1/master/customers/types` |  |
| `GET` | `/v1/master/geographies` | — tenant-scoped list with optional filters. */ |
| `POST` | `/v1/master/geographies` |  |
| `DELETE` | `/v1/master/geographies/:country_code` |  |
| `GET` | `/v1/master/geographies/:country_code` |  |
| `PATCH` | `/v1/master/geographies/:country_code` |  |
| `GET` | `/v1/master/geographies/risk-levels` |  |
| `GET` | `/v1/master/policies` |  |
| `POST` | `/v1/master/policies` |  |
| `DELETE` | `/v1/master/policies/:policy_type_id` |  |
| `GET` | `/v1/master/policies/:policy_type_id` |  |
| `PATCH` | `/v1/master/policies/:policy_type_id` |  |
| `GET` | `/v1/master/policies/categories` |  |
| `GET` | `/v1/master/sectors` |  |
| `POST` | `/v1/master/sectors` |  |
| `DELETE` | `/v1/master/sectors/:sector_id` | Recovery Center. 204 on success; 404 unknown. */ |
| `GET` | `/v1/master/sectors/:sector_id` |  |
| `PATCH` | `/v1/master/sectors/:sector_id` |  |
| `GET` | `/v1/master/sectors/categories` |  |
| `GET` | `/v1/metadata/lineage/catalog` |  |
| `GET` | `/v1/metadata/lineage/datasets/:dataset_id` |  |
| `GET` | `/v1/metadata/lineage/datasets/:dataset_id/downstream` |  |
| `GET` | `/v1/metadata/lineage/datasets/:dataset_id/impact` |  |
| `GET` | `/v1/metadata/lineage/datasets/:dataset_id/upstream` |  |
| `GET` | `/v1/notifications/daily-volume` | LINE view across N consecutive UTC calendar days. Per-day bucket: |
| `GET` | `/v1/notifications/email/log` | GET /v1/notifications/email/log?limit=50 |
| `POST` | `/v1/notifications/email/preview` | POST /v1/notifications/email/preview |
| `POST` | `/v1/notifications/email/send` | POST /v1/notifications/email/send |
| `GET` | `/v1/notifications/email/templates` |  |
| `GET` | `/v1/notifications/ledger-analytics` | channel rollup over M10.1 email + M10.2 SMS + M10.3 push send |
| `GET` | `/v1/notifications/per-recipient` | per-recipient list across all 3 channels. Email recipients, |
| `GET` | `/v1/notifications/preferences/effective` | (T6 M10.10) — effective preferences with the full 3-way |
| `GET` | `/v1/notifications/preferences/me` | Always 200 (defaults to all-enabled for never-touched users). */ |
| `PUT` | `/v1/notifications/preferences/me` | partial update; at least one channel must be supplied. */ |
| `PUT` | `/v1/notifications/preferences/me/quiet-hours` | set or clear the caller's mute window. Body { start_hour, end_hour } |
| `POST` | `/v1/notifications/preferences/me/reset` |  |
| `GET` | `/v1/notifications/preferences/tenant-defaults` | per-tenant defaults; admin-only. */ |
| `PUT` | `/v1/notifications/preferences/tenant-defaults` | defaults via partial patch. */ |
| `POST` | `/v1/notifications/publish` | POST /v1/notifications/publish |
| `GET` | `/v1/notifications/push/log` |  |
| `GET` | `/v1/notifications/push/platform-distribution` | 1D pivot over the M10.3 push ledger by PushPlatform (fcm / |
| `POST` | `/v1/notifications/push/preview` | POST /v1/notifications/push/preview body: { template_id, template_vars } |
| `POST` | `/v1/notifications/push/send` | POST /v1/notifications/push/send body: PushMessageInput |
| `GET` | `/v1/notifications/push/templates` |  |
| `GET` | `/v1/notifications/sms/log` |  |
| `POST` | `/v1/notifications/sms/preview` | POST /v1/notifications/sms/preview body: { template_id, template_vars } |
| `POST` | `/v1/notifications/sms/send` | POST /v1/notifications/sms/send body: SmsMessageInput |
| `GET` | `/v1/notifications/sms/templates` |  |
| `GET` | `/v1/notifications/stream` | GET /v1/notifications/stream |
| `GET` | `/v1/notifications/template-freshness` | templates only + templates_needing_attention[] (never_sent first |
| `GET` | `/v1/notifications/template-usage` | channel ledgers (email/sms/push) by template_id. For each template |
| `GET` | `/v1/notifications/templates/catalog` | template catalog across email + SMS + push. Per-template {channel, |
| `GET` | `/v1/notifications/variables/channel-matrix` | cross-tab elevating M10.13's inverted index. Rows = distinct |
| `GET` | `/v1/notifications/variables/index` | index over the M10.11 catalog. Per-variable: templates[] + |
| `POST` | `/v1/notifications/webhook/send` |  |
| `GET` | `/v1/notifications/webhook/subscriptions` |  |
| `POST` | `/v1/notifications/webhook/subscriptions` |  |
| `DELETE` | `/v1/notifications/webhook/subscriptions/:webhook_id` |  |
| `GET` | `/v1/notifications/webhook/subscriptions/:webhook_id/deliveries` |  |
| `GET` | `/v1/recon/dashboard` |  |
| `GET` | `/v1/recon/definitions` |  |
| `POST` | `/v1/recon/definitions` |  |
| `DELETE` | `/v1/recon/definitions/:recon_id` |  |
| `GET` | `/v1/recon/definitions/:recon_id` |  |
| `PATCH` | `/v1/recon/definitions/:recon_id` |  |
| `POST` | `/v1/recon/definitions/:recon_id/run` | { source_records: any[], target_records: any[] }. */ |
| `GET` | `/v1/recon/kinds` |  |
| `GET` | `/v1/recon/runs` |  |
| `GET` | `/v1/recon/runs/:run_id` |  |
| `GET` | `/v1/recovery` |  |
| `DELETE` | `/v1/recovery/:recovery_id` | Marks purged_at/_by; the row stays for audit but is no longer |
| `GET` | `/v1/recovery/:recovery_id` |  |
| `POST` | `/v1/recovery/:recovery_id/restore` | Admin only. Returns 409 if the original_id already exists (cache or |
| `GET` | `/v1/recovery/analytics` | daily archive/restore/purge volume timeline, top actors, |
| `POST` | `/v1/recovery/purge-expired` | recovery row whose purged_at is older than N days (default 30). |
| `GET` | `/v1/recovery/stats` |  |
| `GET` | `/v1/release/current/:environment` |  |
| `GET` | `/v1/release/history` |  |
| `POST` | `/v1/release/history` |  |
| `DELETE` | `/v1/release/history/:release_id` |  |
| `GET` | `/v1/release/history/:release_id` |  |
| `PATCH` | `/v1/release/history/:release_id` |  |
| `GET` | `/v1/release/info` |  |
| `GET` | `/v1/system/monitoring` | Phase D.1 — System Monitoring dashboard (composer) |
| `GET` | `/v1/tenants` | GET /v1/tenants — admin-only listing of every configured tenant. |
| `POST` | `/v1/tenants` |  |
| `DELETE` | `/v1/tenants/:tenant_id` | DELETE /v1/tenants/:tenant_id — admin removes a tenant. |
| `PATCH` | `/v1/tenants/:tenant_id` | PATCH /v1/tenants/:tenant_id — admin updates name / channels / active. |
| `GET` | `/v1/tenants/:tenant_id/readiness` |  |
| `POST` | `/v1/tenants/bulk-import` | Body: { csv: string, dry_run?: boolean }. Header row required: |
| `POST` | `/v1/tenants/bulk-import/apply` | consumes the preview + commits the snapshotted rows. */ |
| `POST` | `/v1/tenants/bulk-import/preview` | with preview_id + dry-run summary. */ |
| `DELETE` | `/v1/tenants/bulk-import/preview/:preview_id` |  |
| `GET` | `/v1/tenants/bulk-import/previews` |  |
| `GET` | `/v1/tenants/me` |  |
| `GET` | `/v1/tenants/me/readiness` |  |
| `GET` | `/v1/webhooks` |  |
| `POST` | `/v1/webhooks` |  |
| `DELETE` | `/v1/webhooks/:id` |  |
| `GET` | `/v1/webhooks/:id/deliveries` |  |
| `POST` | `/v1/webhooks/:id/test` | POST /v1/webhooks/:id/test |

## Example curl invocations

### Authenticate + score a customer

```bash
TOKEN=$(curl -s http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice.admin","password":"Admin!Pass1"}' | jq -r .access_token)

curl http://localhost:8084/v1/ai/models/pd_xgb_v3/score \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: BANK_DEMO" \
  -H "X-Channel: API" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"c-101"}'
```

### List BIL claims dashboard

```bash
curl http://localhost:8084/v1/dashboards/bil/claims \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: BIL" \
  -H "X-Channel: API"
```

### Provision a service-account API key

```bash
curl http://localhost:8084/v1/admin/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: BANK_DEMO" -H "X-Channel: API" \
  -H "X-APEX-USER: alice.admin" \
  -H "Content-Type: application/json" \
  -d '{"name":"AML Hub primary","scopes":["alerts:read","audit:read"]}'

# Response includes `key: apex_<prefix>.<secret>` — captured ONCE.
```
