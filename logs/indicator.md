# logs/indicator.md — indicator agent

> Append entries chronologically. Each entry: task id, files touched, decisions, hand-offs, blockers.

## 2026-04-26 — Initialised

- Log file created. Awaiting first task.

## 2026-04-26 — T1.6 shipped

### Tasks ticked
- T1.6 — Indicator compute service (`mart.indicator_values` + runtime `POST /indicators/compute`).

### Framework choice — TypeScript + Node + Express (mirroring rules-svc)
Same stack as `services/regulatory-svc/rules` so the regulatory-svc family has one toolchain end-to-end. Pure functional compute fns, AJV-free (catalog is read-only — no schema validation here), supertest for the integration test. `package.json` mirrors the rules-svc devDependencies plus `supertest` for HTTP route tests.

### Files created

- `services/regulatory-svc/indicators/package.json` — npm scripts (`build`, `dev`, `test`).
- `services/regulatory-svc/indicators/tsconfig.json` — same compiler settings as rules-svc.
- `services/regulatory-svc/indicators/src/types.ts` — `MartCustomer360`, `MartLoan360`, `MartTxnFeatures`, `RepaymentEntry`, `RestructureRequest`, `ComputeFn`, `ComputeRegistry`, `IndicatorValueRecord`. The mart types are a *superset* — they mirror what the dbt models currently emit *plus* every catalog-required field that's not yet in the mart. Optional fields are tolerated by the runtime; absent columns make the relevant indicator return `value=null`.
- `services/regulatory-svc/indicators/src/severity.ts` — bucketing of catalog `severity_weight` (0..1) into low/medium/high/critical.
- `services/regulatory-svc/indicators/src/catalog.ts` — `loadCatalog`, `catalogIds`, `checkRegistryAgainstCatalog` (registry-completeness gate).
- `services/regulatory-svc/indicators/src/compute/financial.ts` — FIN-001..008.
- `services/regulatory-svc/indicators/src/compute/behavioural.ts` — BEH-001..008.
- `services/regulatory-svc/indicators/src/compute/transaction.ts` — TXN-001..008.
- `services/regulatory-svc/indicators/src/compute/credit.ts` — CRD-001..008.
- `services/regulatory-svc/indicators/src/compute/index.ts` — merges the 4 family registries into `COMPUTE_REGISTRY`.
- `services/regulatory-svc/indicators/src/mart/reader.ts` — `MartReader` interface + `InMemoryMartReader` (used by tests + dev) + `PostgresMartReader` skeleton (throws on use; SQL plan in comments — agent-integration to wire `pg`).
- `services/regulatory-svc/indicators/src/engine.ts` — `IndicatorEngine.evaluate` / `evaluateBatch`. Per-breach emitter is pluggable; default emitter logs the `// emit to apex.indicator.values` marker.
- `services/regulatory-svc/indicators/src/server.ts` — Express app with `GET /healthz`, `GET /indicators` (catalog), `POST /indicators/compute`, `POST /indicators/compute/batch`. `if (require.main === module)` boots on `:8082` after `checkRegistryAgainstCatalog`; refuses to start with non-empty `missing` / `extras`.
- `services/regulatory-svc/indicators/__tests__/fixtures.ts` — `baseCustomer`, `baseLoan`, `baseTxn`, `healthySnapshot`. Healthy fixtures yield 0 breaches across all 30 indicators (asserted by the integration test).
- `services/regulatory-svc/indicators/__tests__/registry.test.ts` — registry-completeness, 30 ids across 4 families.
- `services/regulatory-svc/indicators/__tests__/compute/financial.test.ts` — positive + negative for FIN-001..008.
- `services/regulatory-svc/indicators/__tests__/compute/behavioural.test.ts` — positive + negative for BEH-001..008.
- `services/regulatory-svc/indicators/__tests__/compute/transaction.test.ts` — positive + negative for TXN-001..008.
- `services/regulatory-svc/indicators/__tests__/compute/credit.test.ts` — positive + negative for CRD-001..008.
- `services/regulatory-svc/indicators/__tests__/integration/batch.test.ts` — 50-customer (25 healthy + 25 stressed) `compute/batch` test via supertest. Asserts each customer returns 30 records, healthy=0 breaches, stressed≥5 breaches; checks 404 + 400 + emitter-callback paths.
- `services/regulatory-svc/indicators/README.md` — how the catalog drives compute, dbt-vs-runtime split, how to add a new indicator.
- `data/dbt/models/marts/indicator_values.sql` — long-format dbt table model materialising 8 of 30 ids.
- `data/dbt/models/marts/schema.yml` — appended `indicator_values` model with `not_null` PKs, `accepted_values` for `severity` + the 8 implemented `indicator_id`s, `relationships` from `customer_id` → `customer_360.customer_id`.
- `logs/indicator.md` — this entry.

