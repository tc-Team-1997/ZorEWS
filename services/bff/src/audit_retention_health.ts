/**
 * M15.25 — Audit log retention health check
 * Checks audit trail health and estimates time until capacity is reached.
 */

import { defaultAuditTrailStore } from './audit_trail';

const CAPACITY = 5000;
const WARNING_PCT = 80;
const CRITICAL_PCT = 95;

export type RetentionHealthStatus = 'healthy' | 'warning' | 'critical';

export interface AuditRetentionHealthReport {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  capacity: number;
  utilization_pct: number;
  oldest_event_at: string | null;
  newest_event_at: string | null;
  event_span_days: number;
  status: RetentionHealthStatus;
  estimated_days_until_cap: number | null;
  recommendations: string[];
}

function statusFor(utilization_pct: number): RetentionHealthStatus {
  if (utilization_pct > CRITICAL_PCT) return 'critical';
  if (utilization_pct > WARNING_PCT) return 'warning';
  return 'healthy';
}

export function buildAuditRetentionHealth(
  tenant_id: string,
  now: Date = new Date(),
): AuditRetentionHealthReport {
  if (!tenant_id) throw new Error('tenant_id required');

  const page = defaultAuditTrailStore.list(tenant_id, {});
  const events = page.items;
  const total_events = events.length;

  const utilization_pct = (total_events / CAPACITY) * 100;
  const status = statusFor(utilization_pct);

  let oldest_event_at: string | null = null;
  let newest_event_at: string | null = null;

  for (const e of events) {
    if (!oldest_event_at || e.ts < oldest_event_at) oldest_event_at = e.ts;
    if (!newest_event_at || e.ts > newest_event_at) newest_event_at = e.ts;
  }

  let event_span_days = 0;
  let events_per_day = 0;
  if (oldest_event_at && newest_event_at) {
    const span_ms =
      new Date(newest_event_at).getTime() - new Date(oldest_event_at).getTime();
    event_span_days = Math.max(1, span_ms / 86_400_000);
    events_per_day = total_events / event_span_days;
  }

  let estimated_days_until_cap: number | null = null;
  if (events_per_day > 0) {
    const remaining = CAPACITY - total_events;
    estimated_days_until_cap = Math.max(0, remaining / events_per_day);
  }

  const recommendations: string[] = [];
  if (status === 'critical') {
    recommendations.push('Immediate action required: audit log near capacity. Export and archive old events.');
    recommendations.push('Consider increasing retention capacity or enabling automatic archival.');
  } else if (status === 'warning') {
    recommendations.push('Audit log is approaching capacity. Plan archival strategy.');
    if (estimated_days_until_cap !== null && estimated_days_until_cap < 30) {
      recommendations.push(`At current rate, capacity will be reached in ~${Math.floor(estimated_days_until_cap)} days.`);
    }
  } else if (events_per_day > 0 && estimated_days_until_cap !== null && estimated_days_until_cap < 90) {
    recommendations.push(`Capacity will be reached in ~${Math.floor(estimated_days_until_cap)} days at current rate.`);
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events,
    capacity: CAPACITY,
    utilization_pct,
    oldest_event_at,
    newest_event_at,
    event_span_days,
    status,
    estimated_days_until_cap,
    recommendations,
  };
}
