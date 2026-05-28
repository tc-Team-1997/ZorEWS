# Insurance EWS — Architecture & Build Plan

**Status:** Module 1 (Policy Lapse Risk) shipped end-to-end. Modules 2–7 follow the same vertical-slice template documented below.
**Last updated:** 2026-05-28

> This is the architecture + delivery plan for the 7-module Insurance Early-Warning System, built as an **additive extension** of the existing ZorEWS platform — not a greenfield rebuild.

---

## 0. Why extend, not rebuild

ZorEWS is already a multi-tenant enterprise EWS: it ships a banking vertical (16 T6 modules), a 25-indicator insurance KRI catalog, BIL insurance dashboards, a multi-tenant + envelope + RBAC + audit foundation, and ~300 tested sub-phases. The Insurance EWS is therefore built **on top of** that foundation. Concretely:

| Requested in brief | What we use (existing platform) | Reason |
|---|---|---|
| React + Tailwind + React Router | ✅ in place | unchanged |
| **Redux Toolkit** | **zustand + react-query** (existing) | Introducing Redux would fork state management across the app and break consistency with ~60 shipped pages. zustand (`web/src/store/auth.ts`) + react-query cover the same needs. |
| Axios | ✅ `web/src/lib/http.ts` (envelope-unwrapping interceptor) | unchanged |
| Recharts / ECharts | ✅ Recharts | already in the tree; ECharts would be a redundant 2nd charting dep |
| **Framer Motion** | CSS transitions + existing Modal/Panel primitives | not currently a dependency; motion is handled with Tailwind transitions to avoid a new dep |
| Node + Express + PostgreSQL + Redis | ✅ BFF (Express) + Postgres; Redis provisioned in `infra/terraform/30-data` | unchanged |
| JWT + RBAC middleware | ✅ auth-svc (RS256 JWT + JWKS) + `@apex-ews/rbac` `requireRole` | unchanged |
| Multi-tenant / multi-country / audit / AI-ready | ✅ `requireTenant` + `X-Tenant-ID` envelope + `app_iam.tenants` + audit chain | unchanged |

Deviations from the literal brief (Redux, Framer Motion, ECharts) are **deliberate** — they preserve a single coherent stack. Everything else maps 1:1.

---

## 1. Layering

```
SPA (React + Tailwind + react-query + zustand + Recharts)
  web/src/modules/insurance/<Module>Page.tsx
  web/src/lib/api.ts            ← typed client (envelope-unwrapped)
  web/src/components/layout/navConfig.ts ← "INSURANCE — EARLY WARNING" group
        │  axios  (X-Tenant-ID + X-Channel injected by interceptor)
        ▼
BFF (Node + Express + TypeScript)         services/bff/src/server.ts
  requireTenant → requireRole(op) → handler → wrapResponse / wrapError
  services/bff/src/insurance_<module>.ts  ← pure builders + deterministic synthesis
        │  (today: in-memory synthesis; swap to pg queries when feeds land)
        ▼
PostgreSQL  schema app_insurance (24 tables, migration 039)
  + Redis (caching — see §9)
        ▲
Auth-svc (Fastify)  RS256 JWT + JWKS  ─ verified by BFF tenant middleware
```

Every public route is `/v1/insurance/<module>/<action>`, tenant-scoped, RBAC-gated, and returns the standard `{header, body}` envelope (`{header, error}` on failure).

---

## 2. The 7 modules

| # | Module | BFF file | Routes (`/v1/insurance/…`) | Tables | Status |
|---|--------|----------|------------------|--------|--------|
| 1 | **Policy Lapse Risk** | `insurance_policy_lapse.ts` | `policy-lapse/{dashboard,predict,high-risk}` | policy_lapse_predictions, customer_payment_history, retention_campaigns | ✅ **shipped** |
| 2 | Claims Anomaly | `insurance_claims_anomaly.ts` | `claims-anomaly/{dashboard,analyze,suspicious}` | claim_anomalies, siu_cases, fraud_scores | ⏳ planned |
| 3 | Fraud Detection | `insurance_fraud.ts` | `fraud/{dashboard,analyze,high-risk}` | fraud_networks, provider_links, fraud_cases, fraud_entities | ⏳ planned |
| 4 | Solvency Watch | `insurance_solvency.ts` | `solvency/{dashboard,forecast,compliance}` | solvency_metrics, solvency_forecasts, compliance_alerts | ⏳ planned |
| 5 | Persistency Watch | `insurance_persistency.ts` | `persistency/{dashboard,analyze,alerts}` | persistency_metrics, retention_analysis, persistency_alerts | ⏳ planned |
| 6 | Underwriting Deviation | `insurance_underwriting.ts` | `underwriting/{dashboard,analyze,deviations}` | underwriting_deviations, approval_exceptions, underwriter_scores | ⏳ planned |
| 7 | Channel Risk | `insurance_channel_risk.ts` | `channel-risk/{dashboard,analyze,high-risk}` | channel_risk_scores, agent_complaints, distribution_metrics | ⏳ planned |

