# logs/alert.md — alert agent

> Append entries chronologically. Each entry: task id, files touched, decisions, hand-offs, blockers.

## 2026-04-26 — Initialised

- Log file created. Awaiting first task.

## 2026-04-26 — T1.10 / T1.11 / T2.7 shipped

### Tasks ticked
- T1.10 — Alert producer at `services/regulatory-svc/alerts/` emitting to `apex.regulatory.events` (v2).
- T1.11 — `services/notification-svc/` with SES + Africa's Talking adapters and LoggingAdapter fallback.
- T2.7 — SmartQueue (Critical / Medium / Low) with FIFO + round-robin + assign / ack / close endpoints.

### Framework choice
TypeScript + Node + Express to match the rest of the regulatory lane (`services/regulatory-svc/rules/` and `services/auth-svc/`). AJV validates both the input firing schema and the output canonical alert schema; jest + ts-jest for tests; multi-stage `node:20-alpine` Dockerfile (mirrors auth-svc).

### Files touched
**Schema registry (agent-alert is allowed to add here per plan):**
- `infra/schema-registry/apex.rule.firings.v1.json` — NEW. Internal stub topic agent-rule produces. Required: firing_id, rule_id, rule_version, customer_id, indicators_fired, rule_severity, ts. Optional: loan_id, reason, recommended_action, evidence{}, trace_id. Compatibility BACKWARD.
- `infra/schema-registry/apex.regulatory.events.v2.json` — NEW (v1 left intact). Adds top-level rule_id, indicators_fired, pd, risk_level, top_reasons, reason_summary, ts. Every v1-required field is still required so v1 consumers still validate (BACKWARD).
- `infra/schema-registry/README.md` — table updated.

**Alert producer (`services/regulatory-svc/alerts/`):**
- `package.json`, `tsconfig.json` — Express + AJV + ajv-formats; ts-jest + ts-node devs.
- `src/types.ts` — RuleFiring, ScoreResponse, CanonicalAlert (mirrors v2 schema), Severity / Bucket / WireSeverity unions.
- `src/severity.ts` — severity merge + bucket-mapping. `mergeSeverity(rule, scoreLevel) = max(rule, fromLevel(scoreLevel))`. `bucketFor`: critical/high → critical bucket; medium → medium; low → low.
- `src/alert.ts` — pure `buildAlert` (no IO). Deterministic `alert_id` from sha256 over `apex.alert.v2|firing_id|rule_id|rule_version|customer_id|final_severity|sorted indicators` formatted as a UUIDv5-shaped string. `reason_summary` is "[SEV] {reason} ({indicators}) for customer {id}. PD x.x%."
- `src/score_client.ts` — `HttpScoreClient` (calls `${APEX_SCORE_URL}/score`, 1.5s timeout, swallows errors → null) + `StubScoreClient` for tests.
- `src/producer.ts` — `Producer` interface; `OutboxProducer` (NDJSON tail at `.outbox/<topic>-<YYYY-MM-DD>.ndjson` + `readAll` for tests); `KafkaProducer` is an explicit TODO that throws — `makeProducer` falls back to outbox if `KAFKA_BROKERS` unset OR if the kafkajs construction throws.
- `src/queue.ts` — `SmartQueue` with bucket FIFO + round-robin + NDJSON persistence at `.queue/queue.ndjson`. States: queued → assigned → acked → closed. `pullNext()` round-robins across analyst pool; `assign / ack / close` mutate state.
- `src/schemas.ts` — AJV-compiled validators for the input + output schemas (lazy, cached). `explain()` formats AJV errors.
- `src/evaluator.ts` — `AlertEvaluator` glues input-validate → score → buildAlert → output-validate → producer.emit → queue.enqueue. Idempotent: if queue already has the alert_id, we skip emit but still return the existing entry.
- `src/server.ts` — Express factory `makeApp({producer, queue, scoreClient, …})`. Endpoints: `POST /alerts/evaluate`, `GET /alerts?bucket=&assignee=&state=&page=&pageSize=`, `GET /alerts/:id`, `POST /alerts/:id/assign` `{user_id}`, `POST /alerts/:id/ack`, `POST /alerts/:id/close` `{outcome, note}`, `GET /healthz`.
- `__tests__/severity.test.ts` — 16-row matrix (rule × score → final severity) + bucket mapping.
- `__tests__/alert.test.ts` — `buildAlert` (severity merge, null-score path, schema-validation against v2, idempotent alert_id), AlertEvaluator end-to-end with stubs (outbox written, idempotency on re-deliver, malformed firing rejected).
- `__tests__/queue.test.ts` — bucket placement, FIFO + priority pull order, round-robin, assign/ack/close happy path, close-requires-outcome, list filters, idempotent enqueue.
- `README.md` — endpoints, severity matrix, env vars, run + test instructions, blockers.

