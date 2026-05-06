# EWS Rules Engine — Operator Guide

This is the day-to-day reference for risk operators authoring and managing rules in the EWS rules engine. For the full architectural design + analysis of why this exists alongside the regulatory-svc rules service, read [`ews-rules-engine-mapping.md`](./ews-rules-engine-mapping.md) first.

## What this engine does

Evaluates the entity (a customer, policy, or claim) against every **active** rule in your tenant, returns the matched rules + a cumulative risk score (0–100, capped) + an aggregate severity (RED ≥ 75, ORANGE ≥ 50, YELLOW ≥ 25, GREEN otherwise). Each match also records a telemetry row and emits a case event so downstream M9.4 consumers can fan out.

## Where things live

| Concern | Path |
|---|---|
| Rule + indicator types | `services/bff/src/ews_rules.ts`, `services/bff/src/ews_indicators.ts` |
| Pure executor | `services/bff/src/ews_rules_executor.ts` |
| Default rule seed | `services/bff/src/ews_rules_seed.ts` |
| BFF routes | `services/bff/src/server.ts` (search "EWS rules engine (EWS-3)") |
| DB migration | `data/schema/012_ews_rules.sql` |
| SQL seed | `data/schema/seed_ews_rules.sql` |
| SPA builder | `web/src/modules/rules/EwsRuleBuilderPage.tsx` (route `/rules/ews`) |
| Postman collection | `docs/ews-rules-postman.json` |

## How to add a new rule (the operator path)

### Option A — SPA visual builder