**All 24 tables already exist** (migration `data/schema/039_insurance_ews.sql`, applied + verified). Cross-cutting tables `insurance_alerts` + `insurance_audit_events` back a unified alert feed + per-module audit trail.

---

## 3. Module vertical-slice template (how 2–7 ship)

Module 1 is the reference. Each subsequent module is one commit following the same shape:

1. **BFF pure module** `services/bff/src/insurance_<module>.ts`
   - Deterministic synthesis (`seedFrom` FNV-1a + `rng` Mulberry32, keyed on `(tenant, day, …)`) so a given tenant sees a stable book today; swap the builder bodies to `app_insurance.*` queries when real feeds land — **response shapes stay frozen**.
   - Pure builders: `build<Module>Dashboard(tenant, now)`, `analyze<Module>(input, now)`, `list<HighRisk/Suspicious/…>(tenant, now, opts)`.
   - `<Module>Error` class with machine-readable codes → routed to `EWS_400_<code>`.
   - Per-tenant scale (`BANK_DEMO` 1.0 / `BIL` 0.6) so two tenants look distinct.
2. **Routes** in `server.ts`: `requireTenantMw → requireRole('insurance:<module>:<op>') → handler`. Read ops gated broadly; analyze/predict gated to analyst+; compliance gated admin+supervisor.
3. **jest tests** `services/bff/__tests__/insurance_<module>.test.ts` — pure builders (shape, determinism, tenant divergence, sort/partition invariants, error paths) + the 3 routes (happy, RBAC 403, missing-tenant 400, query-param handling).
4. **SPA page** `web/src/modules/insurance/<Module>Page.tsx` — PageHeader + KPI MetricCards + Recharts widgets + tables + an analyze/predict Modal. Add a leaf to `navConfig.ts` (INSURANCE group), a route to `App.tsx`, api methods + types to `api.ts`, i18n keys (4 locales), MSW handlers, vitest.
5. **RBAC** — ops already defined in `infra/rbac/matrix.json` (18 insurance ops).

---

## 4. RBAC & roles

Backend enforces 5 canonical roles (`admin, risk_analyst, supervisor, collection_officer, field_officer`). The brief's 8 insurance roles map onto these (the 11-role enterprise catalog at `web/src/lib/enterpriseRoles.ts` already carries `backend_role` mapping):

| Brief role | Backend role | Insurance access |
|---|---|---|
| Super Admin / Insurance Admin | `admin` | everything incl. compliance |
| Fraud Analyst / Risk Analyst | `risk_analyst` | read + analyze/predict |
| Compliance Officer | `supervisor` | read + analyze + compliance |
| Claims Investigator | `collection_officer` | read + SIU manage |
| Auditor / Read Only | `field_officer` | read-only dashboards |

**18 insurance ops** added to the matrix (`insurance:<module>:{read,analyze,predict,…}`). Access is tenant-scoped (JWT `tenant_id` claim must match `X-Tenant-ID`), country/branch/department scoping rides the existing `app_iam.user_roles` multi-scope assignment (migration 038).

---

## 5. AI scoring workflow (Module 1 reference)

`predictPolicyLapse(input, now)` is the deterministic stub of the production model — a logistic-style blend of payment-behaviour drivers (missed instalments, days-since-payment, prior lapses, tenure, claims, horizon), clamped to [0,1], with SHAP-style `top_drivers[]`. Same inputs → same score. **Production swap:** replace the body with a model-serving call (the platform already has `ai-copilot-svc` + a model registry at `services/bff/src/ai_model_registry.ts`); the `LapsePrediction` shape is the contract. The other modules' AI engines (claims anomaly score, fraud-network ring detection, solvency forecast, persistency root-cause) follow the same stub-then-swap pattern.

---

## 6. Database

