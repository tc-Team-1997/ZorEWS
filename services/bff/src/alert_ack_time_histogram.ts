// services/bff/src/alert_ack_time_histogram.ts
//
// T6 M8.12 — Alert ack-time histogram.
//
// M8.6 ships routing analytics with time-to-ack percentiles in the
// envelope (min / mean / p50 / p95 / max). M8.11 ships per-alert
// breach detail with SLA-relative classification (acked_on_time /
// acked_late / open_breached / …). M8.12 ships the THIRD lens on
// the same routing-ledger data: a wall-clock ABSOLUTE-time
// histogram bucketing every record into one of 6 latency bands.
//
// Where M8.11 answers "did this alert MEET its SLA?", M8.12 answers
// "how fast do we typically ack in wall-clock time?" — useful for
// the SPA's "operational responsiveness" tile and for spotting
// drift when SLA windows are tuned.
//
// 6 buckets: under_1h / 1_to_4h / 4_to_24h / 24h_plus / still_open /
// monitor_only. Per-bucket sample list (top 3) helps the SPA drill
// into the longest-running rows.
//
// Pure rollup over RoutedAlertRecord[] + now. The route drains the
// existing routing ledger; no new persistence surface.

import type { RoutedAlertRecord } from './alert_routing_analytics';
import { linearPercentile } from './connector_run_analytics';

// ─── Constants ────────────────────────────────────────────────────────

const MS_PER_HOUR = 60 * 60 * 1000;

const BUCKET_BOUNDS = {
  under_1h: { min: 0, max: 1 * MS_PER_HOUR },
  '1_to_4h': { min: 1 * MS_PER_HOUR, max: 4 * MS_PER_HOUR },
  '4_to_24h': { min: 4 * MS_PER_HOUR, max: 24 * MS_PER_HOUR },
  '24h_plus': { min: 24 * MS_PER_HOUR, max: Infinity },
} as const;

export const ACK_TIME_BUCKETS = [
  'under_1h',
  '1_to_4h',
  '4_to_24h',
  '24h_plus',
  'still_open',
  'monitor_only',
] as const;

export type AckTimeBucketKey = (typeof ACK_TIME_BUCKETS)[number];

const SAMPLE_CAP = 3;

// ─── Public types ─────────────────────────────────────────────────────

export interface AckTimeSampleRow {
  alert_id: string;
  ack_ms: number | null;
  /** Wall-clock age — for still_open this is now − created. */
  age_ms: number;
}

export interface AckTimeBucket {
  bucket: AckTimeBucketKey;
  /** Bucket lower bound in ms. 0 for still_open + monitor_only. */
  min_ms: number;
  /** Bucket upper bound in ms (exclusive). Infinity for the top
   *  acked bucket. null for still_open + monitor_only. */
  max_ms: number | null;
  count: number;
  /** Top-3 samples in this bucket. Sorted differently per bucket:
   *    - acked buckets (under_1h..24h_plus): newest-first by acked_at
   *    - still_open: oldest-first by created_at (longest-waiting)
   *    - monitor_only: newest-first by created_at
   *  Always capped at 3. */
  samples: AckTimeSampleRow[];
}

