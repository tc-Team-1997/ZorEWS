# Event Streaming Center — Architecture & Developer Guide

**Phase 22 — ZorEWS IA Overlay**

The Event Streaming Center is the enterprise event backbone that sits above every operational center in the ZorEWS platform. It provides a unified, observable, and replay-capable event infrastructure connecting all 16 modules — from risk alerts and AI decisions to compliance filings and governance audit trails.

---

## 1. Architecture Overview

The Event Streaming Center implements a publish-subscribe event mesh over an Apache Kafka-style topic fabric. Every system action that matters — an alert firing, an AI decision, a case being opened, a compliance obligation being breached — is emitted as a typed, schema-validated event and routed to consumers via managed topics.

```
┌─────────────────────────────────────────────────────────────┐
│                  Event Streaming Center                     │
│                                                             │
│  Publishers ──► Topics ──► Subscribers ──► Downstream       │
│                   │                                         │
│              Stream Processors                              │
│                   │                                         │
│              Replay Center ◄── DLQ Management               │
│                                                             │
│              AI Insights ──► Executive Stream View          │
└─────────────────────────────────────────────────────────────┘
```

The center provides ten operational surfaces:

1. **Event Hub** — real-time rolling feed of recent events with filtering
2. **Event Bus Dashboard** — fleet-wide throughput, latency, and failure KPIs
3. **Topic Management** — partition, retention, and schema configuration per topic
4. **Publisher Registry** — per-module publishing health and volume tracking
5. **Subscriber Registry** — per-consumer-group delivery status and lag monitoring
6. **Stream Processing** — six continuous processors running over the event fabric
7. **Replay Center** — job management for replaying single events, batches, or full topics
8. **Dead Letter Queue** — failure classification, retry policy, and recovery workflow
9. **AI Insights** — anomaly detection, trend analysis, bottleneck detection, and forecasting
10. **Executive Stream View** — board-level event intelligence summary

---

## 2. Event Model

### 2.1 Event Categories

Every event belongs to one of six mutually exclusive categories:

| Category | Description | Example events |
|---|---|---|
| `risk` | Credit, fraud, and operational risk signals | `alert.created`, `alert.escalated` |
| `case` | Case lifecycle transitions | `case.opened`, `case.assigned`, `case.closed` |
| `investigation` | Formal investigation workflow | `investigation.started`, `investigation.completed` |
| `compliance` | Regulatory compliance events | `compliance.breach`, `compliance.filing_submitted` |
| `ai` | AI model and decision events | `ai.prediction_generated`, `ai.decision_approved`, `ai.model_drift_detected` |
| `governance` | Identity, access, and audit events | `governance.user_created`, `governance.role_changed`, `governance.permission_updated` |

### 2.2 Event Types (16 total)

**Risk category**
- `alert.created` — new risk alert raised by rule engine or AI
- `alert.escalated` — alert escalated to supervisor or senior analyst
- `alert.closed` — alert resolved, suppressed, or expired

**Case category**
- `case.opened` — new case created from an alert
- `case.assigned` — case assigned to an officer or team
- `case.closed` — case closed with decision (resolved / written-off / monitoring)

**Investigation category**
- `investigation.started` — formal investigation opened on a case
- `investigation.completed` — investigation concluded with finding

**Compliance category**
- `compliance.breach` — regulatory threshold or rule breached
- `compliance.filing_submitted` — regulatory report filed with authority

**AI category**
- `ai.prediction_generated` — PD / fraud / churn prediction produced
- `ai.decision_approved` — autonomous AI decision confirmed by maker-checker
- `ai.model_drift_detected` — production model drift exceeds PSI threshold

**Governance category**
- `governance.user_created` — IAM user provisioned
- `governance.role_changed` — role assignment modified
- `governance.permission_updated` — permission matrix updated

### 2.3 Event Envelope

Every event carries a standard envelope regardless of type:

```typescript
interface EventHubEntry {
  event_id: string;          // EVT-{TENANT}-{seq}
  event_type: EventType;     // one of the 16 declared types
  category: EventCategory;   // derived from event_type
  topic: TopicName;          // routing destination
  publisher: PublisherModule; // originating module
  tenant_id: string;         // multi-tenant isolation key
  payload_size_bytes: number; // message size for broker capacity planning
  priority: 'critical' | 'high' | 'medium' | 'low';
  occurred_at: string;       // ISO-8601 — when the business event happened
  processed_at: string;      // ISO-8601 — when the broker processed it
  latency_ms: number;        // occurred → processed latency
  status: 'processed' | 'processing' | 'failed' | 'dead_lettered';
  correlation_id: string;    // workflow trace — links related events
}
```

