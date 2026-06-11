// services/bff/src/audit_volume_forecast.ts
// T6 M15.29 — Audit event volume forecasting.

import { defaultAuditTrailStore, type AuditTrailStore } from './audit_trail';

const CAPACITY_CAP = 5000;
const CAPACITY_WARN_THRESHOLD = 0.9;

export interface AuditVolumeForecastResult {
  tenant_id: string;
  generated_at: string;
  current_total_events: number;
  events_last_7_days: number[];
  trend_slope: number;
  next_7_days_forecast: number[];
  predicted_30day_total: number;
  capacity_warning: boolean;
  days_until_capacity: number | null;
}

function leastSquaresSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (ys[i] - meanY);
    den += (i - meanX) * (i - meanX);
  }
  return den === 0 ? 0 : num / den;
}

export function buildAuditVolumeForecast(
  tenant_id: string,
  now: Date,
  store: AuditTrailStore = defaultAuditTrailStore,
): AuditVolumeForecastResult {
  if (!tenant_id) throw new Error('tenant_id required');

  // Drain all events for this tenant
  const page = store.list(tenant_id, { page_size: 5000 });
  const events = page.items;
  const current_total_events = events.length;

  // Bucket by UTC day for last 7 days
  const nowMs = now.getTime();
  const DAY_MS = 86400000;
  const events_last_7_days: number[] = new Array(7).fill(0);

  for (const e of events) {
    const ageMs = nowMs - new Date(e.ts).getTime();
    const dayIdx = Math.floor(ageMs / DAY_MS);
    if (dayIdx >= 0 && dayIdx < 7) {
      // day 0 = today, day 6 = 6 days ago
      // We want array[0] = 6 days ago, array[6] = today
      events_last_7_days[6 - dayIdx]++;
    }
  }

  const trend_slope = Math.round(leastSquaresSlope(events_last_7_days) * 100) / 100;
  const mean_count = events_last_7_days.reduce((s, v) => s + v, 0) / 7;

  // Forecast next 7 days: index 0 = tomorrow, index 6 = 7 days from now
  // forecast[d] = max(0, round(mean + slope * (d - 3)))
  const next_7_days_forecast: number[] = [];
  for (let d = 0; d < 7; d++) {
    const predicted = Math.max(0, Math.round(mean_count + trend_slope * (d - 3)));
    next_7_days_forecast.push(predicted);
  }

  // 30-day predicted total
  const forecast_30: number[] = [];
  for (let d = 0; d < 30; d++) {
    forecast_30.push(Math.max(0, Math.round(mean_count + trend_slope * (d - 15))));
  }
  const predicted_30day_total = forecast_30.reduce((s, v) => s + v, 0);

  const capacity_warning =
    predicted_30day_total + current_total_events > CAPACITY_CAP * CAPACITY_WARN_THRESHOLD;

  let days_until_capacity: number | null = null;
  if (capacity_warning && trend_slope > 0) {
    const remaining = CAPACITY_CAP - current_total_events;
    days_until_capacity = Math.max(
      1,
      Math.ceil(remaining / Math.max(0.1, mean_count + trend_slope * 7)),
    );
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    current_total_events,
    events_last_7_days,
    trend_slope,
    next_7_days_forecast,
    predicted_30day_total,
    capacity_warning,
    days_until_capacity,
  };
}
