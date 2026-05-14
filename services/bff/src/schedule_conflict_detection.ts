// services/bff/src/schedule_conflict_detection.ts
//
// T6 M12.8 — Report schedule conflict detection.
//
// M12.6 previews the next-N firings of ONE schedule. M12.7 merges all
// schedules' next-N firings into a unified fleet calendar. M12.8 ships
// the conflict view: find pairs of DIFFERENT schedules whose fire_at
// values are within `window_minutes` of each other. Useful for ops
// who want to spot "these two heavy reports fire at the exact same
// minute and slam the database simultaneously".
//
// Pure — no I/O. Caller passes the schedule list (typically the
// tenant's enabled-only set).

import {
  previewScheduleEntryRuns,
  type PreviewedRun,
} from './report_schedule_preview';
import type { ReportScheduleEntry } from './report_schedules';

const CONFLICT_MAX_WINDOW_MIN = 240; // 4 hours — generous upper bound
const CONFLICT_MAX_LOOKAHEAD_N = 50;

// ─── Public types ─────────────────────────────────────────────────────

export interface ConflictPointer {
  schedule_id: string;
  name: string;
  fire_at: string;
}

export interface ScheduleConflict {
  a: ConflictPointer;
  b: ConflictPointer;
  gap_ms: number;
}

export interface ConflictReport {
  from: string;
  window_minutes: number;
  lookahead_n: number;
  total_conflicts: number;
  schedules_involved_count: number;
  conflicts: ScheduleConflict[];
}

export class ConflictDetectionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ConflictDetectionError';
  }
}

// ─── Pure detector ────────────────────────────────────────────────────

/**
 * Detects schedule fire-time conflicts.
 *
 * Algorithm:
 *   1. For every enabled schedule, generate its next `lookahead_n`
 *      firings via previewScheduleEntryRuns.
 *   2. Annotate each firing with `(schedule_id, name)`.
 *   3. Sort all firings by fire_at asc.
 *   4. Two-pointer sweep: for each firing i, walk j=i+1 while
 *      (fire_at[j] - fire_at[i]) <= window_minutes. Emit a conflict
 *      pair (i, j) ONLY when schedule_id[i] !== schedule_id[j] —
 *      same-schedule self-pairs are by-construction never closer
 *      than the cadence (and not interesting either way).
 *   5. Sort conflicts by fire_at[a] asc, then schedule_id[a] asc.
 */
export function detectScheduleConflicts(
  schedules: readonly ReportScheduleEntry[],
  from: Date,
  window_minutes: number = 15,
  lookahead_n: number = 10,
): ConflictReport {
  if (!(from instanceof Date) || !Number.isFinite(from.getTime())) {
    throw new ConflictDetectionError('invalid_input', 'from must be a valid Date');
  }
  if (!Number.isInteger(window_minutes) || window_minutes < 0 || window_minutes > CONFLICT_MAX_WINDOW_MIN) {
    throw new ConflictDetectionError(
      'invalid_input',
      `window_minutes must be 0..${CONFLICT_MAX_WINDOW_MIN}`,
    );
  }
  if (!Number.isInteger(lookahead_n) || lookahead_n < 1 || lookahead_n > CONFLICT_MAX_LOOKAHEAD_N) {
    throw new ConflictDetectionError(
      'invalid_input',
      `lookahead_n must be 1..${CONFLICT_MAX_LOOKAHEAD_N}`,
    );
  }

  const windowMs = window_minutes * 60_000;
  const enabled = schedules.filter((s) => s.enabled);

  // Build the flat firing list.
  interface Firing {
    schedule_id: string;
    name: string;
    fire_at: string;
    fire_ms: number;
  }
  const firings: Firing[] = [];
  for (const s of enabled) {
    const runs: PreviewedRun[] = previewScheduleEntryRuns(s, from, lookahead_n);
    for (const r of runs) {
      firings.push({
        schedule_id: s.schedule_id,
        name: s.name,
        fire_at: r.fire_at,
        fire_ms: new Date(r.fire_at).getTime(),
      });
    }
  }
  firings.sort((a, b) => a.fire_ms - b.fire_ms);

  const conflicts: ScheduleConflict[] = [];
  const seenPair = new Set<string>(); // dedupe (schedule_id, fire_at) × (schedule_id, fire_at)
  for (let i = 0; i < firings.length; i += 1) {
    const a = firings[i]!;
    for (let j = i + 1; j < firings.length; j += 1) {
      const b = firings[j]!;
      const gap = b.fire_ms - a.fire_ms;
      if (gap > windowMs) break;
      if (a.schedule_id === b.schedule_id) continue;
      // Dedupe on the canonical (a.schedule_id|a.fire_at|b.schedule_id|b.fire_at)
      // — for any given pair of firings, we'd never see them twice anyway
      // since j > i, but keeping the dedupe explicit guards against future
      // refactors that swap the inner loop.
      const key = [a.schedule_id, a.fire_at, b.schedule_id, b.fire_at].join('|');
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      conflicts.push({
        a: { schedule_id: a.schedule_id, name: a.name, fire_at: a.fire_at },
        b: { schedule_id: b.schedule_id, name: b.name, fire_at: b.fire_at },
        gap_ms: gap,
      });
    }
  }

  // Sort: earliest-pair first; tie-break by schedule_id asc, then b.schedule_id asc.
  conflicts.sort((x, y) => {
    if (x.a.fire_at !== y.a.fire_at) return x.a.fire_at < y.a.fire_at ? -1 : 1;
    if (x.a.schedule_id !== y.a.schedule_id) return x.a.schedule_id < y.a.schedule_id ? -1 : 1;
    if (x.b.schedule_id !== y.b.schedule_id) return x.b.schedule_id < y.b.schedule_id ? -1 : 1;
    return 0;
  });

  // Count distinct schedules involved.
  const involved = new Set<string>();
  for (const c of conflicts) {
    involved.add(c.a.schedule_id);
    involved.add(c.b.schedule_id);
  }

  return {
    from: from.toISOString(),
    window_minutes,
    lookahead_n,
    total_conflicts: conflicts.length,
    schedules_involved_count: involved.size,
    conflicts,
  };
}