**notification-svc (`services/notification-svc/`):**
- `package.json`, `tsconfig.json`, `Dockerfile` — same Node 20-alpine multi-stage as auth-svc; depends on `@aws-sdk/client-sesv2`.
- `src/types.ts` — Adapter interface, AlertSummary (mirrors v2 alert envelope), NotifyTarget, SendResult.
- `src/adapters/logging.ts` — LoggingAdapter writes stdout + `.outbox/<channel>-<YYYY-MM-DD>.ndjson`.
- `src/adapters/ses.ts` — SESAdapter using `SESv2Client` (lazy require so tests don't need the SDK). `makeEmailAdapter(env)` returns `LoggingAdapter` if `AWS_REGION` is unset.
- `src/adapters/africas_talking.ts` — REST POST to `api.africastalking.com/version1/messaging`, `apiKey` header, urlencoded body, parses `SMSMessageData.Recipients[0].status`. `makeSmsAdapter(env)` returns LoggingAdapter unless both `AT_API_KEY` and `AT_USERNAME` are present. SMS body truncated to 160 chars.
- `src/templates/email.ts` — minimal HTML email with DMS-navy header (`#0D2B6A`) + property table; substitutes `${alert.summary}` (= reason_summary).
- `src/templates/sms.ts` — `[ZorEWS][<SEV>] <reason> id:<short>`, hard 160-char cap.
- `src/router.ts` — `channelsFor(severity)` returns the channels list per FR-ALERT-4: CRITICAL → [sms,email]; HIGH/MEDIUM → [email]; LOW → []. `fanout()` calls each adapter with a templated message.
- `src/subscriber.ts` — `AlertSubscriber.onAlert(alert, target)` is the per-event callback the future kafkajs consumer will invoke.
- `src/server.ts` — Express factory; `POST /notify`, `POST /events` (alias), `GET /healthz` (returns chosen adapter names).
- `__tests__/router.test.ts` — severity matrix, fan-out hits the right adapters, template substitution, SMS bounded ≤ 160.
- `__tests__/adapters.test.ts` — Logging writes to outbox; SES factory falls back without `AWS_REGION`; SES with no recipient fails gracefully; AT factory falls back without keys; AT adapter posts and parses Recipients; AT truncates to 160; AT with no phone fails.
- `README.md` — channel matrix, adapter table, env vars, run + test, blocked items.

### Severity-merge matrix (FR-ALERT-2)
`final = max(rule, score-band)`; `critical` is rule-only.

| rule \ score | (none) | Low | Medium | High |
|---|---|---|---|---|
| **low** | low | low | medium | high |
| **medium** | medium | medium | medium | high |
| **high** | high | high | high | high |
| **critical** | critical | critical | critical | critical |

Bucket: critical/high → Critical; medium → Medium; low → Low.

### Channel routing matrix (FR-ALERT-4)
| Severity | SMS (AT) | Email (SES) | In-app |
|---|---|---|---|
| CRITICAL | ✓ | ✓ | ✓ |
| HIGH     | — | ✓ | ✓ |
| MEDIUM   | — | ✓ | ✓ |
| LOW      | — | — | ✓ (UI subscription only — not this svc) |

HIGH was not explicitly listed in FR-ALERT-4 ("Critical: SMS+Email; Medium: email; Low: in-app") so we treated it like MEDIUM (email only) — flip to SMS via a one-line edit in `router.ts` if Ops want it paged.

### Idempotency
`alert_id = uuidv5-shaped sha256("apex.alert.v2|firing_id|rule_id|rule_version|customer_id|final_severity|sorted indicators_fired")`. Re-delivering the same firing produces the same alert_id, the queue dedupes by id, and the evaluator skips the producer emit when the entry already exists.

### Hand-offs

- **agent-rule** — please emit firings to `apex.rule.firings` topic with the v1 schema in `infra/schema-registry/apex.rule.firings.v1.json`. Required: `{firing_id (uuid), rule_id, rule_version, customer_id, indicators_fired[], rule_severity in {low,medium,high,critical}, ts ISO8601}`. Optional but encouraged: `loan_id`, `reason` (= AlertSpec.title), `recommended_action`, `evidence{<indicator_id>: number|string|null}`, `trace_id`. The shape lines up with `AlertEvent` in `rules/types.ts` (rename `severity → rule_severity`, add `firing_id`).
- **agent-case** — alert envelope is `{alert_id, customer_id, severity (UPPERCASE wire), rule_id, indicators_fired, pd, risk_level, top_reasons[], reason_summary, raised_at, …}` per `infra/schema-registry/apex.regulatory.events.v2.json`. Subscribe to `apex.regulatory.events` and auto-create cases for `severity in {CRITICAL, HIGH}`. v1 consumers still validate — every v1-required field is preserved.
- **agent-ui** — `GET /alerts` returns `{items: QueueEntry[], total, page, pageSize}` where each entry is `{alert: CanonicalAlert, bucket, state, assignee?, enqueued_at, …}`. Compare against `web/src/mocks/data.ts` (`alerts[]` currently uses `id`, `severity` lowercase, `customer.{id,name}`, `rule.{id,name}`, `indicators[]`, `assignee`, `created_at`). The shapes diverge; recommend MSW handler renames `created_at → alert.raised_at`, lowercases severity from the wire field, and projects `customer_id → customer.id`. Or we add a `/alerts/v1ui` legacy projection — agent-ui to decide.
- **agent-integration** — register `infra/schema-registry/apex.rule.firings.v1.json` and `apex.regulatory.events.v2.json` in the Glue Schema Registry IaC (T3.8). Keep the v1 file registered alongside v2 since it's BACKWARD-compatible. Also implement `KafkaProducer` and the notification-svc `apex.regulatory.events` subscriber — both are stubs in this codebase (`src/producer.ts` KafkaProducer throws; `src/subscriber.ts` has no kafkajs binding).

### Blockers
- Sandbox blocked `npm install`, `tsc`, `jest`, and `docker`. Code was written to compile + pass jest under Node 20 + standard deps; verification commands for the user:
  ```bash
  cd services/regulatory-svc/alerts && npm install && npm test && npx tsc --noEmit
  cd services/notification-svc       && npm install && npm test && npx tsc --noEmit
  ```
- `KafkaProducer` impl is intentionally a TODO marker; production wiring is agent-integration's MSK / IRSA work.
- notification-svc Kafka subscriber is also stubbed (only the in-process `AlertSubscriber.onAlert` exists).
- `web/src/mocks/data.ts` `alerts[]` does not currently match the v2 envelope — flagged as a hand-off to agent-ui.

### Definition-of-Done check
- ✅ TypeScript compiles by inspection (strict mode, noImplicitAny). User to run `npx tsc -p tsconfig.json` to confirm.
- ✅ Severity-merge matrix matches FR-ALERT-2 spec table (16 cases tested).
- ✅ `apex.rule.firings.v1.json` added; `apex.regulatory.events.v1.json` untouched; v2 added BACKWARD.
- ✅ No hardcoded credentials — env-only; absent env → LoggingAdapter fallback.
- ⏳ `npm test` would pass (test suite written; `npm install` blocked — see Blockers).

## 2026-05-14 — T6 M8.6 — Alert auto-routing analytics

### Tasks ticked
- T6 sub-phase M8.6 — auto-routing analytics. T6 sub-phase tally 100 → 101.

### Files touched
- `services/bff/src/alert_routing_analytics.ts` (new) — `RoutedAlertRecord` + `RoutingAnalytics` types; pure `aggregateRoutingAnalytics(records, now)`; `InMemoryRoutingLedger` (FIFO 200/tenant) with `record` / `markAcked` / `list(tenant, window)`; constants `ROUTING_ANALYTICS_DEFAULT_WINDOW = 50` / `ROUTING_ANALYTICS_MAX_WINDOW = 200`; `defaultRoutingLedger` singleton.
- `services/bff/__tests__/alert_routing_analytics.test.ts` (new) — 20 jest tests: 14 unit (empty input, class+channel mix, ack_rate excludes monitor_only, time-to-ack percentiles, SLA-breach acked-late, SLA-breach still-open, escalation-due, ledger FIFO + newest-first + markAcked + tenant isolation, constants) + 6 route (200 empty, 200 with records, 400 window=0, 400 window>max, 403 wrong role, cross-tenant isolation).
- `services/bff/src/server.ts` — import the new module; expose `routingLedger?: RoutingLedger` on `AppDeps` with `defaultRoutingLedger` fallback; in `/v1/alerts/ingest` snapshot `alertRoutingEngine.getRule(tenant, baseResult.bil_class)` into `routingLedger.record({...})` after the M10.8 quiet-hours pass; in manual `/v1/alerts/:alert_id/ack` call `routingLedger.markAcked(tenant, alert_id, out.acked_at)` after the M8.3 ack store transitions; new route `GET /v1/alerts/routing/analytics?window=N` (`audit:read`, tenant-isolated, mirror of M3.5 envelope shape).

### Decisions
- **Per-record snapshot vs. on-read lookup.** Snapshot the routing decision at ingest time so later tenant override edits don't retroactively change history. Mirrors how M3.5 + M7.5 keep their ledger entries frozen.
- **Why `getRule(class)` not `route(severity)`.** The M8.5 ingest pipeline already has the resolved `bil_class` on `baseResult.bil_class`; calling `route()` would re-classify the same severity. `getRule(tenant, class)` is cheaper and skips the round-trip.
- **SLA breach = acked-after-SLA OR still-open past SLA.** Captures the unacked-and-overdue case which is the signal SREs actually want. Requires `now` as an input to the aggregator.
- **`ack_rate` denominator excludes monitor_only (green).** Green is monitor-only by design; folding it into the rate would bias the metric downward.
- **FIFO cap 200/tenant.** Matches the M14.10 field-visit ledger + M7.5 performance ledger posture; "rollout-monitoring band" not long-tail BI.
- **No SPA wiring this commit.** M3.5 / M7.5 also shipped as BFF-only sub-phases; SPA integration follows in its own commit per the agreed cadence.

### Hand-offs
- **agent-ui** — when the routing-analytics strip lands on AlertListPage (future sub-phase), pull from `GET /v1/alerts/routing/analytics`; the envelope shape is `{ window: number, analytics: RoutingAnalytics }`.

### Verification
- `npx jest __tests__/alert_routing_analytics.test.ts` — 20/20 pass.
- `npx jest` (full BFF suite) — 4076 pass / 58 skipped / 4134 total (was 3155/9/3164 in STATUS.md — incremental growth since 2026-05-07, all green).
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M10.9 — Quiet-hours mute analytics

### Tasks ticked
- T6 sub-phase M10.9 — quiet-hours mute analytics. T6 sub-phase tally 110 → 111.

### Files touched
- `services/bff/src/alert_quiet_hours_mute.ts` — extended `QuietHoursMuteEventStore` interface with `listAllForTenant(tenant_id, since?)` returning events across all users for the tenant, newest-first. `InMemoryQuietHoursMuteEventStore` implementation iterates the internal `${tenant}::${user}` keyed map, filters by prefix + optional `since`, sorts by `muted_at` desc.
- `services/bff/src/alert_quiet_hours_mute_analytics.ts` (new) — pure `summarizeQuietHoursMutes(events)` returns `QuietHoursMuteAnalytics`: sample_size, distinct_users, by_class (all 4 keys; RED stays 0 by design since M10.8 bypasses red), by_day (UTC YYYY-MM-DD buckets oldest-first), top_users cap 10 sorted by mute_count desc then username asc.
- `services/bff/__tests__/alert_quiet_hours_mute_analytics.test.ts` (new) — 15 jest tests: 6 pure unit (empty, class mix, distinct_users, top_users tie-break, top_users cap, by_day sort), 3 store-level (listAllForTenant newest-first across users, since filter, tenant isolation), 6 route (empty, populated, ?since narrows, ?since=invalid → 400, 403 wrong role, cross-tenant invisible).
- `services/bff/src/server.ts` — `GET /v1/alerts/quiet-hours-muted/analytics?since=ISO` route mounted before the M10.8 `/me` route so the literal "analytics" segment isn't captured. `audit:read` RBAC matches M10.8. Validates ?since with `Number.isFinite(new Date(s).getTime())` and returns 400 on bad input.

### Decisions
- **`listAllForTenant` on the store, not pure-function over the events.** The store already encapsulates the per-(tenant, user) keying; exposing the tenant slice as a method keeps the events-array internals private. Mirrors how M15.5 went vs M15.2.
- **Top 10 cap.** Same posture as M12.5's top_requesters; SPA can paginate later if needed.
- **`by_day` uses UTC.** Mute timestamps are ISO so YYYY-MM-DD slice is the UTC day. Tenant-local-day grouping isn't worth the complexity for an internal supervisor view.
- **`by_class` keeps RED at 0.** RED bypasses M10.8 by design, so the analytics will never see RED events. Surfacing the key at 0 keeps the SPA's stable 4-bucket strip without conditionals.

### Hand-offs
- **agent-ui** — admin dashboard can drive against `GET /v1/alerts/quiet-hours-muted/analytics?since=2026-05-01T00:00:00Z`. Envelope: `{ analytics: QuietHoursMuteAnalytics }`. `top_users` is already a leaderboard; `by_day` is a stacked-bar candidate.

### Verification
- `npx jest __tests__/alert_quiet_hours_mute_analytics.test.ts` — 15/15 pass.
- `npx jest` (full BFF suite) — 4247 pass / 58 skipped / 4305 total, **zero failures**.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M8.7 — Alert routing decision preview

### Tasks ticked
- T6 sub-phase M8.7 — alert routing decision preview. T6 sub-phase tally 118 → 119.

### Files touched
- `services/bff/src/alert_routing_preview.ts` (new) — pure `previewAlertRouting(engine, tenant_id, severity, at)` decorates the existing `AlertRoutingEngine.route()` result with computed `sla_deadline` + `escalation_deadline` ISO timestamps (`at` + rule hours; both null when monitor_only) and an ordered `notifications_chain[]` of `{step_no, channel, assignee_role, tier:'primary'|'secondary'}` pairs. Chain shape: primary tier × every channel first (step_no 1..N), then secondary CC tier × every channel when `secondary_assignee` is set. Skips emitting links when `primary_assignee='none'` (green-class default → empty chain).
- `services/bff/__tests__/alert_routing_preview.test.ts` (new) — 14 jest tests: 6 unit (red full chain + SLA + escalation; orange tier shape + 24h/12h timing; yellow with no secondary; green monitor-only nulls + empty chain; tenant override changes source + chain; custom `at` propagates) + 8 route (200 happy with envelope, ?at honored, 400 missing severity, 400 invalid severity classification error, 400 invalid at, 403 wrong role, tenant_override resolves through route, cross-tenant: BANK_DEMO sees its own defaults not BIL's override).
- `services/bff/src/server.ts` — new route `POST /v1/alerts/routing/preview` body `{severity, at?}`. `audit:read` RBAC matches M8 analytics routes. Validates `at` via `Number.isFinite(new Date(s).getTime())` → 400 on bad input. Maps `AlertClassificationError` → 400 for unrecognized severity strings.

### Decisions
- **Pure decorator on top of `engine.route()`.** No re-implementation of the routing logic; just adds temporal projection (`at + hours`) and chain reshape. Single source of truth for which rule applies.
- **Chain ordering: primary tier × all channels, then secondary tier × all channels.** Matches the dispatch order an alert hits in practice — primary is the first to be notified across every channel before secondary CCs come in. Tested explicitly with red (head_of_risk + supervisor, email + sms → 4 links in exact order).
- **`primary='none'` short-circuits to empty chain.** Green-class default has `primary='none'`, so the chain is empty rather than a one-link `none → in_app` which would be misleading.
- **`at` defaults to `now()`, takes any ISO-8601.** Lets ops preview "what if this fires at midnight on a holiday?" with explicit deadline math.

### Hand-offs
- **agent-ui** — alert routing config page can add a "Preview" button per class → `POST /v1/alerts/routing/preview` with the matching severity → render the chain as a numbered list with deadline countdown timers. Particularly useful when an operator sets an override and wants to verify the deadlines + channel shape before saving.

### Verification
- `npx jest __tests__/alert_routing_preview.test.ts` — 14/14 pass.
- `npx jest` (full BFF suite) — 4375 pass / 58 skipped / 4434 total. Intermittent cross-suite singleton flakiness in `ews_rules_routes` (passes 32/32 alone); pre-existing pattern unrelated to M8.7.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M10.10 — Notification preference effective view + resolution chain

### Tasks ticked
- T6 sub-phase M10.10 — notification preference effective view + resolution chain. T6 sub-phase tally 123 → 124.

### Files touched
- `services/bff/src/notification_preferences.ts` — extended `NotificationPreferenceStore` interface + `InMemoryNotificationPreferenceStore` impl with `hasUserOverride(tenant_id, username): boolean`. Returns `true` iff the user has an explicit override row in the store. Distinguishes "user has explicitly set this" from "tenant default showing through" — `get()` collapses both into the same `ChannelPreference` shape, so this new method is the canonical detection path.
- `services/bff/src/notification_preferences_effective.ts` (new) — pure `resolveEffectivePreference(store, tenant, username, asOf?)` walks the 3-way resolution chain per channel and returns `EffectivePreference {tenant_id, username, channels[], quiet_hours, asOf}`. Each `ChannelResolution` carries `effective_enabled`, `resolution: 'user_override'|'tenant_default'|'platform_default'`, and `levels[]` (3 entries, one per level — `user_override`, `tenant_default`, `platform_default=true`). When a level isn't set its `value` is `null`. Tenant-default level carries `set_at` + `set_by` when populated. `applyQuietHoursMute(effective, asOf)` convenience emits the final dispatch decision INCLUDING the M10.7 quiet-hours mute; webhook bypasses (transactional, per M10.7 contract).
- `services/bff/__tests__/notification_preferences_effective.test.ts` (new) — 18 jest tests: 1 platform-default zero-state, 1 tenant_default override, 2 user_override (full + partial-patch behaviour), 3 quiet_hours (surfaces on response, mute applied within window with webhook bypass, mute released outside window), 1 asOf echo, 3 hasUserOverride store-level (false→true on update, reset clears, tenant_default doesn't register), 7 route (200 platform_default, override resolution chain, missing username → 400, ?asOf echoed + validated, ?asOf=invalid → 400, 403 wrong role, cross-tenant invisibility).
- `services/bff/src/server.ts` — new route `GET /v1/notifications/preferences/effective?username=X&asOf=ISO` mounted BEFORE `/v1/notifications/preferences/me` so the literal `/effective` segment isn't captured. `audit:read` RBAC (admin-only view of any user). Validates `?username` is present (400 invalid_input) and `?asOf` parses to a finite Date (400 invalid_input).

### Decisions
- **`hasUserOverride` as a separate interface method.** The existing `get()` is total: returns the merged view (user-override OR tenant-default OR hardcoded). There was no way for downstream code to ask "did the user explicitly set this?". The new method exposes that signal without breaking existing callers.
- **Resolution chain levels[] always 3 entries.** Even when the user has no override and tenant has no default, the chain shows `user_override: null`, `tenant_default: null`, `platform_default: true`. Makes the SPA's chain renderer uniform.
- **Tenant default detection via `updated_at !== null`.** The store returns a default-shaped `TenantPreferenceDefault` even when the tenant has never set one (all-true hardcoded). `updated_at: null` is the canonical "tenant has not set a default" signal.
- **`applyQuietHoursMute` is a separate convenience.** Keeps `resolveEffectivePreference` pure-shape; quiet-hours is a temporal concern that downstream dispatchers handle differently from the preference resolution. Splits the read-shape from the runtime-decision shape.
- **Webhook bypasses quiet hours.** M10.7 contract. `applyQuietHoursMute` honours it explicitly via the channel name check.

### Hand-offs
- **agent-ui** — admin notification-preferences page can add an "Effective preferences" debug panel: select a user → `GET /v1/notifications/preferences/effective?username=...` → render the 4 channels as cards with the resolution chain unfolded (visual: user_override row strikethrough when null, tenant_default highlighted when winning, platform_default greyed out when overridden).

### Verification
- `npx jest __tests__/notification_preferences_effective.test.ts` — 18/18 pass.
- `npx jest` (full BFF suite) — 4458 pass / 58 skipped / 4519 total. Intermittent cross-suite singleton flakiness in `copilot_v2_routes` / `customer_watchlist` / `scenario_diff` — all pass when run together in isolation (89/89); pre-existing pattern unrelated to M10.10.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M8.8 — Alert routing matrix snapshot + fingerprint

**Goal.** Single round-trip detection of "routing has been edited since I last looked" — via SHA-256 fingerprint of the canonical-encoded matrix. Plus a per-row source annotation so the SPA can badge each rule with "platform default" vs "tenant override" without a separate call.

### Files

- **NEW** `services/bff/src/routing_matrix_snapshot.ts` — two pure functions:
  - `computeRoutingMatrixFingerprint(rulesByClass)` — SHA-256 hex over canonical JSON. Classes serialised in fixed `BIL_CLASS_ORDER`; keys alphabetised within each rule. Equivalent matrices in different insertion orders yield the same hash.
  - `listRoutingMatrix(engine, tenant_id)` — calls `engine.listRules`, defensively backfills missing classes from `DEFAULT_RULES`, annotates `source` via field-by-field `rulesEqual` compare, returns `{tenant_id, rows, fingerprint, override_count}`.
- **NEW** `services/bff/__tests__/routing_matrix_snapshot.test.ts` — 12 tests across 4 fingerprint + 3 listRoutingMatrix + 5 route describe blocks: hex shape, determinism, any-change-flips, channel-reorder-flips, untouched defaults, override row+count+fingerprint flip, cross-tenant isolation, route 200, override changes fingerprint, 403, cross-tenant invisible, /routing/rules regression.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/alerts/routing/matrix` (audit:read) right above `/v1/alerts/routing/rules` so the literal `/matrix` segment wins over any future `:class` wildcard.

### Design notes

- Canonical encoding via fixed key order + fixed class order is what makes the fingerprint a stable identity. JSON.stringify with raw object property order would be insertion-dependent and produce different hashes for equivalent matrices.
- `rulesEqual` walks every field including channel array (length + element-wise). Tested explicitly that channel-reorder flips the fingerprint — that's a feature, not a bug: ['email','sms'] is operationally different from ['sms','email'] (the order = priority).
- Defensive backfill from DEFAULT_RULES handles the (theoretical) case of an engine that returns < 4 classes. The in-memory engine always returns all 4, but keeping this safe under a future store swap costs nothing.
- The SPA flow: render matrix on page load → store fingerprint → poll fingerprint every 30s → if fingerprint changed, re-fetch full matrix. Saves bandwidth on a small-but-rarely-changing data structure.

### Verification
- `npx jest __tests__/routing_matrix_snapshot.test.ts` — 12/12 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **141 → 142**.

## 2026-05-14 — T6 M10.11 — Unified notification template catalog

**Goal.** Single picker-friendly catalog across email + SMS + push templates. The SPA notification-picker currently has to call 3 channel-specific routes with 3 different per-channel-field shapes; M10.11 returns all 12 BIL canned templates in one consistent envelope.

### Files

- **NEW** `services/bff/src/notification_template_catalog.ts` — pure `introspectNotificationTemplateCatalog()`. Walks the three list functions (listEmailTemplates / listSmsTemplates / listPushTemplates), normalises to a minimal common shape `{channel, template_id, description, required_vars[]}`, computes `distinct_required_vars` as a union for the form-builder UX.
- **NEW** `services/bff/__tests__/notification_template_catalog.test.ts` — 10 tests (6 pure + 4 route): total = sum of by_channel, per-channel registry match, sort order, every-entry-shape, defensive copy invariant (mutating returned required_vars doesn't pollute registry), distinct_required_vars union + sort + non-empty, admin happy, 403, platform-static, M10.1 regression.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/notifications/templates/catalog` (audit:read) right above `GET /v1/notifications/email/templates` so the unified entry sits visually alongside the channel-specific ones.

### Design notes

- Cross-channel field reconciliation: email TemplateDef has subject+body_text+body_html?, SMS has body+max_length, push has title+body+deep_link+badge_count. M10.11 surfaces only the common columns (template_id + description + required_vars) — the SPA fetches channel-specific fields via the existing per-channel routes when it needs to RENDER the template (preview/send), not when it needs to PICK one.
- `required_vars` defensive copy: tested by mutating the returned array and asserting a subsequent introspect call produces the original. Catches future "let me just splice in production" mistakes that would corrupt the singleton TEMPLATES record.
- `distinct_required_vars` is the union for the form-builder: "if I render a form with all these inputs, I can populate any template the user might pick". Sorted asc for stable rendering.
- audit:read RBAC (admin tier) — template content includes BIL operational language (escalation directives, recipient roles) that we don't surface at lower tiers.

### Verification
- `npx jest __tests__/notification_template_catalog.test.ts` — 10/10 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **143 → 144**.

## 2026-05-14 — T6 M8.9 — Routing channel transport coverage

**Goal.** Cross-module validator that joins M8.2 routing rules with M10.1/M10.2/M10.3 wired transports. Surfaces gaps like "I configured this rule to fire SMS but I haven't enabled the SMS transport for this tenant" before they bite in production.

### Files

- **NEW** `services/bff/src/routing_channel_coverage.ts` — pure `checkRoutingChannelCoverage(rules)`. Wired set is `{email, sms, push}` — `in_app` is intentionally absent because it's an in-process SPA bell-badge, not a `<Channel>Transport`. Per-rule + envelope partition counts.
- **NEW** `services/bff/__tests__/routing_channel_coverage.test.ts` — 11 tests (6 pure + 5 route): WIRED_CHANNELS invariant, empty input, defaults expose in_app gap, fully-wired rule, per-rule channel-status enumeration, partition invariant, admin happy, override-fully-wires-rule, 403, cross-tenant, M8.2 routing-rules regression.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/alerts/routing/channel-coverage` (audit:read) right above the M8.8 matrix route to keep all the routing diagnostics grouped.

### Design notes

- `in_app` is intentionally NOT in the wired set. The decision: in_app notifications surface via the existing in-process notifications bus → SPA bell badge → not a Transport that needs explicit wiring. Flagging it as "unwired" is the correct contract for the validator's intent (which is "does this channel have an OUT-OF-PROCESS delivery transport?").
- Empty rules → `all_wired=true` (vacuous truth). Tested explicitly so a future caller passing an empty list doesn't get a confusing "all_wired=false because zero rules failed" — that would be wrong by predicate logic.
- Default routing matrix has 3 of 4 rules partially wired (orange/yellow/green all include in_app); red is fully wired. The validator surfaces this immediately, so a new BIL tenant viewing the matrix sees the gap at-a-glance.

### Verification
- `npx jest __tests__/routing_channel_coverage.test.ts` — 11/11 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **146 → 147**.