### Which 8 indicators went into dbt and why

Picks were the cheap rolling-window indicators that work on columns *already* materialised by `mart.customer_360` / `mart.loan_360` / `mart.txn_features` (or `stg_loans` / `stg_repayments` directly). The remaining 22 need columns the marts don't yet expose (daily-balance series, IFRS9 prior stage, restructure_requests JSON, bureau-score-90d-ago, etc.) and stay at runtime.

| Id     | Source columns                                      | Why this one in SQL                                                        |
|--------|-----------------------------------------------------|----------------------------------------------------------------------------|
| TXN-001 | `txn_features.inflow_30d`, `outflow_30d`           | Single division, already aggregated.                                       |
| FIN-005 | `txn_features.inflow_30d`, `outflow_30d`, `customer_360.monthly_income` | Net cashflow ÷ monthly_income (proxy for total_emi until loan_360 exposes emi_amount). |
| FIN-007 | `customer_360.exposure_to_income_ratio`            | Already pre-computed; we just divide by 12 to get loan/annual-income.       |
| CRD-006 | `customer_360.worst_dpd`                           | Direct column read.                                                        |
| CRD-007 | `stg_loans.outstanding_amount`, `collateral_value` | Aggregate sum/sum per customer.                                             |
| BEH-002 | `stg_repayments.is_arrears_payment`, `repayment_date` | Trailing-arrears streak via window function.                                |
| BEH-003 | `stg_repayments.shortfall_amount` last 90d         | Plain count/count ratio.                                                    |
| TXN-005 | `stg_repayments.shortfall_amount = scheduled_amount` last 60d | NSF-bounce proxy until `txn_status` lands on `stg_txns`.                    |

The dbt model encodes the breach predicate inline (one CASE per id) and the severity bucket from the catalog's `severity_weight` so consumers can read `mart.indicator_values` without joining catalog.json. Severity buckets in the SQL match `src/severity.ts`.

### Catalog ids the runtime declares but the mart can't yet feed sensibly

These compute fns return `value=null, breached=false` until agent-data extends the marts. The `src/types.ts` interfaces document each missing field with `// TODO: agent-data follow-up`:

