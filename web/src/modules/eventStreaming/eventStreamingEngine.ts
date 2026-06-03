/**
 * Real-Time Event Streaming Center — core engine.
 *
 * Pure-function engine: no I/O, no React, no stores.
 * Deterministic for (tenant, day) via FNV-1a + Mulberry32.
 *
 * 10 sections: Event Hub, Bus Dashboard, Topics, Publishers,
 * Subscribers, Stream Processing, Replay Center, DLQ Management,
 * AI Insights, Executive Stream View.
 *
 * Phase 22 IA overlay — additive; every prior module untouched.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }
function r2(v: number): number { return Math.round(v * 100) / 100; }
function r1(v: number): number { return Math.round(v * 10) / 10; }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function pick<T>(arr: readonly T[], rng: () => number): T { return arr[Math.floor(rng() * arr.length)]; }
function tsAgo(d: Date, ms: number): string { return new Date(d.getTime() - ms).toISOString(); }

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const EVENT_CATEGORIES = ['risk', 'case', 'investigation', 'compliance', 'ai', 'governance'] as const;
export type EventCategory = typeof EVENT_CATEGORIES[number];

export const EVENT_TYPES = [
  // Risk
  'alert.created', 'alert.escalated', 'alert.closed',
  // Case
  'case.opened', 'case.assigned', 'case.closed',
  // Investigation
  'investigation.started', 'investigation.completed',
  // Compliance
  'compliance.breach', 'compliance.filing_submitted',
  // AI
  'ai.prediction_generated', 'ai.decision_approved', 'ai.model_drift_detected',
  // Governance
  'governance.user_created', 'governance.role_changed', 'governance.permission_updated',
] as const;
export type EventType = typeof EVENT_TYPES[number];

export const TOPIC_NAMES = [
  'risk.alerts', 'risk.predictions', 'risk.cases',
  'compliance.events', 'compliance.filings',
  'ai.decisions', 'ai.predictions', 'ai.model_events',
  'governance.audit', 'governance.iam',
  'investigations.events', 'recovery.actions',
] as const;
export type TopicName = typeof TOPIC_NAMES[number];

export const PUBLISHER_MODULES = ['Alerts Engine', 'Case Management', 'AI Decisioning', 'Compliance Center', 'IAM Center', 'Investigation Center', 'Recovery Center', 'Rule Engine'] as const;
export type PublisherModule = typeof PUBLISHER_MODULES[number];

export const DELIVERY_STATUSES = ['healthy', 'degraded', 'failed', 'lagging'] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];

export const DLQ_STATUSES = ['pending', 'retrying', 'resolved', 'abandoned'] as const;
export type DlqStatus = typeof DLQ_STATUSES[number];

export const REPLAY_STATUSES = ['queued', 'in_progress', 'completed', 'failed'] as const;
export type ReplayStatus = typeof REPLAY_STATUSES[number];

export const INSIGHT_TYPES = ['anomaly', 'trend', 'bottleneck', 'forecast'] as const;
export type InsightType = typeof INSIGHT_TYPES[number];

// ─────────────────────────────────────────────────────────────────────────────
// RBAC
// ─────────────────────────────────────────────────────────────────────────────

export const EVENT_STREAMING_ROLES: readonly string[] = [
  'admin', 'supervisor', 'risk_analyst', 'super_admin', 'country_admin',
  'bank_admin', 'insurance_admin', 'fraud_analyst', 'auditor',
  'compliance_officer', 'operations_user', 'executive', 'cdo', 'cro',
  'ceo', 'coo', 'board_member', 'operations_manager', 'country_head',
];
export function canAccessEventStreamingCenter(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  const allowed = new Set(EVENT_STREAMING_ROLES);
  for (const r of roles) { if (allowed.has(r)) return true; }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Event Hub
// ─────────────────────────────────────────────────────────────────────────────

export interface EventHubEntry {
  event_id: string;
  event_type: EventType;
  category: EventCategory;
  topic: TopicName;
  publisher: PublisherModule;
  tenant_id: string;
  payload_size_bytes: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  occurred_at: string;
  processed_at: string;
  latency_ms: number;
  status: 'processed' | 'processing' | 'failed' | 'dead_lettered';
  correlation_id: string;
}

const EVENT_CATEGORY_MAP: Record<EventType, EventCategory> = {
  'alert.created': 'risk', 'alert.escalated': 'risk', 'alert.closed': 'risk',
  'case.opened': 'case', 'case.assigned': 'case', 'case.closed': 'case',
  'investigation.started': 'investigation', 'investigation.completed': 'investigation',
  'compliance.breach': 'compliance', 'compliance.filing_submitted': 'compliance',
  'ai.prediction_generated': 'ai', 'ai.decision_approved': 'ai', 'ai.model_drift_detected': 'ai',
  'governance.user_created': 'governance', 'governance.role_changed': 'governance', 'governance.permission_updated': 'governance',
};

const EVENT_TOPIC_MAP: Record<EventType, TopicName> = {
  'alert.created': 'risk.alerts', 'alert.escalated': 'risk.alerts', 'alert.closed': 'risk.alerts',
  'case.opened': 'risk.cases', 'case.assigned': 'risk.cases', 'case.closed': 'risk.cases',
  'investigation.started': 'investigations.events', 'investigation.completed': 'investigations.events',
  'compliance.breach': 'compliance.events', 'compliance.filing_submitted': 'compliance.filings',
  'ai.prediction_generated': 'ai.predictions', 'ai.decision_approved': 'ai.decisions', 'ai.model_drift_detected': 'ai.model_events',
  'governance.user_created': 'governance.iam', 'governance.role_changed': 'governance.iam', 'governance.permission_updated': 'governance.audit',
};

const EVENT_PUBLISHER_MAP: Record<EventCategory, PublisherModule> = {
  risk: 'Alerts Engine', case: 'Case Management', investigation: 'Investigation Center',
  compliance: 'Compliance Center', ai: 'AI Decisioning', governance: 'IAM Center',
};

const PRIORITIES: Array<'critical' | 'high' | 'medium' | 'low'> = ['critical', 'high', 'high', 'medium', 'medium', 'medium', 'low', 'low'];
const STATUSES: Array<'processed' | 'processing' | 'failed' | 'dead_lettered'> = ['processed', 'processed', 'processed', 'processed', 'processed', 'processing', 'failed'];

export function buildEventHub(tenant: string, asOf: Date, limit = 30): EventHubEntry[] {
  const rng = mulberry32(fnv1a(`${tenant}:events:${dayKey(asOf)}`));
  return Array.from({ length: limit }, (_, i) => {
    const eventType = pick(EVENT_TYPES, rng);
    const category = EVENT_CATEGORY_MAP[eventType];
    const latency = Math.floor(8 + rng() * 292);
    const msAgo = Math.floor(rng() * 3600000);
    const occurredAt = tsAgo(asOf, msAgo + latency);
    const processedAt = tsAgo(asOf, msAgo);
    return {
      event_id: `EVT-${tenant.slice(0, 3)}-${String(i + 1).padStart(6, '0')}`,
      event_type: eventType,
      category,
      topic: EVENT_TOPIC_MAP[eventType],
      publisher: EVENT_PUBLISHER_MAP[category],
      tenant_id: tenant,
      payload_size_bytes: Math.floor(256 + rng() * 3840),
      priority: pick(PRIORITIES, rng),
      occurred_at: occurredAt,
      processed_at: processedAt,
      latency_ms: latency,
      status: pick(STATUSES, rng),
      correlation_id: `CORR-${Math.floor(rng() * 999999).toString(16).toUpperCase().padStart(6, '0')}`,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Event Bus Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export interface EventBusDashboard {
  events_per_minute: number;
  throughput_per_sec: number;
  total_events_24h: number;
  failed_events_24h: number;
  failure_rate_pct: number;
  retry_queue_size: number;
  dlq_size: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  active_topics: number;
  active_publishers: number;
  active_subscribers: number;
  events_by_category: Record<EventCategory, number>;
  throughput_trend: Array<{ minute: string; events: number; failures: number }>;
}

export function buildEventBusDashboard(tenant: string, asOf: Date): EventBusDashboard {
  const rng = mulberry32(fnv1a(`${tenant}:bus-dash:${dayKey(asOf)}`));
  const totalEvents = Math.floor(85000 + rng() * 65000);
  const failed = Math.floor(totalEvents * 0.005 * (0.5 + rng()));

  const categoryVolumes = EVENT_CATEGORIES.reduce((acc, cat) => {
    acc[cat] = Math.floor(5000 + rng() * 25000);
    return acc;
  }, {} as Record<EventCategory, number>);

  return {
    events_per_minute: Math.floor(820 + rng() * 680),
    throughput_per_sec: Math.floor(14 + rng() * 18),
    total_events_24h: totalEvents,
    failed_events_24h: failed,
    failure_rate_pct: r2(clamp((failed / totalEvents) * 100, 0, 100)),
    retry_queue_size: Math.floor(rng() * 180),
    dlq_size: Math.floor(rng() * 45),
    avg_latency_ms: Math.floor(28 + rng() * 62),
    p95_latency_ms: Math.floor(120 + rng() * 180),
    p99_latency_ms: Math.floor(380 + rng() * 320),
    active_topics: TOPIC_NAMES.length,
    active_publishers: PUBLISHER_MODULES.length,
    active_subscribers: Math.floor(18 + rng() * 22),
    events_by_category: categoryVolumes,
    throughput_trend: Array.from({ length: 15 }, (_, i) => {
      const r = mulberry32(fnv1a(`${tenant}:trend:${i}:${dayKey(asOf)}`));
      const h = asOf.getHours();
      const m = (asOf.getMinutes() - (14 - i)) % 60;
      const evts = Math.floor(780 + r() * 700);
      return { minute: `${String(h).padStart(2, '0')}:${String(Math.max(0, m)).padStart(2, '0')}`, events: evts, failures: Math.floor(evts * 0.006 * r()) };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Event Topics
// ─────────────────────────────────────────────────────────────────────────────

export interface EventTopic {
  topic_name: TopicName;
  category: EventCategory;
  publisher: PublisherModule;
  subscribers_count: number;
  events_per_day: number;
  retention_hours: number;
  partition_count: number;
  avg_message_size_bytes: number;
  oldest_unconsumed_ms: number;
  status: 'active' | 'paused' | 'deprecated';
  schema_version: string;
  compression: 'gzip' | 'lz4' | 'none';
  replication_factor: number;
}

const TOPIC_DEFS: Record<TopicName, { cat: EventCategory; pub: PublisherModule; retention: number; partitions: number }> = {
  'risk.alerts':          { cat: 'risk',          pub: 'Alerts Engine',        retention: 168, partitions: 12 },
  'risk.predictions':     { cat: 'risk',          pub: 'AI Decisioning',       retention: 720, partitions: 6  },
  'risk.cases':           { cat: 'case',          pub: 'Case Management',      retention: 2160,partitions: 8  },
  'compliance.events':    { cat: 'compliance',    pub: 'Compliance Center',    retention: 8760,partitions: 4  },
  'compliance.filings':   { cat: 'compliance',    pub: 'Compliance Center',    retention: 8760,partitions: 4  },
  'ai.decisions':         { cat: 'ai',            pub: 'AI Decisioning',       retention: 2160,partitions: 8  },
  'ai.predictions':       { cat: 'ai',            pub: 'AI Decisioning',       retention: 720, partitions: 6  },
  'ai.model_events':      { cat: 'ai',            pub: 'AI Decisioning',       retention: 4320,partitions: 4  },
  'governance.audit':     { cat: 'governance',    pub: 'IAM Center',           retention: 87600,partitions: 8 },
  'governance.iam':       { cat: 'governance',    pub: 'IAM Center',           retention: 87600,partitions: 4 },
  'investigations.events':{ cat: 'investigation', pub: 'Investigation Center', retention: 4320,partitions: 6  },
  'recovery.actions':     { cat: 'risk',          pub: 'Recovery Center',      retention: 720, partitions: 4  },
};

export function buildEventTopics(tenant: string, asOf: Date): EventTopic[] {
  const rng = mulberry32(fnv1a(`${tenant}:topics:${dayKey(asOf)}`));
  return TOPIC_NAMES.map((name) => {
    const def = TOPIC_DEFS[name];
    return {
      topic_name: name,
      category: def.cat,
      publisher: def.pub,
      subscribers_count: Math.floor(1 + rng() * 8),
      events_per_day: Math.floor(1000 + rng() * 49000),
      retention_hours: def.retention,
      partition_count: def.partitions,
      avg_message_size_bytes: Math.floor(512 + rng() * 3584),
      oldest_unconsumed_ms: Math.floor(rng() * 30000),
      status: rng() > 0.05 ? 'active' : 'paused',
      schema_version: `v${Math.floor(1 + rng() * 4)}.${Math.floor(rng() * 9)}.0`,
      compression: pick(['gzip', 'lz4', 'none'] as const, rng),
      replication_factor: 3,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Publishers
// ─────────────────────────────────────────────────────────────────────────────

export interface Publisher {
  module: PublisherModule;
  topics_published: TopicName[];
  events_published_24h: number;
  success_rate_pct: number;
  failure_rate_pct: number;
  avg_publish_ms: number;
  last_event_at: string;
  status: 'active' | 'degraded' | 'offline';
  event_types: EventType[];
  bytes_published_24h: number;
}

const PUB_TOPICS: Record<PublisherModule, TopicName[]> = {
  'Alerts Engine':        ['risk.alerts'],
  'Case Management':      ['risk.cases'],
  'AI Decisioning':       ['ai.decisions', 'ai.predictions', 'ai.model_events', 'risk.predictions'],
  'Compliance Center':    ['compliance.events', 'compliance.filings'],
  'IAM Center':           ['governance.audit', 'governance.iam'],
  'Investigation Center': ['investigations.events'],
  'Recovery Center':      ['recovery.actions'],
  'Rule Engine':          ['risk.alerts', 'risk.predictions'],
};

export function buildPublishers(tenant: string, asOf: Date): Publisher[] {
  const rng = mulberry32(fnv1a(`${tenant}:publishers:${dayKey(asOf)}`));
  return PUBLISHER_MODULES.map((mod) => {
    const topics = PUB_TOPICS[mod];
    const events = Math.floor(2000 + rng() * 38000);
    const successRate = r2(98.2 + rng() * 1.7);
    return {
      module: mod,
      topics_published: topics,
      events_published_24h: events,
      success_rate_pct: successRate,
      failure_rate_pct: r2(100 - successRate),
      avg_publish_ms: Math.floor(4 + rng() * 28),
      last_event_at: tsAgo(asOf, Math.floor(rng() * 300000)),
      status: rng() > 0.05 ? 'active' : rng() > 0.5 ? 'degraded' : 'offline',
      event_types: EVENT_TYPES.filter(et => EVENT_PUBLISHER_MAP[EVENT_CATEGORY_MAP[et]] === mod),
      bytes_published_24h: events * Math.floor(800 + rng() * 2200),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — Subscribers
// ─────────────────────────────────────────────────────────────────────────────

export interface Subscriber {
  subscriber_id: string;
  subscriber_name: string;
  subscribed_topics: TopicName[];
  event_types_consumed: EventType[];
  delivery_status: DeliveryStatus;
  events_consumed_24h: number;
  lag_messages: number;
  avg_processing_ms: number;
  retry_count_24h: number;
  success_rate_pct: number;
  consumer_group: string;
  last_consumed_at: string;
}

const SUBSCRIBER_DEFS = [
  { name: 'Risk Dashboard Renderer',    topics: ['risk.alerts', 'risk.predictions'] as TopicName[],        group: 'risk-dashboard' },
  { name: 'AI Decisioning Layer',        topics: ['risk.alerts', 'risk.cases', 'ai.predictions'] as TopicName[], group: 'ai-decisioning' },
  { name: 'Board Reporting Engine',      topics: ['compliance.events', 'ai.decisions', 'governance.audit'] as TopicName[], group: 'board-reporting' },
  { name: 'Integration Marketplace',     topics: ['compliance.filings', 'governance.iam'] as TopicName[],  group: 'integration-hub' },
  { name: 'Digital Twin Simulator',      topics: ['risk.predictions', 'ai.model_events'] as TopicName[],   group: 'digital-twin' },
  { name: 'Autonomous Agent Executor',   topics: ['risk.alerts', 'risk.cases', 'ai.decisions'] as TopicName[], group: 'autonomous-agents' },
  { name: 'Compliance Obligation Tracker', topics: ['compliance.events', 'compliance.filings'] as TopicName[], group: 'compliance-engine' },
  { name: 'Audit Chain Recorder',        topics: ['governance.audit', 'ai.decisions', 'investigations.events'] as TopicName[], group: 'audit-recorder' },
  { name: 'Executive Cockpit Feed',      topics: ['risk.alerts', 'ai.decisions', 'compliance.events'] as TopicName[], group: 'exec-cockpit' },
  { name: 'Recovery Workflow Engine',    topics: ['risk.cases', 'recovery.actions'] as TopicName[],        group: 'recovery-engine' },
  { name: 'Predictive Risk Analyzer',    topics: ['risk.predictions', 'ai.model_events'] as TopicName[],   group: 'predictive-risk' },
  { name: 'Investigation Coordinator',   topics: ['investigations.events', 'risk.cases'] as TopicName[],   group: 'investigation-hub' },
];

const SUB_DEL_STATUSES: DeliveryStatus[] = ['healthy', 'healthy', 'healthy', 'lagging', 'healthy', 'healthy'];

export function buildSubscribers(tenant: string, asOf: Date): Subscriber[] {
  const rng = mulberry32(fnv1a(`${tenant}:subscribers:${dayKey(asOf)}`));
  return SUBSCRIBER_DEFS.map((def, i) => {
    const events = Math.floor(1000 + rng() * 32000);
    const status = SUB_DEL_STATUSES[i % SUB_DEL_STATUSES.length];
    return {
      subscriber_id: `SUB-${String(i + 1).padStart(3, '0')}`,
      subscriber_name: def.name,
      subscribed_topics: def.topics,
      event_types_consumed: def.topics.flatMap(t =>
        EVENT_TYPES.filter(et => EVENT_TOPIC_MAP[et] === t)
      ).slice(0, 4),
      delivery_status: status,
      events_consumed_24h: events,
      lag_messages: status === 'lagging' ? Math.floor(100 + rng() * 900) : Math.floor(rng() * 20),
      avg_processing_ms: Math.floor(12 + rng() * 88),
      retry_count_24h: Math.floor(rng() * 15),
      success_rate_pct: r2(status === 'healthy' ? 99 + rng() * 0.9 : 85 + rng() * 10),
      consumer_group: def.group,
      last_consumed_at: tsAgo(asOf, Math.floor(rng() * 120000)),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Stream Processing
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamProcessor {
  processor_id: string;
  name: string;
  type: 'aggregation' | 'correlation' | 'pattern_detection' | 'risk_enrichment';
  input_topics: TopicName[];
  output_topic: TopicName | null;
  events_processed_24h: number;
  patterns_detected_24h: number;
  alerts_generated_24h: number;
  avg_processing_ms: number;
  status: 'running' | 'paused' | 'error';
  description: string;
}

const PROCESSOR_DEFS: Array<Omit<StreamProcessor, 'processor_id' | 'events_processed_24h' | 'patterns_detected_24h' | 'alerts_generated_24h' | 'avg_processing_ms' | 'status'>> = [
  { name: 'Alert Volume Aggregator',      type: 'aggregation',       input_topics: ['risk.alerts'],                            output_topic: 'risk.predictions', description: 'Aggregates alert volumes per customer segment per 5-min window for trend detection' },
  { name: 'Risk Signal Correlator',        type: 'correlation',       input_topics: ['risk.alerts', 'ai.predictions'],           output_topic: 'risk.predictions', description: 'Correlates credit + fraud + behavioural signals into unified risk score' },
  { name: 'Fraud Pattern Detector',        type: 'pattern_detection', input_topics: ['risk.alerts', 'risk.cases'],               output_topic: 'ai.model_events',  description: 'Detects staged accident rings, ghost hospitals, synthetic identity fraud patterns' },
  { name: 'Compliance Event Enricher',     type: 'risk_enrichment',   input_topics: ['compliance.events'],                      output_topic: 'compliance.events', description: 'Enriches compliance breach events with regulatory obligation metadata' },
  { name: 'Case Lifecycle Correlator',     type: 'correlation',       input_topics: ['risk.cases', 'investigations.events'],     output_topic: null,               description: 'Tracks case-to-investigation linkage for SLA monitoring' },
  { name: 'AI Decision Aggregator',        type: 'aggregation',       input_topics: ['ai.decisions'],                           output_topic: 'risk.predictions', description: 'Aggregates AI decisions by type, risk band, and confidence for reporting' },
];

export function buildStreamProcessors(tenant: string, asOf: Date): StreamProcessor[] {
  const rng = mulberry32(fnv1a(`${tenant}:processors:${dayKey(asOf)}`));
  return PROCESSOR_DEFS.map((def, i) => ({
    ...def,
    processor_id: `PROC-${String(i + 1).padStart(3, '0')}`,
    events_processed_24h: Math.floor(8000 + rng() * 42000),
    patterns_detected_24h: Math.floor(rng() * 380),
    alerts_generated_24h: Math.floor(rng() * 120),
    avg_processing_ms: Math.floor(3 + rng() * 22),
    status: rng() > 0.05 ? 'running' : rng() > 0.5 ? 'paused' : 'error',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — Event Replay Center
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayJob {
  job_id: string;
  type: 'single' | 'batch' | 'topic';
  topic: TopicName | null;
  event_count: number;
  status: ReplayStatus;
  requested_by: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  reason: string;
  target_consumer_group: string;
}

const REPLAY_REASONS = [
  'Consumer group reset after schema migration',
  'Reprocess failed events after system recovery',
  'Audit requirement — replay for forensic analysis',
  'Integration testing — replay production events in staging',
  'Rule engine update — reprocess alerts with new logic',
];

export function buildReplayJobs(tenant: string, asOf: Date): ReplayJob[] {
  const rng = mulberry32(fnv1a(`${tenant}:replays:${dayKey(asOf)}`));
  const count = Math.floor(4 + rng() * 8);
  return Array.from({ length: count }, (_, i) => {
    const type = pick(['single', 'batch', 'topic'] as const, rng);
    const status = pick(['completed', 'completed', 'completed', 'in_progress', 'queued', 'failed'] as ReplayStatus[], rng);
    const startedAt = status !== 'queued' ? tsAgo(asOf, Math.floor(rng() * 7200000)) : null;
    const completedAt = status === 'completed' || status === 'failed' ? tsAgo(asOf, Math.floor(rng() * 3600000)) : null;
    const durationMs = startedAt && completedAt ? Math.floor(Math.abs(new Date(completedAt).getTime() - new Date(startedAt).getTime())) : null;
    return {
      job_id: `REPLAY-${String(i + 1).padStart(3, '0')}-${dayKey(asOf).replace(/-/g, '')}`,
      type,
      topic: type === 'topic' ? pick(TOPIC_NAMES, rng) : null,
      event_count: type === 'single' ? 1 : type === 'batch' ? Math.floor(50 + rng() * 950) : Math.floor(5000 + rng() * 45000),
      status,
      requested_by: pick(['admin@bank.com', 'cro@bank.com', 'ops@bank.com', 'system:recovery'], rng),
      requested_at: tsAgo(asOf, Math.floor(rng() * 86400000)),
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
      reason: pick(REPLAY_REASONS, rng),
      target_consumer_group: pick(['risk-dashboard', 'ai-decisioning', 'audit-recorder', 'board-reporting'], rng),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 8 — Dead Letter Queue
// ─────────────────────────────────────────────────────────────────────────────

export interface DlqEntry {
  dlq_id: string;
  original_event_id: string;
  event_type: EventType;
  topic: TopicName;
  publisher: PublisherModule;
  failure_reason: string;
  retry_count: number;
  max_retries: number;
  first_failure_at: string;
  last_retry_at: string;
  status: DlqStatus;
  payload_size_bytes: number;
  error_code: string;
  recovery_action: string | null;
}

const DLQ_FAILURE_REASONS = [
  'Schema validation failed: unknown field "risk_band_v2"',
  'Downstream consumer timeout after 30s',
  'Deserialization error: malformed JSON payload',
  'Consumer group lag exceeded threshold — message expired',
  'Network partition — unable to deliver to target broker',
  'Message size exceeded 10MB limit',
];

const ERROR_CODES = ['SCHEMA_INVALID', 'CONSUMER_TIMEOUT', 'DESERIALIZE_FAIL', 'MSG_EXPIRED', 'NETWORK_ERROR', 'SIZE_LIMIT'];

export function buildDlqEntries(tenant: string, asOf: Date): DlqEntry[] {
  const rng = mulberry32(fnv1a(`${tenant}:dlq:${dayKey(asOf)}`));
  const count = Math.floor(4 + rng() * 12);
  return Array.from({ length: count }, (_, i) => {
    const eventType = pick(EVENT_TYPES, rng);
    const retries = Math.floor(1 + rng() * 4);
    const statusIdx = retries > 3 ? 0 : Math.floor(rng() * 4);
    const statuses: DlqStatus[] = ['pending', 'retrying', 'abandoned', 'resolved'];
    const status = statuses[statusIdx];
    return {
      dlq_id: `DLQ-${String(i + 1).padStart(3, '0')}-${dayKey(asOf).replace(/-/g, '')}`,
      original_event_id: `EVT-${tenant.slice(0, 3)}-${String(Math.floor(rng() * 999999)).padStart(6, '0')}`,
      event_type: eventType,
      topic: EVENT_TOPIC_MAP[eventType],
      publisher: EVENT_PUBLISHER_MAP[EVENT_CATEGORY_MAP[eventType]],
      failure_reason: pick(DLQ_FAILURE_REASONS, rng),
      retry_count: retries,
      max_retries: 5,
      first_failure_at: tsAgo(asOf, Math.floor(rng() * 43200000)),
      last_retry_at: tsAgo(asOf, Math.floor(rng() * 3600000)),
      status,
      payload_size_bytes: Math.floor(256 + rng() * 3840),
      error_code: pick(ERROR_CODES, rng),
      recovery_action: status === 'resolved' ? 'Re-published to original topic after schema fix' : status === 'abandoned' ? 'Moved to cold storage; manual review required' : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — AI Event Insights
// ─────────────────────────────────────────────────────────────────────────────

export interface EventInsight {
  insight_id: string;
  type: InsightType;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  affected_topic: TopicName;
  confidence_score: number;
  recommendation: string;
  detected_at: string;
  metric_value: string;
}

const INSIGHT_TEMPLATES = [
  { type: 'anomaly' as InsightType,     sev: 'critical' as const, title: 'Alert Volume Spike Detected',       desc: 'risk.alerts topic volume increased 340% vs 7-day baseline. Potential MSME sector stress event or system error.', rec: 'Investigate source — check CBS feed for batch error vs genuine credit deterioration signal.' },
  { type: 'bottleneck' as InsightType,  sev: 'warning' as const,  title: 'Consumer Lag Growing on ai.decisions', desc: 'Board Reporting Engine consumer group lagging 840 messages. SLA breach risk in 12 minutes.', rec: 'Scale Board Reporting Engine consumer instances. Review processing logic for inefficiencies.' },
  { type: 'trend' as InsightType,       sev: 'info' as const,     title: 'Compliance Event Volume Trend',       desc: 'compliance.events volume growing 8% WoW consistently for 4 weeks — correlated with regulatory calendar.', rec: 'Pre-scale compliance topic partitions before quarter-end reporting deadline.' },
  { type: 'forecast' as InsightType,    sev: 'info' as const,     title: '30-Day Throughput Forecast Exceeds Plan', desc: 'Predicted 28% volume growth will saturate risk.alerts topic capacity by day 24.', rec: 'Add 4 partitions to risk.alerts. Review retention policy to free broker headroom.' },
  { type: 'anomaly' as InsightType,     sev: 'warning' as const,  title: 'High DLQ Rate on governance.audit',   desc: 'Dead letter rate 4.2× baseline — schema version mismatch post IAM Center upgrade.', rec: 'Roll back IAM Center to v3.1 or publish schema migration event to governance.audit.' },
  { type: 'trend' as InsightType,       sev: 'info' as const,     title: 'AI Decision Events Improving Quality', desc: 'ai.decisions confidence score p50 improved from 0.81 to 0.87 over 30 days — model retraining effective.', rec: 'Continue quarterly retraining cadence. Consider expanding champion model to shadow deployment.' },
];

const INSIGHT_TOPICS: Record<number, TopicName> = { 0: 'risk.alerts', 1: 'ai.decisions', 2: 'compliance.events', 3: 'risk.alerts', 4: 'governance.audit', 5: 'ai.decisions' };

export function buildEventInsights(tenant: string, asOf: Date): EventInsight[] {
  const rng = mulberry32(fnv1a(`${tenant}:insights:${dayKey(asOf)}`));
  return INSIGHT_TEMPLATES.map((tpl, i) => ({
    insight_id: `EI-${String(i + 1).padStart(3, '0')}`,
    type: tpl.type,
    severity: tpl.sev,
    title: tpl.title,
    description: tpl.desc,
    affected_topic: INSIGHT_TOPICS[i],
    confidence_score: r2(0.74 + rng() * 0.24),
    recommendation: tpl.rec,
    detected_at: tsAgo(asOf, Math.floor(rng() * 7200000)),
    metric_value: pick(['340% spike', '+840 lag', '+8% WoW', '+28% forecast', '4.2× baseline', '0.87 p50'], rng),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 10 — Executive Stream View
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutiveStreamView {
  enterprise_events_24h: number;
  critical_events_24h: number;
  event_health_score: number;
  top_risk_streams: Array<{ topic: TopicName; events: number; trend: 'up' | 'down' | 'stable'; critical_pct: number }>;
  compliance_stream_status: Array<{ topic: TopicName; events: number; sla_met_pct: number }>;
  ai_decision_streams: Array<{ metric: string; value: string; trend: 'up' | 'down' | 'stable' }>;
  event_volume_by_hour: Array<{ hour: string; total: number; critical: number }>;
  top_3_insights: string[];
  board_summary: string;
}

export function buildExecutiveStreamView(tenant: string, asOf: Date): ExecutiveStreamView {
  const rng = mulberry32(fnv1a(`${tenant}:exec-stream:${dayKey(asOf)}`));
  const totalEvents = Math.floor(85000 + rng() * 65000);
  const criticalEvents = Math.floor(totalEvents * 0.04 * (0.5 + rng()));

  return {
    enterprise_events_24h: totalEvents,
    critical_events_24h: criticalEvents,
    event_health_score: Math.floor(82 + rng() * 16),
    top_risk_streams: [
      { topic: 'risk.alerts', events: Math.floor(25000 + rng() * 15000), trend: 'up', critical_pct: r1(8 + rng() * 12) },
      { topic: 'ai.decisions', events: Math.floor(12000 + rng() * 8000), trend: 'stable', critical_pct: r1(3 + rng() * 6) },
      { topic: 'risk.cases', events: Math.floor(8000 + rng() * 5000), trend: 'stable', critical_pct: r1(5 + rng() * 8) },
    ],
    compliance_stream_status: [
      { topic: 'compliance.events', events: Math.floor(3000 + rng() * 2000), sla_met_pct: r2(97 + rng() * 2.8) },
      { topic: 'compliance.filings', events: Math.floor(800 + rng() * 400), sla_met_pct: r2(99 + rng() * 0.9) },
      { topic: 'governance.audit', events: Math.floor(5000 + rng() * 3000), sla_met_pct: r2(98 + rng() * 1.8) },
    ],
    ai_decision_streams: [
      { metric: 'Decisions / hour', value: String(Math.floor(420 + rng() * 280)), trend: 'up' },
      { metric: 'Avg confidence', value: `${r2(0.84 + rng() * 0.12)}`, trend: 'up' },
      { metric: 'Human override rate', value: `${r1(3 + rng() * 5)}%`, trend: 'down' },
      { metric: 'Automation rate', value: `${r1(92 + rng() * 6)}%`, trend: 'up' },
    ],
    event_volume_by_hour: Array.from({ length: 12 }, (_, i) => {
      const h = (asOf.getHours() - 11 + i + 24) % 24;
      const vol = Math.floor(3500 + rng() * 4500);
      return { hour: `${String(h).padStart(2, '0')}:00`, total: vol, critical: Math.floor(vol * 0.04 * rng()) };
    }),
    top_3_insights: [
      'Alert volume spike on risk.alerts — investigate MSME sector signal',
      'Consumer lag growing on ai.decisions Board Reporting feed — scale consumers',
      'compliance.events volume trending +8% WoW — pre-scale before quarter-end',
    ],
    board_summary: `The enterprise event bus processed ${totalEvents.toLocaleString('en-IN')} events in the last 24 hours with ${r2((1 - criticalEvents / totalEvents) * 100)}% success rate. Risk streams are operating within tolerance. AI decision pipeline throughput is improving (+12% WoW). One consumer lag alert requires immediate action on the Board Reporting feed. Event health score: ${Math.floor(82 + rng() * 16)}/100.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite KPIs
// ─────────────────────────────────────────────────────────────────────────────

export interface EventStreamingKpis {
  total_events_24h: number;
  events_per_minute: number;
  active_topics: number;
  active_publishers: number;
  active_subscribers: number;
  failure_rate_pct: number;
  dlq_size: number;
  avg_latency_ms: number;
  event_health_score: number;
  critical_events_24h: number;
}

export function buildStreamingKpis(tenant: string, asOf: Date): EventStreamingKpis {
  const dash = buildEventBusDashboard(tenant, asOf);
  const rng = mulberry32(fnv1a(`${tenant}:health:${dayKey(asOf)}`));
  return {
    total_events_24h: dash.total_events_24h,
    events_per_minute: dash.events_per_minute,
    active_topics: dash.active_topics,
    active_publishers: dash.active_publishers,
    active_subscribers: dash.active_subscribers,
    failure_rate_pct: dash.failure_rate_pct,
    dlq_size: dash.dlq_size,
    avg_latency_ms: dash.avg_latency_ms,
    event_health_score: Math.floor(82 + rng() * 16),
    critical_events_24h: Math.floor(dash.total_events_24h * 0.04),
  };
}
