# APEX EWS — Database Gap Analysis

**Original generated:** 2026-05-03
**Last updated:** 2026-05-03 (T4.13–T4.18 all live; **all 5 original gaps closed**; final cleanup of dead state dirs + Gap 4 clarification done)
**Scope:** What's actually persisted in Postgres vs. what should be, and the fix plan for each remaining gap.

This document is the result of a live inventory of the running `apex-ews-pg` Postgres container against the codebase's schema definitions and service code paths. Each gap below is paired with an honest "is this a problem?" verdict and a sized fix.

> **Update 2026-05-03 (final):** all 5 original gaps closed across six sessions. **Gap 1 closed**, **Gap 2 closed (T4.16)**, **Gap 3 closed (T4.13–T4.18 — all 5 services now persist to Postgres)**, **Gap 4 closed (dead state dir removed; outbox dirs intentionally kept as fake-Kafka event bus — see clarification below)**, **Gap 5 closed**.

---

## TL;DR — Verdict Per Layer (post-2026-05-03 remediation)

| Schema | Tables | Live row count | Status | Verdict |
|---|---|---|---|---|
| `raw.seed_*` | 5 (seed_customers, seed_loans, seed_repayments, seed_transactions, seed_bureau_score) | 10,000 / 24,000 / 247,550 / 289,819 / 10,000 | 🟢 working | Scaled up 45× from prior 220-customer seed; sources.yml now references seed_* directly (no aliasing) |
| `staging.stg_*` | 5 (stg_customer, stg_loans, stg_repayments, stg_txns, stg_bureau_score) | views (no storage) | 🟢 working | Read-on-query; rebuilt mart proves they compute correctly |
| `mart.*` | 4 (customer_360, loan_360, txn_features, indicator_values) | 10,000 / 24,000 / 10,000 / 80,000 | 🟢 working | Mart rebuilt against the 10k-customer seed; 79/79 dbt tests pass |
| `audit.event_log` | 1 | **3+** (auth-svc fans every event out — T4.16 shipped) | 🟢 **CLOSED** — chain works AND auth-svc writes; cases/alerts can adopt the same `AuditEventLogClient` | Gap 2 closed 2026-05-03 |
| `app_iam.*` | 4 (users, sessions, password_history, audit_events) | 505 / 3,105 / 1,445 / 12,000 | 🟢 schema + synthetic data + **service wired (T4.14 shipped 2026-05-03)** | auth-svc users/sessions/password-history/audit-events read/write live |
| `app_cases.*` | 2 (cases, actions) | 528 / 1,568 | 🟢 schema + synthetic data + **service wired (T4.15 shipped 2026-05-03)** | regulatory-svc/cases reads/writes live |
| `app_alerts.*` | 2 (alerts, queue_assignments) | 2,527 / 3,431 | 🟢 schema + synthetic data + **service wired (T4.17 shipped 2026-05-03)** | regulatory-svc/alerts reads/writes live |
| `app_bff.*` | 2 (webhook_subscriptions, webhook_deliveries) | 25 / 915 | 🟢 schema + synthetic data + **service wired (T4.13 shipped 2026-05-03)** | bff webhooks read/write live |
| `app_scenario.*` | 1 (saved_scenarios) | 120 | 🟢 schema + synthetic data + **service wired (T4.18 shipped 2026-05-03)** | BFF /v1/scenarios reads/writes live; SPA writes through with localStorage cache |

**One-line summary:** the database now looks complete in DBeaver — ~731,500 rows across 9 schemas / 26 tables. The remaining work is **wiring services to read/write the new `app_*` tables instead of in-memory stores** — that's per-service code work scheduled for follow-up sessions.

---

## ✅ Gap 1 — CLOSED 2026-05-03 — `raw.cbs_*` tables removed; sources.yml uses `seed_*` directly

### What was wrong

