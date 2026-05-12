# Schema registry

JSON Schema (Draft 2020-12) for the five ZorEWS Kafka topics. Compatibility
mode = **BACKWARD** (per FR-INT-3); a new `version` is required on any change
that removes/renames a required field — CI rejects breaking changes.

| Topic | Schema |
|-------|--------|
| `apex.cbs.events`        | `apex.cbs.events.v1.json` |
| `apex.indicator.values`  | `apex.indicator.values.v1.json` |
| `apex.rule.firings`      | `apex.rule.firings.v1.json` (internal — agent-rule → agent-alert) |
| `apex.regulatory.events` | `apex.regulatory.events.v1.json`, `apex.regulatory.events.v2.json` (current) |
| `apex.case.events`       | `apex.case.events.v1.json` |
| `apex.audit.events`      | `apex.audit.events.v1.json` |

`apex.regulatory.events.v2.json` was added by agent-alert to attach the
merged convenience fields (`rule_id`, `indicators_fired`, `pd`,
`risk_level`, `top_reasons`, `reason_summary`, `ts`). Every v1-required
field is still required, so v1 consumers continue to validate (BACKWARD).

Each schema declares `version` and `compatibility` at the top level — these
are read by the `validate-schemas` CI step. In production the same JSON files
are uploaded to AWS Glue Schema Registry (`infra/terraform/30-data/main.tf`
`aws_glue_registry.apex_ews` + `aws_glue_schema.topics`).

## CI gate (T3.8)

`.github/workflows/schema-compat.yml` runs on every PR that touches this
directory:

1. `python infra/schema-registry/scripts/check_compat.py` — exit 1 on any
   BACKWARD break.
2. `pytest infra/schema-registry/tests -q` — 16 tests covering positive
   cases (optional-field add, type widening, enum widening, demoting
   required → optional) and negative cases (required-add, property-removed,
   type-narrowed, enum-removed, additional-properties closed; plus
   recursion into array `items` and nested objects).

Run locally with the project venv:

```
source .venv/bin/activate
python infra/schema-registry/scripts/check_compat.py
pytest infra/schema-registry/tests -q
```

## Adding a new schema version

1. Copy `apex.<topic>.vN.json` → `apex.<topic>.v(N+1).json`.
2. Bump `version` (semver string, e.g. `2.0.0`).
3. Make your changes — additions only, type widening, enum widening, etc.
   The checker enforces the rules listed in
   `scripts/check_compat.py:_check_node`.
4. Run the checker locally; commit; PR. CI gates the merge.
