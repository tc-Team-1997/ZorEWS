// services/bff/src/report_schedule_preview.ts
//
// T6 M12.6 — Recurring report schedule preview.
//
// M12.2 ships `computeNextRun` (pure: cadence + clock anchor +
// `after` instant → next fire time). M12.4 adds tz support. Once
// an operator builds a schedule via the M12.2 CRUD, the natural
// next question is "when WILL this fire, over the next month?".
// M12.6 ships a tiny forward simulator that iterates computeNextRun
// to produce a preview of the next N firings.
//
// Design:
//  - Pure function over a `ReportScheduleEntry` (or its component
//    fields) + a `from` instant + an N. No I/O, no store coupling.
//  - n bounded [1, 50]. 50 = a month-and-change of daily firings
//    or a year of weekly firings; deeper projection isn't useful
//    for the SPA timeline view.
//  - Each step advances the `after` anchor to the previously-
//    computed run_at + 1ms, so consecutive calls strictly increase.

import {
  computeNextRun,
  type ReportScheduleEntry,
  type ScheduleCadence,
  type ScheduleTz,
} from './report_schedules';

// ─── Public types ─────────────────────────────────────────────────────

export interface PreviewedRun {
  /** 1-based ordinal — first projected run is run_no=1. */
  run_no: number;
  /** ISO timestamp the schedule would fire. */
  fire_at: string;
}

export const PREVIEW_DEFAULT_N = 10;
export const PREVIEW_MAX_N = 50;

export class SchedulePreviewError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SchedulePreviewError';
  }
}

// ─── Pure preview ─────────────────────────────────────────────────────

/**
 * Project the next N firings of a recurring schedule from `from`.
 * Iterates `computeNextRun` and advances the anchor by 1 ms each
 * step so consecutive returns are strictly increasing.
 */
export function previewScheduleRuns(
  args: {
    cadence: ScheduleCadence;
    day_of_week: number | null;
    day_of_month: number | null;
    hour_utc: number;
    tz: ScheduleTz;
  },
  from: Date,
  n: number,
): PreviewedRun[] {
  if (!Number.isInteger(n) || n < 1 || n > PREVIEW_MAX_N) {
    throw new SchedulePreviewError(
      'invalid_input',
      `n must be an integer in 1..${PREVIEW_MAX_N}`,
    );
  }
  if (!(from instanceof Date) || !Number.isFinite(from.getTime())) {
    throw new SchedulePreviewError('invalid_input', 'from must be a valid Date');
  }
  const runs: PreviewedRun[] = [];
  let anchor = from;
  for (let i = 0; i < n; i++) {
    const next = computeNextRun(
      args.cadence,
      args.day_of_week,
      args.day_of_month,
      args.hour_utc,
      anchor,
      args.tz,
    );
    runs.push({ run_no: i + 1, fire_at: next.toISOString() });
    // Advance by 1ms so the next iteration finds a STRICTLY-future
    // instant; computeNextRun's contract is "next strictly-future".
    anchor = new Date(next.getTime() + 1);
  }
  return runs;
}

/** Convenience adapter when the caller has a ReportScheduleEntry. */
export function previewScheduleEntryRuns(
  schedule: Pick<
    ReportScheduleEntry,
    'cadence' | 'day_of_week' | 'day_of_month' | 'hour_utc' | 'tz'
  >,
  from: Date,
  n: number,
): PreviewedRun[] {
  return previewScheduleRuns(
    {
      cadence: schedule.cadence,
      day_of_week: schedule.day_of_week,
      day_of_month: schedule.day_of_month,
      hour_utc: schedule.hour_utc,
      tz: schedule.tz,
    },
    from,
    n,
  );
}
