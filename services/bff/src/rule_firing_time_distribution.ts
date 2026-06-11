// services/bff/src/rule_firing_time_distribution.ts
//
// T6 M5.21 — Rule firing pattern by time of day.
//
// Groups audit events with action='rule.fired' and resource_type='rule'
// by UTC hour-of-day (0..23) to surface "when does the rule engine fire
// most often?" — useful for maintenance-window planning and peak-load analysis.

import type { AuditEvent } from './audit_trail';

// ─── Public types ──────────────────────────────────────────────────────

export interface RuleFiringHourBucket {
  hour: number;
  count: number;
  /** count / total_rule_fires, rounded 4 decimals. 0 when total=0. */
  pct: number;
}

export interface RuleFiringTimeDistribution {
  tenant_id: string;
  generated_at: string;
  total_rule_fires: number;
  /** 24 buckets always emitted in canonical 0..23 order. */
  by_hour: RuleFiringHourBucket[];
  /** Hour with the highest count. earliest-hour-wins tie-break. null when no fires. */
  peak_hour: number | null;
  /** Hours with count=0, sorted asc. */
  quiet_hours: number[];
  /** Math.round(total / 24). */
  mean_fires_per_hour: number;
}

// ─── Pure function ─────────────────────────────────────────────────────

/**
 * buildRuleFiringTimeDistribution
 *
 * @param tenant_id  the caller's tenant (validates each event before including)
 * @param auditEvents  raw AuditEvent[] from auditTrailStore.list
 * @param now  current Date (used for generated_at)
 */
export function buildRuleFiringTimeDistribution(
  tenant_id: string,
  auditEvents: readonly AuditEvent[],
  now: Date,
): RuleFiringTimeDistribution {
  if (!tenant_id || typeof tenant_id !== 'string' || !tenant_id.trim()) {
    throw new Error('tenant_id is required');
  }

  // Count per-hour bucket (0..23)
  const counts = new Array<number>(24).fill(0);

  for (const ev of auditEvents) {
    if (ev.tenant_id !== tenant_id) continue;
    if (ev.action !== 'rule.fired') continue;
    if (ev.resource_type !== 'rule') continue;

    // Parse UTC hour from ISO timestamp string
    const ts = ev.ts;
    if (!ts || typeof ts !== 'string') continue;
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) continue;
    const hour = d.getUTCHours(); // 0..23
    counts[hour]++;
  }

  const total = counts.reduce((s, c) => s + c, 0);

  const by_hour: RuleFiringHourBucket[] = counts.map((count, hour) => ({
    hour,
    count,
    pct: total > 0 ? Math.round((count / total) * 10000) / 10000 : 0,
  }));

  // peak_hour — earliest-hour-wins tie-break via strict >
  let peakHour: number | null = null;
  let peakCount = -1;
  for (let h = 0; h < 24; h++) {
    if (counts[h] > peakCount) {
      peakCount = counts[h];
      peakHour = h;
    }
  }
  if (total === 0) peakHour = null;

  const quiet_hours = by_hour.filter((b) => b.count === 0).map((b) => b.hour);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_rule_fires: total,
    by_hour,
    peak_hour: peakHour,
    quiet_hours,
    mean_fires_per_hour: Math.round(total / 24),
  };
}