| Id     | Missing column(s)                                                  | Notes                                                                          |
|--------|--------------------------------------------------------------------|--------------------------------------------------------------------------------|
| FIN-001 | `txn_features.daily_balance` (60d series)                          | Need rolling daily-balance series, oldest→newest.                              |
| FIN-002 | `txn_features.eod_balance_30d`, `customer_360.min_op_balance`      | Customer-level minimum operating balance is a contractual field.               |
| FIN-003 | `customer_360.savings_balance`                                     | Sum of liquid savings products per customer.                                   |
| FIN-004 | `txn_features.monthly_income_history` (12mo)                       | Salary-tagged monthly inflow series.                                           |
| FIN-006 | `txn_features.salary_inflow_history` (6mo)                         | Salary-credits per month.                                                      |
| FIN-008 | `customer_360.overdraft_used`, `overdraft_limit`                   | OD product schema.                                                             |
| BEH-001/002/003 | `loan_360.repayment_history` with `days_late`             | dbt currently aggregates repayments — runtime needs the per-payment list. BEH-002/003 have a SQL proxy in dbt but the runtime fn needs the timeline. |
| BEH-004 | `customer_360.channel_logins_30d`, `channel_logins_90d`            | Channel-login counter source (mobile + web).                                   |
| BEH-005 | `customer_360.complaints_60d`                                       | Contact-centre complaint feed.                                                 |
| BEH-006 | `customer_360.kyc_expiry_days`                                      | Days-until-expiry of nearest KYC doc.                                          |
| BEH-007 | `loan_360.restructure_requests`                                     | Customer-initiated restructure events.                                          |
| BEH-008 | `customer_360.contact_failures_30d`                                | Collections contact log roll-up.                                               |
| TXN-002 | `txn_features.rolling_outflow_30d_history` (90d)                   | Rolling 30-day outflow time-series.                                            |
| TXN-003 | `txn_features.outflow_by_channel_30d`                              | Cash vs non-cash split.                                                        |
| TXN-004 | `txn_features.merchant_unique_30d`, `merchant_unique_30_60d`        | Distinct merchant counts.                                                      |
| TXN-006 | `txn_features.inflow_by_source_90d`                                 | Inflow split by source for HHI.                                                |
| TXN-007 | `txn_features.rolling_p2p_outflow_30d_history`                      | Rolling P2P/wallet outflow time-series.                                         |
| TXN-008 | `txn_features.weekend_txn_share_30d`, `weekend_txn_share_30_60d`    | Weekend share roll-ups.                                                        |
| CRD-001 | `customer_360.bureau_score_prior_60d`                               | Snapshot of bureau score from 60 days ago.                                     |
| CRD-002 | `customer_360.bureau_inquiries_90d`                                 | Bureau enquiry counter (a 3-month version exists — needs extending to 90d).    |
| CRD-003 | `customer_360.bureau_external_dpd_max_90d`                          | Max DPD across other lenders.                                                  |
| CRD-004 | `customer_360.bureau_ext_outstanding`, `bureau_ext_outstanding_90d_ago` | External outstanding now + 90d ago.                                            |
| CRD-005 | `loan_360.ifrs9_stage`, `ifrs9_stage_90d_ago`                       | IFRS 9 stage today vs 90d ago.                                                  |
| CRD-008 | `customer_360.guarantor_default_180d`                                | Linked-guarantor default flag.                                                  |

(Note: TXN-005 and CRD-006/007 *are* covered both at runtime and in dbt — runtime uses the same backing data via `MartReader`.)

### Question for agent-rule
- None — catalog ids and inputs are taken as the contract. If any seed rule references an indicator I've flagged above as runtime-only, the rule's runtime evaluation has to fan out via `POST /indicators/compute`; agent-rule's evaluator already does this for non-materialised ids.

### Verification status
- TypeScript code self-validates by inspection. **`npm install` + `npm test` blocked by the sandbox** — same constraint as the other Node services in this repo (rules, alerts, notification, auth). Expected output:
  ```
  cd services/regulatory-svc/indicators && npm install && npm test
  # → registry.test.ts: 3 passed
  # → financial.test.ts: 16 passed
  # → behavioural.test.ts: 16 passed
  # → transaction.test.ts: 16 passed
  # → credit.test.ts: 16 passed
  # → integration/batch.test.ts: 7 passed
  # 74 total passing
  ```
- dbt model **not parsed** here — sandbox blocks `dbt`. Run:
  ```
  cd data/dbt && dbt deps && dbt parse
  ```
  to confirm the new `indicator_values` model + `schema.yml` entry. Expected output: `Found 1 model … No issues.` plus the existing models.

### Hand-offs