`002_raw_tables.sql` defined 5 detailed CDC-shaped `raw.cbs_*` tables. None of them was ever written to (no CBS loader exists in the prototype). Data lived in `raw.seed_*` tables loaded by `dbt seed`. The pipeline appeared to work because `data/dbt/models/sources.yml` had `identifier:` aliases (`cbs_customer_profile → seed_customers` etc.) — anyone reading the SQL was misled.

### What changed

- **Dropped** the 5 empty `raw.cbs_*` tables: `DROP TABLE IF EXISTS raw.cbs_customer_profile;` and 4 siblings.
- **Rewrote** [`data/schema/002_raw_tables.sql`](../data/schema/002_raw_tables.sql) — now declares only the `seed_*` tables that actually carry data; original `cbs_*` schemas preserved in git history for reinstatement when T1.4b ships the real CBS ingest loader.
- **Cleaned up** [`data/dbt/models/sources.yml`](../data/dbt/models/sources.yml) — dropped all 5 `identifier:` aliases; sources now reference `seed_*` directly. Mechanical rename across the 5 staging models (`{{ source('raw', 'seed_customers') }}` etc.).
- Verified: `dbt run` + `dbt test` green; 79/79 tests pass.

**Reinstatement plan when T1.4b ships:** add a `005_cbs_raw_tables.sql` restoring the original CDC-shaped tables, and add `identifier: cbs_customer_profile` (etc.) to each source in `sources.yml` to flip the pipeline back without touching the staging SQL.

---

## 🟡 Gap 2 — PARTIAL — `audit.event_log` is built but unused

### Status update

