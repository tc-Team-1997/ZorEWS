# regulatory-svc / indicators

Indicator engine for APEX EWS. Owns the catalog (read-only here, seeded by
agent-rule), the compute functions for every catalog id, and the HTTP
service that materialises indicator values for a (customer, snapshot)
pair.

## How the catalog drives compute

The catalog at `catalog.json` is the single source of truth for the 36
indicator ids the prototype supports. Each entry carries:

- `id` (e.g. `FIN-001`) — stable, never mutated.
- `family` — `Financial | Behavioural | Transaction | Credit | Fraud` — the
  Fraud family (FRD-NNN) was added 2026-05-08 per BAC §3.5 to back the
  third alert type (fraud-suspicion).
- `formula_pseudocode` — informal description; the runtime intent.
- `window_days` — rolling-window length.
- `severity_weight` — 0..1, used by `src/severity.ts` to bucket per-indicator
  severity into `low | medium | high | critical`.
- `inputs[]` — mart columns the compute fn consumes.

The compute layer is a pure functional registry:

```
COMPUTE_REGISTRY: { [catalog.id]: ComputeFn }

ComputeFn = (inputs: ComputeInputs) => { value, breached, severity }
```

Implementations live one-file-per-family under `src/compute/`:

- `financial.ts`     — FIN-001 … FIN-008
- `behavioural.ts`   — BEH-001 … BEH-008
- `transaction.ts`   — TXN-001 … TXN-008
- `credit.ts`        — CRD-001 … CRD-008
- `fraud.ts`         — FRD-001 … FRD-004 (BAC §3.5)

`src/compute/index.ts` merges the five sub-registries into `COMPUTE_REGISTRY`.
A registry-completeness gate (`src/catalog.checkRegistryAgainstCatalog`)
runs at boot and as a Jest test — every catalog id must have a compute
fn and there must be no stray keys.

## What gets evaluated in dbt vs at runtime

| Layer    | Indicator ids                                                                             | Why                                                                              |
|----------|-------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------|
| dbt SQL  | TXN-001, FIN-005, FIN-007, CRD-006, CRD-007, BEH-002, BEH-003, TXN-005                    | All inputs already exist in `mart.customer_360 / mart.loan_360 / mart.txn_features` (or stg_loans / stg_repayments). Cheap rolling-window aggregates that fit a single SELECT. Materialised into `mart.indicator_values` so agent-rule can read them with a plain JOIN. |
| Runtime  | The other 22                                                                              | Need columns the dbt mart doesn't yet expose — daily-balance series, IFRS9 prior stage, bureau-score-90d-ago, restructure_requests, etc. Computed on-demand from `MartReader`. |

agent-rule reads `mart.indicator_values` for the dbt subset and calls
`POST /indicators/compute` for the runtime subset. The HTTP route returns
the same shape for both, so callers don't branch on the source.

## HTTP API

| Method | Path                              | Purpose                                                            |
|--------|-----------------------------------|--------------------------------------------------------------------|
| GET    | `/healthz`                        | Liveness + registry status (catalog vs compute_size, missing keys). |
| GET    | `/indicators`                     | Returns the catalog as JSON.                                       |
| POST   | `/indicators/compute`             | Body `{customer_id, snapshot_date}`. Returns one record per catalog id (currently 36). |
| POST   | `/indicators/compute/batch`       | Body `{items: [{customer_id, snapshot_date}, ...]}`. Returns one result per item. |

Breached records are emitted to the configured `IndicatorEventEmitter`;
the default emitter logs the `// emit to apex.indicator.values` marker
that agent-integration replaces with a Kafka producer. The on-the-wire
shape is:

```json
{
  "topic": "apex.indicator.values",
  "key":   "CUST-001|FIN-001",
  "value": {
    "customer_id":   "CUST-001",
    "snapshot_date": "2026-04-26",
    "indicator_id":  "FIN-001",
    "value":         0.42,
    "breached":      true,
    "severity":      "high",
    "ts":            "2026-04-26T08:30:21.001Z"
  }
}
```

## How to add a new indicator

1. **Get an id from agent-rule**, prefixed by family (`FIN-009`, `TXN-009`,
   etc.). Append it to `catalog.json` with `formula_pseudocode`,
   `window_days`, `severity_weight`, and `inputs[]`.
2. **Pick a family file** under `src/compute/` and write the compute fn:

   ```ts
   const FIN_009: ComputeFn = ({ customer, loans, txn, catalogEntry }) => {
     // 1. Read the inputs the catalog specified.
     // 2. Compute a numeric value (or null if inputs missing).
     // 3. Decide breached.
     // 4. Use severityIfBreached(breached, catalogEntry.severity_weight).
     return { value, breached, severity };
   };
   ```
3. **Register it** in the family file's `*_REGISTRY` export.
4. **Type-extend** `MartCustomer360 / MartLoan360 / MartTxnFeatures` in
   `src/types.ts` if you need a new column. Mark optional + `// TODO:
   agent-data follow-up` if the dbt mart doesn't yet expose it.
5. **Write a test** under `__tests__/compute/<family>.test.ts` — one
   positive (breached=true) and one negative (breached=false).
6. **Run `npm test`** — the registry-completeness gate will fail if you
   forgot to register, and the per-indicator test will fail if breach
   semantics are wrong.
7. (Optional) **Materialise in dbt** — if every input is already in mart,
   add a CTE to `data/dbt/models/marts/indicator_values.sql` and update
   the `accepted_values` list in `data/dbt/models/marts/schema.yml`.

## Local dev

```sh
npm install
npm test                # registry + per-family + integration
npm run dev             # starts the service on :8082 with InMemoryMartReader
```

The integration test seeds 50 synthetic customers (25 healthy + 25
stressed) and asserts `compute/batch` produces one indicator row per
catalog id per customer (currently 36) with the expected breach pattern.

## Hand-offs

- **agent-rule** — your rules read `mart.indicator_values` for the 8
  dbt-materialised ids. For the other 22, fetch via `POST /indicators/compute`
  and reduce in-memory.
- **agent-alert** — when consuming `apex.indicator.values`, expect
  `{customer_id, snapshot_date, indicator_id, value, breached, severity, ts}`.
- **agent-data** — the runtime types reference catalog inputs that the
  dbt mart does NOT yet expose. Search `src/types.ts` for `// TODO:
  agent-data follow-up` to see the column wishlist.
- **agent-integration** — wire the Kafka producer into
  `src/engine.IndicatorEventEmitter` + a `pg` client into
  `src/mart/reader.PostgresMartReader.fetchSnapshot`.
