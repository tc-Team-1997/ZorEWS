// services/bff/src/report_schedule_cadence_format_matrix.ts
//
// T6 M12.17 — Report schedule cadence × format cross-tab matrix.
//
// M12.2 ships the recurring schedule store. M12.9 ships 1D cadence
// distribution. M12.11 ships 1D format distribution (over jobs).
// M12.14 ships format × status matrix (over jobs). M12.16 ships
// per-recipient distribution.
//
// M12.17 elevates the per-tenant SCHEDULE list (not jobs) into a 2D
// cadence × format cross-tab. Schedule axis is CLOSED on both sides
// — 5 ScheduleCadence × 4 ReportFormat = 20 cells. Each schedule
// lives in exactly one (cadence, format) cell.
//
// Per-row {cadence, total, by_format (every format at 0 — stable
// 4-key grid), formats_without[] canonical, schedule_ids[] sorted asc,
// enabled_count, disabled_count}. Per-col {format, total, by_cadence
// (every cadence at 0 — stable 5-key grid), cadences_without[]
// canonical, enabled_count, disabled_count, schedule_ids[] sorted asc}.
//
// Envelope: peak_cell (canonical iteration tie-break: cadences in
// VALID_CADENCES order × formats in ALL_REPORT_FORMATS order; null
// on empty), most_versatile_cadence (most distinct formats used;
// canonical tie-break; null on empty), most_universal_format (most
// distinct cadences using it; canonical tie-break; null on empty),
// empty_cells[] in canonical cadence × format row-major order.
//
// Mirror of M12.14 / M3.14 / M5.17 / M13.15 / M15.14 / M14.28 matrix
// pattern for the recurring-schedule surface. Drives BIL ops "do we
// have any daily PDF schedules? are quarterly schedules always
// xlsx?" coverage view.

import {
  VALID_CADENCES,
  type ReportScheduleEntry,
  type ReportScheduleStore,
  type ScheduleCadence,
} from './report_schedules';
import { ALL_REPORT_FORMATS } from './report_format_distribution';
import type { ReportFormat } from './reports_catalog';

// ─── Public types ──────────────────────────────────────────────────────

export interface CadenceRow {
  cadence: ScheduleCadence;
  total: number;
  by_format: Record<ReportFormat, number>;
  formats_without: ReportFormat[];
  schedule_ids: string[];
  enabled_count: number;
  disabled_count: number;
}

export interface FormatColumn {
  format: ReportFormat;
  total: number;
  by_cadence: Record<ScheduleCadence, number>;
  cadences_without: ScheduleCadence[];
  schedule_ids: string[];
  enabled_count: number;
  disabled_count: number;
}

