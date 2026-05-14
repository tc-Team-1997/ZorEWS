// services/bff/src/audit_activity_heatmap.ts
//
// T6 M15.7 — Audit activity day-of-week × hour-of-day heatmap.
//
// Mirror of M14.22 (field visit heatmap) but over the M15.1 audit
// chain. Bins each event's `ts` into a 7 × 24 grid (ISO Mon=0..Sun=6
// × hour 0..23) so the SPA can render a calendar heatmap answering
// "when are ops most active on the platform?". Zone-aware: caller
// supplies a tz from the M12.4 13-zone whitelist.
//
// Pure — no I/O. Caller filters the event list (via auditTrailStore's
// since/until/actor filters) before passing it in.

import { isScheduleTz, type ScheduleTz } from './report_schedules';
import type { AuditEvent } from './audit_trail';

// ─── Public types ─────────────────────────────────────────────────────

export type DowIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6; // ISO Mon=0..Sun=6

export interface AuditDowHourHeatmap {
  tz: ScheduleTz;
  total_events: number;
  /** 7 × 24 matrix indexed [dow][hour]. */
  by_dow_hour: number[][];
  by_dow: number[];
  by_hour: number[];
  /** Single peak (dow, hour). Ties broken row-major: dow asc, hour asc. */
  peak_dow: DowIndex | null;
  peak_hour: number | null;
  peak_count: number;
}

const WEEKDAY_TO_DOW: Record<string, DowIndex> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

function extractDowHour(iso: string, tz: ScheduleTz): { dow: DowIndex; hour: number } | null {
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
  const h = hour === 24 ? 0 : hour;
  const dow = WEEKDAY_TO_DOW[weekday];
  if (dow === undefined) return null;
  return { dow, hour: h };
}

function makeMatrix(rows: number, cols: number): number[][] {
  const m: number[][] = [];
  for (let r = 0; r < rows; r += 1) m.push(new Array<number>(cols).fill(0));
  return m;
}

export function bucketAuditByDowHour(
  events: readonly AuditEvent[],
  tz: ScheduleTz = 'UTC',
): AuditDowHourHeatmap {
  if (!isScheduleTz(tz)) {
    // Defensive — TS already constrains, but the route accepts strings.
    throw new Error(`tz '${tz}' is not in the supported list`);
  }
  const matrix = makeMatrix(7, 24);
  const byDow = new Array<number>(7).fill(0);
  const byHour = new Array<number>(24).fill(0);
  let total = 0;
  for (const e of events) {
    const bucket = extractDowHour(e.ts, tz);
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
    total_events: total,
    by_dow_hour: matrix,
    by_dow: byDow,
    by_hour: byHour,
    peak_dow: peakDow,
    peak_hour: peakHour,
    peak_count: peakCount,
  };
}
