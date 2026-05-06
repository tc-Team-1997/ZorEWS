# EWS Rules Engine — Analysis & Architecture Mapping

**Status:** RFC — pending sign-off before code lands.
**Scope:** Tasks #1 + #2 of the 5-task brief (analyse existing rules infrastructure, then map the proposed EWS rules engine to it so we know what to reuse vs. build).
**Author:** EWS engineering, 2026-05-06.

---

## 1. Executive summary

This repo already ships **two parallel rules implementations**, **plus** a SPA builder, **plus** a 12-entry rule-template library — but it does **not** ship the EWS-specific evaluator the brief describes. The brief's "EMI bounce ≥ 3 / claim > 3× avg / KYC expired / login from new country / risk-score delta" rules are a **superset** of the existing 32-indicator banking catalogue and require **new insurance + operational + portfolio-derived signals** to land.

**Recommendation:** build the EWS rules engine as a **new BFF module** (`ews_rules.ts`) that reuses the existing DSL evaluator (regulatory-svc/rules/dsl.ts) but adds:
- A wider indicator catalogue (insurance + operations + portfolio-derived)
- A stable per-tenant evaluator service that takes `entity` + `entity_type` and runs every active rule
- A canonical DB schema for rules (currently rules live only in code/JSON; the alerts table only stores denormalised `rule_id` / `rule_name`)
- An execution-history table so the brief's `/rules/:id/hits` endpoint has somewhere to read from
- Performance-budgeted bulk evaluator (≥1000 rules / entity / 500 ms)

Net change is additive — no rewrite of existing rules code.

---

## 2. What already exists

### (A) `services/regulatory-svc/rules/` — minimal regulatory rules service

| Concern | Implementation |
|---|---|
| Rule format | JSON file per rule, schema at `rules/dsl.schema.json` |
| Storage | In-memory `RuleStore` (Map<id, Rule>); seed at `rules/seed/RULE-001.json` … `RULE-040+.json` |
| Lifecycle | `draft → simulate → live → retired` (one-way); promote requires FP rate ≤ 0.25 |
| Evaluator | Pure `evalExpr(when_tree, indicator_values)` returning boolean; `firingIndicators()` returns the matching leaves |
| Operators | `gt / gte / lt / lte / eq / between` |
| Logic ops | `and / or / not` recursive |
| Routes | Express service: `POST/GET /rules`, `GET /rules/:id`, `POST /rules/:id/{simulate,promote,retire}`, `GET /rules/:id/audit` |
| Audit | In-memory log with `// emit to apex.audit.events` marker |
| Tests | 31 jest pass |

### (B) `services/bff/src/rules/` — fuller BFF rules surface (the SPA's source of truth)

| Concern | Implementation |
|---|---|
| Rule format | TypeScript `RuleV2` with `ConditionNode` (recursive `and/or/not` + leaf `Condition`) |
| Operators | `> >= < <= == != in not_in between` (wider than the regulatory-svc set) |
| Lifecycle | 6-state: `draft → pending_review → approved → active → rejected → deprecated`; transitions `submit/approve/reject/activate/deprecate/edit`; RBAC capability per transition |
| Variable library | 5-category catalog (account/loan/customer/transaction/external) × 7 types (number/percent/count/days/amount_kes/flag/enum); used by the SPA builder |
| Backtest | Deterministic `backtest()` → precision / coverage / avg-days-to-default / 12-month volume |
| Performance model | `performing / underperforming / deprecated / no_data` |
| Routes | `GET /v1/rules`, `GET /v1/rules/:id`, `POST /v1/rules/:id/transition`, `POST /v1/rules/:id/backtest`, `/v1/rules/variables`, `/v1/rules/templates/*` |
| Storage | `RuleStore` in-memory; seed in `rules/seed.ts` |

### (C) BFF rule-template ecosystem (M5 sub-phases shipped)

| Sub-phase | Surface |
|---|---|
| M5.1 | 12-template library |
| M5.3–4 | Bulk-clone + simulation BUNDLE |
| M5.5 | Diff |
| M5.6 | Custom-template CRUD (per-tenant) |
| M5.7 | Custom→simulation/diff merge |
| M5.8 | PUT + audit history |
| M5.9 | Single clone-from-library |
| M5.10 | Bulk-clone-from-library |
| M5.11 | (uncommitted on disk) export/import bundle |