**Latency target:** p95 < 300ms, p99 < 700ms under normal load.

---

## 3. Topics

The platform manages 12 topics across 6 categories. Each topic has fixed retention, partition count, and replication settings.

| Topic | Category | Publisher | Retention | Partitions | Replication |
|---|---|---|---|---|---|
| `risk.alerts` | risk | Alerts Engine | 168h (7d) | 12 | 3 |
| `risk.predictions` | risk | AI Decisioning | 720h (30d) | 6 | 3 |
| `risk.cases` | case | Case Management | 2160h (90d) | 8 | 3 |
| `compliance.events` | compliance | Compliance Center | 8760h (1y) | 4 | 3 |
| `compliance.filings` | compliance | Compliance Center | 8760h (1y) | 4 | 3 |
| `ai.decisions` | ai | AI Decisioning | 2160h (90d) | 8 | 3 |
| `ai.predictions` | ai | AI Decisioning | 720h (30d) | 6 | 3 |
| `ai.model_events` | ai | AI Decisioning | 4320h (180d) | 4 | 3 |
| `governance.audit` | governance | IAM Center | 87600h (10y) | 8 | 3 |
| `governance.iam` | governance | IAM Center | 87600h (10y) | 4 | 3 |
| `investigations.events` | investigation | Investigation Center | 4320h (180d) | 6 | 3 |
| `recovery.actions` | risk | Recovery Center | 720h (30d) | 4 | 3 |

**Governance and compliance topics** use 10-year retention to satisfy RBI / IRDAI audit trail requirements. **Risk topics** use shorter retention aligned to operational SLAs. **Replication factor is always 3** across all topics for fault tolerance.

### 3.1 Topic Statuses

- `active` — accepting writes and delivering reads normally
- `paused` — writes suspended; typically for schema migration
- `deprecated` — read-only; scheduled for removal after consumer migration

---

## 4. Publishers

Eight platform modules publish events to the topic fabric. Each module is responsible for a well-defined set of topics and event types.

| Module | Topics Published | Event Types |
|---|---|---|
| Alerts Engine | `risk.alerts` | alert.created, alert.escalated, alert.closed |
| Case Management | `risk.cases` | case.opened, case.assigned, case.closed |
| AI Decisioning | `ai.decisions`, `ai.predictions`, `ai.model_events`, `risk.predictions` | ai.prediction_generated, ai.decision_approved, ai.model_drift_detected |
| Compliance Center | `compliance.events`, `compliance.filings` | compliance.breach, compliance.filing_submitted |
| IAM Center | `governance.audit`, `governance.iam` | governance.user_created, governance.role_changed, governance.permission_updated |
| Investigation Center | `investigations.events` | investigation.started, investigation.completed |
| Recovery Center | `recovery.actions` | (risk recovery workflow events) |
| Rule Engine | `risk.alerts`, `risk.predictions` | alert.created (rule-triggered) |

### 4.1 Publisher Health Model

Each publisher exposes:
- `success_rate_pct` + `failure_rate_pct` — sum to 100%
- `avg_publish_ms` — end-to-end publish latency
- `events_published_24h` — volume in the last 24 hours
- `status` — `active` | `degraded` | `offline`

Publishers with `degraded` status are flagged in the Bus Dashboard and trigger an ops alert. Publishers that go `offline` block dependent consumers until restarted.

---

## 5. Subscribers

Twelve consumer groups subscribe to the topic fabric. Each group maps to a downstream platform capability.

