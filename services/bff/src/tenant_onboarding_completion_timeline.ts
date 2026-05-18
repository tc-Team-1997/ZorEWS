// services/bff/src/tenant_onboarding_completion_timeline.ts
//
// T6 M2.16 — Onboarding step completion daily timeline.
//
// M2.13 ships per-step cross-tenant completion ranking (aggregate
// status per step). M2.14 ships step × tenant-vertical matrix.
// M2.15 ships fleet-wide per-actor rollup.
//
// M2.16 lands the TREND-LINE view: across all tenants in the
// registry, count step completions per UTC calendar day. Drives
// "are we onboarding more tenants this month than last? when did
// completions spike?" answers in one round-trip.
//
// Mirror of M1.9 / M8.15 / M10.15 / M12.13 / M15.11 daily-volume
// pattern for the onboarding surface.
//
// Pure resolver — caller passes fleet of (tenant_id, steps[]).

import type { StepProgress } from './tenant_onboarding';

// ─── Constants ─────────────────────────────────────────────────────────

export const DEFAULT_ONBOARDING_DAILY_WINDOW = 30;
export const MAX_ONBOARDING_DAILY_WINDOW = 365;
export const MIN_ONBOARDING_DAILY_WINDOW = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Public types ──────────────────────────────────────────────────────

export interface OnboardingDailyBucket {
  date: string;
  /** Total step actions in this day (completed + skipped). */
  total: number;
  completed_count: number;
  skipped_count: number;
  /** Distinct tenants that had ≥ 1 action on this day. */
  distinct_tenants: number;
}

export interface OnboardingCompletionTimelineSummary {
  generated_at: string;
  days: number;
  window_start: string;
  window_end: string;
  total_tenants_scanned: number;
  total_actions_in_window: number;
  total_actions_observed: number;
  by_day: OnboardingDailyBucket[];
  /** Highest-total day; earliest-day-wins tie-break via strict `>`;
   *  null on empty. */
  peak_day: string | null;
  peak_count: number;
  mean_per_day: number;
  /** (second-half mean − first-half mean) / first-half mean; null when
   *  first-half=0 OR days<2 — same M1.9/M8.15/M10.15 semantics. */
  growth_rate: number | null;
}

export class OnboardingCompletionTimelineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OnboardingCompletionTimelineError';
  }
}

interface FleetEntry {
  tenant_id: string;
  steps: readonly StepProgress[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function utcDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function meanOf(arr: OnboardingDailyBucket[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((acc, b) => acc + b.total, 0) / arr.length;
}

function validateDays(days: number): void {
  if (
    !Number.isInteger(days) ||
    days < MIN_ONBOARDING_DAILY_WINDOW ||
    days > MAX_ONBOARDING_DAILY_WINDOW
  ) {
    throw new OnboardingCompletionTimelineError(
      'invalid_input',
      `days must be an integer in [${MIN_ONBOARDING_DAILY_WINDOW}, ${MAX_ONBOARDING_DAILY_WINDOW}]`,
    );
  }
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeOnboardingCompletionTimeline(
  fleet: readonly FleetEntry[],
  days: number,
  now: Date,
): OnboardingCompletionTimelineSummary {
  validateDays(days);

  const endDay = startOfUtcDay(now);
  const startDay = new Date(endDay.getTime() - (days - 1) * MS_PER_DAY);

  const byDate = new Map<string, OnboardingDailyBucket>();
  const tenantsByDate = new Map<string, Set<string>>();
  const by_day: OnboardingDailyBucket[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDay.getTime() + i * MS_PER_DAY);
    const date = utcDateStr(d);
    const bucket: OnboardingDailyBucket = {
      date,
      total: 0,
      completed_count: 0,
      skipped_count: 0,
      distinct_tenants: 0,
    };
    byDate.set(date, bucket);
    tenantsByDate.set(date, new Set<string>());
    by_day.push(bucket);
  }

  const window_start = by_day[0]!.date;
  const window_end = by_day[by_day.length - 1]!.date;

  let total_actions_in_window = 0;
  let total_actions_observed = 0;

  for (const entry of fleet) {
    for (const sp of entry.steps) {
      if (sp.status !== 'completed' && sp.status !== 'skipped') continue;
      if (!sp.completed_at) continue;
      total_actions_observed++;
      const ts = new Date(sp.completed_at).getTime();
      if (!Number.isFinite(ts)) continue;
      const dateKey = utcDateStr(new Date(ts));
      const bucket = byDate.get(dateKey);
      if (!bucket) continue; // outside window
      bucket.total++;
      total_actions_in_window++;
      if (sp.status === 'completed') bucket.completed_count++;
      else bucket.skipped_count++;
      tenantsByDate.get(dateKey)!.add(entry.tenant_id);
    }
  }

  // Finalize distinct_tenants per bucket.
  for (const bucket of by_day) {
    bucket.distinct_tenants = tenantsByDate.get(bucket.date)!.size;
  }

  // peak_day — highest total; earliest-day-wins tie-break.
  let peak_day: string | null = null;
  let peak_count = 0;
  for (const b of by_day) {
    if (b.total > peak_count) {
      peak_count = b.total;
      peak_day = b.date;
    }
  }
  if (peak_count === 0) peak_day = null;

  const mean_per_day = Math.round(total_actions_in_window / days);

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
    generated_at: now.toISOString(),
    days,
    window_start,
    window_end,
    total_tenants_scanned: fleet.length,
    total_actions_in_window,
    total_actions_observed,
    by_day,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
  };
}
