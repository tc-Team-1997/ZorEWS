// services/bff/src/admin_config_change_patterns.ts
// T6 M13.25 — Config change pattern analysis.
// Analyzes config change patterns from the audit trail.

import { type AuditTrailStore } from './audit_trail';

export type ChangeVelocity = 'accelerating' | 'decelerating' | 'stable';

export interface AdminConfigChangePatternsResult {
  tenant_id: string;
  generated_at: string;
  total_changes: number;
  by_day_of_week: number[]; // ISO Mon=0..Sun=6
  by_hour: number[];        // 0..23
  most_active_day: number | null; // 0-6
  most_active_hour: number | null; // 0-23
  changes_this_week: number; // last 7 days
  change_velocity: ChangeVelocity;
}

function utcDayOfWeekIso(ts: string): number {
  // JS getUTCDay: 0=Sun, 1=Mon...6=Sat → convert to ISO Mon=0..Sun=6
  const d = new Date(ts).getUTCDay();
  return d === 0 ? 6 : d - 1;
}

function utcHour(ts: string): number {
  return new Date(ts).getUTCHours();
}

export function buildAdminConfigChangePatterns(
  auditStore: AuditTrailStore,
  tenant_id: string,
  now: Date,
): AdminConfigChangePatternsResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const page = auditStore.list(tenant_id, {
    resource_type: 'config',
    page: 1,
    page_size: 10000,
  });
  const events = page.items.filter(
    (e) => e.action === 'config.update' || e.action === 'config.reset',
  );

  const total_changes = events.length;

  const by_day_of_week = new Array<number>(7).fill(0);
  const by_hour = new Array<number>(24).fill(0);

  for (const e of events) {
    const dow = utcDayOfWeekIso(e.ts);
    const hr = utcHour(e.ts);
    if (dow >= 0 && dow < 7) by_day_of_week[dow]++;
    if (hr >= 0 && hr < 24) by_hour[hr]++;
  }

  // most_active_day: highest count, earliest index tie-break
  let most_active_day: number | null = null;
  if (total_changes > 0) {
    let maxDay = -1;
    let maxDayCount = 0;
    for (let i = 0; i < 7; i++) {
      if (by_day_of_week[i] > maxDayCount) {
        maxDayCount = by_day_of_week[i];
        maxDay = i;
      }
    }
    most_active_day = maxDay >= 0 ? maxDay : null;
  }

  // most_active_hour
  let most_active_hour: number | null = null;
  if (total_changes > 0) {
    let maxHr = -1;
    let maxHrCount = 0;
    for (let i = 0; i < 24; i++) {
      if (by_hour[i] > maxHrCount) {
        maxHrCount = by_hour[i];
        maxHr = i;
      }
    }
    most_active_hour = maxHr >= 0 ? maxHr : null;
  }

  const nowMs = now.getTime();
  const sevenDaysMs = 7 * 86_400_000;

  const changes_this_week = events.filter((e) => {
    const ms = new Date(e.ts).getTime();
    return nowMs - ms <= sevenDaysMs;
  }).length;

  const prior_week = events.filter((e) => {
    const ms = new Date(e.ts).getTime();
    const age = nowMs - ms;
    return age > sevenDaysMs && age <= 2 * sevenDaysMs;
  }).length;

  let change_velocity: ChangeVelocity;
  if (changes_this_week > prior_week) change_velocity = 'accelerating';
  else if (changes_this_week < prior_week) change_velocity = 'decelerating';
  else change_velocity = 'stable';

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_changes,
    by_day_of_week,
    by_hour,
    most_active_day,
    most_active_hour,
    changes_this_week,
    change_velocity,
  };
}
