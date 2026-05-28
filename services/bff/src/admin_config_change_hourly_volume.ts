// services/bff/src/admin_config_change_hourly_volume.ts
//
// T6 M13.19 — Config change hourly-volume cyclic distribution.
//
// Over the same M13.2 audit-trail source M13.18 uses (every successful
// PUT/DELETE on /v1/admin/config/:key writes a config.update /
// config.reset event to M15.1), but a CYCLIC intraday view: bucket
// every config change by UTC hour-of-day 0..23 across the whole drained
// set (no trailing window — mirrors M12.18 / M3.12 hourly cyclic shape).
//
// Distinct from M13.18 (LINEAR daily trend over N days) — M13.19 answers
// the orthogonal "WHEN in the day do config changes cluster?" question.
// Its headline value is the AFTER-HOURS security signal: a spike of
// config changes at 02:00 UTC is a classic insider-threat / compromised-
// account tell that a daily trend line cannot surface.
//
// Distinct from M13.11 (override age snapshot), M13.12 (category
// override-rate snapshot), M13.16 (per-actor rollup), M13.17 (category ×
// actor matrix) — none is time-of-day-aware.
//
// Mirror of M3.12 / M12.18 / M8.17 cyclic-volume pattern, adapted to
// filter M15.1 audit events for the config resource type.

import { DEFAULTS, type ConfigCategory, listCategories } from './admin_config';
import {
  type ConfigChangeAction,
  ALL_CONFIG_CHANGE_ACTIONS,
} from './admin_config_change_daily_volume';
import type { AuditEvent } from './audit_trail';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export const HOURS_IN_DAY = 24;

// After-hours window (UTC heuristic — production would resolve per the
// tenant's timezone). A change is "after hours" when its UTC hour is
// >= AFTER_HOURS_START_UTC (22:00) OR < AFTER_HOURS_END_UTC (06:00).
export const AFTER_HOURS_START_UTC = 22;
export const AFTER_HOURS_END_UTC = 6;

export function isAfterHoursUtc(hour: number): boolean {
  return hour >= AFTER_HOURS_START_UTC || hour < AFTER_HOURS_END_UTC;
}

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export class ConfigChangeHourlyVolumeError extends Error {
  constructor(
    public readonly code: 'invalid_input',
    message: string,
  ) {
    super(message);
    this.name = 'ConfigChangeHourlyVolumeError';
  }
}

export interface ConfigChangeHourBucket {
  /** 0..23 (UTC hour of day). */
  hour: number;
  total: number;
  /** Every ConfigChangeAction key present at 0 when absent. */
  by_action: Record<ConfigChangeAction, number>;
  /** Every ConfigCategory key present at 0 when absent. */
  by_category: Record<ConfigCategory, number>;
  /** Distinct actor_username values that wrote a change in this hour. */
  distinct_actors: number;
  /** Distinct resource_id (config key) values touched in this hour. */
  distinct_keys: number;
}