- **Schema:** `app_insurance` (24 tables) — `data/schema/039_insurance_ews.sql`.
- **Conventions:** every table carries `tenant_id` (FK → `app_iam.tenants ON DELETE CASCADE`) + `created_at`; AI tables carry `model_version` + `scored_at` for regulator reconstruction.
- **Migrations:** additive only, `CREATE TABLE IF NOT EXISTS` + `DO $$ … $$` guards → re-runnable (verified idempotent).
- **Apply:** `PGPASSWORD=… psql -h localhost -p 55432 -U zorews_user -d zorews -f data/schema/039_insurance_ews.sql` (or `make migrate`).

---

## 7. OpenAPI / Swagger

The auth-svc already serves an OpenAPI 3.1 spec via Swagger UI (`services/auth-svc/openapi.yaml` + `/auth/docs`). Insurance routes are added to the BFF's spec surface following the same tag-per-module shape (`Insurance · Policy Lapse`, `Insurance · Claims Anomaly`, …). Each route documents the `{header, body}` envelope + the `EWS_4xx_<code>` error shape. **Follow-up:** generate the BFF OpenAPI doc from the route table once ≥3 modules ship (keeps the spec from churning per-module).

---

## 8. Docker & deployment

- **Local:** `make up` starts the BFF + auth-svc + supporting services (PIDs in `.pids/`, logs in `.logs/`); Postgres runs as the `zorews-pg` container (port 55432).
- **Production:** the platform deploys to EKS — Terraform under `infra/terraform/{10-network,20-eks,30-data,40-edge}` provisions VPC + EKS + Aurora + MSK + Redis + ALB/WAF/CloudFront. K8s manifests at `infra/k8s/` (Deployments, HPAs at `hpa.yaml`, PDBs at `pdb.yaml`, Karpenter at `karpenter/`). The Insurance EWS adds **no new service** — it ships inside the existing BFF + SPA images, so no new Dockerfile/Deployment is required.

---

## 9. Redis caching strategy

Redis is provisioned (`infra/terraform/30-data`). The dashboard endpoints are the natural cache targets since they're read-heavy + deterministic per `(tenant, day)`:

- **Key:** `ins:<module>:dashboard:<tenant_id>:<utc-day>` → JSON payload, TTL 1h (or until the underlying feed refreshes).
- **Invalidation:** on `analyze`/`predict` writes that change the book, `DEL` the tenant's dashboard key.
- **Pattern:** wrap the builder call in a cache-aside helper (`getOrCompute(key, ttl, () => build…)`). Today the synthesis is cheap enough to skip caching; wire it when real pg queries land and p95 warrants (mirror the T4.6 / B7 perf-gate approach).

---

## 10. Smoke testing checklist

Per module, after wiring:

- [ ] `cd services/bff && npx tsc --noEmit` → 0 new errors
- [ ] `npx jest insurance_<module>` → all green (pure builders + routes)
- [ ] `make migrate` re-run → idempotent (no errors)
- [ ] BFF route smoke: `curl -H 'X-Tenant-ID: BANK_DEMO' -H 'X-Channel: API' localhost:8084/v1/insurance/<module>/dashboard` → `{header:{status:SUCCESS}, body:…}`
- [ ] RBAC: a read-only role → 200 on dashboard, 403 on analyze
- [ ] Tenant isolation: `BIL` payload differs from `BANK_DEMO`
- [ ] `cd web && npx vitest run src/__tests__/<Module>Page.test.tsx` → green
- [ ] SPA visual: `make web-dev` → nav → INSURANCE group → page renders widgets + predict modal scores

### Module 1 smoke result (2026-05-28)
- BFF tsc: 0 new errors · jest `insurance_policy_lapse`: **43/43 pass**
- Migration 039: applied + idempotent re-run clean (24 tables)
- SPA tsc: 0 new errors (25 pre-existing handler errors unrelated) · vitest `PolicyLapsePage`: **4/4 pass** · `AppShellNavGroups`: **8/8 pass**

---

## 11. Build sequence for modules 2–7

Recommended order (highest operator value first): **2 Claims Anomaly → 3 Fraud Detection → 4 Solvency Watch → 5 Persistency Watch → 6 Underwriting Deviation → 7 Channel Risk.** Each is one self-contained commit per §3. Tables + RBAC ops for all 7 already exist, so each module is purely BFF builder + routes + tests + SPA page + nav leaf.
