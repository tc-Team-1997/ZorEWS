// services/bff/src/alert_volume_spike.ts
//
// T6 M8.25 — Alert volume spike predictor.
//
// From the routing ledger (last 200 records), compute per-hour alert
// volume bucketed to the nearest UTC hour. Detect spike hours where
// count > mean + 2*std_dev.
//
// Also predict next_24h_predicted_volume = mean * 24 (rounded).
//
// Route: GET /v1/alerts/volume-spike-prediction
//   RBAC: audit:read (admin)

import { defaultRoutingLedger, type RoutingLedger } from './alert_routing_analytics';

// ─── Public types ─────────────────────────────────────────────────────

export type VolumeSpikeRiskLevel = 'normal' | 'elevated' | 'high_risk';

export interface AlertVolumeSpikeReport {
  tenant_id: string;
  generated_at: string;
  hourly_counts: number[];
  mean_per_hour: number;
  std_dev: number;
  spike_hours: number[];
  next_24h_predicted: number;
  risk_level: VolumeSpikeRiskLevel;
}

function stdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const variance =
    values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function riskLevel(spike_count: number): VolumeSpikeRiskLevel {
  if (spike_count >= 3) return 'high_risk';
  if (spike_count >= 1) return 'elevated';
  return 'normal';
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildAlertVolumeSpikePrediction(
  ledger: RoutingLedger,
  tenant_id: string,
  now: Date,
): AlertVolumeSpikeReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const records = ledger.list(tenant_id, 200);
  const nowMs = now.getTime();
  const WINDOW_MS = 24 * 60 * 60 * 1000;

  // 24 buckets for last 24 hours
  const hourly_counts = new Array<number>(24).fill(0);

  for (const r of records) {
    const createdMs = new Date(r.created_at).getTime();
    const ageMs = nowMs - createdMs;
    if (ageMs < 0 || ageMs >= WINDOW_MS) continue;
    // Which hour ago (0=most recent, 23=oldest in window)?
    // We'll use absolute UTC hour of the event
    const hourIndex = new Date(r.created_at).getUTCHours();
    hourly_counts[hourIndex]++;
  }

  const total = hourly_counts.reduce((s, c) => s + c, 0);
  const mean_per_hour = Math.round((total / 24) * 100) / 100;
  const std = Math.round(stdDev(hourly_counts, mean_per_hour) * 100) / 100;

  const spike_hours: number[] = [];
  const threshold = mean_per_hour + 2 * std;
  for (let h = 0; h < 24; h++) {
    if (std > 0 && hourly_counts[h] > threshold) {
      spike_hours.push(h);
    }
  }

  const next_24h_predicted = Math.round(mean_per_hour * 24);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    hourly_counts,
    mean_per_hour,
    std_dev: std,
    spike_hours,
    next_24h_predicted,
    risk_level: riskLevel(spike_hours.length),
  };
}