### (D) Database

- `004_app_schemas.sql` references `rule_id` + `rule_name` **only as denormalised columns** on `app.alerts` and `app.cases`.
- **There is no canonical `rules` table.** Rules currently live in JSON seed files (regulatory-svc) and in-memory stores (BFF).
- No `rule_executions` / `rule_hits` table — the brief's `GET /api/rules/:id/hits` has nothing to read from.

### (E) SPA

- `web/src/modules/rules/RuleConfigPage.tsx` (1090 LOC) — visual builder against `/v1/rules*` using TanStack Query + Recharts.
- Test: `web/src/__tests__/RuleConfigPage.test.tsx`.
- Wired to the BFF's `RuleV2` shape (option B above), **not** the regulatory-svc DSL.

### (F) Indicator catalogue

- `services/regulatory-svc/indicators/catalog.json` — 32 indicators across `FIN- / BEH- / TXN- / CRD-` families. Banking-only.
- BFF carries an extended in-code catalogue at `bil_scoring_v2.ts` with insurance KRIs (POL- / CUS-INS- / AGT- / CLM- / OPS-).

---

## 3. What the brief asks for vs. what exists

### Brief's 10 sample rules — coverage check

| Brief rule | Required signal | Closest existing indicator | Coverage |
|---|---|---|---|
| RULE_CREDIT_001 — EMI bounce ≥ 3 / 90d | `emi_bounce_count_90d` | TXN-005 `bounced_payment_count_60d` | **Different window** (60d vs 90d) — extend catalog |
| RULE_LAPSE_001 — premium overdue > 15d | `premium_overdue_days` | _(none — insurance not in regulatory-svc catalog)_ | **Add insurance indicator** |
| RULE_FRAUD_001 — claim > 3× avg + within 30d of policy | `claim_to_avg_ratio`, `policy_age_days_at_claim` | _(none)_ | **Add insurance indicator** |
| RULE_KYC_001 — KYC expired > 30d | BEH-006 `kyc_doc_expiry_days` | BEH-006 ✓ | **Reuse** (negate sign) |
| RULE_TXN_001 — txn > 10× avg | TXN-002 `large_outflow_anomaly` | TXN-002 ≈ | **Reuse with new threshold** |
| RULE_AGENT_001 — agent portfolio lapse > 20% | `agent_portfolio_lapse_pct` | _(none)_ | **Add agent indicator** |
| RULE_OPS_001 — login from new country | `login_new_country_24h` | _(none)_ | **Add operational indicator** |
| RULE_CONC_001 — single customer > 30% portfolio | `customer_exposure_pct_of_portfolio` | _(none)_ | **Add portfolio-derived indicator** |
| RULE_BEHAV_001 — 50% drop in txn freq | `txn_freq_drop_30d_pct` | _(none directly)_ | **Add behavioural indicator** |
| RULE_SCORE_001 — risk score +30 in 7d | `risk_score_delta_7d` | CRD-001 `bureau_score_drop_60d` ≠ | **Add derived indicator** |

**3/10 reusable as-is, 7/10 require catalog extension.** This is the bulk of the new work.

### Brief's API contract vs. existing

| Brief endpoint | Existing equivalent | Gap |
|---|---|---|
| `GET /api/rules` | `GET /v1/rules` (BFF) | Path prefix only — BFF uses `/v1/`, not `/api/`. Adopt `/v1/ews/rules` for the new layer. |
| `POST /api/rules` | `POST /v1/rules` | Existing requires submit→approve workflow. New layer can fast-path for prototype. |
| `PUT /api/rules/:id` | `POST /v1/rules/:id/transition` (edit) | Existing is transition-based. Add a direct PUT for the EWS layer. |
| `DELETE /api/rules/:id` (soft) | `POST /v1/rules/:id/transition deprecate` | Existing already supports soft-delete. Reuse semantically. |
| `POST /api/rules/:id/test` | `POST /v1/rules/:id/backtest` | Backtest is historical; brief asks for "test against sample data" → **add `/evaluate` endpoint**. |
| `POST /api/rules/:id/activate` | transition `activate` | Reuse. |
| `GET /api/rules/:id/hits` | _(none)_ | **Build** — needs `rule_executions` table. |

