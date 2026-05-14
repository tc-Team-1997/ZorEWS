// services/bff/src/report_schedule_cadence_stats.ts
//
// T6 M12.9 — Report schedule cadence statistics.
//
// M12.2 ships per-schedule CRUD; M12.6 ships next-N-runs preview;
// M12.7 the fleet-wide upcoming-runs preview; M12.8 conflict
// detection. M12.9 ships the CADENCE-pivoted rollup: across all
// schedules in a tenant, how many use each cadence (daily/weekly/
// monthly/quarterly/last_day_of_month), enabled split, next-run-
// within-window counts.
//
// Lets the SPA render a cadence-distribution chip strip on the
// schedules page header + spot operational imbalances ("you have
// 30 daily schedules but only 2 are enabled — was that
// intentional?").
//
// Pure rollup — drains the store via pagination then groups
// in-memory. Companion to M12.7 / M12.8 — different lens.

import type {
  ReportScheduleEntry,
  ReportScheduleStore,
  ScheduleCadence,
} from './report_schedules';
import { VALID_CADENCES } from './report_schedules';

// ─── Public types ─────────────────────────────────────────────────────

export interface CadenceStatRow {
  cadence: ScheduleCadence;
  total_count: number;
  enabled_count: number;
  disabled_count: number;
  /** Schedules whose `next_run_at` falls within the next 24 hours of
   *  `now`. Disabled schedules excluded — they aren't actionable.
   *  null `next_run_at` (shouldn't happen but defensive) → excluded. */
  next_run_within_24h_count: number;
  /** Schedules whose `next_run_at` falls within the next 7 days. */
  next_run_within_7d_count: number;
  /** Earliest enabled-schedule next_run_at across this cadence.
   *  null when no enabled schedules in cadence. */
  earliest_next_run_at: string | null;
}

export interface ScheduleCadenceStats {
  tenant_id: string;
  generated_at: string;
  total_schedules: number;
  total_enabled: number;
  total_disabled: number;
  /** Per-cadence rows. Every declared cadence emitted in
   *  VALID_CADENCES canonical order, even when zero schedules use it. */
  cadences: CadenceStatRow[];
  /** Cadence with the most schedules (total_count). Ties broken by
   *  VALID_CADENCES declared order. null when total_schedules=0. */
  most_common_cadence: ScheduleCadence | null;
  /** Cadences with zero schedules in this tenant. Sorted by
   *  VALID_CADENCES declared order. */
  unused_cadences: ScheduleCadence[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

const HOURS_24 = 24 * 60 * 60 * 1000;
const HOURS_7D = 7 * 24 * 60 * 60 * 1000;
const DRAIN_PAGE_SIZE = 200;
const DRAIN_PAGE_CAP = 200;

function drainAllSchedules(
  store: ReportScheduleStore,
  tenant_id: string,
): ReportScheduleEntry[] {
  const out: ReportScheduleEntry[] = [];
  for (let page = 1; page <= DRAIN_PAGE_CAP; page++) {
    const result = store.list(tenant_id, page, DRAIN_PAGE_SIZE);
    out.push(...result.items);
    if (result.items.length < DRAIN_PAGE_SIZE) break;
    if (out.length >= result.total) break;
  }
  return out;
}

function emptyRow(cadence: ScheduleCadence): CadenceStatRow {
  return {
    cadence,
    total_count: 0,
    enabled_count: 0,
    disabled_count: 0,
    next_run_within_24h_count: 0,
    next_run_within_7d_count: 0,
    earliest_next_run_at: null,
  };
}

export function buildScheduleCadenceStats(
  store: ReportScheduleStore,
  tenant_id: string,
  now: Date,
): ScheduleCadenceStats {
  const schedules = drainAllSchedules(store, tenant_id);
  const byCadence = new Map<ScheduleCadence, CadenceStatRow>();
  for (const c of VALID_CADENCES) byCadence.set(c, emptyRow(c));

  const nowMs = now.getTime();
  const within24 = nowMs + HOURS_24;
  const within7d = nowMs + HOURS_7D;

  let total_enabled = 0;
  let total_disabled = 0;

  for (const s of schedules) {
    const row = byCadence.get(s.cadence);
    if (!row) continue; // unknown cadence — shouldn't happen
    row.total_count++;
    if (s.enabled) {
      row.enabled_count++;
      total_enabled++;
      const t = Date.parse(s.next_run_at);
      if (Number.isFinite(t)) {
        if (t <= within24) row.next_run_within_24h_count++;
        if (t <= within7d) row.next_run_within_7d_count++;
        if (!row.earliest_next_run_at || s.next_run_at < row.earliest_next_run_at) {
          row.earliest_next_run_at = s.next_run_at;
        }
      }
    } else {
      row.disabled_count++;
      total_disabled++;
    }
  }

  // Cadences in declared (canonical) order; SPA renders in this sequence.
  const cadences: CadenceStatRow[] = [];
  for (const c of VALID_CADENCES) cadences.push(byCadence.get(c)!);

  // most_common_cadence: highest total_count; tie-break by VALID_CADENCES
  // order (iteration via for-of preserves that natural tie-break since
  // we only flip on strict >).
  let most_common_cadence: ScheduleCadence | null = null;
  let mostCount = -1;
  for (const c of VALID_CADENCES) {
    const row = byCadence.get(c)!;
    if (row.total_count > mostCount) {
      mostCount = row.total_count;
      most_common_cadence = c;
    }
  }
  if (mostCount === 0) most_common_cadence = null;

  const unused_cadences: ScheduleCadence[] = [];
  for (const c of VALID_CADENCES) {
    if (byCadence.get(c)!.total_count === 0) unused_cadences.push(c);
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_schedules: schedules.length,
    total_enabled,
    total_disabled,
    cadences,
    most_common_cadence,
    unused_cadences,
  };
}
