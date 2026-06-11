/**
 * M8.24 — Alert noise ratio by indicator
 * Analyses the routing ledger to estimate noise (very fast acks).
 */

import { defaultRoutingLedger } from './alert_routing_analytics';

const NOISE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

const BIL_CLASSES = ['red', 'orange', 'yellow', 'green'] as const;
type BilClass = (typeof BIL_CLASSES)[number];

export interface ClassNoiseStats {
  class: BilClass;
  total: number;
  noise_count: number;
  signal_count: number;
  noise_ratio: number;
}

export interface AlertNoiseRatioReport {
  tenant_id: string;
  generated_at: string;
  total_analyzed: number;
  overall_noise_ratio: number;
  by_class: ClassNoiseStats[];
  noisiest_class: string | null;
  signal_classes: string[];
}

export function buildAlertNoiseRatio(
  tenant_id: string,
  now: Date = new Date(),
): AlertNoiseRatioReport {
  if (!tenant_id) throw new Error('tenant_id required');

  const records = defaultRoutingLedger.list(tenant_id, 200);

  const classCounts: Record<
    BilClass,
    { total: number; noise: number; signal: number }
  > = {
    red:    { total: 0, noise: 0, signal: 0 },
    orange: { total: 0, noise: 0, signal: 0 },
    yellow: { total: 0, noise: 0, signal: 0 },
    green:  { total: 0, noise: 0, signal: 0 },
  };

  for (const record of records) {
    const cls = record.class as BilClass;
    if (!classCounts[cls]) continue;

    classCounts[cls].total++;

    if (record.acked_at) {
      const ack_time =
        new Date(record.acked_at).getTime() - new Date(record.created_at).getTime();
      if (ack_time < NOISE_THRESHOLD_MS) {
        classCounts[cls].noise++;
      } else {
        classCounts[cls].signal++;
      }
    } else {
      classCounts[cls].signal++;
    }
  }

  const by_class: ClassNoiseStats[] = BIL_CLASSES.map((cls) => {
    const c = classCounts[cls];
    const noise_ratio = c.total > 0 ? c.noise / c.total : 0;
    return {
      class: cls,
      total: c.total,
      noise_count: c.noise,
      signal_count: c.signal,
      noise_ratio,
    };
  });

  const total_analyzed = records.length;
  const total_noise = by_class.reduce((s, c) => s + c.noise_count, 0);
  const overall_noise_ratio = total_analyzed > 0 ? total_noise / total_analyzed : 0;

  const with_data = by_class.filter((c) => c.total > 0);
  const noisiest_class =
    with_data.length > 0
      ? with_data.reduce((best, c) => (c.noise_ratio > best.noise_ratio ? c : best), with_data[0])
          .class
      : null;

  const signal_classes = by_class
    .filter((c) => c.noise_ratio < 0.2)
    .map((c) => c.class);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_analyzed,
    overall_noise_ratio,
    by_class,
    noisiest_class,
    signal_classes,
  };
}