| Subscriber | Topics Consumed | Consumer Group |
|---|---|---|
| Risk Dashboard Renderer | risk.alerts, risk.predictions | risk-dashboard |
| AI Decisioning Layer | risk.alerts, risk.cases, ai.predictions | ai-decisioning |
| Board Reporting Engine | compliance.events, ai.decisions, governance.audit | board-reporting |
| Integration Marketplace | compliance.filings, governance.iam | integration-hub |
| Digital Twin Simulator | risk.predictions, ai.model_events | digital-twin |
| Autonomous Agent Executor | risk.alerts, risk.cases, ai.decisions | autonomous-agents |
| Compliance Obligation Tracker | compliance.events, compliance.filings | compliance-engine |
| Audit Chain Recorder | governance.audit, ai.decisions, investigations.events | audit-recorder |
| Executive Cockpit Feed | risk.alerts, ai.decisions, compliance.events | exec-cockpit |
| Recovery Workflow Engine | risk.cases, recovery.actions | recovery-engine |
| Predictive Risk Analyzer | risk.predictions, ai.model_events | predictive-risk |
| Investigation Coordinator | investigations.events, risk.cases | investigation-hub |

### 5.1 Delivery Status

- `healthy` — processing within SLA with lag < 20 messages
- `lagging` — consumer behind by 100–1000 messages; SLA at risk
- `degraded` — intermittent processing failures; retry rate elevated
- `failed` — consumer group offline; manual intervention required

Lagging consumers appear prominently in both the Bus Dashboard and the AI Insights feed with time-to-breach estimates.

---

## 6. Stream Processing

Six continuous stream processors run against the live event fabric, performing real-time aggregation, correlation, pattern detection, and enrichment.

### 6.1 Processor Inventory

**Alert Volume Aggregator** (`aggregation`)
Aggregates alert volumes per customer segment per 5-minute window. Publishes rolling volume signals to `risk.predictions` for trend-based escalation rules. Input: `risk.alerts`. Output: `risk.predictions`.

**Risk Signal Correlator** (`correlation`)
Correlates credit, fraud, and behavioural signals from multiple upstream topics into a unified per-customer risk score. Detects multi-signal deterioration that no individual signal would trigger alone. Input: `risk.alerts` + `ai.predictions`. Output: `risk.predictions`.

**Fraud Pattern Detector** (`pattern_detection`)
Detects known fraud patterns: staged accident rings, ghost hospital claim mills, synthetic identity fraud, and shell company orchestration. Emits enriched fraud signals to `ai.model_events` for model retraining feedback. Input: `risk.alerts` + `risk.cases`. Output: `ai.model_events`.

**Compliance Event Enricher** (`risk_enrichment`)
Enriches incoming compliance breach events with regulatory obligation metadata — applicable regulation, filing deadline, penalty schedule, responsible officer. Input: `compliance.events`. Output: `compliance.events` (enriched).

**Case Lifecycle Correlator** (`correlation`)
Tracks case-to-investigation linkage across the case management and investigation workflows. Generates SLA monitoring signals when cases age beyond threshold without an investigation being opened. Input: `risk.cases` + `investigations.events`. Output: null (state maintained internally).

**AI Decision Aggregator** (`aggregation`)
Aggregates AI decisions by type, risk band, and confidence score for the Board Reporting Engine. Produces hourly and daily decision-quality summaries. Input: `ai.decisions`. Output: `risk.predictions`.

### 6.2 Processor Status

- `running` — processing events in real time
- `paused` — suspended for deployment or schema migration
- `error` — processor has faulted; events accumulating in input topic lag

---

## 7. Event Replay

The Replay Center enables operators to reprocess historical events. This is required after:
- Consumer group reset following schema migration
- System recovery after an extended outage
- Audit-driven forensic analysis
- Integration testing with production event shapes
- Rule engine updates requiring re-evaluation of historical alerts

### 7.1 Replay Job Lifecycle

```
queued ──► in_progress ──► completed
                │
                └──► failed
```

Jobs start in `queued` state. The replay worker picks up jobs in FIFO order, processes the target events, and transitions to `completed` or `failed`. Failed jobs retain the error reason for ops investigation.

### 7.2 Replay Job Types

| Type | Description | Typical event_count |
|---|---|---|
| `single` | Replay one specific event by ID | 1 |
| `batch` | Replay a range of events | 50–1000 |
| `topic` | Replay all events on a topic from a given offset | 5000–50000 |

### 7.3 Replay Job Fields

