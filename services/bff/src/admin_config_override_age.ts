// services/bff/src/admin_config_override_age.ts
//
// T6 M13.11 — Admin config override age tracker.
//
// M13.1 ships the config store; M13.2 tracks per-key audit history;
// M13.3 ships rollback. M13.11 surfaces age: for each tenant override,
// compute "how long has this been in place?" and bucket into
// recent/stable/stale. Useful for the periodic config review
// ("this override is 4 months old — still appropriate?").
//
// Pure — no I/O. Caller passes the tenant's config entries (typically
// via `configStore.list(tenant)`).

import type { ConfigEntry } from './admin_config';

// ─── Public types ─────────────────────────────────────────────────────

export type OverrideFreshness = 'recent' | 'stable' | 'stale';

export interface OverrideAgeRow {
  key: string;
  category: string;
  type: string;
  value: ConfigEntry['value'];
  default_value: ConfigEntry['value'];
  updated_at: string;
  updated_by: string | null;
  age_days: number;
  freshness: OverrideFreshness;
}

export interface ConfigOverrideAgeReport {
  tenant_id: string;
  generated_at: string;
  fresh_days: number;
  stale_days: number;
  total_overrides: number;
  recent_count: number;
  stable_count: number;
  stale_count: number;
  /** Oldest override (largest age_days). null when total_overrides=0. */
  oldest_override: Pick<OverrideAgeRow, 'key' | 'age_days' | 'updated_at'> | null;
  /** Newest override (smallest age_days). null when total_overrides=0. */
  newest_override: Pick<OverrideAgeRow, 'key' | 'age_days' | 'updated_at'> | null;
  /** Sorted by age_days desc with key asc tie-break. */
  overrides: OverrideAgeRow[];
}

export class OverrideAgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OverrideAgeError';
  }
}

// ─── Pure analyser ───────────────────────────────────────────────────

function freshnessFor(age_days: number, fresh: number, stale: number): OverrideFreshness {
  if (age_days < fresh) return 'recent';
  if (age_days > stale) return 'stale';
  return 'stable';
}

export function analyseConfigOverrideAges(
  tenant_id: string,
  entries: readonly ConfigEntry[],
  now: Date,
  fresh_days: number = 30,
  stale_days: number = 90,
): ConfigOverrideAgeReport {
  if (!Number.isFinite(fresh_days) || fresh_days < 0) {
    throw new OverrideAgeError('invalid_input', 'fresh_days must be ≥ 0');
  }
  if (!Number.isFinite(stale_days) || stale_days < 0) {
    throw new OverrideAgeError('invalid_input', 'stale_days must be ≥ 0');
  }
  if (stale_days < fresh_days) {
    throw new OverrideAgeError('invalid_input', 'stale_days must be ≥ fresh_days');
  }
  const overrides_only = entries.filter((e) => !e.is_default && e.updated_at);
  const rows: OverrideAgeRow[] = overrides_only.map((e) => {
    const ageMs = now.getTime() - new Date(e.updated_at!).getTime();
    const age_days = Math.max(0, Math.floor(ageMs / 86_400_000));
    return {
      key: e.key,
      category: e.category,
      type: e.type,
      value: e.value,
      default_value: e.default_value,
      updated_at: e.updated_at!,
      updated_by: e.updated_by,
      age_days,
      freshness: freshnessFor(age_days, fresh_days, stale_days),
    };
  });
  rows.sort((a, b) => {
    if (b.age_days !== a.age_days) return b.age_days - a.age_days;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const recent_count = rows.filter((r) => r.freshness === 'recent').length;
  const stale_count = rows.filter((r) => r.freshness === 'stale').length;
  const stable_count = rows.length - recent_count - stale_count;
  const oldest = rows[0] ?? null;
  const newest = rows.length > 0 ? rows[rows.length - 1]! : null;
  return {
    tenant_id,
    generated_at: now.toISOString(),
    fresh_days,
    stale_days,
    total_overrides: rows.length,
    recent_count,
    stable_count,
    stale_count,
    oldest_override: oldest
      ? { key: oldest.key, age_days: oldest.age_days, updated_at: oldest.updated_at }
      : null,
    newest_override: newest
      ? { key: newest.key, age_days: newest.age_days, updated_at: newest.updated_at }
      : null,
    overrides: rows,
  };
}
