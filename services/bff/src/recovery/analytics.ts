// services/bff/src/recovery/analytics.ts
//
// Recovery Center ops analytics — operator-actionable insight over
// app_recovery.deleted_records. Drives a future SPA "Recovery
// Center → Analytics" tab that answers questions like:
//   - "How many deletes did we have this week?"
//   - "Who deletes the most?"
//   - "Are operators restoring or purging more often?"
//   - "When operators do restore, how long does it usually sit in
//      the bin first?"
//
// Pure-function resolver; the route layer drains the recovery store
// via the existing list() interface (paginated, all three statuses)
// then invokes this. Mirrors the M15.11 audit daily-volume +
// M15.13 per-actor analytics shapes — kept the field names parallel
// so future operators learning one analytics surface can guess at
// the others.

import type { DeletedRecord, RecoveryStatus } from './types';

export interface RecoveryAnalyticsInput {
  tenant_id: string;
  days: number; // window length 1..365
  now: Date;
}

export interface RecoveryDayBucket {
  /** YYYY-MM-DD in UTC. */
  date: string;
  total: number;
  by_status: Record<RecoveryStatus, number>;
}

export interface RecoveryActorRow {
  actor_username: string;
  total_archives: number;
  total_restores: number;
  total_purges: number;
  /** Most-recent timestamp across any of this actor's ops in the window. */
  most_recent_at: string;
}

export interface RecoveryEntityRow {
  entity_type: string;
  total_archives: number;
  total_restores: number;
  total_purges: number;
  /** Convenience: archive count minus restore count — the "still in
   *  the Recycle Bin" delta. Negative when restores outpaced
   *  archives in the window (operators cleaning up a backlog). */
  outstanding_delta: number;
}

export interface RecoveryAnalyticsResult {
  tenant_id: string;
  generated_at: string;
  days: number;
  window_start: string;
  window_end: string;
  /** Total archive operations in the window. */
  total_archives_in_window: number;
  /** Total restore operations (regardless of when the row was originally archived). */
  total_restores_in_window: number;
  /** Total purges in the window. */
  total_purges_in_window: number;
  /** Per-UTC-day timeline. Always exactly `days` entries, even when zero. */
  by_day: RecoveryDayBucket[];
  /** Top-N operators by total ops in window. Sorted desc by total, asc by username on tie. */
  top_actors: RecoveryActorRow[];
  /** Per-entity_type rollup. Sorted desc by archive count, asc by entity_type on tie. */
  by_entity_type: RecoveryEntityRow[];
  /** Per-module rollup. Sorted desc by archive count. */
  by_module: Array<{
    module: string;
    total_archives: number;
    total_restores: number;
    total_purges: number;
  }>;
  /** Of archived rows IN the window: what fraction was then restored
   *  (any time, even outside the window — restores follow archives
   *  asymmetrically). Null when no archives in window. */
  restore_rate: number | null;
  /** Of archived rows IN the window: what fraction was then purged.
   *  Null when no archives in window. */
  purge_rate: number | null;
  /** Mean hours between archive and restore for restored records in
   *  the window. Null when no restores in window. */
  mean_time_to_restore_hours: number | null;
  /** p50 + p95 time-to-restore in hours. Both null when fewer than
   *  2 restored records (no meaningful distribution). */
  p50_time_to_restore_hours: number | null;
  p95_time_to_restore_hours: number | null;
}

export class RecoveryAnalyticsError extends Error {
  constructor(public readonly code: 'invalid_input', message: string) {
    super(`${code}: ${message}`);
    this.name = 'RecoveryAnalyticsError';
  }
}

const TOP_ACTORS_CAP = 10;
const TOP_ENTITY_CAP = 20;
const TOP_MODULE_CAP = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

/** Validate the analytics input + clamp days to [1, 365]. */
export function validateAnalyticsInput(opts: RecoveryAnalyticsInput): void {
  if (!opts.tenant_id || typeof opts.tenant_id !== 'string') {
    throw new RecoveryAnalyticsError('invalid_input', 'tenant_id required');
  }
  if (
    !Number.isInteger(opts.days) ||
    opts.days < 1 ||
    opts.days > 365
  ) {
    throw new RecoveryAnalyticsError(
      'invalid_input',
      `days must be an integer in [1, 365] (got ${opts.days})`,
    );
  }
  if (!(opts.now instanceof Date) || Number.isNaN(opts.now.getTime())) {
    throw new RecoveryAnalyticsError('invalid_input', 'now must be a valid Date');
  }
}

/** Format a Date as YYYY-MM-DD UTC. */
function toUtcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Round to 1 decimal place — operator-friendly precision for hours
 *  and percentages. Math.round on (x * 10) handles negative numbers
 *  the same way (banker's rounding isn't a concern here since all
 *  inputs are non-negative). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Linear-interpolation percentile (Excel/R type 7) — same impl as
 *  the existing audit + ack-time histogram helpers. Returns 0 when
 *  the sample is empty, the only value when n=1, and otherwise
 *  interpolates between the two surrounding values. */
function linearPercentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (n - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAsc[lower]!;
  const frac = rank - lower;
  return sortedAsc[lower]! + frac * (sortedAsc[upper]! - sortedAsc[lower]!);
}

/**
 * Pure analytics resolver. Caller drains the recovery store via
 * list() for each status separately then concats the results.
 *
 * Time-bucketing rules:
 *   - ARCHIVE op timestamp = `deleted_at`
 *   - RESTORE op timestamp = `restored_at` (null when not restored)
 *   - PURGE op timestamp = `purged_at` (null when not purged)
 * A single recovery row can contribute to multiple op buckets at
 * different times (deleted Mon, restored Tue, would count in both).
 *
 * Window boundaries: `[now - days*24h, now]`, inclusive on both
 * ends. Records with op timestamps strictly outside the window are
 * excluded from in-window totals + per-day buckets but DO show up
 * in the time-to-restore percentile calculation when the RESTORE
 * timestamp falls in window (so cross-window restores are
 * representative of operator behavior even when the original
 * archive happened earlier).
 */
export function summarizeRecoveryActivity(
  records: readonly DeletedRecord[],
  opts: RecoveryAnalyticsInput,
): RecoveryAnalyticsResult {
  validateAnalyticsInput(opts);
  const { tenant_id, days, now } = opts;
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - days * MS_PER_DAY);

  // Day-bucket scaffold (always exactly `days` entries, oldest first).
  const dayBuckets: RecoveryDayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * MS_PER_DAY);
    dayBuckets.push({
      date: toUtcDateString(d),
      total: 0,
      by_status: { archived: 0, restored: 0, purged: 0 },
    });
  }
  const dayIndex = new Map(dayBuckets.map((b, i) => [b.date, i]));

  const archivedInWindow: DeletedRecord[] = [];
  const restoresInWindow: DeletedRecord[] = [];
  const purgesInWindow: DeletedRecord[] = [];

  // Walk the records once + accumulate every op timestamp that falls
  // in the window. A single row contributes to up to 3 ops (archive
  // + restore + purge) — though mutex constraint in the schema
  // prevents restore + purge on the same row, we still emit both
  // when they happen for different rows.
  const inWindow = (iso: string | null): boolean => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= windowStart.getTime() && t <= windowEnd.getTime();
  };

  for (const r of records) {
    if (r.tenant_id !== tenant_id) continue;

    // ARCHIVE op — always counted (every row was archived once).
    if (inWindow(r.deleted_at)) {
      archivedInWindow.push(r);
      const d = toUtcDateString(new Date(r.deleted_at));
      const i = dayIndex.get(d);
      if (i !== undefined) {
        dayBuckets[i]!.total += 1;
        dayBuckets[i]!.by_status.archived += 1;
      }
    }
    // RESTORE op — only when restored_at is present and in-window.
    if (r.restored_at && inWindow(r.restored_at)) {
      restoresInWindow.push(r);
      const d = toUtcDateString(new Date(r.restored_at));
      const i = dayIndex.get(d);
      if (i !== undefined) {
        dayBuckets[i]!.total += 1;
        dayBuckets[i]!.by_status.restored += 1;
      }
    }
    // PURGE op — only when purged_at is present and in-window.
    if (r.purged_at && inWindow(r.purged_at)) {
      purgesInWindow.push(r);
      const d = toUtcDateString(new Date(r.purged_at));
      const i = dayIndex.get(d);
      if (i !== undefined) {
        dayBuckets[i]!.total += 1;
        dayBuckets[i]!.by_status.purged += 1;
      }
    }
  }

  // ─── Per-actor rollup ─────────────────────────────────────────────
  // Each op uses the actor on that op (deleted_by / restored_by /
  // purged_by). Same person showing up in multiple ops gets one row.
  const actorMap = new Map<string, RecoveryActorRow>();
  function bumpActor(
    username: string | null,
    field: 'total_archives' | 'total_restores' | 'total_purges',
    ts: string,
  ): void {
    if (!username) return;
    let row = actorMap.get(username);
    if (!row) {
      row = {
        actor_username: username,
        total_archives: 0,
        total_restores: 0,
        total_purges: 0,
        most_recent_at: ts,
      };
      actorMap.set(username, row);
    }
    row[field] += 1;
    if (ts > row.most_recent_at) row.most_recent_at = ts;
  }
  for (const r of archivedInWindow) bumpActor(r.deleted_by, 'total_archives', r.deleted_at);
  for (const r of restoresInWindow) bumpActor(r.restored_by, 'total_restores', r.restored_at!);
  for (const r of purgesInWindow) bumpActor(r.purged_by, 'total_purges', r.purged_at!);
  const top_actors = [...actorMap.values()]
    .sort((a, b) => {
      const ta = a.total_archives + a.total_restores + a.total_purges;
      const tb = b.total_archives + b.total_restores + b.total_purges;
      if (tb !== ta) return tb - ta;
      return a.actor_username < b.actor_username ? -1 : a.actor_username > b.actor_username ? 1 : 0;
    })
    .slice(0, TOP_ACTORS_CAP);

  // ─── Per-entity_type rollup ───────────────────────────────────────
  const entityMap = new Map<string, RecoveryEntityRow>();
  function ensureEntity(et: string): RecoveryEntityRow {
    let row = entityMap.get(et);
    if (!row) {
      row = {
        entity_type: et,
        total_archives: 0,
        total_restores: 0,
        total_purges: 0,
        outstanding_delta: 0,
      };
      entityMap.set(et, row);
    }
    return row;
  }
  for (const r of archivedInWindow) ensureEntity(r.entity_type).total_archives += 1;
  for (const r of restoresInWindow) ensureEntity(r.entity_type).total_restores += 1;
  for (const r of purgesInWindow) ensureEntity(r.entity_type).total_purges += 1;
  for (const row of entityMap.values()) {
    row.outstanding_delta = row.total_archives - row.total_restores;
  }
  const by_entity_type = [...entityMap.values()]
    .sort((a, b) => {
      if (b.total_archives !== a.total_archives) return b.total_archives - a.total_archives;
      return a.entity_type < b.entity_type ? -1 : a.entity_type > b.entity_type ? 1 : 0;
    })
    .slice(0, TOP_ENTITY_CAP);

  // ─── Per-module rollup ────────────────────────────────────────────
  const moduleMap = new Map<
    string,
    { module: string; total_archives: number; total_restores: number; total_purges: number }
  >();
  function ensureModule(m: string) {
    let row = moduleMap.get(m);
    if (!row) {
      row = { module: m, total_archives: 0, total_restores: 0, total_purges: 0 };
      moduleMap.set(m, row);
    }
    return row;
  }
  for (const r of archivedInWindow) ensureModule(r.module).total_archives += 1;
  for (const r of restoresInWindow) ensureModule(r.module).total_restores += 1;
  for (const r of purgesInWindow) ensureModule(r.module).total_purges += 1;
  const by_module = [...moduleMap.values()]
    .sort((a, b) => {
      if (b.total_archives !== a.total_archives) return b.total_archives - a.total_archives;
      return a.module < b.module ? -1 : a.module > b.module ? 1 : 0;
    })
    .slice(0, TOP_MODULE_CAP);

  // ─── Rates over the archived-in-window cohort ─────────────────────
  // Of the rows ARCHIVED in this window, how many ended up restored
  // OR purged (at any time, including outside the window)? This is
  // a cohort metric; restores of OLDER rows don't show up here.
  const cohortRestored = archivedInWindow.filter((r) => r.restored_at !== null).length;
  const cohortPurged = archivedInWindow.filter((r) => r.purged_at !== null).length;
  const cohortSize = archivedInWindow.length;
  const restore_rate = cohortSize > 0 ? round1((cohortRestored / cohortSize) * 100) / 100 : null;
  const purge_rate = cohortSize > 0 ? round1((cohortPurged / cohortSize) * 100) / 100 : null;

  // ─── Time-to-restore (uses the in-window RESTORE ops, regardless
  //     of when the underlying row was archived) ─────────────────────
  const timeToRestoreHours: number[] = [];
  for (const r of restoresInWindow) {
    const archivedAt = new Date(r.deleted_at).getTime();
    const restoredAt = new Date(r.restored_at!).getTime();
    if (restoredAt > archivedAt) {
      timeToRestoreHours.push((restoredAt - archivedAt) / MS_PER_HOUR);
    }
  }
  const mean_time_to_restore_hours =
    timeToRestoreHours.length === 0
      ? null
      : round1(
          timeToRestoreHours.reduce((a, b) => a + b, 0) / timeToRestoreHours.length,
        );
  timeToRestoreHours.sort((a, b) => a - b);
  const p50_time_to_restore_hours =
    timeToRestoreHours.length < 2 ? null : round1(linearPercentile(timeToRestoreHours, 50));
  const p95_time_to_restore_hours =
    timeToRestoreHours.length < 2 ? null : round1(linearPercentile(timeToRestoreHours, 95));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    total_archives_in_window: archivedInWindow.length,
    total_restores_in_window: restoresInWindow.length,
    total_purges_in_window: purgesInWindow.length,
    by_day: dayBuckets,
    top_actors,
    by_entity_type,
    by_module,
    restore_rate,
    purge_rate,
    mean_time_to_restore_hours,
    p50_time_to_restore_hours,
    p95_time_to_restore_hours,
  };
}