```typescript
interface ReplayJob {
  job_id: string;
  type: 'single' | 'batch' | 'topic';
  topic: TopicName | null;         // populated for topic-type jobs
  event_count: number;
  status: ReplayStatus;
  requested_by: string;            // email or system actor
  reason: string;                  // mandatory audit field
  target_consumer_group: string;   // which group to replay to
  started_at: string | null;
  completed_at: string | null;     // non-null when status = completed
  duration_ms: number | null;
}
```

---

## 8. Dead Letter Queue

Events that cannot be delivered after exhausting retry attempts are moved to the Dead Letter Queue (DLQ). The DLQ provides a structured recovery workflow rather than silent event loss.

### 8.1 Failure Classification

| Error Code | Description | Recovery Action |
|---|---|---|
| `SCHEMA_INVALID` | Schema validation failed — field missing or type mismatch | Fix schema; re-publish corrected event |
| `CONSUMER_TIMEOUT` | Downstream consumer did not acknowledge within 30s | Scale consumer or investigate processing bottleneck |
| `DESERIALIZE_FAIL` | Malformed JSON in event payload | Fix publisher serialisation; republish from source |
| `MSG_EXPIRED` | Consumer group lag caused message to expire before processing | Replay from topic offset after fixing consumer lag |
| `NETWORK_ERROR` | Network partition prevented delivery to target broker | Automatic retry on network restoration |
| `SIZE_LIMIT` | Message exceeded 10MB broker limit | Refactor publisher to use references rather than inline payloads |

### 8.2 DLQ Entry Lifecycle

```
pending ──► retrying ──► resolved
                │
                └──► abandoned
```

Entries retry up to `max_retries = 5` times with exponential back-off (1s, 2s, 4s, 8s, 16s). Entries that exhaust retries transition to `abandoned` and require manual recovery. `resolved` entries have been successfully republished to the original topic.

### 8.3 DLQ Entry Fields

```typescript
interface DlqEntry {
  dlq_id: string;
  original_event_id: string;
  event_type: EventType;
  failure_reason: string;    // human-readable description
  error_code: string;        // structured code for automation
  retry_count: number;
  max_retries: number;       // always 5 on this platform
  status: DlqStatus;
  recovery_action: string | null; // non-null when resolved or abandoned
}
```

---

## 9. AI Event Insights

The AI Insights engine continuously analyses the event fabric and produces six actionable insights per evaluation cycle. Four insight types are supported:

### 9.1 Insight Types

**`anomaly`** — Sudden volume or rate deviations that exceed normal variance. Example: `risk.alerts` volume spike 340% above 7-day baseline. Severity is typically `critical` or `warning`.

**`bottleneck`** — Consumer lag growing beyond safe thresholds with time-to-SLA-breach estimates. Example: Board Reporting Engine lagging 840 messages with 12 minutes to SLA breach. Severity is `warning`.

**`trend`** — Gradual directional changes in event volume or quality metrics. Example: `compliance.events` volume growing 8% week-on-week for four consecutive weeks. Severity is `info`.

**`forecast`** — Capacity projections based on recent growth trends. Example: 28% volume growth forecast to saturate `risk.alerts` topic partitions in 24 days. Severity is `info`.

### 9.2 Insight Fields

```typescript
interface EventInsight {
  insight_id: string;
  type: InsightType;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  affected_topic: TopicName;
  confidence_score: number;    // 0.0–1.0
  recommendation: string;      // concrete action for the ops team
  detected_at: string;
  metric_value: string;        // key metric that triggered the insight
}
```

Insights with `confidence_score >= 0.85` and `severity = critical` are surfaced immediately in the Bus Dashboard header and the Executive Stream View.

---

## 10. Executive Reporting

The Executive Stream View provides a board-level summary of the enterprise event backbone. It consolidates:

- **enterprise_events_24h** — total events processed in the last 24 hours
- **critical_events_24h** — events with `priority = critical`
- **event_health_score** — composite health score 0–100 based on failure rate, consumer lag, and DLQ size
- **top_risk_streams** — the three busiest risk-category topics with trend direction and critical event percentage
- **compliance_stream_status** — compliance and governance topic SLA adherence
- **ai_decision_streams** — AI decision throughput, confidence, human override rate, and automation rate
- **event_volume_by_hour** — 12-hour rolling volume histogram with critical event overlay
- **top_3_insights** — the highest-priority AI insights from the current cycle
- **board_summary** — natural language paragraph suitable for board packs

