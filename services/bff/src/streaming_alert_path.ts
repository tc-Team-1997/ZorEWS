// services/bff/src/streaming_alert_path.ts
//
// T2.12.1 — Streaming indicator-event ledger + latency telemetry.
//
// The "real-time alert path" half of T2.12: the measurement layer that
// proves the EWS.docx §3.5 / SLOs.md tier-1 claim of `p95 indicator-
// observed-at → alert-created-at < 60s`. Accepts indicator-update
// events (today posted by tests / a future Kafka consumer; tomorrow
// directly by the indicator-engine streaming producer per Year-2
// Theme D), assigns a deterministic event_id, records ingest /
// processing / total latencies, and rolls them up into a p50/p95
// analytics view.
//
// Scope explicitly excludes the upstream Kafka producer (Year-2
// Theme D) and the downstream rule-evaluation hook (T2.12.2 follow-
// up — the rule store / alert producer wire-up sits at the BFF
// boundary and the existing alert routing path picks up from there).
// This module owns ONLY the latency telemetry contract — pure pipe.

import { linearPercentile } from './connector_run_analytics';

// ─── Types ────────────────────────────────────────────────────────────

/** Wire shape sent by the producer side. */
export interface StreamingIndicatorEventInput {
  /** Optional caller-supplied event id; if omitted we mint a
   *  deterministic `sie-<tenant>-<ts>-<seq>` per call. */
  event_id?: string;
  indicator_id: string;
  customer_id: string;
  value: number;
  /** ISO-8601 timestamp when the indicator value was observed by the
   *  upstream system (the clock the latency is measured against). */
  observed_at: string;
  /** Optional already-fired alert ids for the producer to record
   *  (when the producer composes evaluation + this ledger in one
   *  call). Defaults to []. */
  fired_alert_ids?: string[];
  /** Optional already-evaluated rule ids. */
  fired_rule_ids?: string[];
  /** Optional ISO timestamp the receiver got the event; defaults to
   *  `now`. The split `received_at` vs `processed_at` lets us
   *  separate transit latency from BFF processing latency. */
  received_at?: string;
}

/** Persisted record — all latencies in milliseconds (rounded). */
export interface StreamingProcessingRecord {
  event_id: string;
  tenant_id: string;
  indicator_id: string;
  customer_id: string;
  observed_at: string;
  received_at: string;
  processed_at: string;
  /** `received_at - observed_at` — producer → BFF transit. */
  ingest_latency_ms: number;
  /** `processed_at - received_at` — BFF receive → finished evaluating. */
  processing_latency_ms: number;
  /** `processed_at - observed_at` — full observed → finished. The
   *  SLO claim is `p95(total) < 60_000ms` per tier-1 docs/slos.md. */
  total_latency_ms: number;
  fired_alert_ids: string[];
  fired_rule_ids: string[];
}

/** Per-indicator-id rollup row. */
export interface IndicatorLatencyRow {
  indicator_id: string;
  count: number;
  /** Mean / p50 / p95 / max of `total_latency_ms` for this id. */
  mean_total_ms: number;
  median_total_ms: number;
  p95_total_ms: number;
  max_total_ms: number;
  count_under_60s: number;
  /** Fraction of this indicator's events that met the 60s budget.
   *  0..1; 1.0 = every event under the SLO. */
  percentage_under_60s: number;
}

export interface StreamingLatencySummary {
  tenant_id: string;
  generated_at: string;
  sample_size: number;
  /** Aggregate over `total_latency_ms` across every record. */
  mean_total_ms: number | null;
  median_total_ms: number | null;
  p95_total_ms: number | null;
  max_total_ms: number | null;
  min_total_ms: number | null;
  /** Same percentiles for the BFF-only processing component (handy
   *  when investigating "is the slow tail us, or upstream?"). */
  mean_processing_ms: number | null;
  p95_processing_ms: number | null;
  count_under_60s: number;
  count_over_60s: number;
  percentage_under_60s: number;
  /** True iff p95 of total_latency_ms < 60_000ms — the literal
   *  EWS.docx §3.5 / docs/slos.md tier-1 budget. */
  target_p95_60s_met: boolean;
  /** Per-indicator-id breakdown sorted by count desc + indicator_id
   *  asc tie-break. */
  by_indicator: IndicatorLatencyRow[];
  /** Total distinct indicator ids in the sample. */
  total_indicators: number;
  /** Convenience: most-recent record (newest processed_at) — null
   *  when empty. */
  most_recent_at: string | null;
  /** Oldest record in the sample. */
  oldest_at: string | null;
}

export class StreamingLedgerError extends Error {
  override name = 'StreamingLedgerError';
  constructor(
    public code:
      | 'invalid_input'
      | 'invalid_observed_at'
      | 'invalid_received_at'
      | 'invalid_value'
      | 'observed_in_future',
    message: string,
  ) {
    super(message);
  }
}