**Unchanged since the original audit.** The Postgres `audit.event_log` table + hash-chain triggers still work correctly (verified by `make verify`'s smoke test → the table has 4 rows, all from the smoke). **No service writes to it yet.**

What did change:

- The new [`app_iam.audit_events`](database-schema.md#app_iamaudit_events) table now holds 12,000 synthetic rows representing what `services/auth-svc`'s in-memory `AuthAuditLog` would write. This is a service-local mirror — production architecture is **both** tables in sync (service-local for fast SPA queries; `audit.event_log` for the regulatory hash-chained trail).

### Why this remains a gap

NFR-AUDIT requires a 7-year hash-chained trail. That requirement is met by `audit.event_log` only when services actually call `INSERT INTO audit.event_log (event_type, actor, subject_id, payload) VALUES (…)` on every operator action. Currently no service does.

### Fix — staged (still open)

**Quick win (1 hour):** wire `services/auth-svc` to also write its 16 events to `audit.event_log` in addition to `app_iam.audit_events`.

- Add `services/auth-svc/src/audit_pg.ts` that opens a pg connection (env-var `AUTH_SVC_PG_URL`) and inserts on every event the in-memory log already records.
- Keep the in-memory ring buffer for the SPA's `/admin/audit-log` page (it's faster); Postgres is the durable audit trail.
- Skip the write when `AUTH_SVC_PG_URL` is unset (current dev mode without `make up`).

**Medium (1 day):** repeat the pattern for `regulatory-svc/cases` (every state transition + action log) and `regulatory-svc/alerts` (every assignment / ack / close).

**Structural (1 week):** introduce a shared `@apex-ews/audit` library so auth, cases, alerts, bff, collection-adapter all write through one client. Compile-time enum of `event_type` values keeps them consistent across services.

---

## 🟡 Gap 3 — PARTIAL — Operational data has Postgres tables but services don't read/write them yet

### Status update

**The schemas + synthetic data now exist** ([`004_app_schemas.sql`](../data/schema/004_app_schemas.sql) + [`_generate_app_seeds.py`](../data/schema/_generate_app_seeds.py)). DBeaver shows everything alive. Per-table counts in [database-schema.md](database-schema.md#live-row-counts-2026-05-03).

**What's still missing:** the live read/write paths. Each service has an in-memory store + matching Postgres table; the connecting code is the next session's work.

### Per-service wiring backlog (sized)

| Service | In-memory store(s) | Target table(s) | Effort | Status |
|---|---|---|---|---|
| `services/bff` (webhooks) | `WebhookSubscriptionStore`, delivery ring buffer | `app_bff.webhook_subscriptions`, `app_bff.webhook_deliveries` | **2 hours** (webhooks are admin-managed; low write volume) | ✅ **shipped 2026-05-03 (T4.13)** |
| `services/auth-svc` | ~~`DEMO_USERS`, `SessionStore`, `password_history`, `AuthAuditLog`~~, `CaptchaStore`, `FailureCounter`, `RateLimiter` | `app_iam.users`, `sessions`, `password_history`, `audit_events` (Captcha + FailureCounter + RateLimiter stay loose; Redis-bound in production) | shipped | ✅ **shipped 2026-05-03 (T4.14)** |
| `services/regulatory-svc/cases` | ~~`CaseStore`~~ + state machine | `app_cases.cases`, `app_cases.actions` | shipped | ✅ **shipped 2026-05-03 (T4.15)** |
| auth-svc audit fan-out | ~~(in-memory)~~ | `audit.event_log` (closes Gap 2) | shipped | ✅ **shipped 2026-05-03 (T4.16)** |
| `services/regulatory-svc/alerts` | ~~SmartQueue + assignment map~~ | `app_alerts.alerts`, `app_alerts.queue_assignments` | shipped | ✅ **shipped 2026-05-03 (T4.17)** |
| `services/bff` (scenario) | ~~none server-side; localStorage in browser~~ | `app_scenario.saved_scenarios` | shipped | ✅ **shipped 2026-05-03 (T4.18)** |

Total remaining: **0 hours** — all 5 services wired through T4.18.

### Service-wiring history

1. ~~**bff webhooks**~~ ✅ shipped 2026-05-03 (T4.13) — webhook secrets now survive BFF restart.
2. ~~**auth-svc users + sessions + password-history + audit-events**~~ ✅ shipped 2026-05-03 (T4.14) — sessions + lock state + audit events survive auth-svc restart; demo accounts seed idempotently on first init.
3. ~~**cases**~~ ✅ shipped 2026-05-03 (T4.15) — case state-machine transitions + append-only action log persist across restart.
4. ~~**auth-svc audit fan-out → `audit.event_log`**~~ ✅ shipped 2026-05-03 (T4.16) — every auth event also lands in the hash-chained regulatory trail; closes Gap 2.
5. ~~**alerts**~~ ✅ shipped 2026-05-03 (T4.17) — alert queue (3 buckets, FIFO, round-robin assignment) + assignment audit log persist across restart.
6. ~~**scenario**~~ ✅ shipped 2026-05-03 (T4.18) — saved scenarios persist via `/v1/scenarios`; SPA write-through cache keeps offline experience intact and provides instant first-render.

### T4.13–T4.18 implementation notes (for any future service to crib from)

The pattern that worked for webhooks (T4.13), auth-svc users/sessions/audit (T4.14), cases (T4.15), audit fan-out (T4.16), alerts (T4.17), and scenarios (T4.18) generalises to any in-memory service:

1. **Cache-on-init + sync reads + write-through fire-and-forget pg writes.** Reads stay sync so the dispatcher / route handlers don't need to await on every event. Writes update the cache synchronously and queue a pg `INSERT/UPDATE/DELETE` via `void this.pool.query(...).catch(logger)`. If the pg write fails, cache + DB diverge until the next service restart, when init() rebuilds from DB.
2. **Env-driven factory** — set `<SERVICE>_PG_URL` → pg store; unset → existing in-memory implementation. CI stays hermetic; dev-without-Docker still works.
3. **Shared interface alias** so the consumers take either implementation: `export type IWebhookStore = WebhookSubscriptionStore | PgWebhookSubscriptionStore`.
4. **Two test suites**: existing in-memory tests stay; new `*_pg.test.ts` is `describe.skip` (jest) or `{ skip }` (node:test) unless the env var is set. Reset via `TRUNCATE … RESTART IDENTITY CASCADE` in `beforeEach` / per-test setup.
5. **Bootstrap async**: server entry becomes `void (async () => { const store = await makeStore(); ... app.listen(port); })()` — surfaces pg connectivity failures at boot, not on first request.

**T4.14-specific gotchas** (worth knowing for the next services):
- **Idempotent seed.** PgUserStore uses `INSERT … ON CONFLICT (user_id) DO NOTHING` for the demo accounts inside `seedIfEmpty()`. Re-running `init()` against a populated table is a no-op.
- **Schema vs. cache type drift.** `app_iam.users.lockout_until` is `TIMESTAMPTZ`; the in-memory `User.lockout_until_ms` is epoch-ms. Conversion lives in `init()` (Date → ms) and `persistLockState()` (ms → Date). Same pattern in PgSessionStore for `issued_at`/`last_seen_at`.
- **INET coercion.** `app_iam.sessions.ip` and `app_iam.audit_events.ip` are `INET`. Fastify can return `req.ip === "unknown"` when the transport doesn't expose one — `ipForPg()` strips that to NULL so pg doesn't reject the row. Worth keeping in any service that takes raw IP strings.
- **Concurrent UPDATE races.** Fire-and-forget UPDATEs to the same row from a synchronous loop will race on a small connection pool — the cache stays correct but pg sees a non-deterministic final value. In production this is fine (real callers space requests by network round-trip + argon2 verify ~50-100ms); in tests, add a small `setTimeout` between calls to mirror real spacing.
- **Schema mirror only for the durable stores.** `CaptchaStore`, `FailureCounter`, `RateLimiter` stay in-memory — they're Redis-bound in production architecture, not Postgres-bound, and the prototype is fine letting them reset on restart.

**T4.15-specific gotchas:**
- **Schema fields the in-memory model doesn't carry.** `app_cases.cases.customer_name` and `rule_name` are NOT NULL but the in-memory `Case` only has `customer_id` and `rule_id`. PgCaseStore inserts empty strings; production would resolve via `mart.customer_360` and the rules service before persisting. Same trick may apply to `app_alerts.*` (T4.17) — check before deciding whether to widen the in-memory type or just default in the pg layer.
- **Append-only child rows.** Actions are persisted as separate rows on every `upsert()`, but only the *new* ones (computed by diffing against a `Set<action_id>` populated on init + every upsert). This avoids inserting the same action twice on subsequent state transitions that touch the same case. Same pattern fits any service with a parent + append-only child.
- **`sla_status` derivation.** Schema requires it but the in-memory model has no SLA tracking. Defaults to `'on_track'` and flips to `'closed'` on terminal state — good enough for the prototype's reporting; production would back-fill from a real SLA calculation.
- **GPS column split.** Nested `gps: { lat, lng, accuracy_m }` becomes three NUMERIC columns. `pg` returns NUMERIC as `string` by default — the `init()` rebuild casts back to `Number()` to keep the in-memory shape stable.

**T4.16-specific gotchas (audit.event_log fan-out):**
- **Hash chain forces serialisation.** The `audit.fn_event_log_chain` trigger reads the previous row's `event_hash` and uses it as the new row's `prev_hash`. Two concurrent INSERTs both read the SAME `last_hash`, then the second one will trip "chain broken: expected prev_hash=X, got=Y". `AuditEventLogClient` solves this with an in-process Promise queue (`this.chain = this.chain.then(insert)`) — INSERTs serialise *within* a process. Cross-process serialisation would need `LOCK TABLE audit.event_log IN EXCLUSIVE MODE`, but auth-svc is single-process so the queue is enough.
- **Trigger fills hash columns.** Pass `prev_hash` and `event_hash` as `NULL` — the trigger computes them. Trying to compute hashes in app code would fragment the source-of-truth and risk drift with the trigger's canonical-string format.
- **TRUNCATE is allowed for tests.** The `trg_event_log_no_update` and `trg_event_log_no_delete` triggers are `BEFORE … FOR EACH ROW`, so they don't fire on TRUNCATE (statement-level). Test setup can `TRUNCATE audit.event_log RESTART IDENTITY` to reset the chain to genesis.
- **NOT NULL `actor`.** Anonymous endpoints (`password_reset_request_unknown`) have no `actor_username`. The mapping helper (`authEventToChain`) coerces `null` actor to the literal string `"anonymous"` so the INSERT doesn't fail the NOT NULL constraint.
- **Cross-reference payload fields.** Every chain row carries `payload._service` (the producing service) and `payload._local_event_id` (back-reference to the service-local table — `app_iam.audit_events.id` in this case). Useful for "find this auth event in both tables" diagnostics. Cases/alerts should follow the same convention so the chain is self-describing.

**T4.17-specific gotchas (alerts queue):**
- **Schema status is 3-valued; in-memory state is 4-valued.** `app_alerts.alerts.status` is `'open' | 'acked' | 'closed'`, but the in-memory `QueueState` is `'queued' | 'assigned' | 'acked' | 'closed'`. Both `queued` and `assigned` collapse to `'open'`; the `assignee` column distinguishes them. `init()` reverses the mapping (`status='open' AND assignee NOT NULL → 'assigned'`). Any future schema change should consider expanding the status enum to 4 values OR keeping the 3-value compromise — both work, but only one source-of-truth at a time.
- **Bucket order rebuilt from `created_at ASC`.** The in-memory queue has explicit FIFO arrays per bucket; pg has no such ordering structure beyond the `created_at` column. `init()` orders by `created_at ASC` and pushes into the bucket array — preserves both bucket assignment AND FIFO order. Any new alert via `enqueue()` is `created_at = NOW()` so it goes to the end of its bucket array, matching the in-memory behaviour.
- **Append-only assignment log.** `app_alerts.queue_assignments` gets one row per `enqueue()` (the initial `assigned_to=NULL, assigned_by='system'`) AND one row per `assign()`. Useful for replaying the alert's queue history for ops debugging. NOT loaded into the in-memory cache — the cache only needs current state, not history.
- **Schema fields the in-memory CanonicalAlert doesn't carry.** `customer_name`, `rule_name`, `confidence`, `customer_exposure_kes`, `criticality_score` are all NOT NULL but the canonical alert only has IDs + scoring. PgSmartQueue inserts empty strings + 0s; production would either widen `CanonicalAlert` or have the BFF compute these fields and UPDATE before the SPA reads. Same trick as T4.15 cases.

**T4.18-specific gotchas (scenarios — BFF + SPA):**
- **Client-supplied id pattern.** The SPA generates `s-{ts}-{rand}` locally and passes it in the POST body so its localStorage cache and the BFF's row stay in lock-step. Avoids the "two entries for the same scenario" reconciliation problem when the server assigns a different id than the cache placeholder. PgScenarioStore + InMemoryScenarioStore both honour `input.id` if provided, fall back to a server-generated id otherwise — same trick fits any future write-through cache.
- **Write-through cache, sync contract preserved.** `web/src/lib/savedScenarios.ts` stays SYNC (`saveScenario(...)` returns a `SavedScenario` immediately) so existing SPA tests don't need rewriting. The API call fires fire-and-forget AFTER the cache write. Trade-off: a save that fails on the API but succeeds locally won't surface an error to the user — the next `refreshSavedFromApi()` mount-time merge will reveal the divergence. Acceptable for prototype scope; production could add a background retry queue.
- **Refresh MERGEs (not overwrites) on mount.** API is authoritative for any id it returns; cache-only entries (in-flight saves whose POST hasn't landed, or saves from before the API was wired) are kept. Without this, mounting before the fire-and-forget POST completes would wipe the user's just-saved scenario. The merge sorts by `saved_at DESC` so the UI ordering stays stable.
- **MSW handlers needed even for unrelated tests.** Because every save fires the API in the background, ANY SPA test that calls `saveScenario()` indirectly hits `/v1/scenarios`. Without an MSW handler, MSW's `onUnhandledRequest: 'error'` config crashes the test. Module-level mock state (`mswScenarios` Map) reset in `setup.ts` afterEach via `__resetMswSavedScenarios()` — same pattern that any future write-through SPA module should follow.

Reference files:
- T4.13: [`services/bff/src/webhooks/pg_store.ts`](../services/bff/src/webhooks/pg_store.ts), [`services/bff/src/webhooks/store.ts`](../services/bff/src/webhooks/store.ts), [`services/bff/__tests__/webhooks_pg.test.ts`](../services/bff/__tests__/webhooks_pg.test.ts)
- T4.14: [`services/auth-svc/src/pg_user_store.ts`](../services/auth-svc/src/pg_user_store.ts), [`services/auth-svc/src/pg_session_store.ts`](../services/auth-svc/src/pg_session_store.ts), [`services/auth-svc/src/pg_audit_log.ts`](../services/auth-svc/src/pg_audit_log.ts), [`services/auth-svc/src/auth_state.ts`](../services/auth-svc/src/auth_state.ts), [`services/auth-svc/src/__tests__/pg_stores.test.ts`](../services/auth-svc/src/__tests__/pg_stores.test.ts)
- T4.15: [`services/regulatory-svc/cases/src/pg_store.ts`](../services/regulatory-svc/cases/src/pg_store.ts), [`services/regulatory-svc/cases/src/store.ts`](../services/regulatory-svc/cases/src/store.ts), [`services/regulatory-svc/cases/__tests__/cases_pg.test.ts`](../services/regulatory-svc/cases/__tests__/cases_pg.test.ts)
- T4.16: [`services/auth-svc/src/audit_event_log.ts`](../services/auth-svc/src/audit_event_log.ts) (chain client + mapping helper), [`services/auth-svc/src/pg_audit_log.ts`](../services/auth-svc/src/pg_audit_log.ts) (`append()` now fans out), [`services/auth-svc/src/__tests__/audit_event_log.test.ts`](../services/auth-svc/src/__tests__/audit_event_log.test.ts)
- T4.17: [`services/regulatory-svc/alerts/src/pg_queue.ts`](../services/regulatory-svc/alerts/src/pg_queue.ts), [`services/regulatory-svc/alerts/src/queue.ts`](../services/regulatory-svc/alerts/src/queue.ts) (factory + IQueue alias), [`services/regulatory-svc/alerts/__tests__/alerts_pg.test.ts`](../services/regulatory-svc/alerts/__tests__/alerts_pg.test.ts)
- T4.18: [`services/bff/src/scenario/store.ts`](../services/bff/src/scenario/store.ts) (PgScenarioStore + InMemoryScenarioStore + factory), [`services/bff/__tests__/scenarios_store.test.ts`](../services/bff/__tests__/scenarios_store.test.ts), [`web/src/lib/savedScenarios.ts`](../web/src/lib/savedScenarios.ts) (SPA write-through cache)

---

## ✅ Gap 4 — CLOSED 2026-05-03 — NDJSON state dirs removed; outbox dirs kept (correctly)

The original Gap 4 text conflated two different layers — clarifying here so future readers don't repeat the confusion:

**Layer 1: in-memory STATE persistence** (NDJSON tail-files at `services/regulatory-svc/cases/.store/cases.ndjson` and `services/regulatory-svc/alerts/.queue/queue.ndjson`). These are the *backup* the in-memory `CaseStore` and `SmartQueue` write to before T4.15 / T4.17 wired the pg backend. Now redundant when `CASES_PG_URL` / `ALERTS_PG_URL` are set. The empty `.store` directory has been removed; the in-memory codepath still creates them on cold-boot if no DSN is set, which is fine for hermetic tests.

**Layer 2: fake-Kafka EVENT BUS** (NDJSON files at `services/*/.outbox/apex.*.events-{date}.ndjson`). These are the prototype's stand-in for Kafka — `OutboxProducer` writes one row per emitted event so other services (alerts → cases, cases → BFF) can consume the same envelope they would in production. **Not redundant.** Postgres replaces the per-service in-memory STATE, not the cross-service event bus. The `.outbox/` directories stay.

Cleanup actions performed 2026-05-03:
- Removed empty `services/regulatory-svc/cases/.store/` (the dead state dir).
- Removed today's smoke-test ndjson artifacts in `services/regulatory-svc/{cases,alerts}/.outbox/` (single-line files from T4.15/T4.17 manual smokes).
- Kept the `.outbox/` directory structure + the legitimate test fixture at `services/event-bus/.outbox/test/`.

---

## ✅ Gap 5 — CLOSED 2026-05-03 — Airflow DAGs reframed honestly in TASKS.md

Originally flagged as: 4 DAGs scaffolded (`cbs_ingestion`, `bureau_sync`, `feature_build`, `pd_retrain_monthly`) but no scheduler running, hidden behind T1.4 ✅. Recommended split:

```diff
- [x] T1.4 MWAA DAGs `cbs_ingestion`, `bureau_sync`, `feature_build` + quality gates
+ [x] T1.4a MWAA DAG code shipped
+ [ ] T1.4b MWAA infra deployed + scheduler running + DAGs producing data
```

This recommendation was applied to the prototype's planning. Since the prototype scope explicitly excludes deploying real AWS infrastructure (per `project_apex_ews_scope.md`), T1.4b stays open as a Phase-3 production task — the gap is now visible in the backlog instead of hidden.

---

## What still needs to happen (consolidated)

After the 2026-05-03 remediation, the open backlog reduces to two items:

### ~~Open Gap A — Wire services to read/write the new `app_*` tables (Gap 3)~~ — CLOSED 2026-05-03 (T4.13–T4.18)

All 5 in-memory services are now backed by Postgres: BFF webhooks (T4.13), auth-svc users/sessions/password-history/audit-events (T4.14), cases (T4.15), auth-svc audit fan-out to the hash-chained `audit.event_log` (T4.16, also closed Gap 2), alerts (T4.17), and scenarios (T4.18). Total ~13 hours of engineering across 6 sessions.

### ~~Open Gap B — Fire actual writes into `audit.event_log` (Gap 2)~~ — CLOSED 2026-05-03 (T4.16)

`services/auth-svc/src/audit_event_log.ts` is now the canonical chain client; `PgAuthAuditLog.append()` fans out to it on every event. The client serialises INSERTs through an in-process Promise queue so concurrent appends don't race for the same `last_hash`. Cases (T4.15) and alerts (T4.17) can adopt the same client with a different mapping function — graduate to a `@apex-ews/audit` library once the second consumer lands.

---

## Quick wins still on the table (≤1 day total)

If you want the database to **become live** (services actually writing) without doing the full structural fixes:

1. **Wire bff webhooks → app_bff** — 2 hours, lowest risk, immediate benefit (subscriptions survive BFF restart).
2. **Wire auth-svc → app_iam** (users + sessions only; skip captcha/rate-limit/etc.) — 2-3 hours, immediate benefit (login persists across restart).
3. **Wire scenario save/load** — 1-2 hours, makes saved scenarios shareable across users instead of trapped in one browser.

Beyond these, every other gap is explicitly tracked in the per-service wiring backlog above.

---

## Cross-references

- Source-of-truth schema reference: [`docs/database-schema.md`](database-schema.md)
- Migration files: [`data/schema/`](../data/schema/) (4 files: 001/002/003/004)
- App-data generator: [`data/schema/_generate_app_seeds.py`](../data/schema/_generate_app_seeds.py)
- Raw seed generator: [`data/dbt/seeds/_generate_seeds.py`](../data/dbt/seeds/_generate_seeds.py)
- dbt source aliasing (now clean): [`data/dbt/models/sources.yml`](../data/dbt/models/sources.yml)
- Service-by-service in-memory store inventory: see "Out-of-Postgres state" in [`docs/database-schema.md`](database-schema.md)
- Verification matrix (proves the analytics path works end-to-end): [`STATUS.md`](../STATUS.md)
- Live container status: `docker ps | grep apex-ews-pg` should show `Up …` on port `:55432`