export interface AlertAckTimeHistogramSummary {
  tenant_id: string;
  generated_at: string;
  /** Newest-first window the resolver scanned. */
  window: number;
  total_records: number;
  /** Records with acked_at != null AND non-monitor. */
  total_acked: number;
  /** Records still open AND non-monitor. */
  total_still_open: number;
  /** Records in green / monitor_only class. */
  total_monitor_only: number;
  /** Mean of ack_ms across the `total_acked` rows. null when no acks. */
  mean_ack_ms: number | null;
  median_ack_ms: number | null;
  p95_ack_ms: number | null;
  /** Highest-count bucket. Tie-broken by ACK_TIME_BUCKETS canonical
   *  order (under_1h wins over 1_to_4h at same count). null when no records. */
  peak_bucket: AckTimeBucketKey | null;
  /** Always 6 buckets in canonical order. */
  buckets: AckTimeBucket[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

function ackMs(rec: RoutedAlertRecord): number | null {
  if (rec.acked_at === null) return null;
  const created = new Date(rec.created_at).getTime();
  const acked = new Date(rec.acked_at).getTime();
  return Math.max(0, acked - created);
}

function ageMs(rec: RoutedAlertRecord, now: Date): number {
  const created = new Date(rec.created_at).getTime();
  return Math.max(0, now.getTime() - created);
}

function classifyBucket(
  rec: RoutedAlertRecord,
  ms: number | null,
): AckTimeBucketKey {
  if (rec.monitor_only) return 'monitor_only';
  if (ms === null) return 'still_open';
  // Acked. Use strict-< upper to keep boundary semantics consistent
  // (1h exactly → falls into 1_to_4h; 4h exactly → 4_to_24h; etc).
  if (ms < BUCKET_BOUNDS.under_1h.max) return 'under_1h';
  if (ms < BUCKET_BOUNDS['1_to_4h'].max) return '1_to_4h';
  if (ms < BUCKET_BOUNDS['4_to_24h'].max) return '4_to_24h';
  return '24h_plus';
}

function emptyBucket(key: AckTimeBucketKey): AckTimeBucket {
  if (key === 'still_open' || key === 'monitor_only') {
    return { bucket: key, min_ms: 0, max_ms: null, count: 0, samples: [] };
  }
  const bounds = BUCKET_BOUNDS[key];
  return {
    bucket: key,
    min_ms: bounds.min,
    max_ms: bounds.max === Infinity ? Infinity : bounds.max,
    count: 0,
    samples: [],
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeAlertAckTime(
  tenant_id: string,
  records: readonly RoutedAlertRecord[],
  window: number,
  now: Date,
): AlertAckTimeHistogramSummary {
  const bucketMap = new Map<AckTimeBucketKey, AckTimeBucket>();
  for (const key of ACK_TIME_BUCKETS) bucketMap.set(key, emptyBucket(key));

  // Per-bucket sample collector. Different sort orders per bucket
  // (defined in AckTimeBucket.samples comment); for acked buckets +
  // monitor_only sort newest-first by the relevant timestamp; for
  // still_open sort oldest-first by created_at.
  const samplesByBucket = new Map<AckTimeBucketKey, AckTimeSampleRow[]>();
  for (const key of ACK_TIME_BUCKETS) samplesByBucket.set(key, []);

  const ackedDurations: number[] = [];
  let total_acked = 0;
  let total_still_open = 0;
  let total_monitor_only = 0;

  for (const rec of records) {
    const ms = ackMs(rec);
    const age = ageMs(rec, now);
    const bucket = classifyBucket(rec, ms);
    const target = bucketMap.get(bucket)!;
    target.count++;

    samplesByBucket.get(bucket)!.push({
      alert_id: rec.alert_id,
      ack_ms: ms,
      age_ms: age,
    });

    if (rec.monitor_only) {
      total_monitor_only++;
    } else if (ms === null) {
      total_still_open++;
    } else {
      total_acked++;
      ackedDurations.push(ms);
    }
  }

  // Finalise samples per bucket.
  for (const key of ACK_TIME_BUCKETS) {
    const all = samplesByBucket.get(key)!;
    let sorted: AckTimeSampleRow[];
    if (key === 'still_open') {
      // Oldest waiting first.
      sorted = [...all].sort((a, b) => b.age_ms - a.age_ms);
    } else if (key === 'monitor_only') {
      // Newest first by age (= oldest age desc; smaller age = newer record).
      // Use age asc → newer creation first.
      sorted = [...all].sort((a, b) => a.age_ms - b.age_ms);
    } else {
      // Acked buckets: smallest ack_ms first (fastest acks at top, less
      // surprising than newest-first when investigating "did we ack well?").
      sorted = [...all].sort((a, b) => (a.ack_ms ?? 0) - (b.ack_ms ?? 0));
    }
    bucketMap.get(key)!.samples = sorted.slice(0, SAMPLE_CAP);
  }

  // Aggregate percentiles over acked durations.
  const sortedDurations = [...ackedDurations].sort((a, b) => a - b);
  const mean_ack_ms = ackedDurations.length > 0
    ? Math.round(ackedDurations.reduce((a, b) => a + b, 0) / ackedDurations.length)
    : null;
  const median_ack_ms = ackedDurations.length > 0
    ? Math.round(linearPercentile(sortedDurations, 0.5) ?? 0)
    : null;
  const p95_ack_ms = ackedDurations.length > 0
    ? Math.round(linearPercentile(sortedDurations, 0.95) ?? 0)
    : null;

  // peak_bucket: highest count; ties broken by canonical order
  // (under_1h wins over 1_to_4h at same count).
  let peak_bucket: AckTimeBucketKey | null = null;
  let peakCount = 0;
  for (const key of ACK_TIME_BUCKETS) {
    const b = bucketMap.get(key)!;
    if (b.count > peakCount) {
      peakCount = b.count;
      peak_bucket = key;
    }
  }
  if (peakCount === 0) peak_bucket = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    window,
    total_records: records.length,
    total_acked,
    total_still_open,
    total_monitor_only,
    mean_ack_ms,
    median_ack_ms,
    p95_ack_ms,
    peak_bucket,
    buckets: ACK_TIME_BUCKETS.map((k) => bucketMap.get(k)!),
  };
}
