// services/bff/src/ai_model_framework_status_matrix.ts
//
// T6 M7.19 — AI model framework × status cross-tab matrix.
//
// M7.12 ships the type-coverage 1D pivot (by_status + by_framework
// nested per type). M7.13 ships the framework 1D pivot (by_status +
// by_type nested per framework). M7.14 ships framework × TYPE. None is
// a proper framework × STATUS 2D cross-tab with per-status column
// rollups + lifecycle leaderboards.
//
// M7.19 ships it. Rows = 5 ModelFramework (canonical xgboost → sklearn
// → torch → lightgbm → isolation_forest), cols = 5 ModelStatus
// (canonical experimental → staging → production → shadow → retired) =
// 25 cells. Each model lives in exactly one (framework, status) cell.
//
// Per-row {framework, total, by_status (every status at 0 when absent —
// stable grid), statuses_without[] canonical, distinct_statuses (0..5)}.
// Per-col {status, total, by_framework (5 keys), frameworks_without[]
// canonical, distinct_frameworks (0..5)}. Envelope: peak_cell (with
// model_ids[]) + empty_cells + the status-lens leaderboards that make
// this worth shipping: most_deployed_framework (highest PRODUCTION
// count), frameworks_in_production[] (≥ 1 production model — the "what's
// live?" list), most_common_status (highest column total — where the
// fleet sits in its lifecycle), most_versatile_framework (most distinct
// statuses spanned — a mature experimental→production→retired pipeline).
//
// Mirror of M7.14 / M5.17 / M3.14 closed × closed matrix pattern.
//
// Drives BIL ML governance: "which framework dominates production? is
// torch stuck in experimental while xgboost ships? where are the
// framework × lifecycle gaps?".

import type { AiModelRegistry, ModelFramework, ModelStatus } from './ai_model_registry';
import { ALL_MODEL_FRAMEWORKS } from './ai_model_framework_distribution';

// Canonical status order (kept local — mirrors how M7.12 / M7.18 each
// declare their own status-order const rather than exporting a shared one).
export const ALL_MODEL_STATUSES: readonly ModelStatus[] = [
  'experimental',
  'staging',
  'production',
  'shadow',
  'retired',
];

// ─── Public types ──────────────────────────────────────────────────────

export interface ModelFrameworkStatusRow {
  framework: ModelFramework;
  total: number;
  by_status: Record<ModelStatus, number>;
  /** Statuses with by_status=0 (canonical order). */
  statuses_without: ModelStatus[];
  /** Distinct statuses this framework's models occupy (0..5). */
  distinct_statuses: number;
}

export interface ModelStatusColumn {
  status: ModelStatus;
  total: number;
  by_framework: Record<ModelFramework, number>;
  /** Frameworks with by_framework=0 (canonical order). */
  frameworks_without: ModelFramework[];
  /** Distinct frameworks with a model in this status (0..5). */
  distinct_frameworks: number;
}

