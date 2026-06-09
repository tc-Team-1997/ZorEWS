// services/bff/src/alert_volume_forecast.ts
//
// T6 M8.19 — Alert volume 7-day forecast.
//
// Uses the M8.6 routing ledger to project forward-looking alert volume.
// Groups records by UTC date, computes trailing moving averages,
// extrapolates a 7-day forecast, and signals whether the trend is
// rising, falling, or stable.
//
// Distinct from M8.15 (daily volume TREND — backward-looking) by being
// FORWARD-LOOKING. Uses the last 7 + 14 days of ledger data to
// produce a simple moving-average projection (suitable for a prototype;
// production would use time-series ML).
//
// Drives "should we staff up for next week?" capacity planning.

import type { RoutedAlertRecord } from './alert_routing_analytics';
import type { BilAlertClass } from './bil_alert_classification';

// ─── Constants ─────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ALL_CLASSES: readonly BilAlertClass[] = ['red', 'orange', 'yellow', 'green'] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface AlertVolumeForecast {
  tenant_id: string;
  generated_at: string;
  /** Mean daily alert count over the last 7 days. */
  historical_7d_avg: number;
  /** Mean daily alert count over the last 14 days. */
  historical_14d_avg: number;
  /** Projected daily alert count for the next 7 days (moving average). */
  forecast_next_7d: number;
  /** Trend direction based on 7d vs 14d comparison. */
  trend: 'rising' | 'falling' | 'stable';
  /** (7d_avg - 14d_avg) / 14d_avg; null when 14d_avg = 0. */
  trend_pct_change: number | null;
  /** Data confidence based on available history. */
  confidence: 'high' | 'medium' | 'low';
  /** Number of data points used (unique days with at least 1 record). */
  data_points: number;
  /** Per-class proportional forecast for next 7 days.
   *  Derived from the recent class distribution. */
  by_class_forecast: Record<BilAlertClass, number>;
  /** Optional warning when forecast signals an unusual condition. */
  warning: string | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function utcDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function emptyByClass(): Record<BilAlertClass, number> {
  return { red: 0, orange: 0, yellow: 0, green: 0 };
}

// ─── Implementation ─────────────────────────────────────────────────────

export function buildAlertVolumeForecast(
  tenant_id: string,
  records: readonly RoutedAlertRecord[],
  now: Date,
): AlertVolumeForecast {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('tenant_id is required');
  }

  const todayStart = startOfUtcDay(now).getTime();

  // Bucket records by UTC date
  const dailyCounts = new Map<string, number>();
  const dailyClassCounts = new Map<string, Record<BilAlertClass, number>>();

  for (const r of records) {
    const createdMs = new Date(r.created_at).getTime();
    if (isNaN(createdMs)) continue;
    // Only records from the last 14 days contribute to our windows
    if (createdMs >= todayStart) continue; // exclude today (in-progress)
    const dateKey = utcDateStr(new Date(createdMs));
    dailyCounts.set(dateKey, (dailyCounts.get(dateKey) ?? 0) + 1);
    if (!dailyClassCounts.has(dateKey)) {
      dailyClassCounts.set(dateKey, emptyByClass());
    }
    const cc = dailyClassCounts.get(dateKey)!;
    if (ALL_CLASSES.includes(r.class as BilAlertClass)) {
      cc[r.class as BilAlertClass]++;
    }
  }

  // Build windows of the past 7 and 14 days (not including today)
  const days7: number[] = [];
  const days14: number[] = [];
  const classTotals = emptyByClass();

  for (let d = 1; d <= 14; d++) {
    const dayStart = new Date(todayStart - d * MS_PER_DAY);
    const key = utcDateStr(dayStart);
    const count = dailyCounts.get(key) ?? 0;
    days14.push(count);
    if (d <= 7) {
      days7.push(count);
      // Accumulate class totals from the last 7 days
      const cc = dailyClassCounts.get(key);
      if (cc) {
        for (const cls of ALL_CLASSES) {
          classTotals[cls] += cc[cls];
        }
      }
    }
  }

  const sum7 = days7.reduce((a, b) => a + b, 0);
  const sum14 = days14.reduce((a, b) => a + b, 0);
  const historical_7d_avg = Math.round((sum7 / 7) * 100) / 100;
  const historical_14d_avg = Math.round((sum14 / 14) * 100) / 100;
  const forecast_next_7d = historical_7d_avg;

  // Trend
  let trend: 'rising' | 'falling' | 'stable';
  let trend_pct_change: number | null;
  if (historical_14d_avg === 0) {
    trend = 'stable';
    trend_pct_change = null;
  } else {
    const ratio = (historical_7d_avg - historical_14d_avg) / historical_14d_avg;
    trend_pct_change = Math.round(ratio * 10_000) / 10_000;
    if (ratio > 0.1) trend = 'rising';
    else if (ratio < -0.1) trend = 'falling';
    else trend = 'stable';
  }

  // Confidence
  const data_points = dailyCounts.size;
  let confidence: 'high' | 'medium' | 'low';
  if (data_points >= 14) confidence = 'high';
  else if (data_points >= 7) confidence = 'medium';
  else confidence = 'low';

  // Per-class forecast (proportional from recent distribution)
  const total7 = sum7;
  const by_class_forecast = emptyByClass();
  if (total7 > 0) {
    for (const cls of ALL_CLASSES) {
      const proportion = classTotals[cls] / total7;
      by_class_forecast[cls] = Math.round(forecast_next_7d * proportion * 100) / 100;
    }
  }

  // Warning
  let warning: string | null = null;
  if (historical_14d_avg > 0 && forecast_next_7d >= historical_14d_avg * 1.5 && trend === 'rising') {
    warning = 'Unusual spike predicted: forecast exceeds 1.5× historical 14-day average with rising trend.';
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    historical_7d_avg,
    historical_14d_avg,
    forecast_next_7d,
    trend,
    trend_pct_change,
    confidence,
    data_points,
    by_class_forecast,
    warning,
  };
}
