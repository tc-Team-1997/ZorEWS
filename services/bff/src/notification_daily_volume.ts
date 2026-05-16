// services/bff/src/notification_daily_volume.ts
//
// T6 M10.15 — Notification daily volume timeline.
//
// M10.12 ships cross-channel ledger analytics (non-time aggregate).
// M10.14 ships per-recipient cross-channel rollup. M10.15 lands the
// TREND-LINE view: per UTC calendar day across the trailing N days,
// total sends + by_channel breakdown. Drives the SaaS ops dashboard's
// "are we sending more notifications this month than last?" question
// in one round-trip.
//
// Mirror of M15.11 (audit daily volume) shape — same window mechanics,
// same growth_rate computation, same peak/mean envelope fields.
// Distinct from M10.12 (no time axis) + M15.11 (audit events not
// notifications).
//
// Pure rollup over the 3 ledger arrays. Tenant-scoped at the caller.

import type { EmailLedgerEntry } from './notifications/email';
import type { SmsLedgerEntry } from './notifications/sms';
import type { PushLedgerEntry } from './notifications/push';

// ─── Constants ────────────────────────────────────────────────────────

export const DEFAULT_NOTIF_DAILY_WINDOW = 30;
export const MAX_NOTIF_DAILY_WINDOW = 365;
export const MIN_NOTIF_DAILY_WINDOW = 1;

export type NotificationChannel = 'email' | 'sms' | 'push';

const ALL_CHANNELS: readonly NotificationChannel[] = ['email', 'sms', 'push'] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Public types ─────────────────────────────────────────────────────

export interface NotificationDailyVolumeBucket {
  /** UTC calendar day YYYY-MM-DD. */
  date: string;
  total: number;
  /** Per-channel count; every NotificationChannel key present at 0 when absent. */
  by_channel: Record<NotificationChannel, number>;
}

export interface NotificationDailyVolumeSummary {
  tenant_id: string;
  generated_at: string;
  days: number;
  window_start: string;
  window_end: string;
  /** Total sends that fell inside the trailing window. */
  total_sent_in_window: number;
  /** Total sends scanned across the 3 ledgers (regardless of window). */
  total_sent_observed: number;
  /** Every day in [window_start, window_end] oldest-first. */
  by_day: NotificationDailyVolumeBucket[];
  /** Highest-volume day. Tie-broken by date asc (earliest wins).
   *  null when zero sends. */
  peak_day: string | null;
  peak_count: number;
  /** Math.round(total / days). 0 when no sends. */
  mean_per_day: number;
  /** (second-half mean - first-half mean) / first-half mean.
   *  null when first-half mean = 0 OR days < 2. Same semantics
   *  as M15.11 audit daily volume. */
  growth_rate: number | null;
  /** Channel with the highest total across the window. Canonical
   *  email > sms > push tie-break. null when zero sends. */
  busiest_channel: NotificationChannel | null;
}

export class NotificationDailyVolumeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NotificationDailyVolumeError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByChannel(): Record<NotificationChannel, number> {
  return { email: 0, sms: 0, push: 0 };
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

function meanOf(arr: NotificationDailyVolumeBucket[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((acc, b) => acc + b.total, 0) / arr.length;
}

function validateDays(days: number): void {
  if (!Number.isInteger(days) || days < MIN_NOTIF_DAILY_WINDOW || days > MAX_NOTIF_DAILY_WINDOW) {
    throw new NotificationDailyVolumeError(
      'invalid_input',
      `days must be an integer in [${MIN_NOTIF_DAILY_WINDOW}, ${MAX_NOTIF_DAILY_WINDOW}]`,
    );
  }
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeNotificationDailyVolume(
  tenant_id: string,
  email: readonly EmailLedgerEntry[],
  sms: readonly SmsLedgerEntry[],
  push: readonly PushLedgerEntry[],
  days: number,
  now: Date,
): NotificationDailyVolumeSummary {
  validateDays(days);

  // Build the bucket array for the trailing window [today - (days-1), today].
  const endDay = startOfUtcDay(now);
  const startDay = new Date(endDay.getTime() - (days - 1) * MS_PER_DAY);

  const byDate = new Map<string, NotificationDailyVolumeBucket>();
  const by_day: NotificationDailyVolumeBucket[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDay.getTime() + i * MS_PER_DAY);
    const date = utcDateStr(d);
    const bucket: NotificationDailyVolumeBucket = {
      date,
      total: 0,
      by_channel: emptyByChannel(),
    };
    byDate.set(date, bucket);
    by_day.push(bucket);
  }
  const window_start = by_day[0]!.date;
  const window_end = by_day[by_day.length - 1]!.date;

  let total_sent_in_window = 0;
  const total_sent_observed = email.length + sms.length + push.length;

  for (const e of email) {
    const t = new Date(e.sent_at);
    if (!Number.isFinite(t.getTime())) continue;
    const bucket = byDate.get(utcDateStr(t));
    if (!bucket) continue;
    bucket.total++;
    bucket.by_channel.email++;
    total_sent_in_window++;
  }
  for (const s of sms) {
    const t = new Date(s.sent_at);
    if (!Number.isFinite(t.getTime())) continue;
    const bucket = byDate.get(utcDateStr(t));
    if (!bucket) continue;
    bucket.total++;
    bucket.by_channel.sms++;
    total_sent_in_window++;
  }
  for (const p of push) {
    const t = new Date(p.sent_at);
    if (!Number.isFinite(t.getTime())) continue;
    const bucket = byDate.get(utcDateStr(t));
    if (!bucket) continue;
    bucket.total++;
    bucket.by_channel.push++;
    total_sent_in_window++;
  }

  // peak_day: highest total; ties broken by date asc.
  let peak_day: string | null = null;
  let peak_count = 0;
  for (const b of by_day) {
    if (b.total > peak_count) {
      peak_count = b.total;
      peak_day = b.date;
    }
  }
  if (peak_count === 0) peak_day = null;

  const mean_per_day = Math.round(total_sent_in_window / days);

  // growth_rate: split window into halves (mirrors M15.11 semantics).
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

  // busiest_channel: highest total across the window; canonical
  // email > sms > push tie-break via iteration order.
  let busiest_channel: NotificationChannel | null = null;
  let mostChannel = 0;
  for (const ch of ALL_CHANNELS) {
    const total = by_day.reduce((acc, b) => acc + b.by_channel[ch], 0);
    if (total > mostChannel) {
      mostChannel = total;
      busiest_channel = ch;
    }
  }
  if (mostChannel === 0) busiest_channel = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start,
    window_end,
    total_sent_in_window,
    total_sent_observed,
    by_day,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
    busiest_channel,
  };
}