### Brief's DSL vs. existing

The brief shows:
```json
{ "field": "emi_bounce_count_90d", "operator": ">=", "value": 3 }
```

Existing BFF `Condition`:
```ts
{ field: string; op: '>=' | …; value: unknown; }
```

**Direct match.** The brief's logic groups (`AND` / `OR`) match the BFF `ConditionNode` recursive shape. We can reuse the BFF DSL verbatim.

### Brief's action vs. existing

The brief says `"action": { "alert_severity": "RED", "weight": 25 }`.

Existing BFF `RuleOutcome`:
```ts
interface RuleOutcome {
  severity: 'critical' | 'high' | 'medium' | 'low';
  alert_priority: 'P1' | 'P2' | 'P3' | 'P4';
  notify: NotifyRole[];
  weight?: number;  // missing — needs to be added
}
```

**Maps cleanly** with one addition: a `weight` field for cumulative scoring (the brief says "cumulative score impact"). The brief's `RED/ORANGE/YELLOW/GREEN` enum maps to the BIL alert classification (`bil_alert_classification.ts`) which already exists and is the canonical EWS severity vocabulary.

---

## 4. Architecture mapping — source → target

### 4.1 Files to **add**

| New file | Purpose |
|---|---|
| `services/bff/src/ews_rules.ts` | EWS rule type, validator, evaluator, in-memory store + per-tenant cap; reuses BFF `ConditionNode` |
| `services/bff/src/ews_rules_executor.ts` | Pure executor: `evaluateRules(entity, entity_type, rules)` → matched rules + cumulative score + alerts to emit |
| `services/bff/src/ews_rules_seed.ts` | 10 brief-mandated default rules + 5 supporting BIL rules |
| `services/bff/__tests__/ews_rules.test.ts` | Unit + route tests, including the 1000-rule perf budget |
| `services/bff/__tests__/ews_rules_executor.test.ts` | Pure-function executor tests |
| `data/schema/012_rules.sql` | DB schema: `app.ews_rules` + `app.ews_rule_executions` tables (canonical home; current code-only storage is an MVP shortcut) |
| `data/schema/seed_ews_rules.sql` | SQL seed for the 10 default rules |
| `web/src/modules/rules/EwsRuleBuilderPage.tsx` | New SPA page for the EWS-specific builder (reuses the existing `RuleConfigPage` patterns) |
| `web/src/__tests__/EwsRuleBuilderPage.test.tsx` | Component test |
| `docs/ews-rules-postman.json` | Postman collection |
| `docs/ews-rules-engine-readme.md` | Operator-facing readme: "how to add a new rule" |

### 4.2 Files to **extend** (additive only — no existing-line rewrites)