The board summary is generated deterministically per (tenant, day), ensuring consistent narrative across multiple report versions generated on the same date.

---

## 11. RBAC — Access Control

The Event Streaming Center is accessible to all roles with operational or oversight responsibilities. Restricted to staff that have a legitimate need to see infrastructure-level event data.

**Allowed roles:** `admin`, `supervisor`, `risk_analyst`, `super_admin`, `country_admin`, `bank_admin`, `insurance_admin`, `fraud_analyst`, `auditor`, `compliance_officer`, `operations_user`, `executive`, `cdo`, `cro`, `ceo`, `coo`, `board_member`, `operations_manager`, `country_head`.

The `canAccessEventStreamingCenter(roles)` function returns `false` for undefined or empty role arrays, ensuring anonymous callers are rejected at the access-control layer before any data is constructed.

---

## 12. Testing Strategy

The engine is a pure-function module with no I/O, no React, and no side effects. All state is derived deterministically from `(tenant, asOf)` inputs via FNV-1a seeding and Mulberry32 PRNG.

### 12.1 Test Coverage

The test suite (`EventStreamingCenter.test.tsx`) covers 13 describe groups with 91 tests:

| Group | Function | Tests |
|---|---|---|
| 1 | `canAccessEventStreamingCenter` | 5 |
| 2 | Enum constants | 6 |
| 3 | `buildEventHub` | 10 |
| 4 | `buildEventBusDashboard` | 10 |
| 5 | `buildEventTopics` | 8 |
| 6 | `buildPublishers` | 8 |
| 7 | `buildSubscribers` | 8 |
| 8 | `buildStreamProcessors` | 6 |
| 9 | `buildReplayJobs` | 6 |
| 10 | `buildDlqEntries` | 6 |
| 11 | `buildEventInsights` | 6 |
| 12 | `buildExecutiveStreamView` | 6 |
| 13 | `buildStreamingKpis` | 6 |

### 12.2 Test Patterns

**Determinism** — Every builder is tested with two identical calls to confirm idempotent output:
```typescript
const result1 = buildEventTopics(TENANT, AS_OF);
const result2 = buildEventTopics(TENANT, AS_OF);
expect(result1[0].partition_count).toBe(result2[0].partition_count);
```

**Tenant isolation** — Events for `BANK_DEMO` and `BIL` are verified to differ, confirming that the seed key includes the tenant identifier.

**Invariant checking** — Business invariants are tested directly:
- `failure_rate_pct + success_rate_pct ≈ 100` on publishers
- `failed_events_24h < total_events_24h` on the bus dashboard
- `critical_events_24h < total_events_24h` on KPIs
- `p95_latency_ms > avg_latency_ms` on the bus dashboard

**Enum membership** — All status, type, and category fields are tested against the exported closed enum arrays, ensuring no typos drift into the synthesis logic.

---

## 13. Backward Compatibility

The Event Streaming Center is implemented as Phase 22 IA overlay. Every prior module is untouched. The engine file (`eventStreamingEngine.ts`) exports only new symbols; no existing exports are modified or removed.

New exports are strictly additive:
- `buildEventHub` — new
- `buildEventBusDashboard` — new
- `buildEventTopics` — new
- `buildPublishers` — new
- `buildSubscribers` — new
- `buildStreamProcessors` — new
- `buildReplayJobs` — new
- `buildDlqEntries` — new
- `buildEventInsights` — new
- `buildExecutiveStreamView` — new
- `buildStreamingKpis` — new
- All enum constants — new

The page component (`EventStreamingCenterPage.tsx`) is a new route entry and does not modify any existing AppShell navigation or route configuration except adding its own entry via the standard IA overlay pattern.

---

## 14. Performance Notes

- All builder functions run in O(n) time where n is the number of items returned
- FNV-1a hashing is O(k) in key length; typically < 50 characters
- Mulberry32 PRNG calls are O(1) per value
- The most expensive call is `buildEventHub(tenant, asOf, 30)` which makes 30 sequential PRNG passes — expected runtime < 1ms in all environments
- `buildStreamingKpis` internally calls `buildEventBusDashboard`; avoid calling both independently if both outputs are needed — call `buildStreamingKpis` and use `buildEventBusDashboard` separately only when the full dashboard shape is required
