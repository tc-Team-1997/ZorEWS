// services/bff/src/api_key_expiry_forecast.ts
//
// T6 M1.7 — API key expiry forecast timeline.
//
// M1.4 ships per-key usage analytics; M1.5 ships scope distribution;
// M1.6 ships by-creator. M1.7 lands the FORWARD-LOOKING timeline —
// "your next N days of key expirations" with peak-day callout +
// classification of edge cases (already_expired / no_expiry / beyond_window).
//
// Mirror of M12.13/M15.11/M10.15 daily volume pattern but forward-looking:
// window starts at NOW (UTC day) and extends N days forward instead of
// trailing N days back. Active keys only — revoked keys excluded since
// they can't be rotated.
//
// Drives the SPA's "rotation calendar" panel + an "already expired,
// rotate now" alert section. Useful for capacity planning ("the next
// 2 weeks have 5 expirations — schedule rotation work").
//
// Pure resolver — accepts redacted ApiKeyEntry[] surface (NOT the
// internal hash-carrying record).

import type { ApiKeyEntry } from './api_keys';

// ─── Constants ────────────────────────────────────────────────────────

export const DEFAULT_EXPIRY_FORECAST_WINDOW = 30;
export const MAX_EXPIRY_FORECAST_WINDOW = 365;
export const MIN_EXPIRY_FORECAST_WINDOW = 1;

const SAMPLE_CAP_PER_DAY = 5;
const EDGE_LIST_CAP = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Public types ─────────────────────────────────────────────────────

export interface ExpiringKeySample {
  key_id: string;
  name: string;
  prefix: string;
  created_by: string;
  expires_at: string;
}

export interface ExpiryDailyBucket {
  date: string;
  expiring_count: number;
  /** Top-5 by name asc for stable rendering. */
  sample_keys: ExpiringKeySample[];
}

export interface ApiKeyExpiryForecast {
  tenant_id: string;
  generated_at: string;
  days: number;
  window_start: string;
  window_end: string;
  total_active_keys: number;
  total_with_expiry: number;
  /** Active keys with `expires_at === null`. Perpetual until revoked. */
  no_expiry_count: number;
  /** Active keys with `expires_at < window_start` (UTC day). */
  already_expired_count: number;
  /** Active keys with `expires_at` in [window_start, window_end] (inclusive). */
  expiring_in_window_count: number;
  /** Active keys with `expires_at > window_end`. */
  beyond_window_count: number;
  by_day: ExpiryDailyBucket[];
  /** Highest expiring_count day; earliest-day-wins tie-break. null when
   *  zero expirations in window. */
  peak_day: string | null;
  peak_count: number;
  /** Already-expired key list — sorted expires_at asc (most-overdue first).
   *  Cap 20. */
  already_expired_keys: ExpiringKeySample[];
  /** Beyond-window key list — sorted expires_at asc (soonest first). Cap 20. */
  beyond_window_keys: ExpiringKeySample[];
}

export class ApiKeyExpiryForecastError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiKeyExpiryForecastError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function utcDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function endOfUtcDay(d: Date): Date {
  // 23:59:59.999 UTC of the supplied day. Used as the upper bound on the
  // window so a key expiring late on `window_end` still classifies as
  // in-window rather than beyond_window.
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  );
}

function validateDays(days: number): void {
  if (
    !Number.isInteger(days) ||
    days < MIN_EXPIRY_FORECAST_WINDOW ||
    days > MAX_EXPIRY_FORECAST_WINDOW
  ) {
    throw new ApiKeyExpiryForecastError(
      'invalid_input',
      `days must be an integer in [${MIN_EXPIRY_FORECAST_WINDOW}, ${MAX_EXPIRY_FORECAST_WINDOW}]`,
    );
  }
}

function toSample(entry: ApiKeyEntry): ExpiringKeySample {
  return {
    key_id: entry.key_id,
    name: entry.name,
    prefix: entry.prefix,
    created_by: entry.created_by,
    expires_at: entry.expires_at!, // caller has filtered expires_at != null
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildApiKeyExpiryForecast(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  days: number,
  now: Date,
): ApiKeyExpiryForecast {
  validateDays(days);

  const startDay = startOfUtcDay(now);
  const endDay = new Date(startDay.getTime() + (days - 1) * MS_PER_DAY);
  const windowEndMs = endOfUtcDay(endDay).getTime();

  // Build buckets oldest-first.
  const byDate = new Map<string, ExpiryDailyBucket>();
  const by_day: ExpiryDailyBucket[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDay.getTime() + i * MS_PER_DAY);
    const date = utcDateStr(d);
    const bucket: ExpiryDailyBucket = { date, expiring_count: 0, sample_keys: [] };
    byDate.set(date, bucket);
    by_day.push(bucket);
  }
  const window_start = by_day[0]!.date;
  const window_end = by_day[by_day.length - 1]!.date;

  // Filter to ACTIVE keys (revoked keys can't be rotated; not actionable here).
  const active = entries.filter((e) => e.status === 'active');
  const total_active_keys = active.length;

  let total_with_expiry = 0;
  let no_expiry_count = 0;
  let already_expired_count = 0;
  let beyond_window_count = 0;
  let expiring_in_window_count = 0;
  const alreadyExpired: ExpiringKeySample[] = [];
  const beyondWindow: ExpiringKeySample[] = [];

  for (const entry of active) {
    if (entry.expires_at == null) {
      no_expiry_count++;
      continue;
    }
    total_with_expiry++;
    const expMs = new Date(entry.expires_at).getTime();
    if (!Number.isFinite(expMs)) {
      // Malformed expires_at — treat as no_expiry defensively (counted in
      // total_with_expiry since the field is non-null).
      continue;
    }
    if (expMs < startDay.getTime()) {
      already_expired_count++;
      alreadyExpired.push(toSample(entry));
      continue;
    }
    if (expMs > windowEndMs) {
      beyond_window_count++;
      beyondWindow.push(toSample(entry));
      continue;
    }
    const bucketDate = utcDateStr(new Date(expMs));
    const bucket = byDate.get(bucketDate);
    if (bucket) {
      bucket.expiring_count++;
      bucket.sample_keys.push(toSample(entry));
      expiring_in_window_count++;
    }
  }

  // Sort + cap each day's sample_keys (by name asc).
  for (const b of by_day) {
    b.sample_keys.sort((a, z) => a.name.localeCompare(z.name));
    if (b.sample_keys.length > SAMPLE_CAP_PER_DAY) {
      b.sample_keys = b.sample_keys.slice(0, SAMPLE_CAP_PER_DAY);
    }
  }

  // peak_day — highest expiring_count; earliest-day-wins tie-break via
  // strict `>`.
  let peak_day: string | null = null;
  let peak_count = 0;
  for (const b of by_day) {
    if (b.expiring_count > peak_count) {
      peak_count = b.expiring_count;
      peak_day = b.date;
    }
  }
  if (peak_count === 0) peak_day = null;

  // Sort edge lists asc + cap.
  alreadyExpired.sort((a, z) => a.expires_at.localeCompare(z.expires_at));
  beyondWindow.sort((a, z) => a.expires_at.localeCompare(z.expires_at));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start,
    window_end,
    total_active_keys,
    total_with_expiry,
    no_expiry_count,
    already_expired_count,
    expiring_in_window_count,
    beyond_window_count,
    by_day,
    peak_day,
    peak_count,
    already_expired_keys: alreadyExpired.slice(0, EDGE_LIST_CAP),
    beyond_window_keys: beyondWindow.slice(0, EDGE_LIST_CAP),
  };
}