export interface AiModelFrameworkStatusMatrix {
  generated_at: string;
  total_models: number;
  total_frameworks: number; // = 5
  total_statuses: number; // = 5
  rows: ModelFrameworkStatusRow[];
  columns: ModelStatusColumn[];
  /** Highest-count cell; canonical iteration tie-break — frameworks in
   *  ALL_MODEL_FRAMEWORKS order × statuses in ALL_MODEL_STATUSES order;
   *  null when no models. */
  peak_cell: {
    framework: ModelFramework;
    status: ModelStatus;
    count: number;
    model_ids: string[];
  } | null;
  /** Framework with the highest PRODUCTION count — which ML framework
   *  dominates the live fleet; canonical framework-order tie-break;
   *  null when no production models anywhere. */
  most_deployed_framework: { framework: ModelFramework; production_count: number } | null;
  /** Frameworks with ≥ 1 production model (canonical order) — the
   *  "what's live?" list. */
  frameworks_in_production: ModelFramework[];
  /** Status column with the highest total — where most of the fleet
   *  sits in its lifecycle; canonical status-order tie-break; null on empty. */
  most_common_status: { status: ModelStatus; count: number } | null;
  /** Framework spanning the most distinct statuses — a mature
   *  experimental→production→retired pipeline; canonical framework-order
   *  tie-break; null on empty. */
  most_versatile_framework: { framework: ModelFramework; statuses_covered: number } | null;
  /** (framework, status) cells with count=0 — canonical row-major order
   *  (framework outer × status inner). */
  empty_cells: Array<{ framework: ModelFramework; status: ModelStatus }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByStatus(): Record<ModelStatus, number> {
  const out = {} as Record<ModelStatus, number>;
  for (const s of ALL_MODEL_STATUSES) out[s] = 0;
  return out;
}

function emptyByFramework(): Record<ModelFramework, number> {
  const out = {} as Record<ModelFramework, number>;
  for (const f of ALL_MODEL_FRAMEWORKS) out[f] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildAiModelFrameworkStatusMatrix(
  registry: AiModelRegistry,
  now: Date,
): AiModelFrameworkStatusMatrix {
  // (framework, status) → string[] of model_ids
  const cellIds = new Map<ModelFramework, Map<ModelStatus, string[]>>();
  for (const f of ALL_MODEL_FRAMEWORKS) cellIds.set(f, new Map());

  const models = registry.list();
  let total_models = 0;
  for (const m of models) {
    if (!ALL_MODEL_FRAMEWORKS.includes(m.framework)) continue;
    if (!ALL_MODEL_STATUSES.includes(m.status)) continue;
    total_models++;
    const inner = cellIds.get(m.framework)!;
    const arr = inner.get(m.status) ?? [];
    arr.push(m.model_id);
    inner.set(m.status, arr);
  }

  // Rows (frameworks × all statuses).
  const rows: ModelFrameworkStatusRow[] = ALL_MODEL_FRAMEWORKS.map((framework) => {
    const inner = cellIds.get(framework)!;
    const by_status = emptyByStatus();
    let total = 0;
    for (const s of ALL_MODEL_STATUSES) {
      const ids = inner.get(s) ?? [];
      by_status[s] = ids.length;
      total += ids.length;
    }
    const statuses_without = ALL_MODEL_STATUSES.filter((s) => by_status[s] === 0);
    return {
      framework,
      total,
      by_status,
      statuses_without,
      distinct_statuses: ALL_MODEL_STATUSES.length - statuses_without.length,
    };
  });

  // Columns (statuses × all frameworks).
  const columns: ModelStatusColumn[] = ALL_MODEL_STATUSES.map((status) => {
    const by_framework = emptyByFramework();
    let total = 0;
    for (const f of ALL_MODEL_FRAMEWORKS) {
      const ids = cellIds.get(f)!.get(status) ?? [];
      by_framework[f] = ids.length;
      total += ids.length;
    }
    const frameworks_without = ALL_MODEL_FRAMEWORKS.filter((f) => by_framework[f] === 0);
    return {
      status,
      total,
      by_framework,
      frameworks_without,
      distinct_frameworks: ALL_MODEL_FRAMEWORKS.length - frameworks_without.length,
    };
  });

  // peak_cell — canonical iteration tie-break.
  let peak_cell: AiModelFrameworkStatusMatrix['peak_cell'] = null;
  for (const f of ALL_MODEL_FRAMEWORKS) {
    for (const s of ALL_MODEL_STATUSES) {
      const ids = cellIds.get(f)!.get(s) ?? [];
      const count = ids.length;
      if (count > 0 && (!peak_cell || count > peak_cell.count)) {
        peak_cell = {
          framework: f,
          status: s,
          count,
          model_ids: [...ids].sort((a, z) => a.localeCompare(z)),
        };
      }
    }
  }

  // most_deployed_framework — highest production count; canonical tie-break.
  let most_deployed_framework: AiModelFrameworkStatusMatrix['most_deployed_framework'] = null;
  let bestProd = 0;
  for (const row of rows) {
    if (row.by_status.production > bestProd) {
      bestProd = row.by_status.production;
      most_deployed_framework = {
        framework: row.framework,
        production_count: row.by_status.production,
      };
    }
  }

  // frameworks_in_production — canonical order, ≥ 1 production model.
  const frameworks_in_production = rows
    .filter((r) => r.by_status.production > 0)
    .map((r) => r.framework);

  // most_common_status — highest column total; canonical tie-break.
  let most_common_status: AiModelFrameworkStatusMatrix['most_common_status'] = null;
  let bestColTotal = 0;
  for (const col of columns) {
    if (col.total > bestColTotal) {
      bestColTotal = col.total;
      most_common_status = { status: col.status, count: col.total };
    }
  }

  // most_versatile_framework — most distinct statuses spanned; canonical tie-break.
  let most_versatile_framework: AiModelFrameworkStatusMatrix['most_versatile_framework'] = null;
  let bestSpan = 0;
  for (const row of rows) {
    if (row.distinct_statuses > bestSpan) {
      bestSpan = row.distinct_statuses;
      most_versatile_framework = {
        framework: row.framework,
        statuses_covered: row.distinct_statuses,
      };
    }
  }

  // empty_cells — canonical row-major (framework × status).
  const empty_cells: Array<{ framework: ModelFramework; status: ModelStatus }> = [];
  for (const f of ALL_MODEL_FRAMEWORKS) {
    for (const s of ALL_MODEL_STATUSES) {
      const ids = cellIds.get(f)!.get(s) ?? [];
      if (ids.length === 0) empty_cells.push({ framework: f, status: s });
    }
  }

  return {
    generated_at: now.toISOString(),
    total_models,
    total_frameworks: ALL_MODEL_FRAMEWORKS.length,
    total_statuses: ALL_MODEL_STATUSES.length,
    rows,
    columns,
    peak_cell,
    most_deployed_framework,
    frameworks_in_production,
    most_common_status,
    most_versatile_framework,
    empty_cells,
  };
}
