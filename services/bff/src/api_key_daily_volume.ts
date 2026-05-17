// services/bff/src/api_key_daily_volume.ts
//
// T6 M1.9 — API key creation daily volume timeline.
//
// M1.4 ships per-key usage analytics. M1.5 ships scope distribution.
// M1.6 ships by-creator. M1.7 ships forward-looking expiry forecast.
// M1.8 ships scope × status matrix. M1.9 lands the TREND-LINE view:
// for each UTC calendar day across N days, count keys created on
// that day plus by_status breakdown.
//
// Mirror of M12.13 (report jobs daily volume) / M15.11 (audit daily
// volume) / M10.15 (notification daily volume) shape for the API
// keys surface. Same window mechanics, growth_rate math, peak/mean
// envelope.
//
// Pure resolver — accepts the redacted ApiKeyEntry[] surface (never
// the internal record with hash/secret).
//
// Drives "are we provisioning more keys this month than last? when
// did the spike happen?".

import type { ApiKeyEntry, ApiKeyStatus } from './api_keys';

// ─── Constants ────────────────────────────────────────────────────────

export const DEFAULT_API_KEY_DAILY_WINDOW = 30;
export const MAX_API_KEY_DAILY_WINDOW = 365;
export const MIN_API_KEY_DAILY_WINDOW = 1;

const ALL_STATUSES: readonly ApiKeyStatus[] = ['active', 'revoked'] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Public types ─────────────────────────────────────────────────────

export interface ApiKeyDailyBucket {
  date: string;
  total: number;
  /** Per-ApiKeyStatus; every key present at 0 when absent. */
  by_status: Record<ApiKeyStatus, number>;
}

export interface ApiKeyDailyVolumeSummary {
  tenant_id: string;
  generated_at: string;
  days: number;
  window_start: string;
  window_end: string;
  total_created_in_window: number;
  /** Total keys observed across the entire input list — useful to
   *  surface "keys created outside the window" gap. */
  total_keys_observed: number;
  by_day: ApiKeyDailyBucket[];
  peak_day: string | null;
  peak_count: number;
  mean_per_day: number;
  /** (second-half mean − first-half mean) / first-half mean; null when
   *  first-half=0 OR days<2. Positive = growth in creation rate. */
  growth_rate: number | null;
  /** Active vs revoked across the window. Convenience for the SPA
   *  "is our active provisioning trending up vs revocations?" view. */
  total_active_in_window: number;
  total_revoked_in_window: number;
}

export class ApiKeyDailyVolumeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiKeyDailyVolumeError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStatus(): Record<ApiKeyStatus, number> {
  return { active: 0, revoked: 0 };
}

function utcDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function meanOf(arr: ApiKeyDailyBucket[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((acc, b) => acc + b.total, 0) / arr.length;
}

function validateDays(days: number): void {
  if (
    !Number.isInteger(days) ||
    days < MIN_API_KEY_DAILY_WINDOW ||
    days > MAX_API_KEY_DAILY_WINDOW
  ) {
    throw new ApiKeyDailyVolumeError(
      'invalid_input',
      `days must be an integer in [${MIN_API_KEY_DAILY_WINDOW}, ${MAX_API_KEY_DAILY_WINDOW}]`,
    );
  }
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeApiKeyDailyVolume(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  days: number,
  now: Date,
): ApiKeyDailyVolumeSummary {
  validateDays(days);

  const endDay = startOfUtcDay(now);
  const startDay = new Date(endDay.getTime() - (days - 1) * MS_PER_DAY);

  const byDate = new Map<string, ApiKeyDailyBucket>();
  const by_day: ApiKeyDailyBucket[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDay.getTime() + i * MS_PER_DAY);
    const date = utcDateStr(d);
    const bucket: ApiKeyDailyBucket = {
      date,
      total: 0,
      by_status: emptyByStatus(),
    };
    byDate.set(date, bucket);
    by_day.push(bucket);
  }
  const window_start = by_day[0]!.date;
  const window_end = by_day[by_day.length - 1]!.date;

  let total_created_in_window = 0;
  let total_active_in_window = 0;
  let total_revoked_in_window = 0;

  for (const entry of entries) {
    const ts = new Date(entry.created_at).getTime();
    if (!Number.isFinite(ts)) continue;
    const bucket = byDate.get(utcDateStr(new Date(ts)));
    if (!bucket) continue;
    bucket.total++;
    total_created_in_window++;
    if (ALL_STATUSES.includes(entry.status)) {
      bucket.by_status[entry.status]++;
      if (entry.status === 'active') total_active_in_window++;
      else if (entry.status === 'revoked') total_revoked_in_window++;
    }
  }

  // peak_day — highest total; earliest-day-wins tie-break via strict >.
  let peak_day: string | null = null;
  let peak_count = 0;
  for (const b of by_day) {
    if (b.total > peak_count) {
      peak_count = b.total;
      peak_day = b.date;
    }
  }
  if (peak_count === 0) peak_day = null;

  const mean_per_day = Math.round(total_created_in_window / days);

  // growth_rate — same semantics as M12.13 / M15.11 / M10.15.
  let growth_rate: number | null = null;
  if (days >= 2) {
    const half = Math.floor(days / 2);
    const firstHalf = by_day.slice(0, half);
    const secondHalf = by_day.slice(half);
    const firstMean = meanOf(firstHalf);
    const secondMean = meanOf(secondHalf);
    if (firstMean > 0) {
      growth_rate = (secondMean - firstMean) / firstMean;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start,
    window_end,
    total_created_in_window,
    total_keys_observed: entries.length,
    by_day,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
    total_active_in_window,
    total_revoked_in_window,
  };
}
