// services/bff/src/admin_config_change_daily_volume.ts
//
// T6 M13.18 — Config change daily volume timeline.
//
// Cross-tenant N-day TREND view over the M13.2 audit-trail wiring:
// every successful PUT/DELETE on /v1/admin/config/:key writes a
// config.update / config.reset event to M15.1. M13.18 aggregates
// those events into a daily bucket distribution.
//
// Distinct from:
//   M13.11 — override AGE tracker (snapshot of current overrides
//            by age bucket; no time-series)
//   M13.12 — category override-rate snapshot (snapshot, not trend)
//   M13.16 — per-actor rollup (no time axis)
//   M13.17 — category × actor matrix (no time axis)
//
// Drives compliance + ops questions:
//   "How often are tenants changing config? Is the rate increasing?"
//   "Which day saw the most config churn? Was it a planned rollout?"
//   "What category sees the most changes? — features toggles or
//    alert SLA tuning?"
//   "Who's the busiest config-changer? — quarterly access review"
//
// Mirror of M2.16 / M12.13 / M1.9 / M15.11 daily-volume pattern,
// adapted to filter M15.1 audit events for the config resource type.

import {
  DEFAULTS,
  type ConfigCategory,
  listCategories,
} from './admin_config';
import type { AuditEvent } from './audit_trail';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export const DEFAULT_CONFIG_CHANGE_DAYS = 30;
export const MIN_CONFIG_CHANGE_DAYS = 1;
export const MAX_CONFIG_CHANGE_DAYS = 365;

/** Closed enum of action verbs M13.2 writes. */
export type ConfigChangeAction = 'config.update' | 'config.reset';
export const ALL_CONFIG_CHANGE_ACTIONS: readonly ConfigChangeAction[] = [
  'config.update',
  'config.reset',
] as const;

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export class ConfigChangeDailyVolumeError extends Error {
  constructor(
    public readonly code: 'invalid_input',
    message: string,
  ) {
    super(message);
    this.name = 'ConfigChangeDailyVolumeError';
  }
}

export interface ConfigChangeDayBucket {
  /** YYYY-MM-DD (UTC). */
  date: string;
  total: number;
  /** Every ConfigChangeAction key present at 0 when absent. */
  by_action: Record<ConfigChangeAction, number>;
  /** Every ConfigCategory key present at 0 when absent. Unknown
   *  config keys (not in DEFAULTS) get bucketed into 'unknown' which
   *  is reported separately at the envelope level. */
  by_category: Record<ConfigCategory, number>;
  /** Distinct actor_username values that wrote a change this day. */
  distinct_actors: number;
  /** Distinct resource_id (config key) values touched this day. */
  distinct_keys: number;
}

export interface ConfigChangeDailyVolumeResult {
  tenant_id: string;
  generated_at: string;
  days: number;
  /** YYYY-MM-DD inclusive lower bound. */
  window_start: string;
  /** YYYY-MM-DD inclusive upper bound (today UTC). */
  window_end: string;
  /** Σ across by_day. */
  total_changes_in_window: number;
  /** Total events observed in the input (incl. outside window). */
  total_events_observed: number;
  /** Σ across all days for config.update only. */
  total_updates_in_window: number;
  /** Σ across all days for config.reset only. */
  total_resets_in_window: number;
  /** Events targeting keys not in DEFAULTS catalog (defensively
   *  excluded from by_category but still counted in total). */
  total_unknown_key_events: number;
  /** by_day[] oldest-first, every day always emitted (stable chart). */
  by_day: ConfigChangeDayBucket[];
  /** Highest-total day; earliest-day-wins tie-break via strict >. null when 0. */
  peak_day: string | null;
  peak_count: number;
  /** Math.round(total / days). */
  mean_per_day: number;
  /** (second-half mean − first-half mean) / first-half mean.
   *  null when first-half mean = 0 OR days < 2. */
  growth_rate: number | null;
  /** Highest-total category across the window. Canonical listCategories
   *  tie-break: alerts wins over notifications at tied count via
   *  iteration order. null when zero changes in window. */
  busiest_category: ConfigCategory | null;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// Key→category map built once at module load from DEFAULTS.
const KEY_TO_CATEGORY: Map<string, ConfigCategory> = new Map(
  DEFAULTS.map((d) => [d.key, d.category]),
);

function zeroByAction(): Record<ConfigChangeAction, number> {
  return { 'config.update': 0, 'config.reset': 0 };
}

function zeroByCategory(): Record<ConfigCategory, number> {
  const out = {} as Record<ConfigCategory, number>;
  for (const cat of listCategories()) out[cat] = 0;
  return out;
}

function emptyBucket(date: string): ConfigChangeDayBucket {
  return {
    date,
    total: 0,
    by_action: zeroByAction(),
    by_category: zeroByCategory(),
    distinct_actors: 0,
    distinct_keys: 0,
  };
}

/** Format a Date as YYYY-MM-DD in UTC. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build the [window_start, window_end] inclusive date strings. */
function buildWindow(days: number, now: Date): { start: string; end: string; startMs: number; endMs: number } {
  const endDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const startDay = new Date(endDay.getTime() - (days - 1) * 86_400_000);
  return {
    start: utcDate(startDay),
    end: utcDate(endDay),
    startMs: startDay.getTime(),
    endMs: endDay.getTime() + 86_400_000 - 1, // inclusive end-of-day
  };
}

function isConfigChangeAction(s: string): s is ConfigChangeAction {
  return s === 'config.update' || s === 'config.reset';
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export function summarizeConfigChangeDailyVolume(
  tenant_id: string,
  events: readonly AuditEvent[],
  days: number,
  now: Date,
): ConfigChangeDailyVolumeResult {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new ConfigChangeDailyVolumeError(
      'invalid_input',
      'tenant_id required',
    );
  }
  if (
    !Number.isInteger(days) ||
    days < MIN_CONFIG_CHANGE_DAYS ||
    days > MAX_CONFIG_CHANGE_DAYS
  ) {
    throw new ConfigChangeDailyVolumeError(
      'invalid_input',
      `days must be integer in [${MIN_CONFIG_CHANGE_DAYS}, ${MAX_CONFIG_CHANGE_DAYS}]`,
    );
  }

  const w = buildWindow(days, now);

  // Pre-build N empty day buckets oldest-first
  const dayList: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(w.startMs + i * 86_400_000);
    dayList.push(utcDate(d));
  }
  const buckets = new Map<string, ConfigChangeDayBucket>();
  const actorSets = new Map<string, Set<string>>();
  const keySets = new Map<string, Set<string>>();
  for (const date of dayList) {
    buckets.set(date, emptyBucket(date));
    actorSets.set(date, new Set());
    keySets.set(date, new Set());
  }