1. Navigate to `/rules/ews` in the SPA.
2. Click **New rule**.
3. Pick a `rule_id` matching the pattern `RULE_<DOMAIN>_<NNN>` — e.g. `RULE_LIQ_001`.
4. Pick a category, severity, weight (1–100), and a recommended action.
5. Add one or more conditions:
   - Pick an indicator from the dropdown (auto-populated from `/v1/ews/rules/indicators`).
   - Pick an operator (`>=`, `between`, `in`, etc.).
   - Enter the threshold value (the placeholder shows the indicator's natural range).
6. Click **Save draft**. The rule lands in `draft` state — not yet firing.
7. Click **Test** on the rule, enter sample indicator values, click **Run test** to see whether the rule would match. This **does not** record telemetry.
8. When happy, click **Activate**. The rule transitions `draft → pending_review → active` in one click and starts firing on `/v1/ews/rules/evaluate` calls.

### Option B — direct API call

```bash
# Create
curl -X POST $BFF/v1/ews/rules \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" \
  -H "X-APEX-USER: compliance.lead" -H "x-apex-role: admin" \
  -H "Content-Type: application/json" \
  -d '{
    "rule_id": "RULE_LIQ_001",
    "name": "Liquidity erosion",
    "category": "credit",
    "description": "Customer balance dropped 40% in 30 days.",
    "conditions": [
      { "field": "emi_bounce_count_90d", "operator": ">=", "value": 3 }
    ],
    "logic": "AND",
    "action": { "alert_severity": "ORANGE", "weight": 20 }
  }'

# Activate
curl -X POST $BFF/v1/ews/rules/RULE_LIQ_001/activate \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" \
  -H "x-apex-role: admin"
```

## Rule shape

```jsonc
{
  "rule_id": "RULE_CREDIT_001",      // RULE_<UPPER>_NNN, must be unique per tenant
  "name": "High EMI Bounce Risk",     // ≤ 80 chars
  "category": "credit",               // one of 10 enum values (see ews_rules.ts)
  "description": "3+ EMI bounces in 90 days …",  // ≤ 500 chars
  "conditions": [                     // 1-12 conditions; flat list
    { "field": "emi_bounce_count_90d", "operator": ">=", "value": 3 }
  ],
  "logic": "AND",                     // 'AND' | 'OR' applied to all conditions
  "action": {
    "alert_severity": "RED",          // RED | ORANGE | YELLOW | GREEN
    "weight": 25,                     // 1-100 integer; sum across matches caps at 100
    "recommended_action": "Pause disbursement; assign to RM."  // optional, ≤ 280 chars
  },
  "is_active": true,                  // ignored on create — set via /activate route
  "tags": ["fraud", "early-warning"]  // optional, ≤ 10 tags
}
```

### Operators

| Operator | Use for | Notes |
|---|---|---|
| `>` `>=` `<` `<=` | numeric comparisons | requires a number `value` |
| `==` `!=` | exact match | works for both numbers and strings (enum indicators) |
| `in` `not_in` | membership | requires `value: <array>` |
| `between` | inclusive range | requires `range: [min, max]` (no `value`) |

### Indicator types

| Type | Operators allowed |
|---|---|
| `count`, `percent`, `ratio`, `days`, `amount`, `flag` | all 9 operators |
| `enum` | `==`, `!=`, `in`, `not_in` only — strings only |

## How aggregate scoring works

Each matching rule contributes `action.weight` to the cumulative score. The cumulative score is **summed**, then **capped at 100**. The aggregate severity is then derived:

| Cumulative score | Aggregate severity |
|---|---|
| ≥ 75 | RED |
| ≥ 50 | ORANGE |
| ≥ 25 | YELLOW |
| < 25 | GREEN |

This means a single RED-severity rule with weight 25 contributes a YELLOW *aggregate*. To force RED, either bump the rule's weight to 75+ or design rules so a real customer in distress matches multiple low-weight rules summing to the RED threshold.

## Lifecycle states

```
draft  ──submit──▶  pending_review  ──activate──▶  active  ──delete──▶  deprecated  (terminal)
                          │                                                     ▲
                          └────────────────────deprecate────────────────────────┘
```

- New rules land in `draft`. Not firing.
- `activate` route auto-submits + activates in one call.
- `deprecate` (`DELETE`) flips `is_active=false` and stamps `deprecated_at`. Cannot un-deprecate — author a new rule.
- Cannot edit a deprecated rule (HTTP 409 `illegal_state`).

## Testing a rule

```bash
curl -X POST $BFF/v1/ews/rules/RULE_CREDIT_001/test \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" -H "x-apex-role: admin" \
  -H "Content-Type: application/json" \
  -d '{ "values": { "emi_bounce_count_90d": 5 } }'
```

Returns `{matched, matched_indicators, score_impact, alert_severity}`. **Does not** record telemetry — safe to call repeatedly during authoring.

## Bulk evaluation (the production path)

```bash
curl -X POST $BFF/v1/ews/rules/evaluate \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" -H "x-apex-role: admin" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type": "customer",
    "entity_id": "cust-001",
    "values": {
      "emi_bounce_count_90d": 5,
      "kyc_doc_expiry_days": 60
    }
  }'
```

Returns the full envelope with `matches[]`, `cumulative_score`, `aggregate_severity`, `duration_us`. Records one telemetry row per match. Writes one case event per match (visible at `/v1/cases/events`).

## Performance budget

The brief mandates 1000+ rules / entity / 500 ms. The executor is pure (no I/O), so the tight loop is `O(rules × conditions)`. Verified directly by `services/bff/__tests__/ews_rules_routes.test.ts` ("PERF: 1000 active rules"). On the test box this runs in 30–80 ms — comfortably inside budget.

## Indicator catalog

15 indicators across 10 domains. Operators **cannot** define new indicators — they're platform-static and require a code change to extend. Use `GET /v1/ews/rules/indicators` (or the SPA dropdown) to see the live list. Each entry declares:

- `name` — DSL key (`emi_bounce_count_90d`)
- `display_name` — UI label
- `domain` — credit / insurance / fraud / kyc / transaction / agent / operational / portfolio / behaviour / risk_score
- `type` — drives operator/value validation
- `range` — numeric bounds enforced at rule-save time
- `enum_values` — allowed values for enum indicators

## Audit + telemetry

| Action | Audit event written | Case event written |
|---|---|---|
| POST /v1/ews/rules (create) | `rule.create` | — |
| PUT /v1/ews/rules/:id | `rule.update` | — |
| POST /v1/ews/rules/:id/activate | `rule.activate` | — |
| DELETE /v1/ews/rules/:id | `rule.retire` | — |
| POST /v1/ews/rules/evaluate (per match) | — | `opened` (per matched rule) |

All events are queryable via the existing audit-trail surfaces (`/v1/audit/events`) and case-event journal (`/v1/cases/events`).

## Cap + retention

- **Rules**: 2000 / tenant
- **Executions** (telemetry): 5000 / tenant FIFO
- **Per-rule conditions**: 12

Rule list is unbounded in the response shape — use `?category=` / `?state=` / `?is_active=` filters for the SPA.

## Database schema (forward-looking)

Per the architecture RFC, the prototype runtime is in-memory. Production deployment swaps in PostgreSQL via `data/schema/012_ews_rules.sql`. Two tables:

- `app.ews_rules` — composite PK `(tenant_id, rule_id)`; JSONB conditions/action; CHECK constraints keep state + is_active in lock-step.
- `app.ews_rule_executions` — append-only telemetry; FK to `ews_rules` cascades on delete; partial index on `matched=TRUE` for the matched-only stream.

`data/schema/seed_ews_rules.sql` loads the 10 default rules into tenant `BIL` (idempotent via `ON CONFLICT DO NOTHING`).

## Postman quickstart

Import `docs/ews-rules-postman.json` into Postman. Sets a `baseUrl` variable (default `http://localhost:3001`) plus tenant + role headers. Run the requests in order (0–9) for the full lifecycle: list catalog → list rules → create → get → update → test → activate → bulk evaluate → get hits → soft-delete.
