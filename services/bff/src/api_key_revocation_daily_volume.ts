// services/bff/src/api_key_revocation_daily_volume.ts
//
// T6 M1.15 — API key revocation daily volume timeline.
//
// M1.9 ships the CREATION daily volume timeline over the M1.2 store.
// M1.15 ships the orthogonal REVOCATION daily volume — same window
// mechanics, but bucketing by `revoked_at` instead of `created_at`.
//
// Distinct from M1.9 by surface: M1.9 answers "are we provisioning
// more keys this month?"; M1.15 answers "are we revoking faster than
// creating? has revocation activity spiked?". Drives BIL ops rotation
// hygiene tracking + post-incident cleanup pattern detection.
//
// Per UTC calendar day across N days (default 30, bounds [1, 365]):
// {date, total_revocations, by_scope (every VALID_SCOPES at 0 when
// absent — multi-scope key contributes to each), distinct_creators
// (per-day Set-dedup)}. Every day in [window_start, window_end]
// emitted at 0 — stable SPA chart axis.
//
// Envelope: peak_day (earliest-day-wins tie-break) + mean_per_day +
// growth_rate (second-half vs first-half; null when first-half=0 OR
// days<2) + most_revoked_scope (canonical VALID_SCOPES tie-break) +
// total_revocations_in_window + total_revocations_observed.
//
// Mirror of M1.9 / M3.17 / M7.17 / M8.15 / M10.15 / M12.13 / M15.11
// daily-volume pattern.

import {
  VALID_SCOPES,
  type ApiKeyEntry,
  type ApiKeyScope,
} from './api_keys';

const MS_PER_DAY = 86_400_000;

export const DEFAULT_REVOCATION_DAILY_WINDOW = 30;
export const MAX_REVOCATION_DAILY_WINDOW = 365;

// ─── Public types ──────────────────────────────────────────────────────

export interface RevocationDailyBucket {
  /** UTC calendar date in YYYY-MM-DD format. */
  date: string;
  total_revocations: number;
  /** Per-scope counts; every VALID_SCOPES key at 0 when absent.
   *  Multi-scope keys contribute to each listed scope. */
  by_scope: Record<ApiKeyScope, number>;
  /** Distinct `revoked_by` actors who revoked on this day (Set-dedup). */
  distinct_revokers: number;
}

export interface ApiKeyRevocationDailyVolume {
  tenant_id: string;
  generated_at: string;
  days: number;
  window_start: string;
  window_end: string;
  total_revocations_in_window: number;
  /** All revocations seen across the entire input — incl. those
   *  outside the trailing window. Surfaces "old revocations dropped
   *  from the chart" gap. */
  total_revocations_observed: number;
  by_day: RevocationDailyBucket[];
  /** Highest-count day; earliest-day-wins tie-break via strict `>`;
   *  null on empty. */
  peak_day: string | null;
  peak_count: number;
  mean_per_day: number;
  /** Second-half mean − first-half mean / first-half mean; null when
   *  first-half=0 OR days<2. */
  growth_rate: number | null;
  /** Scope with highest total revocations across the window;
   *  canonical VALID_SCOPES tie-break (alerts:read wins at tied);
   *  null on empty. */
  most_revoked_scope: ApiKeyScope | null;
}

export class ApiKeyRevocationDailyVolumeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiKeyRevocationDailyVolumeError';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByScope(): Record<ApiKeyScope, number> {
  const out = {} as Record<ApiKeyScope, number>;
  for (const s of VALID_SCOPES) out[s] = 0;
  return out;
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDayStart(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildApiKeyRevocationDailyVolume(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  days: number,
  now: Date,
): ApiKeyRevocationDailyVolume {
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > MAX_REVOCATION_DAILY_WINDOW
  ) {
    throw new ApiKeyRevocationDailyVolumeError(
      'invalid_input',
      `days must be an integer in [1, ${MAX_REVOCATION_DAILY_WINDOW}]`,
    );
  }

  const todayUtc = utcDayStart(now);
  const windowStartUtc = new Date(todayUtc.getTime() - (days - 1) * MS_PER_DAY);

  // Pre-allocate every day bucket — stable SPA axis.
  const buckets: RevocationDailyBucket[] = [];
  const bucketIndex = new Map<string, RevocationDailyBucket>();
  for (let i = 0; i < days; i++) {
    const day = new Date(windowStartUtc.getTime() + i * MS_PER_DAY);
    const date = utcDateString(day);
    const bucket: RevocationDailyBucket = {
      date,
      total_revocations: 0,
      by_scope: emptyByScope(),
      distinct_revokers: 0,
    };
    buckets.push(bucket);
    bucketIndex.set(date, bucket);
  }

  const revokerSetByDay = new Map<string, Set<string>>();
  for (const b of buckets) revokerSetByDay.set(b.date, new Set<string>());

  let total_revocations_in_window = 0;
  let total_revocations_observed = 0;

  for (const entry of entries) {
    // Only revoked keys count toward revocation volume.
    if (entry.status !== 'revoked') continue;
    if (!entry.revoked_at) continue;
    total_revocations_observed++;

    const revokedTs = new Date(entry.revoked_at).getTime();
    if (Number.isNaN(revokedTs)) continue;

    const dayStr = utcDateString(utcDayStart(new Date(revokedTs)));
    const bucket = bucketIndex.get(dayStr);
    if (!bucket) continue; // outside window

    bucket.total_revocations++;
    total_revocations_in_window++;

    // Defensive intra-key scope dedup + closed-enum filter.
    const seen = new Set<ApiKeyScope>();
    for (const scope of entry.scopes) {
      if (VALID_SCOPES.includes(scope) && !seen.has(scope)) {
        seen.add(scope);
        bucket.by_scope[scope]++;
      }
    }

    if (entry.revoked_by) {
      revokerSetByDay.get(dayStr)!.add(entry.revoked_by);
    }
  }

  for (const bucket of buckets) {
    bucket.distinct_revokers = revokerSetByDay.get(bucket.date)!.size;
  }

  // peak_day — highest total; earliest-day-wins tie-break.
  let peak_day: string | null = null;
  let peak_count = 0;
  for (const bucket of buckets) {
    if (bucket.total_revocations > peak_count) {
      peak_count = bucket.total_revocations;
      peak_day = bucket.date;
    }
  }

  const mean_per_day = Math.round(total_revocations_in_window / days);

  let growth_rate: number | null = null;
  if (days >= 2) {
    const half = Math.floor(days / 2);
    let firstSum = 0;
    let secondSum = 0;
    for (let i = 0; i < days; i++) {
      if (i < half) firstSum += buckets[i].total_revocations;
      else secondSum += buckets[i].total_revocations;
    }
    const firstHalfMean = firstSum / half;
    const secondHalfMean = secondSum / (days - half);
    if (firstHalfMean > 0) {
      growth_rate = (secondHalfMean - firstHalfMean) / firstHalfMean;
    }
  }

  // most_revoked_scope — canonical VALID_SCOPES tie-break.
  let most_revoked_scope: ApiKeyScope | null = null;
  let bestScope = 0;
  const scopeTotals = emptyByScope();
  for (const bucket of buckets) {
    for (const s of VALID_SCOPES) scopeTotals[s] += bucket.by_scope[s];
  }
  for (const s of VALID_SCOPES) {
    if (scopeTotals[s] > bestScope) {
      bestScope = scopeTotals[s];
      most_revoked_scope = s;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start: utcDateString(windowStartUtc),
    window_end: utcDateString(todayUtc),
    total_revocations_in_window,
    total_revocations_observed,
    by_day: buckets,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
    most_revoked_scope,
  };
}