  let total_events_observed = 0;
  let total_changes_in_window = 0;
  let total_updates = 0;
  let total_resets = 0;
  let total_unknown_key_events = 0;

  for (const event of events) {
    // Filter: only config events for this tenant
    if (event.tenant_id !== tenant_id) continue;
    if (event.resource_type !== 'config') continue;
    if (!isConfigChangeAction(event.action)) continue;

    total_events_observed += 1;

    // Bucket into the correct UTC day
    const tsMs = Date.parse(event.ts);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < w.startMs || tsMs > w.endMs) continue;

    const date = utcDate(new Date(tsMs));
    const bucket = buckets.get(date);
    if (!bucket) continue;

    bucket.total += 1;
    bucket.by_action[event.action] += 1;
    total_changes_in_window += 1;
    if (event.action === 'config.update') total_updates += 1;
    else total_resets += 1;

    const key = event.resource_id;
    if (key) {
      const category = KEY_TO_CATEGORY.get(key);
      if (category) {
        bucket.by_category[category] += 1;
      } else {
        // Defensively count but exclude from by_category
        total_unknown_key_events += 1;
      }
      keySets.get(date)!.add(key);
    }
    if (event.actor_username) {
      actorSets.get(date)!.add(event.actor_username);
    }
  }

  // Finalize distinct counts per bucket
  for (const date of dayList) {
    const bucket = buckets.get(date)!;
    bucket.distinct_actors = actorSets.get(date)!.size;
    bucket.distinct_keys = keySets.get(date)!.size;
  }

  const by_day = dayList.map((date) => buckets.get(date)!);

  // peak_day: earliest-day-wins tie-break via strict >
  let peak_day: string | null = null;
  let peak_count = 0;
  if (total_changes_in_window > 0) {
    for (const bucket of by_day) {
      if (bucket.total > peak_count) {
        peak_count = bucket.total;
        peak_day = bucket.date;
      }
    }
  }

  // mean_per_day
  const mean_per_day = Math.round(total_changes_in_window / days);

  // growth_rate: second-half mean vs first-half mean
  let growth_rate: number | null = null;
  if (days >= 2) {
    const mid = Math.floor(days / 2);
    let firstSum = 0;
    let secondSum = 0;
    for (let i = 0; i < mid; i++) firstSum += by_day[i].total;
    for (let i = mid; i < days; i++) secondSum += by_day[i].total;
    const firstMean = firstSum / mid;
    const secondMean = secondSum / (days - mid);
    if (firstMean > 0) {
      growth_rate = (secondMean - firstMean) / firstMean;
    }
  }

  // busiest_category: highest total across window with canonical
  // listCategories iteration tie-break
  let busiest_category: ConfigCategory | null = null;
  if (total_changes_in_window > 0) {
    const totals: Record<ConfigCategory, number> = zeroByCategory();
    for (const bucket of by_day) {
      for (const cat of listCategories()) {
        totals[cat] += bucket.by_category[cat];
      }
    }
    let max = 0;
    for (const cat of listCategories()) {
      if (totals[cat] > max) {
        max = totals[cat];
        busiest_category = cat;
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start: w.start,
    window_end: w.end,
    total_changes_in_window,
    total_events_observed,
    total_updates_in_window: total_updates,
    total_resets_in_window: total_resets,
    total_unknown_key_events,
    by_day,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
    busiest_category,
  };
}