/** The 60s SLO budget per EWS.docx §3.5 / docs/slos.md tier-1. */
export const STREAMING_SLO_BUDGET_MS = 60_000;

// ─── Helpers ──────────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIso(s: string, code: 'invalid_observed_at' | 'invalid_received_at'): number {
  if (typeof s !== 'string' || !ISO_RE.test(s)) {
    throw new StreamingLedgerError(code, `${code}: malformed ISO-8601 timestamp`);
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) {
    throw new StreamingLedgerError(code, `${code}: unparseable timestamp`);
  }
  return ms;
}

function validateInput(input: unknown): asserts input is StreamingIndicatorEventInput {
  if (!input || typeof input !== 'object') {
    throw new StreamingLedgerError('invalid_input', 'event must be an object');
  }
  const e = input as Record<string, unknown>;
  if (typeof e.indicator_id !== 'string' || e.indicator_id.length === 0) {
    throw new StreamingLedgerError('invalid_input', 'indicator_id required');
  }
  if (typeof e.customer_id !== 'string' || e.customer_id.length === 0) {
    throw new StreamingLedgerError('invalid_input', 'customer_id required');
  }
  if (typeof e.value !== 'number' || !Number.isFinite(e.value)) {
    throw new StreamingLedgerError('invalid_value', 'value must be a finite number');
  }
  if (typeof e.observed_at !== 'string') {
    throw new StreamingLedgerError('invalid_observed_at', 'observed_at required');
  }
}

// ─── Pure processing ──────────────────────────────────────────────────

/** Builds a single record from a wire event. Pure — no ledger write,
 *  no side effects. The route handler wraps with the ledger insert. */
export function processStreamingEvent(
  input: StreamingIndicatorEventInput,
  ctx: {
    tenant_id: string;
    now: Date;
    /** Deterministic event_id seq when caller doesn't supply one. */
    seq: number;
  },
): StreamingProcessingRecord {
  validateInput(input);
  if (!ctx.tenant_id) {
    throw new StreamingLedgerError('invalid_input', 'tenant_id required');
  }

  const observedMs = parseIso(input.observed_at, 'invalid_observed_at');
  const nowMs = ctx.now.getTime();
  if (observedMs > nowMs) {
    throw new StreamingLedgerError(
      'observed_in_future',
      `observed_at ${input.observed_at} is in the future`,
    );
  }

  const receivedMs = input.received_at
    ? parseIso(input.received_at, 'invalid_received_at')
    : nowMs;
  const processedMs = nowMs;

  const ingest = Math.max(0, Math.round(receivedMs - observedMs));
  const processing = Math.max(0, Math.round(processedMs - receivedMs));
  const total = Math.max(0, Math.round(processedMs - observedMs));

  const eventId =
    typeof input.event_id === 'string' && input.event_id.length > 0
      ? input.event_id
      : `sie-${ctx.tenant_id}-${nowMs}-${ctx.seq}`;

  return {
    event_id: eventId,
    tenant_id: ctx.tenant_id,
    indicator_id: input.indicator_id,
    customer_id: input.customer_id,
    observed_at: input.observed_at,
    received_at: input.received_at ?? new Date(receivedMs).toISOString(),
    processed_at: ctx.now.toISOString(),
    ingest_latency_ms: ingest,
    processing_latency_ms: processing,
    total_latency_ms: total,
    fired_alert_ids: Array.isArray(input.fired_alert_ids) ? [...input.fired_alert_ids] : [],
    fired_rule_ids: Array.isArray(input.fired_rule_ids) ? [...input.fired_rule_ids] : [],
  };
}

// ─── Analytics ────────────────────────────────────────────────────────

