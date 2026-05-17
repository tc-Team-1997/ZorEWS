// services/bff/src/ai_model_framework_type_matrix.ts
//
// T6 M7.14 — AI model framework × type cross-tab matrix.
//
// M7.12 ships per-type coverage (1D pivot by ModelType). M7.13 ships
// per-framework distribution (1D pivot by ModelFramework). M7.14
// lands the 2D cross-tab combining both axes: rows = 5 ModelFramework
// × cols = 6 ModelType = 30 cells.
//
// Mirror of M5.17 / M13.15 / M14.28 / M3.11 / M9.13 matrix pattern
// for the AI model registry.
//
// Pure resolver — operates over the registry's listAll snapshot.
// Drives the BIL AI governance dashboard "do we have torch models
// for every type?" + "where are the framework × type gaps?".

import {
  type AiModelRegistry,
  type ModelType,
  type ModelFramework,
} from './ai_model_registry';
import { ALL_MODEL_TYPES as ALL_TYPES_RAW } from './ai_model_type_coverage';
import { ALL_MODEL_FRAMEWORKS as ALL_FRAMEWORKS_RAW } from './ai_model_framework_distribution';

// Re-narrow the imported readonly tuples to typed arrays so TS infers
// the iteration variable as ModelType / ModelFramework (not `any`).
const ALL_MODEL_TYPES: readonly ModelType[] = ALL_TYPES_RAW;
const ALL_MODEL_FRAMEWORKS: readonly ModelFramework[] = ALL_FRAMEWORKS_RAW;

// ─── Public types ─────────────────────────────────────────────────────

export interface ModelMatrixCell {
  framework: ModelFramework;
  type: ModelType;
  count: number;
  /** Model_ids in this cell, sorted asc. */
  model_ids: string[];
}

export interface ModelFrameworkRow {
  framework: ModelFramework;
  total: number;
  by_type: Record<ModelType, number>;
  /** Types this framework does NOT cover. Sorted in canonical
   *  ALL_MODEL_TYPES order. */
  types_without: ModelType[];
}

export interface ModelTypeColumn {
  type: ModelType;
  total: number;
  by_framework: Record<ModelFramework, number>;
  /** Frameworks that have NO model for this type. Sorted in canonical
   *  ALL_MODEL_FRAMEWORKS order. */
  frameworks_without: ModelFramework[];
}

