# ZorEWS — Postman Collections

Auto-generated from `docs/api/swagger.json` by `scripts/gen-postman.js`.
Re-run `npm run postman:generate` after any route addition.

## Files

| File | Operations | Folders | Purpose |
|---|---|---|---|
| `local.postman_environment.json` | — | — | **Import first.** Local-only env (`http://localhost:8084` / `:8080`) + auth state |
| `ZorEWS-Auth.postman_collection.json` | 33 | 8 | Login, OAuth, 2FA, JWKS, API keys, `/v1/svc/*` |
| `ZorEWS-Users.postman_collection.json` | 31 | 2 | auth-svc user CRUD, sessions, teams, leave covers |
| `ZorEWS-Dashboard.postman_collection.json` | 26 | 5 | Executive / Claims / UW / Agent / Operational dashboards |
| `ZorEWS-Borrower.postman_collection.json` | 8 | 7 | Customers, risk profile, customer 360 |
| `ZorEWS-EWS.postman_collection.json` | 80 | 25 | Indicators, rules, streaming, feature store |
| `ZorEWS-Alerts.postman_collection.json` | 54 | 23 | Alert ledger, routing, classification, AML correlation |
| `ZorEWS-Workflow.postman_collection.json` | 92 | 28 | Cases, investigations, action log, onboarding |
| `ZorEWS-AI.postman_collection.json` | 71 | 13 | Model registry, scoring, predictions, copilot |
| `ZorEWS-Reports.postman_collection.json` | 71 | 12 | Catalog, jobs, scenarios |
| `ZorEWS-Config.postman_collection.json` | 308 | 104 | Webhooks, integrations, audit, ingestion, admin config |

**Total: 774 operations across 10 collections + 1 environment.**

## Quick start

1. **Start the local stack:**
   ```bash
   npm run up        # docker postgres + 8 RUNNABLE services
   ```
2. **Import into Postman:**
   - `Files → Import` → drag every `.json` file in this directory
   - In the env switcher (top-right), select **ZorEWS Local**
3. **Capture an auth token:**
   - Open `ZorEWS — Auth APIs` → `00 — Smoke tests` → `✅ 1. Login (captures access_token)` → **Send**
   - The test script saves `access_token` into the environment automatically
4. **Run anything:** every other request inherits the bearer token via collection-level auth

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `bff_url` | `http://localhost:8084` | BFF base URL |
| `auth_svc_url` | `http://localhost:8080` | auth-svc base URL |
| `tenant_id` | `BANK_DEMO` | Switch to `BIL` for the insurance vertical |
| `channel` | `API` | Must be in tenant's `channels_allowed` |
| `apex_user` | `alice.admin` | Operator identity (audit attribution) |
| `apex_role` | `admin` | RBAC role; valid: `admin / supervisor / risk_analyst / collection_officer / field_officer` |
| `access_token` | `(empty)` | Auto-captured by the login request |
| `refresh_token` | `(empty)` | Auto-captured |
| `partial_token` | `(empty)` | 2FA flow only |
| `customer_id` / `model_id` / `case_id` / `alert_id` / `config_key` / `scenario_preset_id` / `rule_id` | seeded defaults | Path-param substitutions |

## Smoke folders

Every collection ships a **`00 — Smoke tests`** folder at the top with:
- One happy-path request (e.g. `GET /v1/ai/models`)
- One missing-tenant-header negative test → expects `400`
- One unknown-role negative test → expects `403`

Auth collection also includes:
- Login bad-credentials → `401` or `423`
- Login missing-username → `400`

## Per-request tests

Every request has a `test` event script with three assertions:
1. Status is documented (success or 4xx envelope)
2. Response time < 5s
3. For `/v1/*`: success → envelope shape `{header.status: "success", body}`; error → `{header, error.{code, severity}}`

## Negative-test patterns

The auth + non-auth smoke folders cover the BFF's standard error envelope:

| Scenario | Expected response |
|---|---|
| Missing `X-Tenant-ID` on `/v1/*` | `400 EWS_400_missing_tenant_id` |
| Unknown role | `403 EWS_403_missing_scope` |
| Bad credentials | `401 EWS_401_invalid_credentials` |
| Account locked | `423 EWS_423_account_locked` |

## Regenerating

```bash
# After any new BFF route:
npm run openapi:generate    # regenerate docs/api/swagger.{json,yaml,md}
npm run postman:generate    # regenerate the 10 collections + env
npm run postman:validate    # 89-check structural validator
```

## Constraints

- **Local-only.** All `*_url` env vars point to `localhost`. No production URLs in the env file.
- **No AWS calls.** All requests target the local stack started by `make up`.
- **No business-logic changes.** Collections are read-only over the OpenAPI spec.