| Existing file | Addition |
|---|---|
| `services/bff/src/server.ts` | New routes block under `/v1/ews/rules/*` (the brief's `/api/rules` adapted to the project convention); calls into `ews_rules.ts` |
| `services/regulatory-svc/indicators/catalog.json` | **Don't extend this** — keep the regulatory-svc indicator catalog frozen (it underpins regulatory rule validation). Instead, ship a parallel **EWS indicator catalog** at `services/bff/src/ews_indicators.ts` with the new insurance / operational / portfolio-derived signals. The two catalogs are disjoint by ID prefix (`POL- / CLM- / AGT- / OPS- / RSK-`). |
| `STATUS.md` | Bump sub-phase totals + add an "EWS rules engine" coverage row |

### 4.3 Files NOT to touch

- `services/regulatory-svc/rules/*` — frozen
- `services/bff/src/rules/*` — frozen (this is the existing M5 surface; tests depend on its exact shape)
- `services/bff/src/rule_templates*.ts` — frozen (M5.1–M5.10)
- `web/src/modules/rules/RuleConfigPage.tsx` — frozen
- `004_app_schemas.sql` — frozen (existing `rule_id` denormalisation stays)

### 4.4 DB schema — proposed `data/schema/012_rules.sql`

```sql
CREATE SCHEMA IF NOT EXISTS app;

-- Canonical rule definitions. Mirrors the in-memory EwsRule shape.
CREATE TABLE IF NOT EXISTS app.ews_rules (
    rule_id            TEXT        PRIMARY KEY,
    tenant_id          TEXT        NOT NULL,
    name               TEXT        NOT NULL,
    category           TEXT        NOT NULL,
        -- credit / lapse / fraud / kyc / txn / agent / ops / concentration /
        -- behaviour / score
    description        TEXT        NOT NULL,
    conditions         JSONB       NOT NULL,   -- the ConditionNode tree
    logic              TEXT        NOT NULL,   -- 'AND' / 'OR' (top-level for flat rules)
    action             JSONB       NOT NULL,   -- {alert_severity, weight, recommended_action}
    is_active          BOOLEAN     NOT NULL DEFAULT FALSE,
    state              TEXT        NOT NULL DEFAULT 'draft',
        -- draft / pending_review / active / deprecated
    version            INTEGER     NOT NULL DEFAULT 1,
    created_by         TEXT        NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    deprecated_at      TIMESTAMPTZ,
    CHECK (state IN ('draft','pending_review','active','deprecated')),
    CHECK (logic IN ('AND','OR'))
);
CREATE INDEX IF NOT EXISTS ix_ews_rules_tenant_active
  ON app.ews_rules (tenant_id, is_active)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS ix_ews_rules_category
  ON app.ews_rules (tenant_id, category);

-- Per-execution telemetry. Powers /v1/ews/rules/:id/hits and the SPA's
-- "rule firing volume" sparklines.
CREATE TABLE IF NOT EXISTS app.ews_rule_executions (
    execution_id       BIGSERIAL   PRIMARY KEY,
    rule_id            TEXT        NOT NULL REFERENCES app.ews_rules(rule_id) ON DELETE CASCADE,
    tenant_id          TEXT        NOT NULL,
    entity_type        TEXT        NOT NULL,    -- 'customer' | 'policy' | 'claim'
    entity_id          TEXT        NOT NULL,
    matched            BOOLEAN     NOT NULL,
    matched_indicators TEXT[]      NOT NULL DEFAULT '{}',
    score_impact       NUMERIC(8,2) NOT NULL DEFAULT 0,
    alert_id           TEXT,                    -- set when an alert was emitted
    evaluated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_us        INTEGER     NOT NULL,    -- micro-seconds, for perf monitoring
    CHECK (entity_type IN ('customer','policy','claim'))
);
CREATE INDEX IF NOT EXISTS ix_ews_executions_rule_time
  ON app.ews_rule_executions (rule_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS ix_ews_executions_entity
  ON app.ews_rule_executions (tenant_id, entity_type, entity_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS ix_ews_executions_matched
  ON app.ews_rule_executions (tenant_id, evaluated_at DESC) WHERE matched = TRUE;
```

### 4.5 API contract — proposed `/v1/ews/rules/*`

Following the existing BFF convention (`/v1/`, T4.24 envelope, role-gated):

| Method + path | Role | Purpose |
|---|---|---|
| `GET    /v1/ews/rules` | rules:list | List with `?category=&state=&is_active=` filters |
| `POST   /v1/ews/rules` | rules:create | Create draft rule |
| `GET    /v1/ews/rules/:rule_id` | rules:read | Single rule + recent executions count |
| `PUT    /v1/ews/rules/:rule_id` | rules:create | Replace mutable fields; bumps version |
| `DELETE /v1/ews/rules/:rule_id` | rules:retire | Soft-delete (state → deprecated) |
| `POST   /v1/ews/rules/:rule_id/test` | rules:simulate | Run rule against ad-hoc sample entity, return matched + which indicators fired |
| `POST   /v1/ews/rules/:rule_id/activate` | rules:retire | Promote draft → active |
| `GET    /v1/ews/rules/:rule_id/hits` | audit:read | Recent matches with cursor pagination (`?since_seq=&limit=`) |
| `POST   /v1/ews/rules/evaluate` | rules:simulate | **Bulk evaluate**: takes one entity, runs ALL active rules, returns matched rules + cumulative score |
| `GET    /v1/ews/rules/indicators` | rules:list | EWS indicator catalog (insurance + operational + portfolio-derived) |

### 4.6 Performance budget — 1000+ rules / entity / 500 ms

The brief mandates evaluating 1000+ rules against a single entity in <500 ms. Concrete plan:

- The DSL evaluator is **pure** — no DB lookups, no I/O. Each rule eval is `O(condition tree size)`.
- For a typical 3-leaf rule tree, `evalExpr` is < 1 µs. 1000 rules × 1 µs = 1 ms — comfortably inside budget.
- **The expensive part** is the indicator-value resolution per entity. We'll cache the indicator-values map at the start of an evaluation (one map for all 1000 rules) so each rule re-uses the same map. Resolution cost is O(distinct indicators across the rule set), not O(rules × indicators).
- Tests will assert the perf budget directly with a synthetic 1000-rule scenario.

### 4.7 Frontend mapping

| SPA element | Reuses | New |
|---|---|---|
| Rule list page | `RuleConfigPage` patterns (Panel, MetricCard) | New page at `/rules/ews` |
| Visual condition builder | `Condition` recursive UI from `RuleConfigPage` | Field picker auto-populated from `/v1/ews/rules/indicators` |
| Operator dropdown | Existing `Operator` enum | Same |
| AND/OR groups | `ConditionNode` recursive | Same |
| Live test | New | Calls `/v1/ews/rules/:id/test` |
| Activation toggle | New | Calls `/v1/ews/rules/:id/activate` |
| Hit timeline | New | Reads from `/v1/ews/rules/:id/hits` |

---

## 5. Implementation sub-phases

Proposed split into 5 commits, each independently testable + reviewable:

| Commit | Scope | Files | Test count target |
|---|---|---|---|
| **EWS-1** Indicators + types | New EWS indicator catalog + `EwsRule` type + validator | `ews_indicators.ts`, `ews_rules.ts` (types only) | ~25 |
| **EWS-2** Store + executor | `InMemoryEwsRuleStore`, pure `evaluateRules()` | `ews_rules.ts` (store), `ews_rules_executor.ts` | ~30 |
| **EWS-3** Routes + perf budget | All 9 routes, perf test for 1000-rule budget | `server.ts` patch, route tests | ~25 |
| **EWS-4** Seed + DB migration | 10 brief-mandated rules + SQL migration + seed file | `ews_rules_seed.ts`, `012_rules.sql`, `seed_ews_rules.sql` | ~10 |
| **EWS-5** SPA + Postman + README | New builder page + Postman collection + operator readme | `EwsRuleBuilderPage.tsx`, Postman JSON, README md | ~15 |

Total ≈ 105 new tests on top of the existing 2937.

---

## 6. Open questions for sign-off

1. **Path prefix** — confirm `/v1/ews/rules/*` rather than the brief's literal `/api/rules`. The BFF convention is `/v1/` and the existing tests rely on it.
2. **Rule-state lifecycle** — adopt the simpler 4-state (`draft / pending_review / active / deprecated`) for the EWS layer rather than the BFF's 6-state (`draft / pending_review / approved / active / rejected / deprecated`). Mirrors the brief's tone of "draft → active → archived".
3. **Score-aggregation semantics** — the brief says "weight: 25" with a "cumulative score impact". Confirm: cumulative score is **summed across all matching rules**, capped at 100, and translated to a single-call `aggregate_severity` (RED if ≥75, ORANGE if ≥50, YELLOW if ≥25, GREEN otherwise). This is **new logic** — neither existing implementation does cumulative weighting.
4. **DB integration** — the brief asks for migration scripts. Confirm: DB tables are **defined but the prototype remains in-memory** (matches the existing repo posture per the auto-memory note "production deploy out of scope"). The migration ships as a forward-looking schema, not a runtime dependency.
5. **Should the EWS executor write to the M9.4 case-event journal?** Recently shipped — every match could append an `opened` event to feed downstream consumers. **Yes** unless you say otherwise.

Once the above are confirmed I'll start EWS-1 (indicators + types). If any of (1)–(5) need to change, this doc gets updated first, then code follows.
