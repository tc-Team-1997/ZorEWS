// services/bff/src/report_schedule_fleet_preview.ts
//
// T6 M12.7 — Report schedule fleet-wide upcoming runs.
//
// M12.6 previews the next-N runs for ONE schedule. M12.7 widens the
// view to the entire tenant: walk every enabled schedule, generate
// each one's next N firings, merge into a single timeline sorted
// by fire_at asc, and trim to the top n. Useful for a SPA calendar
// view that answers "what's firing in the next hour / day / week
// across all my scheduled reports?".
//
// Pure — no I/O. Caller passes the schedules already filtered to
// the tenant (typically via `reportScheduleStore.list(tenant)`).
// Disabled schedules are silently skipped (their `next_run_at`
// isn't a real firing).

import {
  previewScheduleEntryRuns,
  type PreviewedRun,
} from './report_schedule_preview';
import type { ReportScheduleEntry } from './report_schedules';

const FLEET_PREVIEW_MAX_N = 100;

// ─── Public types ─────────────────────────────────────────────────────

export interface FleetPreviewItem {
  schedule_id: string;
  name: string;
  report_id: string;
  format: ReportScheduleEntry['format'];
  fire_at: string;
}

export interface FleetPreview {
  from: string;
  total_schedules_considered: number;
  total_enabled: number;
  total_returned: number;
  items: FleetPreviewItem[];
}

export class FleetPreviewError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FleetPreviewError';
  }
}

// ─── Pure fleet preview ───────────────────────────────────────────────

/**
 * Generates the next-N firings across the supplied schedules,
 * merged + sorted by fire_at asc and trimmed to top n.
 *
 * Each enabled schedule contributes up to `n` candidate runs to
 * the merge pool — that's enough to ensure the top-n overall is
 * complete even when one fast-firing schedule (e.g. daily) would
 * otherwise dominate the slot.
 */
export function previewScheduleFleet(
  schedules: readonly ReportScheduleEntry[],
  from: Date,
  n: number = 20,
): FleetPreview {
  if (!Number.isInteger(n) || n < 1 || n > FLEET_PREVIEW_MAX_N) {
    throw new FleetPreviewError(
      'invalid_input',
      `n must be an integer in 1..${FLEET_PREVIEW_MAX_N}`,
    );
  }
  if (!(from instanceof Date) || !Number.isFinite(from.getTime())) {
    throw new FleetPreviewError('invalid_input', 'from must be a valid Date');
  }
  const enabled = schedules.filter((s) => s.enabled);

  const pool: FleetPreviewItem[] = [];
  for (const s of enabled) {
    const runs: PreviewedRun[] = previewScheduleEntryRuns(s, from, n);
    for (const r of runs) {
      pool.push({
        schedule_id: s.schedule_id,
        name: s.name,
        report_id: s.report_id,
        format: s.format,
        fire_at: r.fire_at,
      });
    }
  }

  pool.sort((a, b) => {
    if (a.fire_at !== b.fire_at) return a.fire_at < b.fire_at ? -1 : 1;
    return a.schedule_id < b.schedule_id ? -1 : a.schedule_id > b.schedule_id ? 1 : 0;
  });

  const items = pool.slice(0, n);
  return {
    from: from.toISOString(),
    total_schedules_considered: schedules.length,
    total_enabled: enabled.length,
    total_returned: items.length,
    items,
  };
}
