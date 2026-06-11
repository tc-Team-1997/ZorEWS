// services/bff/src/alert_burst_detection.ts
//
// T6 M8.21 — Alert burst detection.
//
// Groups routed alert records from the M8.6 routing ledger into 5-minute
// buckets and flags buckets where count > mean + 2*std_dev as "bursts".
// Useful for ops to spot sudden spikes in alert volume (network incidents,
// upstream data quality issues, rule changes).

import type { RoutedAlertRecord } from './alert_routing_analytics';
import type { BilAlertClass } from './bil_alert_classification';

// ─── Public types ──────────────────────────────────────────────────────

export interface BurstBucket {
  /** ISO timestamp of the 5-minute bucket start. */
  bucket_start: string;
  count: number;
  severity_breakdown: { red: number; orange: number; yellow: number; green: number };
}

export interface AlertBurstDetection {
  tenant_id: string;
  generated_at: string;
  window: number;
  total_records: number;
  /** Mean alerts per 5-min bucket, rounded 4 decimals. */
  mean_per_5min: number;
  /** Population std dev. null when < 2 buckets. */
  std_dev: number | null;
  /** mean + 2*std_dev. null when std_dev is null. */
  burst_threshold: number;
  /** Number of buckets that exceed burst_threshold. */
  burst_count: number;
  /** Buckets that exceeded the threshold, sorted count desc. */
  bursts: BurstBucket[];
  /** Count of records in the most-recent 5-minute bucket. */
  current_5min_count: number;
  /** Whether the most-recent 5-min bucket is itself a burst. */
  is_currently_bursting: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const BUCKET_MS = 5 * 60 * 1000; // 5 minutes

function bucketKey(ts: number): number {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

// ─── Pure function ─────────────────────────────────────────────────────

/**
 * buildAlertBurstDetection
 *
 * @param tenant_id  caller's tenant
 * @param records    RoutedAlertRecord[] from routingLedger.list
 * @param window     number of records consumed (echoed in envelope)
 * @param now        current Date
 */
export function buildAlertBurstDetection(
  tenant_id: string,
  records: readonly RoutedAlertRecord[],
  window: number,
  now: Date,
): AlertBurstDetection {
  const nowMs = now.getTime();

  // Build 5-min bucket map
  const bucketMap = new Map<number, { count: number; red: number; orange: number; yellow: number; green: number }>();

  for (const r of records) {
    if (r.tenant_id !== tenant_id) continue;
    const ts = Date.parse(r.created_at);
    if (!Number.isFinite(ts)) continue;
    const key = bucketKey(ts);
    let slot = bucketMap.get(key);
    if (!slot) {
      slot = { count: 0, red: 0, orange: 0, yellow: 0, green: 0 };
      bucketMap.set(key, slot);
    }
    slot.count++;
    const cls = r.class as BilAlertClass;
    if (cls === 'red') slot.red++;
    else if (cls === 'orange') slot.orange++;
    else if (cls === 'yellow') slot.yellow++;
    else if (cls === 'green') slot.green++;
  }

  const counts = [...bucketMap.values()].map((b) => b.count);
  const n = counts.length;
  const total_records = records.filter((r) => r.tenant_id === tenant_id).length;

  let mean_per_5min = 0;
  let std_dev: number | null = null;
  let burst_threshold = 0;

  if (n > 0) {
    mean_per_5min = Math.round((counts.reduce((s, c) => s + c, 0) / n) * 10000) / 10000;
  }

  if (n >= 2) {
    const variance =
      counts.reduce((s, c) => s + (c - mean_per_5min) * (c - mean_per_5min), 0) / n;
    std_dev = Math.round(Math.sqrt(variance) * 10000) / 10000;
    burst_threshold = mean_per_5min + 2 * std_dev;
  }

  // Identify burst buckets
  const burstBuckets: BurstBucket[] = [];
  for (const [key, slot] of bucketMap.entries()) {
    if (std_dev !== null && slot.count > burst_threshold) {
      burstBuckets.push({
        bucket_start: new Date(key).toISOString(),
        count: slot.count,
        severity_breakdown: { red: slot.red, orange: slot.orange, yellow: slot.yellow, green: slot.green },
      });
    }
  }
  burstBuckets.sort((a, b) => b.count - a.count);

  // Current 5-min bucket
  const currentKey = bucketKey(nowMs);
  const currentSlot = bucketMap.get(currentKey);
  const current_5min_count = currentSlot?.count ?? 0;
  const is_currently_bursting =
    std_dev !== null && current_5min_count > burst_threshold;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    window,
    total_records,
    mean_per_5min,
    std_dev,
    burst_threshold: std_dev !== null ? Math.round(burst_threshold * 10000) / 10000 : 0,
    burst_count: burstBuckets.length,
    bursts: burstBuckets,
    current_5min_count,
    is_currently_bursting,
  };
}
