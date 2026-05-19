// services/bff/src/ai_promotion_daily_volume.ts
//
// T6 M7.17 — Promotion request daily volume timeline.
//
// M7.2 ships the PromotionEngine + request lifecycle. M7.10 ships the
// per-model timeline. M7.15 ships the approval-latency histogram
// (bucketed by decision duration). M7.16 ships the per-reviewer rollup.
//
// M7.17 ships the trailing-N-day TREND view across the fleet: per UTC
// calendar day, bucket {total, by_status (every PromotionRequestStatus
// at 0), distinct_models, distinct_requesters}. Mirror of M1.9 / M8.15
// / M10.15 / M12.13 / M15.11 / M3.17 daily-volume pattern.
//
// Distinct from M7.10 (per-model timeline — chronological ladder per
// model) and M7.15 (latency histogram — bucketed by decision duration)
// by being the fleet-wide DAILY volume trend over the requested_at
// timestamp. Drives BIL AI governance "are we filing more promotion
// requests this month? when did the spike happen?" answers.

import type {
  PromotionEngine,
  PromotionRequestStatus,
} from './ai_model_promotion';

const MS_PER_DAY = 86_400_000;

export const DEFAULT_PROMOTION_DAILY_WINDOW = 30;
export const MAX_PROMOTION_DAILY_WINDOW = 365;

const ALL_PROMOTION_STATUSES: readonly PromotionRequestStatus[] = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface PromotionDailyBucket {
  date: string; // YYYY-MM-DD UTC
  total: number;
  by_status: Record<PromotionRequestStatus, number>;
  distinct_models: number;
  distinct_requesters: number;
}

export interface PromotionDailyVolume {
  tenant_id: string;
  generated_at: string;
  days: number;
  window_start: string;
  window_end: string;
  total_requests_in_window: number;
  total_requests_observed: number;
  by_day: PromotionDailyBucket[];
  peak_day: string | null;
  peak_count: number;
  mean_per_day: number;
  growth_rate: number | null;
  busiest_status: PromotionRequestStatus | null;
}

export class PromotionDailyVolumeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PromotionDailyVolumeError';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByStatus(): Record<PromotionRequestStatus, number> {
  const out = {} as Record<PromotionRequestStatus, number>;
  for (const s of ALL_PROMOTION_STATUSES) out[s] = 0;
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

const DRAIN_PAGE_SIZE = 500;
const DRAIN_PAGE_CAP = 200;

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildPromotionDailyVolume(
  engine: PromotionEngine,
  tenant_id: string,
  days: number,
  now: Date,
): PromotionDailyVolume {
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > MAX_PROMOTION_DAILY_WINDOW
  ) {
    throw new PromotionDailyVolumeError(
      'invalid_input',
      `days must be an integer in [1, ${MAX_PROMOTION_DAILY_WINDOW}]`,
    );
  }

  const todayUtc = utcDayStart(now);
  const windowStartUtc = new Date(todayUtc.getTime() - (days - 1) * MS_PER_DAY);

  const buckets: PromotionDailyBucket[] = [];
  const bucketIndex = new Map<string, PromotionDailyBucket>();
  for (let i = 0; i < days; i++) {
    const day = new Date(windowStartUtc.getTime() + i * MS_PER_DAY);
    const date = utcDateString(day);
    const bucket: PromotionDailyBucket = {
      date,
      total: 0,
      by_status: emptyByStatus(),
      distinct_models: 0,
      distinct_requesters: 0,
    };
    buckets.push(bucket);
    bucketIndex.set(date, bucket);
  }

  const modelSetByDay = new Map<string, Set<string>>();
  const requesterSetByDay = new Map<string, Set<string>>();
  for (const b of buckets) {
    modelSetByDay.set(b.date, new Set<string>());
    requesterSetByDay.set(b.date, new Set<string>());
  }

  let total_requests_observed = 0;
  let total_requests_in_window = 0;

  for (let page = 1; page <= DRAIN_PAGE_CAP; page++) {
    const result = engine.list(tenant_id, { page, page_size: DRAIN_PAGE_SIZE });
    for (const req of result.items) {
      total_requests_observed++;
      const reqAt = new Date(req.requested_at).getTime();
      if (Number.isNaN(reqAt)) continue;
      const dayStr = utcDateString(utcDayStart(new Date(reqAt)));
      const bucket = bucketIndex.get(dayStr);
      if (!bucket) continue;
      bucket.total++;
      total_requests_in_window++;
      if (ALL_PROMOTION_STATUSES.includes(req.status)) {
        bucket.by_status[req.status]++;
      }
      modelSetByDay.get(dayStr)!.add(req.model_id);
      if (req.requested_by) {
        requesterSetByDay.get(dayStr)!.add(req.requested_by);
      }
    }
    if (result.items.length < DRAIN_PAGE_SIZE) break;
  }

  for (const bucket of buckets) {
    bucket.distinct_models = modelSetByDay.get(bucket.date)!.size;
    bucket.distinct_requesters = requesterSetByDay.get(bucket.date)!.size;
  }

  let peak_day: string | null = null;
  let peak_count = 0;
  for (const bucket of buckets) {
    if (bucket.total > peak_count) {
      peak_count = bucket.total;
      peak_day = bucket.date;
    }
  }

  const mean_per_day = Math.round(total_requests_in_window / days);

  let growth_rate: number | null = null;
  if (days >= 2) {
    const half = Math.floor(days / 2);
    let firstSum = 0;
    let secondSum = 0;
    for (let i = 0; i < days; i++) {
      if (i < half) firstSum += buckets[i].total;
      else secondSum += buckets[i].total;
    }
    const firstHalfMean = firstSum / half;
    const secondHalfMean = secondSum / (days - half);
    if (firstHalfMean > 0) {
      growth_rate = (secondHalfMean - firstHalfMean) / firstHalfMean;
    }
  }

  let busiest_status: PromotionRequestStatus | null = null;
  let busiestCount = 0;
  const statusTotals = emptyByStatus();
  for (const bucket of buckets) {
    for (const s of ALL_PROMOTION_STATUSES) {
      statusTotals[s] += bucket.by_status[s];
    }
  }
  for (const s of ALL_PROMOTION_STATUSES) {
    if (statusTotals[s] > busiestCount) {
      busiestCount = statusTotals[s];
      busiest_status = s;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start: utcDateString(windowStartUtc),
    window_end: utcDateString(todayUtc),
    total_requests_in_window,
    total_requests_observed,
    by_day: buckets,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
    busiest_status,
  };
}