export interface ReportScheduleCadenceFormatMatrix {
  tenant_id: string;
  generated_at: string;
  total_schedules: number;
  total_enabled: number;
  total_disabled: number;
  total_cadences: number; // = 5
  total_formats: number; // = 4
  rows: CadenceRow[];
  columns: FormatColumn[];
  peak_cell: {
    cadence: ScheduleCadence;
    format: ReportFormat;
    count: number;
  } | null;
  /** Cadence with most distinct non-zero by_format entries; canonical
   *  VALID_CADENCES tie-break; null on empty. */
  most_versatile_cadence: ScheduleCadence | null;
  /** Format with most distinct non-zero by_cadence entries; canonical
   *  ALL_REPORT_FORMATS tie-break; null on empty. */
  most_universal_format: ReportFormat | null;
  /** (cadence, format) cells with count=0 in canonical cadence × format
   *  row-major order. */
  empty_cells: Array<{ cadence: ScheduleCadence; format: ReportFormat }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByFormat(): Record<ReportFormat, number> {
  const out = {} as Record<ReportFormat, number>;
  for (const f of ALL_REPORT_FORMATS) out[f] = 0;
  return out;
}

function emptyByCadence(): Record<ScheduleCadence, number> {
  const out = {} as Record<ScheduleCadence, number>;
  for (const c of VALID_CADENCES) out[c] = 0;
  return out;
}

const DRAIN_PAGE_SIZE = 500;
const DRAIN_PAGE_CAP = 200;

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildReportScheduleCadenceFormatMatrix(
  tenant_id: string,
  entries: readonly ReportScheduleEntry[],
  now: Date,
): ReportScheduleCadenceFormatMatrix {
  // cellCounts[cadence][format] = { count, schedule_ids: Set, enabled, disabled }
  type Cell = {
    count: number;
    schedule_ids: string[];
    enabled_count: number;
    disabled_count: number;
  };
  const cellCounts: Record<ScheduleCadence, Record<ReportFormat, Cell>> = {} as never;
  for (const c of VALID_CADENCES) {
    cellCounts[c] = {} as Record<ReportFormat, Cell>;
    for (const f of ALL_REPORT_FORMATS) {
      cellCounts[c][f] = {
        count: 0,
        schedule_ids: [],
        enabled_count: 0,
        disabled_count: 0,
      };
    }
  }

  let total_schedules = 0;
  let total_enabled = 0;
  let total_disabled = 0;

  for (const entry of entries) {
    if (!VALID_CADENCES.includes(entry.cadence)) continue;
    if (!ALL_REPORT_FORMATS.includes(entry.format)) continue;
    total_schedules++;
    if (entry.enabled) total_enabled++;
    else total_disabled++;

    const cell = cellCounts[entry.cadence][entry.format];
    cell.count++;
    cell.schedule_ids.push(entry.schedule_id);
    if (entry.enabled) cell.enabled_count++;
    else cell.disabled_count++;
  }

  // Build rows in canonical cadence order.
  const rows: CadenceRow[] = VALID_CADENCES.map((cadence) => {
    const by_format = emptyByFormat();
    let total = 0;
    let enabled_count = 0;
    let disabled_count = 0;
    const schedule_ids: string[] = [];
    for (const format of ALL_REPORT_FORMATS) {
      const cell = cellCounts[cadence][format];
      by_format[format] = cell.count;
      total += cell.count;
      enabled_count += cell.enabled_count;
      disabled_count += cell.disabled_count;
      schedule_ids.push(...cell.schedule_ids);
    }
    schedule_ids.sort((a, b) => a.localeCompare(b));
    const formats_without = ALL_REPORT_FORMATS.filter(
      (f) => by_format[f] === 0,
    );
    return {
      cadence,
      total,
      by_format,
      formats_without,
      schedule_ids,
      enabled_count,
      disabled_count,
    };
  });

  // Build columns in canonical format order.
  const columns: FormatColumn[] = ALL_REPORT_FORMATS.map((format) => {
    const by_cadence = emptyByCadence();
    let total = 0;
    let enabled_count = 0;
    let disabled_count = 0;
    const schedule_ids: string[] = [];
    for (const cadence of VALID_CADENCES) {
      const cell = cellCounts[cadence][format];
      by_cadence[cadence] = cell.count;
      total += cell.count;
      enabled_count += cell.enabled_count;
      disabled_count += cell.disabled_count;
      schedule_ids.push(...cell.schedule_ids);
    }
    schedule_ids.sort((a, b) => a.localeCompare(b));
    const cadences_without = VALID_CADENCES.filter(
      (c) => by_cadence[c] === 0,
    );
    return {
      format,
      total,
      by_cadence,
      cadences_without,
      schedule_ids,
      enabled_count,
      disabled_count,
    };
  });

  // peak_cell — canonical iteration tie-break.
  let peak_cell: ReportScheduleCadenceFormatMatrix['peak_cell'] = null;
  let peakCount = 0;
  for (const cadence of VALID_CADENCES) {
    for (const format of ALL_REPORT_FORMATS) {
      const c = cellCounts[cadence][format].count;
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { cadence, format, count: c };
      }
    }
  }

  // most_versatile_cadence — highest distinct non-zero by_format; canonical tie-break.
  let most_versatile_cadence: ScheduleCadence | null = null;
  let bestVersatile = 0;
  for (const row of rows) {
    const distinct = ALL_REPORT_FORMATS.filter((f) => row.by_format[f] > 0).length;
    if (distinct > bestVersatile) {
      bestVersatile = distinct;
      most_versatile_cadence = row.cadence;
    }
  }

  // most_universal_format — highest distinct non-zero by_cadence; canonical tie-break.
  let most_universal_format: ReportFormat | null = null;
  let bestUniversal = 0;
  for (const col of columns) {
    const distinct = VALID_CADENCES.filter((c) => col.by_cadence[c] > 0).length;
    if (distinct > bestUniversal) {
      bestUniversal = distinct;
      most_universal_format = col.format;
    }
  }

  // empty_cells — canonical cadence × format row-major order.
  const empty_cells: Array<{
    cadence: ScheduleCadence;
    format: ReportFormat;
  }> = [];
  for (const cadence of VALID_CADENCES) {
    for (const format of ALL_REPORT_FORMATS) {
      if (cellCounts[cadence][format].count === 0) {
        empty_cells.push({ cadence, format });
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_schedules,
    total_enabled,
    total_disabled,
    total_cadences: VALID_CADENCES.length,
    total_formats: ALL_REPORT_FORMATS.length,
    rows,
    columns,
    peak_cell,
    most_versatile_cadence,
    most_universal_format,
    empty_cells,
  };
}

/** Convenience: drain the M12.2 schedule store then summarize. */
export function buildReportScheduleCadenceFormatMatrixFromStore(
  store: ReportScheduleStore,
  tenant_id: string,
  now: Date,
): ReportScheduleCadenceFormatMatrix {
  const allEntries: ReportScheduleEntry[] = [];
  for (let page = 1; page <= DRAIN_PAGE_CAP; page++) {
    const result = store.list(tenant_id, page, DRAIN_PAGE_SIZE);
    allEntries.push(...result.items);
    if (result.items.length < DRAIN_PAGE_SIZE) break;
  }
  return buildReportScheduleCadenceFormatMatrix(tenant_id, allEntries, now);
}