export interface AiModelFrameworkTypeMatrix {
  generated_at: string;
  total_models: number;
  total_frameworks: number;
  total_types: number;
  rows: ModelFrameworkRow[];
  columns: ModelTypeColumn[];
  /** Highest-count cell. Canonical iteration tie-break (frameworks in
   *  ALL_MODEL_FRAMEWORKS order × types in ALL_MODEL_TYPES order).
   *  Null on empty. */
  peak_cell: ModelMatrixCell | null;
  /** Zero-count (framework, type) pairs in canonical row-major order
   *  (framework × type). Comprehensive gap list. */
  empty_cells: Array<{ framework: ModelFramework; type: ModelType }>;
  /** Framework with the most distinct non-zero types. Canonical
   *  framework-order tie-break. Null on empty. */
  most_versatile_framework: { framework: ModelFramework; types_covered: number } | null;
  /** Type with the most distinct non-zero frameworks. Canonical
   *  type-order tie-break. Null on empty. */
  best_supported_type: { type: ModelType; frameworks_supporting: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByType(): Record<ModelType, number> {
  const out: Partial<Record<ModelType, number>> = {};
  for (const t of ALL_MODEL_TYPES) out[t] = 0;
  return out as Record<ModelType, number>;
}

function emptyByFramework(): Record<ModelFramework, number> {
  const out: Partial<Record<ModelFramework, number>> = {};
  for (const f of ALL_MODEL_FRAMEWORKS) out[f] = 0;
  return out as Record<ModelFramework, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildAiModelFrameworkTypeMatrix(
  registry: AiModelRegistry,
  now: Date,
): AiModelFrameworkTypeMatrix {
  // (framework, type) → string[] of model_ids
  const cellIds = new Map<ModelFramework, Map<ModelType, string[]>>();
  for (const f of ALL_MODEL_FRAMEWORKS) cellIds.set(f, new Map());

  const models = registry.list();
  let total_models = 0;
  for (const m of models) {
    if (!ALL_MODEL_FRAMEWORKS.includes(m.framework)) continue;
    if (!ALL_MODEL_TYPES.includes(m.type)) continue;
    total_models++;
    const inner = cellIds.get(m.framework)!;
    const arr = inner.get(m.type) ?? [];
    arr.push(m.model_id);
    inner.set(m.type, arr);
  }

  // Rows (frameworks × all types).
  const rows: ModelFrameworkRow[] = ALL_MODEL_FRAMEWORKS.map((framework) => {
    const inner = cellIds.get(framework)!;
    const by_type = emptyByType();
    let total = 0;
    for (const t of ALL_MODEL_TYPES) {
      const ids = inner.get(t) ?? [];
      by_type[t] = ids.length;
      total += ids.length;
    }
    const types_without = ALL_MODEL_TYPES.filter((t) => by_type[t] === 0);
    return { framework, total, by_type, types_without };
  });

  // Columns (types × all frameworks).
  const columns: ModelTypeColumn[] = ALL_MODEL_TYPES.map((type) => {
    const by_framework = emptyByFramework();
    let total = 0;
    for (const f of ALL_MODEL_FRAMEWORKS) {
      const ids = cellIds.get(f)!.get(type) ?? [];
      by_framework[f] = ids.length;
      total += ids.length;
    }
    const frameworks_without = ALL_MODEL_FRAMEWORKS.filter((f) => by_framework[f] === 0);
    return { type, total, by_framework, frameworks_without };
  });

  // peak_cell — canonical iteration tie-break.
  let peak: ModelMatrixCell | null = null;
  for (const f of ALL_MODEL_FRAMEWORKS) {
    for (const t of ALL_MODEL_TYPES) {
      const ids = cellIds.get(f)!.get(t) ?? [];
      const count = ids.length;
      if (count > 0 && (!peak || count > peak.count)) {
        peak = {
          framework: f,
          type: t,
          count,
          model_ids: [...ids].sort((a, z) => a.localeCompare(z)),
        };
      }
    }
  }

  // empty_cells in canonical row-major (framework × type).
  const empty_cells: Array<{ framework: ModelFramework; type: ModelType }> = [];
  for (const f of ALL_MODEL_FRAMEWORKS) {
    for (const t of ALL_MODEL_TYPES) {
      const ids = cellIds.get(f)!.get(t) ?? [];
      if (ids.length === 0) empty_cells.push({ framework: f, type: t });
    }
  }

  // most_versatile_framework — highest distinct non-zero by_type count.
  let bestFwSpan = 0;
  let mostVersatileFw: ModelFrameworkRow | null = null;
  for (const row of rows) {
    const span = ALL_MODEL_TYPES.filter((t) => row.by_type[t] > 0).length;
    if (span > bestFwSpan) {
      bestFwSpan = span;
      mostVersatileFw = row;
    }
  }
  const most_versatile_framework = mostVersatileFw
    ? { framework: mostVersatileFw.framework, types_covered: bestFwSpan }
    : null;

  // best_supported_type — highest distinct non-zero by_framework count.
  let bestTypeSpan = 0;
  let bestSupportedTy: ModelTypeColumn | null = null;
  for (const col of columns) {
    const span = ALL_MODEL_FRAMEWORKS.filter((f) => col.by_framework[f] > 0).length;
    if (span > bestTypeSpan) {
      bestTypeSpan = span;
      bestSupportedTy = col;
    }
  }
  const best_supported_type = bestSupportedTy
    ? { type: bestSupportedTy.type, frameworks_supporting: bestTypeSpan }
    : null;

  return {
    generated_at: now.toISOString(),
    total_models,
    total_frameworks: ALL_MODEL_FRAMEWORKS.length,
    total_types: ALL_MODEL_TYPES.length,
    rows,
    columns,
    peak_cell: peak,
    empty_cells,
    most_versatile_framework,
    best_supported_type,
  };
}