- **agent-rule** — your rules read `mart.indicator_values` for the 8 dbt-materialised ids (TXN-001, FIN-005, FIN-007, CRD-006, CRD-007, BEH-002, BEH-003, TXN-005). For catalog ids handled at runtime, fetch via `POST /indicators/compute` (single) or `POST /indicators/compute/batch` (list). Body shape: `{customer_id, snapshot_date}` → response `{values: [{indicator_id, value, breached, severity, ...}], breached: [...], not_found: false}`.
- **agent-alert** — when consuming `apex.indicator.values`, expect `{customer_id, snapshot_date, indicator_id, value, breached, severity, ts}`. Only `breached=true` records are emitted (the engine filters before calling the emitter). Severity has been pre-bucketed from catalog `severity_weight`; do your final merge against rule severity in the alert producer.
- **agent-data** — added `indicator_values` model + tests to `data/dbt/models/marts/schema.yml`. Re-run `dbt parse` to confirm. Also: the runtime types in `src/types.ts` carry a wishlist of catalog-required columns the marts don't yet expose (search `// TODO: agent-data follow-up`). When you extend the marts, the runtime fns will start producing real values without code change — they already tolerate `undefined`.
- **agent-integration** — wire the Kafka producer into `IndicatorEventEmitter` in `src/engine.ts` (replace `defaultEmitter`'s `console.log`). Also bind `pg` into `PostgresMartReader.fetchSnapshot` — the SQL plan is in the file as a TODO comment. Service runs on `:8082`.

### Blockers
- **Sandbox blocks `npm install`, `npm test`, and `dbt parse`** — same B1 as the other Node services. The user should run the commands listed under *Verification status* in a network-enabled shell.
- **22 of the 30 catalog indicators have no real source columns yet.** They compile, type-check, return `value=null, breached=false` against today's mart. Agent-data extension closes the gap; nothing in the runtime needs to change.

### Definition-of-Done check
- ✅ Every catalog id has a registered compute function (`registry.test.ts` enforces it; `checkRegistryAgainstCatalog` runs at server boot too).
- ✅ dbt model `indicator_values` written; **parses** unverified (sandbox).
- ✅ schema.yml validates by inspection — single new model, columns + tests use only built-in dbt + dbt_utils tests, no overlapping model names.
- ✅ Jest tests assert: registry-completeness (3), per-indicator positive + negative across 4 families (64 cases), batch endpoint behaviour (7).

## 2026-05-14 — T6 M4.8 — Indicator backtest result comparison

### Tasks ticked
- T6 sub-phase M4.8 — backtest result comparison. T6 sub-phase tally 108 → 109.

### Files touched
- `services/bff/src/indicator_backtest_compare.ts` (new) — pure `compareBacktestResults(a, b)` returns `BacktestCompareResult` with `identical`, `same_indicator`, `same_segment`, signed `fires_delta` + `precision_delta` + `recall_delta` + `f1_delta` + `mean_value_delta`, per-cell `confusion_delta` (TP/FP/FN/TN), `per_day_fires_delta[]` aligned over overlapping days, and `a_only_days[]` / `b_only_days[]` for the symmetric difference of day sets. Direction convention: every delta is b - a (positive = candidate stronger than baseline). Also exports `compareFromUnknown(input)` as the route-level entry point that validates the two BacktestResult shapes (presence of indicator_id / confusion / metrics / daily) before delegating to the pure comparator.
- `services/bff/__tests__/indicator_backtest_compare.test.ts` (new) — 21 jest tests: 1 identical-pair, 4 fires/metrics/confusion/mean_value deltas, 3 per-day alignment (overlap → deltas; only-one-side → *_only_days; sort order), 2 warning bools (different indicator, different segment), 6 validation (non-object, missing a, missing b, missing indicator_id, missing confusion, well-formed delegates), 5 route (200 happy + envelope, mismatched indicators still 200 with warning bool, 400 bad shape, 403 wrong role, cross-tenant header still works since no per-tenant state).
- `services/bff/src/server.ts` — import `BacktestCompareError` + `compareFromUnknown`; new route `POST /v1/indicators/backtest/compare` mounted right after the existing `/v1/indicators/backtest` route. `customers:read_risk_profile` RBAC. Pure compute — no `tenant_id` involved in the body or response.

### Decisions
- **Caller-supplies-both-results, not server-runs-both.** Keeps M4.8 a pure-function endpoint. Caller already ran the backtests via `/v1/indicators/backtest` to inspect each individually; passing the resolved results back is a tiny payload and avoids re-running the engine twice. Also lets analysts compare results from different timestamps.
- **All deltas b - a.** Single direction convention; "positive = candidate improved on baseline" is the natural reading for the threshold-tuning use case.
- **`same_indicator` / `same_segment` are bools, not errors.** Comparing two backtests of different indicators is a real (if rare) need ("would FIN-002 be a better gate than FIN-001 for this rule?"). Warning bool lets the SPA show a label without blocking the comparison.
- **`per_day_fires_delta` over overlap only.** Days only on one side surface as `a_only_days` / `b_only_days` to keep the delta list interpretable. Don't fake a `delta` against an implicit zero — would mislead a reader.

### Hand-offs
- **agent-ui** — threshold-tuning workflow: SPA runs `/v1/indicators/backtest` twice with different threshold params, posts both results to `/v1/indicators/backtest/compare`, renders the delta panel (fires shift, precision/recall trade-off, per-day fires bar with delta colors). The `same_indicator: false` warning surfaces inline with a "comparing different indicators" badge.

### Verification
- `npx jest __tests__/indicator_backtest_compare.test.ts` — 21/21 pass.
- `npx jest` (full BFF suite) — 4213 pass / 58 skipped / 4272 total. Intermittent cross-suite singleton flakiness in `alert_auto_ack` (passes 45/45 alone); pre-existing pattern unrelated to M4.8.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M4.9 — Indicator threshold effective view

### Tasks ticked
- T6 sub-phase M4.9 — indicator threshold effective view. T6 sub-phase tally 125 → 126.

### Files touched
- `services/bff/src/indicator_threshold_effective.ts` (new) — pure `resolveEffectiveThresholds(store, tenant_id, vertical?)` walks every platform indicator (optionally filtered by vertical via `listThresholds({vertical})`), looks up the M4.4 tenant override via `store.getOverride`, and emits per-entry `{indicator_id, name, vertical, source: 'library_default'|'tenant_override', effective, library_default, override}` — keeping both levels visible side-by-side so the SPA can render "was X, now Y" without a second round-trip. Totals `{override_count, library_count, total}`. Sorted by `indicator_id` asc for deterministic output.
- `services/bff/__tests__/indicator_threshold_effective.test.ts` (new) — 16 jest tests: 2 no-overrides (everything library_default + entries sorted by indicator_id asc), 3 override resolution (source flips, count split, deletion reverts), 3 vertical filter (banking, insurance, invalid throws), 1 tenant isolation, 7 route (200 happy with all library_default, override surface, ?vertical=banking narrow, ?vertical=invalid → 400, 403 wrong role, cross-tenant invisibility, M4.4 PUT regression).
- `services/bff/src/server.ts` — new route `GET /v1/indicators/thresholds/effective?vertical=banking|insurance` mounted BEFORE the catch-all `/:indicator_id` so the literal `/effective` segment isn't captured. `audit:read` RBAC. Validates `?vertical` is one of `banking|insurance` → 400 otherwise. `vertical` undefined / empty string falls through as "no filter".

### Decisions
- **Mirror M10.10's resolution-chain shape.** Same `source` enum naming convention (`library_default` / `tenant_override` here; `platform_default` / `tenant_default` / `user_override` on M10.10). Both levels surface side-by-side so operators see "was → now" at a glance.
- **Per-indicator entries always present.** Even when no override, the entry shows `source: 'library_default'` + `override: null` rather than just listing overrides. Lets the SPA render a complete-tenant view from a single call.
- **Sorted by `indicator_id` asc.** Deterministic output matters for the SPA "compare two tenants" view; same ordering both sides simplifies the diff.
- **Vertical filter via `listThresholds({vertical})`.** Reuses the existing M4.3 helper; route validates the enum value before delegating.
- **No new store method.** The existing `getOverride` + `listThresholds` cover the read paths; no need to extend the interface.

### Hand-offs
- **agent-ui** — indicator config page can render a per-tenant "Effective thresholds" table: every indicator on one row, library defaults in greyed columns, overrides in highlighted columns, source badge ("default" vs "overridden"). Pair with M4.3 PUT to flip an override in-place. The `vertical` filter drives the existing tab UI.

### Verification
- `npx jest __tests__/indicator_threshold_effective.test.ts` — 16/16 pass.
- `npx jest` (full BFF suite) — 4496 pass / 58 skipped / 4554 total, **zero failures**.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M4.10 — Indicator threshold auto-tune suggestion

**Goal.** Derive red/orange/yellow thresholds from observed historical values via percentile — lets tenants bootstrap their M4.4 overrides from real data instead of hand-picking numbers. Fresh shape this session: percentile-based suggestion with polarity awareness.

### Files

- **NEW** `services/bff/src/threshold_auto_tune.ts` — pure `suggestThresholdsFromHistory(values, polarity)`. Drops non-finite values; refuses with `suggested=null + insufficient_reason` when < 5 finite samples. Polarity 'higher_is_worse' (default; DPD/repeat-claim/drift): red=p95, orange=p75, yellow=p50. Polarity 'lower_is_worse' (customer health, AUC-like): red=p5, orange=p25, yellow=p50. Uses M3.5 `linearPercentile`.
- **NEW** `services/bff/__tests__/threshold_auto_tune.test.ts` — 18 tests (10 pure + 8 route) covering empty input, insufficient samples (5-sample floor), all-NaN, polarity validation, uniform [0,1] for both polarities, skewed-distribution sanity check, default polarity, 404 unknown_indicator, validation 400s, 403.
- **EDIT** `services/bff/src/server.ts` — mounted `POST /v1/indicators/thresholds/:indicator_id/suggest` (customers:read_risk_profile) BEFORE the catch-all `/:indicator_id` GET so the literal `/suggest` segment wins. 404 maps `getThreshold(id) === null`.

### Design notes

- 5-sample floor: percentile estimation on tiny samples is noise. Refusing with `insufficient_reason='too_few_samples'` is more useful than emitting a misleading suggestion. Returning 200 (not 400) so the SPA can render "collect more data" instead of an error toast.
- Polarity is metric-aware: for "higher-is-worse" signals (DPD, drift_score) the worst tail of the distribution defines red. For "lower-is-worse" signals (customer health score) the bottom tail defines red. Tested explicitly that lower_is_worse produces inverted ordering (red < orange < yellow).
- Non-finite filter drops NaN + Infinity defensively — the backtest mart can emit infinities under degenerate cohorts.

### Verification
- `npx jest __tests__/threshold_auto_tune.test.ts` — 18/18 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **140 → 141**.

## 2026-05-14 — T6 M4.11 — Indicator usage / orphan detection

**Goal.** Reverse cross-reference for the indicator catalog. M5.14 walks templates → supporting_indicators; M4.11 walks indicators → which templates reference me. Surfaces dead config (orphan indicators with no references AND no threshold are cleanup candidates).

### Files

- **NEW** `services/bff/src/indicator_usage_map.ts` — pure `mapIndicatorUsage(catalog, templates)`. Builds reverse-index by iterating templates × indicator-ids. Per-indicator emits referenced_by_templates[] sorted asc + reference_count + has_threshold (from M4.3 getThreshold lookup) + vertical_matches per template. Envelope adds orphaned_count, most_referenced top-5, by_vertical counts.
- **NEW** `services/bff/__tests__/indicator_usage_map.test.ts` — 12 tests (9 pure + 3 route): empty templates → all orphaned, single reference, vertical mismatch, vertical=both accepts-either, multi-template + orphan invariant, top-5 sort order, by_vertical counts, references sorted by template_id, default-registries integration, admin happy, 403, platform-static.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/indicators/usage` (audit:read) right ABOVE `/v1/indicators/thresholds` so the literal `/usage` segment wins.

### Design notes

- M5.14 + M4.11 form a complete bi-directional reference graph: forward = "which indicators does this template need?" + reverse = "which templates reference this indicator?". Together they catch drift in either direction.
- `vertical_matches` per template-reference: if a banking template references an insurance indicator (mismatch), the reference still surfaces (because the relationship exists) but the boolean flags the SPA can render it warning-yellow.
- `has_threshold` flag distinguishes "orphan indicator with no consumer AND no threshold" (full dead config) from "orphan indicator with threshold but no rule" (used for ad-hoc breach checks). The former is the stronger cleanup candidate.
- audit:read RBAC for consistency with M5.14 + the rest of the catalog introspection family.

### Verification
- `npx jest __tests__/indicator_usage_map.test.ts` — 12/12 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **150 → 151**.