export interface ConfigChangeHourlyVolumeResult {
  tenant_id: string;
  generated_at: string;
  /** Σ across by_hour (config changes in the drained set). */
  total_changes: number;
  /** All config events observed (incl. malformed-ts skipped). */
  total_events_observed: number;
  /** Config-key events whose resource_id was not in DEFAULTS. */
  total_unknown_key_events: number;
  /** Always 24 buckets in canonical 0..23 order. */
  by_hour: ConfigChangeHourBucket[];
  /** Hour with the highest total; earliest-hour-wins tie-break via
   *  strict >; null when zero changes. */
  peak_hour: number | null;
  peak_count: number;
  /** Zero-count hours in ascending order. */
  quiet_hours: number[];
  /** Math.round(total_changes / 24). */
  mean_per_hour: number;
  /** Highest-total action; canonical ALL_CONFIG_CHANGE_ACTIONS tie-break
   *  (config.update wins over config.reset at tied); null when zero. */
  busiest_action: ConfigChangeAction | null;
  /** Highest-total category; canonical listCategories tie-break; null
   *  when zero. */
  busiest_category: ConfigCategory | null;
  /** Config changes landing in the after-hours UTC window. */
  after_hours_changes: number;
  /** after_hours_changes / total_changes (0..1, rounded 4 dp; 0 when
   *  no changes) — the off-hours-change security signal. */
  after_hours_pct: number;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

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

function isConfigChangeAction(s: string): s is ConfigChangeAction {
  return s === 'config.update' || s === 'config.reset';
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export function summarizeConfigChangeHourlyVolume(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): ConfigChangeHourlyVolumeResult {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new ConfigChangeHourlyVolumeError('invalid_input', 'tenant_id required');
  }

  // Pre-build 24 empty hour buckets.
  const by_hour: ConfigChangeHourBucket[] = [];
  const actorSets: Array<Set<string>> = [];
  const keySets: Array<Set<string>> = [];
  for (let h = 0; h < HOURS_IN_DAY; h++) {
    by_hour.push({
      hour: h,
      total: 0,
      by_action: zeroByAction(),
      by_category: zeroByCategory(),
      distinct_actors: 0,
      distinct_keys: 0,
    });
    actorSets.push(new Set());
    keySets.push(new Set());
  }

  let total_events_observed = 0;
  let total_changes = 0;
  let total_unknown_key_events = 0;

  for (const event of events) {
    if (event.tenant_id !== tenant_id) continue;
    if (event.resource_type !== 'config') continue;
    if (!isConfigChangeAction(event.action)) continue;

    total_events_observed += 1;

    const tsMs = Date.parse(event.ts);
    if (!Number.isFinite(tsMs)) continue;
    const hour = new Date(tsMs).getUTCHours();
    const bucket = by_hour[hour];

    bucket.total += 1;
    bucket.by_action[event.action] += 1;
    total_changes += 1;

    const key = event.resource_id;
    if (key) {
      const category = KEY_TO_CATEGORY.get(key);
      if (category) bucket.by_category[category] += 1;
      else total_unknown_key_events += 1;
      keySets[hour].add(key);
    }
    if (event.actor_username) actorSets[hour].add(event.actor_username);
  }

  for (let h = 0; h < HOURS_IN_DAY; h++) {
    by_hour[h].distinct_actors = actorSets[h].size;
    by_hour[h].distinct_keys = keySets[h].size;
  }

  // peak_hour — earliest-hour-wins tie-break via strict >.
  let peak_hour: number | null = null;
  let peak_count = 0;
  if (total_changes > 0) {
    for (const b of by_hour) {
      if (b.total > peak_count) {
        peak_count = b.total;
        peak_hour = b.hour;
      }
    }
  }

  const quiet_hours = by_hour.filter((b) => b.total === 0).map((b) => b.hour);
  const mean_per_hour = Math.round(total_changes / HOURS_IN_DAY);

  // busiest_action — canonical ALL_CONFIG_CHANGE_ACTIONS tie-break.
  let busiest_action: ConfigChangeAction | null = null;
  if (total_changes > 0) {
    const totals = zeroByAction();
    for (const b of by_hour) {
      for (const a of ALL_CONFIG_CHANGE_ACTIONS) totals[a] += b.by_action[a];
    }
    let max = 0;
    for (const a of ALL_CONFIG_CHANGE_ACTIONS) {
      if (totals[a] > max) {
        max = totals[a];
        busiest_action = a;
      }
    }
  }

  // busiest_category — canonical listCategories tie-break.
  let busiest_category: ConfigCategory | null = null;
  if (total_changes > 0) {
    const totals = zeroByCategory();
    for (const b of by_hour) {
      for (const cat of listCategories()) totals[cat] += b.by_category[cat];
    }
    let max = 0;
    for (const cat of listCategories()) {
      if (totals[cat] > max) {
        max = totals[cat];
        busiest_category = cat;
      }
    }
  }

  // after_hours — Σ counts in after-hours UTC buckets.
  let after_hours_changes = 0;
  for (const b of by_hour) {
    if (isAfterHoursUtc(b.hour)) after_hours_changes += b.total;
  }
  const after_hours_pct =
    total_changes > 0
      ? Math.round((after_hours_changes / total_changes) * 10000) / 10000
      : 0;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_changes,
    total_events_observed,
    total_unknown_key_events,
    by_hour,
    peak_hour,
    peak_count,
    quiet_hours,
    mean_per_hour,
    busiest_action,
    busiest_category,
    after_hours_changes,
    after_hours_pct,
  };
}
