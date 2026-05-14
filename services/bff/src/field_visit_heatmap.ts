// services/bff/src/field_visit_heatmap.ts
//
// T6 M14.22 — Field-visit day-of-week × hour-of-day heatmap.
//
// M14.10 ships the visit ledger; M14.19 rolls up totals + per-officer
// breakdowns; M14.21 clusters visits by GPS. M14.22 bins visits into
// a 7 × 24 temporal grid (ISO Mon=0..Sun=6 × hour 0..23) so the SPA
// can render a calendar-style heatmap answering "when are officers
// most active?".
//
// Zone-aware: `tz` parameter selects the wall-clock used for
// bucketing. Default 'UTC'. Reuses the 13-zone whitelist already
// shared with M12.4 report schedules + M14.10 today() endpoint.
//
// Pure — no I/O. Caller filters the input list to a window /
// officer / outcome before passing it in (the M14.10 store already
// supports those filters).

import { isScheduleTz, type ScheduleTz } from './report_schedules';
import type { FieldVisit } from './field_officer';

// ─── Public types ─────────────────────────────────────────────────────

export type DowIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6; // ISO Mon=0..Sun=6

export interface DowHourHeatmap {
  /** Wall-clock zone used for bucketing. */
  tz: ScheduleTz;
  total_visits: number;
  /** 7 × 24 matrix indexed [dow][hour]. */
  by_dow_hour: number[][];
  /** 7-element marginal totals per day-of-week. */
  by_dow: number[];
  /** 24-element marginal totals per hour-of-day. */
  by_hour: number[];
  /** Bucket with the highest count. Ties broken by (dow asc, hour asc). */
  peak_dow: DowIndex | null;
  peak_hour: number | null;
  peak_count: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Map Intl.DateTimeFormat short-weekday output to ISO Mon=0..Sun=6. */
const WEEKDAY_TO_DOW: Record<string, DowIndex> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

function extractDowHour(
  iso: string,
  tz: ScheduleTz,
): { dow: DowIndex; hour: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  let weekday: string | null = null;
  let hour: number | null = null;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour') hour = Number.parseInt(p.value, 10);
  }
  if (weekday == null || hour == null || Number.isNaN(hour)) return null;
  // Intl emits '24' for midnight in some locales; normalise.
  const h = hour === 24 ? 0 : hour;
  const dow = WEEKDAY_TO_DOW[weekday];
  if (dow === undefined) return null;
  return { dow, hour: h };
}

function makeMatrix(rows: number, cols: number): number[][] {
  const m: number[][] = [];
  for (let r = 0; r < rows; r += 1) {
    m.push(new Array<number>(cols).fill(0));
  }
  return m;
}

// ─── Pure binner ──────────────────────────────────────────────────────

/**
 * Pure binner — buckets each visit's `visit_at` into the (dow, hour)
 * grid in the caller-supplied timezone. Visits with unparseable
 * `visit_at` are silently dropped (the M14.10 store already validates
 * on insert, so this only catches paranoid inputs).
 */
export function bucketVisitsByDowHour(
  visits: readonly FieldVisit[],
  tz: ScheduleTz = 'UTC',
): DowHourHeatmap {
  const matrix = makeMatrix(7, 24);
  const byDow = new Array<number>(7).fill(0);
  const byHour = new Array<number>(24).fill(0);
  let total = 0;

  for (const v of visits) {
    const bucket = extractDowHour(v.visit_at, tz);
    if (!bucket) continue;
    matrix[bucket.dow]![bucket.hour] += 1;
    byDow[bucket.dow] += 1;
    byHour[bucket.hour] += 1;
    total += 1;
  }

  let peakDow: DowIndex | null = null;
  let peakHour: number | null = null;
  let peakCount = 0;
  if (total > 0) {
    for (let d = 0 as DowIndex; d <= 6; d = (d + 1) as DowIndex) {
      for (let h = 0; h < 24; h += 1) {
        const c = matrix[d]![h]!;
        if (c > peakCount) {
          peakCount = c;
          peakDow = d;
          peakHour = h;
        }
      }
    }
  }

  return {
    tz,
    total_visits: total,
    by_dow_hour: matrix,
    by_dow: byDow,
    by_hour: byHour,
    peak_dow: peakDow,
    peak_hour: peakHour,
    peak_count: peakCount,
  };
}

export function isHeatmapTz(s: unknown): s is ScheduleTz {
  return isScheduleTz(s);
}