export function summarizeStreamingLatency(
  tenant_id: string,
  records: ReadonlyArray<StreamingProcessingRecord>,
  now: Date,
): StreamingLatencySummary {
  const generated_at = now.toISOString();
  const sample_size = records.length;

  if (sample_size === 0) {
    return {
      tenant_id,
      generated_at,
      sample_size: 0,
      mean_total_ms: null,
      median_total_ms: null,
      p95_total_ms: null,
      max_total_ms: null,
      min_total_ms: null,
      mean_processing_ms: null,
      p95_processing_ms: null,
      count_under_60s: 0,
      count_over_60s: 0,
      percentage_under_60s: 0,
      target_p95_60s_met: true, // vacuously true on empty sample
      by_indicator: [],
      total_indicators: 0,
      most_recent_at: null,
      oldest_at: null,
    };
  }

  const totals = records.map((r) => r.total_latency_ms);
  const processings = records.map((r) => r.processing_latency_ms);
  const sortedTotals = [...totals].sort((a, b) => a - b);
  const sortedProcs = [...processings].sort((a, b) => a - b);

  const mean = (arr: number[]) =>
    Math.round(arr.reduce((s, n) => s + n, 0) / arr.length);

  const count_under = totals.filter((t) => t < STREAMING_SLO_BUDGET_MS).length;
  const count_over = sample_size - count_under;
  const percentage = Math.round((count_under / sample_size) * 10_000) / 10_000;

  const p95Total = Math.round(linearPercentile(sortedTotals, 0.95) ?? 0);
  const target_p95_60s_met = p95Total < STREAMING_SLO_BUDGET_MS;

  // Per-indicator breakdown.
  const byIndMap = new Map<string, StreamingProcessingRecord[]>();
  for (const r of records) {
    const arr = byIndMap.get(r.indicator_id);
    if (arr) arr.push(r);
    else byIndMap.set(r.indicator_id, [r]);
  }
  const by_indicator: IndicatorLatencyRow[] = [];
  for (const [indicator_id, rows] of byIndMap.entries()) {
    const ind_totals = rows.map((r) => r.total_latency_ms);
    const ind_sorted = [...ind_totals].sort((a, b) => a - b);
    const ind_under = ind_totals.filter((t) => t < STREAMING_SLO_BUDGET_MS).length;
    by_indicator.push({
      indicator_id,
      count: rows.length,
      mean_total_ms: mean(ind_totals),
      median_total_ms: Math.round(linearPercentile(ind_sorted, 0.5) ?? 0),
      p95_total_ms: Math.round(linearPercentile(ind_sorted, 0.95) ?? 0),
      max_total_ms: ind_sorted[ind_sorted.length - 1] ?? 0,
      count_under_60s: ind_under,
      percentage_under_60s: Math.round((ind_under / rows.length) * 10_000) / 10_000,
    });
  }
  // Sort by count desc + indicator_id asc tie-break.
  by_indicator.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.indicator_id.localeCompare(b.indicator_id);
  });

  // Recency.
  let most_recent_at = records[0].processed_at;
  let oldest_at = records[0].processed_at;
  for (const r of records) {
    if (r.processed_at > most_recent_at) most_recent_at = r.processed_at;
    if (r.processed_at < oldest_at) oldest_at = r.processed_at;
  }

  return {
    tenant_id,
    generated_at,
    sample_size,
    mean_total_ms: mean(totals),
    median_total_ms: Math.round(linearPercentile(sortedTotals, 0.5) ?? 0),
    p95_total_ms: p95Total,
    max_total_ms: sortedTotals[sortedTotals.length - 1],
    min_total_ms: sortedTotals[0],
    mean_processing_ms: mean(processings),
    p95_processing_ms: Math.round(linearPercentile(sortedProcs, 0.95) ?? 0),
    count_under_60s: count_under,
    count_over_60s: count_over,
    percentage_under_60s: percentage,
    target_p95_60s_met,
    by_indicator,
    total_indicators: byIndMap.size,
    most_recent_at,
    oldest_at,
  };
}

// ─── Ledger ───────────────────────────────────────────────────────────

export interface StreamingLedger {
  record(rec: StreamingProcessingRecord): void;
  list(tenant_id: string, limit?: number): StreamingProcessingRecord[];
  /** Test helper / future-pg-store hook. */
  clear(tenant_id?: string): void;
}

const STREAMING_LEDGER_CAP_PER_TENANT = 1000;

export class InMemoryStreamingLedger implements StreamingLedger {
  private byTenant = new Map<string, StreamingProcessingRecord[]>();

  record(rec: StreamingProcessingRecord): void {
    const arr = this.byTenant.get(rec.tenant_id) ?? [];
    arr.push(rec);
    // Evict oldest first when over cap.
    if (arr.length > STREAMING_LEDGER_CAP_PER_TENANT) {
      arr.splice(0, arr.length - STREAMING_LEDGER_CAP_PER_TENANT);
    }
    this.byTenant.set(rec.tenant_id, arr);
  }

  list(tenant_id: string, limit?: number): StreamingProcessingRecord[] {
    const arr = this.byTenant.get(tenant_id) ?? [];
    // Newest-first.
    const sorted = [...arr].reverse();
    if (typeof limit === 'number' && limit > 0) return sorted.slice(0, limit);
    return sorted;
  }

  clear(tenant_id?: string): void {
    if (tenant_id) this.byTenant.delete(tenant_id);
    else this.byTenant.clear();
  }
}

let _default: StreamingLedger | null = null;
export function defaultStreamingLedger(): StreamingLedger {
  if (!_default) _default = new InMemoryStreamingLedger();
  return _default;
}
export function _resetDefaultStreamingLedger(): void {
  _default = null;
}
