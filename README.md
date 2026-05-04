# APEX EWS

**Last updated:** 2026-05-05

Early-Warning System prototype for credit-risk monitoring. A single platform that ingests CBS + bureau + transaction data, scores every customer with a calibrated PD model, fires rule-based alerts, opens cases, and routes them through a state machine to Collection.

This is a **prototype** — not a deployable bank product. See `project_apex_ews_scope.md` (in the orchestrator's memory) for what's in/out of scope.

## What's shipped

- **Data platform** — Postgres + dbt mart (`mart.{customer_360, loan_360, txn_features, indicator_values}`) seeded with **10,000 synthetic customers / 24,000 loans / 247k repayments / 290k transactions / 10k bureau scores**. 79 dbt tests pass. **Plus 5 application schemas (`app_iam`, `app_cases`, `app_alerts`, `app_bff`, `app_scenario` — 11 tables, ~26k rows of synthetic operator data) — see [docs/database-schema.md](docs/database-schema.md) for the full column-level reference and [docs/database-gap-analysis.md](docs/database-gap-analysis.md) for the open service-wiring backlog.**
- **PD model** — XGBoost + isotonic calibration, holdout AUC 0.8822, KS 0.642, CV-AUC 0.862±0.019. SHAP TreeExplainer for top-5 reason codes. Artefacts in `ml/models/pd/v0.1.0/`. _A mart-trained challenger also exists at AUC 1.0 — but that's a leakage artefact in the 220-customer seed (`has_npa` ≡ DPD-derived), not a quality signal; the synthetic-trained 0.8822 model stays champion. See BOOTSTRAP §4._
- **Rule engine** — JSON-Schema-backed DSL, 30 seed rules, simulator-measured FP 0.148, 32-indicator catalog with full compute coverage.
- **Case management** — `services/regulatory-svc/cases` exposes the full `Alert → Case → Assigned → InAction → Monitored → Closed` lifecycle (FR-CASE-1) with action log + GPS + outcome capture (FR-CASE-3/4).
- **Public API + BFF** — `services/bff` exposes `/v1/{alerts, ews/evaluate, risk-profile, action, scenario/run, reports/:type, webhooks, webhooks/:id/{deliveries,test}}` for partners and `/api/*` for the SPA, mapping `apex.regulatory.events.v2` to UI list-rows.
- **Collection adapter** — `services/collection-adapter` consumes `apex.case.events`, routes high-severity cases to a Collection outbox, and exposes `/collection/callback` for status reports.
- **RBAC** — canonical matrix at `infra/rbac/matrix.json` (5 roles × 28 ops, including `webhooks:manage`). Enforced at every TS service via `@apex-ews/rbac.requireRole`. Quarterly access review process documented + scriptable.
- **Auth + security hardening** — auth-svc layered with rate-limit (5/15min login, 3/hr password reset), captcha gate after 2 failures, auto-lockout after 5 wrong-passwords-in-a-row, 16-event audit log, server-tracked sessions with revocation (jwt `sid` claim), password history (no-reuse against last 5), first-login wizard. SPA-side: 15-min idle timeout with 2-min warning, OWASP security headers on every response, EN+HI i18n bundles, password show/hide + strength meter, network-vs-credential error distinction at sign-in.
- **Schema registry CI** — `infra/schema-registry/` JSON schemas for the 5 Kafka topics, BACKWARD-compat checker (`scripts/check_compat.py`) gated on every PR. Glue Schema Registry resource in `infra/terraform/30-data`.
- **React SPA** — `web/` — login, dashboard (clickable KPI cards + time-range selector), alert list (criticality scoring + customer dedup + sort dropdown), customer list, customer risk profile (SHAP top-5 + linked alerts + linked cases), rule config (search + sticky list + 5-tab unified detail card), case view, scenario simulator (5 templates + IFRS 9 stage migration + segment×risk heatmap + saved scenarios + side-by-side compare + CSV/PDF/Excel export), profile/sessions, profile/activity, admin/users, admin/audit-log, admin/integrations, admin/webhooks. DMS-style design system. EN + HI i18n.
- **Outbound webhooks** — `services/bff/src/webhooks/` — admin-managed subscriptions (HMAC-SHA256 signed delivery, 3-attempt retry with 1s/4s/16s back-off, 10s timeout). Fires `alert.created` (on High-risk evaluations) + `scenario.run` events fire-and-forget. Admin SPA at `/admin/webhooks` (admin role only) — create with one-time secret reveal, test-fire button, deliveries log per subscription.
- **Infra-as-code** — Terraform across 5 layers (`00-landing-zone`, `10-network`, `20-eks`, `30-data`, `40-edge`). VPC + EKS + Aurora + MSK + Glue Schema Registry. `terraform fmt -check && terraform validate` green.
- **T6 — BIL 16-module platform expansion (in flight)** — All 16 modules have at least one live sub-phase wired into the BFF. **48 sub-phases shipped · ~140 enveloped routes · BFF jest 1991 pass / 9 skipped / 2000 total.** Modules covered: M1 auth (TOTP + service-account API keys + Bearer middleware), M2 tenant ops (readiness + onboarding wizard), M3 ingestion (8-connector registry + schema metadata), M4 indicators (25-KRI catalog + backtest), M5 rules (12-template library + bulk-clone), M6 scoring (Σ(W×V) + catalog lookup), M7 AI/ML (model registry + promotion state machine), M8 alerts (Red/Orange/Yellow/Green classification + routing matrix + ack lifecycle), M9 cases (investigation tracker + custom checklists + RBI 4-eyes maker-checker), M10 notifications (email + SMS + push), M11 dashboards (Claims/Underwriting/Agent/Operational/Executive/360), M12 reports (catalog + recurring schedules), M13 admin config (registry + audit wiring + rollback), M14 integrations (8 adapters), M15 audit (events + hash-chain + evidence packaging), M16 scenarios (10-preset library + bulk-run). See [STATUS.md → T6 Coverage Matrix](STATUS.md) for the full table + per-module follow-on backlog.

## Quick start

### Prereqs

```sh
# One-time install of the toolchain (macOS):
brew install python@3.12 hashicorp/tap/terraform libomp
docker --version            # Docker Desktop must be running
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r data/dbt/requirements.txt   # or follow BOOTSTRAP.md
```

### UI-only demo (5 minutes, no backends needed)

```sh
make web-dev
```

Open http://localhost:5173. Login:

| User | Password | Role |
|------|----------|------|
| `alice.admin` | `Admin!Pass1` | admin |
| `sue.super` | `Super!Pass1` | supervisor |
| `ravi.risk` | `RiskAnalyst!1` | risk_analyst |
| `carl.collect` | `Collect!Pass1` | collection_officer |
| `fiona.field` | `Field!Pass1` | field_officer |

The SPA's MSW path mocks every backend, so click-through works without any service running.

### Full backend stack

```sh
make install   # one-time: deps for every workspace
make up        # starts cases, alerts, rules, indicators, bff, collection-adapter, auth-svc
make smoke     # curl /healthz on each
make ps        # what's running

cd web && echo 'VITE_API_BASE_URL=http://localhost:8084' > .env.local
make web-dev   # SPA now hits the real BFF (with x-apex-role enforcement)

# When done:
make down
```

### Database (Postgres)

The dev database runs in Docker (`apex-ews-pg` on `:55432`, role `apex` / db `apex_ews`). Bootstrap from scratch:

```sh
# One-time bootstrap of the schemas + seed data:
cd data/schema
make up                         # docker run apex-ews-pg (postgres:16) on :55432
make migrate                    # apply 001_init_schemas.sql, 002_raw_tables.sql, 003_audit_table.sql
PGPASSWORD=apex psql -h localhost -p 55432 -U apex -d apex_ews \
  -v ON_ERROR_STOP=1 -f 004_app_schemas.sql      # 5 new app_* schemas

# Load raw seed CSVs (10k customers; ~4 min):
source ../../.venv/bin/activate
cd ../dbt
dbt deps && dbt seed --full-refresh && dbt run && dbt test
# → 79 dbt tests pass; raw 581k rows; mart 124k rows

# Load synthetic app data into the new app_* schemas (~26k rows):
cd ../schema
python3 _generate_app_seeds.py
PGPASSWORD=apex psql -h localhost -p 55432 -U apex -d apex_ews \
  -v ON_ERROR_STOP=1 -f app_seeds.sql
```

After bootstrap: **~731,500 rows across 9 schemas / 21 tables**, queryable via DBeaver. See [docs/database-schema.md](docs/database-schema.md) for the column-level reference and [docs/database-gap-analysis.md](docs/database-gap-analysis.md) for the open service-wiring backlog (services don't yet read/write the `app_*` tables — that's the next sessions' work).

### Validate the codebase

```sh
make ci        # install + test + build + lint — local equivalent of all four GH workflows
```

### Run a single suite

```sh
make test-ts   # every TS service jest
make test-py   # schema-registry + rbac pytest
make test-web  # SPA vitest
make lint      # terraform fmt -check + per-layer validate
```

## Repo layout

```
apex-ews/
├── data/
│   ├── airflow/        # Airflow DAGs (CBS ingest, feature build, bureau sync)
│   ├── dbt/            # dbt project — mart.{customer_360, loan_360, txn_features, indicator_values}
│   └── schema/         # Postgres init SQL + audit-trigger
├── infra/
│   ├── rbac/           # Canonical RBAC matrix + access-review script + @apex-ews/rbac TS helper
│   ├── schema-registry/# JSON schemas for all 5 Kafka topics + BACKWARD-compat CI
│   └── terraform/      # 5-layer IaC (landing zone, network, eks, data, edge)
├── ml/
│   ├── data/           # generate_synthetic.py, load_from_mart.py
│   ├── pipelines/      # train_pd.py — PD model training + calibration
│   ├── models/         # Trained artefacts (model.joblib, shap_explainer.joblib, metrics.json)
│   └── registry/       # Champion / challenger registry
├── services/
│   ├── ai-copilot-svc/ # Python FastAPI: PD scoring + SHAP top-5
│   ├── audit-svc/      # Python FastAPI: hash-chain audit log
│   ├── auth-svc/       # Node + Fastify: JWT + TOTP login
│   ├── bff/            # Node + Express: BFF + public REST API v1 (T3.7 + T3.10)
│   ├── collection-adapter/   # Node + Express: case routing + Collection callback (T3.4)
│   ├── notification-svc/     # Node: SMS/email/push stubs
│   └── regulatory-svc/
│       ├── alerts/     # Node + Express: alert producer + smart queue
│       ├── cases/      # Node + Express: case state machine (T3.5)
│       ├── indicators/ # Node + Express: 32-indicator compute engine
│       └── rules/      # Node + Express: rule lifecycle + simulator
├── web/                # React + Vite + TanStack Query + MSW SPA
├── rules/              # Top-level rule DSL types + JSON Schema
├── logs/               # Per-agent activity logs
├── AGENTS.md           # 9-agent split + ownership boundaries
├── BOOTSTRAP.md        # First-time setup runbook
├── REQUIREMENTS.md     # Functional + non-functional requirements
├── STATUS.md           # Verification matrix + KPI snapshot + activity log
├── TASKS.md            # Phase 0–5 task backlog
├── SKILLS.md           # Shared tooling/conventions
└── Makefile            # Top-level dev orchestration
```

## CI gates (4 GitHub Actions workflows)

| Workflow | What it gates |
|----------|---------------|
| `.github/workflows/schema-compat.yml` | BACKWARD-compat across all schema versions + 16 pytest |
| `.github/workflows/rbac-matrix.yml`   | Matrix self-consistency + 11 pytest + the `@apex-ews/rbac` helper |
| `.github/workflows/services-ci.yml`   | jest/tsc on 8 TS services + vitest/vite on web |
| `.github/workflows/terraform-ci.yml`  | fmt + init + validate across all 5 IaC layers |

`make ci` is the local equivalent of running all four.

## Where to look next

| Question | Document |
|----------|----------|
| What's been built? | [STATUS.md](STATUS.md) — verification matrix, KPI snapshot, activity log |
| Who owns what? | [AGENTS.md](AGENTS.md) — 9-agent split |
| What's the backlog? | [TASKS.md](TASKS.md) — Phase 0–5 |
| How do I bootstrap? | [BOOTSTRAP.md](BOOTSTRAP.md) — first-time runbook |
| What does this need to do? | [REQUIREMENTS.md](REQUIREMENTS.md) — FR/NFR |
| RBAC + access review process | [infra/rbac/README.md](infra/rbac/README.md) |
| Schema BACKWARD compat | [infra/schema-registry/README.md](infra/schema-registry/README.md) |

## Status

**414 tests pass clean** across the codebase (204 SPA vitest + 210 BFF jest, plus 79 dbt + 16 schema-compat pytest + 11 RBAC pytest + 13 RBAC TS jest). All four blockers (B1/B2/B3/B4) closed. Wave 3 done; auth/security sweep done; Wave 4 UX features (dashboard interactivity, full scenario simulation, alert prioritization, rule config UX overhaul, customer 360-view, outbound webhooks) all shipped in 2026-04-28 → 2026-05-02. **Database scaled out 2026-05-03 to 10k customers + 5 new app_* schemas (~731k rows total).** The system runs end-to-end locally — see the Quick Start above.

**Three scheduled follow-ups** (in-session, recipes saved to memory for cross-session recovery):
- 2026-05-16 — convert existing `/v1/reports` PDF/Excel to client-side (mirrors the scenario approach so MSW dev mode produces real binaries instead of falling back to JSON).
- 2026-05-23 — build T4.1 Analytics Dashboard suite (4 sub-dashboards: risk trend / PD distribution / stage migration / alert resolution).
- 2026-05-30 — wire reserved webhook event types (`alert.updated`, `case.assigned`, `case.closed`) once case lifecycle workflows mature.

**Open backlog from 2026-05-03 database fill-out:** per-service Postgres wiring (T4.13–T4.17, ~10-13 hours total). Recommended order: bff webhooks → auth-svc → cases → audit-log fan-out → alerts → scenario. See [docs/database-gap-analysis.md](docs/database-gap-analysis.md) for the sized backlog.
