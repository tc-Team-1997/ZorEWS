// services/bff/src/audit_volume_anomaly.ts
//
// T6 M15.22 — Audit event volume anomaly detection.
//
// Detects days with unusually high ("spike") or unusually low ("dip")
// audit event volume by computing a z-score against the per-day
// rolling distribution over the requested window.
//
// Algorithm: simple z-score over daily volumes within the window.
//   spike: daily_count > mean + 2 × std_dev
//   dip:   daily_count < mean - 2 × std_dev
//   severity: |z| > 3 → 'high', else → 'medium'
//
// Distinct from:
//   M15.7  — activity dow × hour heatmap (cyclic intraday, not anomaly)
//   M15.11 — daily volume timeline (trend line, no anomaly detection)
//   M15.13 — action prefix distribution (verb grouping, not time series)
//
// Pure rollup over the M15.1 AuditEvent array supplied by the caller.
// The route drains auditTrailStore with pagination.

import type { AuditEvent, AuditTrailStore } from './audit_trail';

// ─── Constants ────────────────────────────────────────────────────────

export const DEFAULT_ANOMALY_WINDOW_DAYS = 14;
export const MAX_ANOMALY_WINDOW_DAYS = 90;

// ─── Public types ─────────────────────────────────────────────────────

export type AnomalyType = 'spike' | 'dip';
export type AnomalySeverity = 'high' | 'medium';

export interface AuditVolumeAnomaly {
  /** YYYY-MM-DD in UTC. */
  date: string;
  volume: number;
  z_score: number;
  type: AnomalyType;
  severity: AnomalySeverity;
}

export interface AuditVolumeAnomalyReport {
  tenant_id: string;
  generated_at: string;
  window_days: number;
  mean_daily_volume: number;
  /** null when < 2 distinct days in window (cannot compute variance). */
  std_dev: number | null;
  anomaly_count: number;
  /** Anomaly entries sorted date desc (most recent first). */
  anomalies: AuditVolumeAnomaly[];
  /** Anomaly with the highest |z_score|. null when no anomalies. */
  most_anomalous_day: AuditVolumeAnomaly | null;
  /** True when today's volume (the latest day in the window) is anomalous. */
  is_currently_anomalous: boolean;
}

export class AuditVolumeAnomalyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AuditVolumeAnomalyError';
  }
}

// ─── Pure function ────────────────────────────────────────────────────

function toUtcDateStr(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

export function detectAuditVolumeAnomalies(
  tenant_id: string,
  events: AuditEvent[],
  window_days: number = DEFAULT_ANOMALY_WINDOW_DAYS,
  now: Date = new Date(),
): AuditVolumeAnomalyReport {
  if (!tenant_id) throw new AuditVolumeAnomalyError('invalid_input', 'tenant_id is required');
  if (!Number.isInteger(window_days) || window_days < 1 || window_days > MAX_ANOMALY_WINDOW_DAYS) {
    throw new AuditVolumeAnomalyError(
      'invalid_input',
      `window_days must be an integer between 1 and ${MAX_ANOMALY_WINDOW_DAYS}`,
    );
  }

  // Build day buckets for the window
  const todayStr = now.toISOString().slice(0, 10);
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - (window_days - 1));
  const windowStartStr = windowStart.toISOString().slice(0, 10);

  const dayCounts = new Map<string, number>();
  // Initialise all days in the window to 0
  for (let d = new Date(windowStart); d.toISOString().slice(0, 10) <= todayStr; d.setUTCDate(d.getUTCDate() + 1)) {
    dayCounts.set(d.toISOString().slice(0, 10), 0);
  }

  for (const event of events) {
    if (event.tenant_id !== tenant_id) continue;
    const date = toUtcDateStr(event.ts);
    if (!date || date < windowStartStr || date > todayStr) continue;
    dayCounts.set(date, (dayCounts.get(date) ?? 0) + 1);
  }

  const volumes = Array.from(dayCounts.values());
  const totalVolume = volumes.reduce((s, v) => s + v, 0);
  const mean_daily_volume = volumes.length > 0
    ? Math.round((totalVolume / volumes.length) * 100) / 100
    : 0;

  // Compute standard deviation (sample, Bessel's correction n-1)
  let std_dev: number | null = null;
  if (volumes.length >= 2) {
    const variance = volumes.reduce((s, v) => s + Math.pow(v - mean_daily_volume, 2), 0) / (volumes.length - 1);
    std_dev = Math.sqrt(variance);
  }

  const anomalies: AuditVolumeAnomaly[] = [];

  if (std_dev !== null && std_dev > 0) {
    for (const [date, volume] of dayCounts.entries()) {
      const z_score = (volume - mean_daily_volume) / std_dev;
      if (Math.abs(z_score) > 2) {
        const type: AnomalyType = z_score > 0 ? 'spike' : 'dip';
        const severity: AnomalySeverity = Math.abs(z_score) > 3 ? 'high' : 'medium';
        anomalies.push({
          date,
          volume,
          z_score: Math.round(z_score * 10000) / 10000,
          type,
          severity,
        });
      }
    }
  }

  // Sort by date desc (most recent first)
  anomalies.sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));

  const most_anomalous_day = anomalies.length > 0
    ? anomalies.reduce((max, a) =>
        Math.abs(a.z_score) > Math.abs(max.z_score) ? a : max,
      anomalies[0])
    : null;

  const is_currently_anomalous = anomalies.some(a => a.date === todayStr);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    window_days,
    mean_daily_volume,
    std_dev: std_dev !== null ? Math.round(std_dev * 100) / 100 : null,
    anomaly_count: anomalies.length,
    anomalies,
    most_anomalous_day,
    is_currently_anomalous,
  };
}

// ─── Store adapter ────────────────────────────────────────────────────

export function detectAuditVolumeAnomaliesFromStore(
  store: AuditTrailStore,
  tenant_id: string,
  window_days: number,
  now: Date,
): AuditVolumeAnomalyReport {
  const events: AuditEvent[] = [];
  const PAGE_SIZE = 500;
  const PAGE_CAP = 200;
  for (let page = 1; page <= PAGE_CAP; page++) {
    const result = store.list(tenant_id, { page, page_size: PAGE_SIZE });
    events.push(...result.items);
    if (result.items.length < PAGE_SIZE) break;
  }
  return detectAuditVolumeAnomalies(tenant_id, events, window_days, now);
}
