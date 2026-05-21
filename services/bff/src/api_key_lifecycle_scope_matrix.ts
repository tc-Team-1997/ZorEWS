// services/bff/src/api_key_lifecycle_scope_matrix.ts
//
// T6 M1.16 — API key lifecycle stage × scope cross-tab matrix.
//
// Combines M1.10 lifecycle stages (closed-axis 7 ApiKeyLifecycleStage
// values in priority order: revoked > expired > expiring_soon >
// idle_never_used > dormant > fresh > mature_active) × M1.5 scopes
// (closed-axis VALID_SCOPES.length ApiKeyScope values in canonical
// order: alerts:read → cases:read → audit:read → ... →
// recovery:archive_internal). 7 × VALID_SCOPES.length cells.
//
// Cells count KEY-SCOPE PAIRS not unique keys: a key in stage
// 'expiring_soon' with scopes [alerts:read, audit:read] contributes
// 1 to (expiring_soon, alerts:read) AND 1 to (expiring_soon,
// audit:read). Defensive intra-key scope dedup via Set + closed-enum
// filter via VALID_SCOPES so bogus scopes don't pollute the matrix.
//
// Drives BIL ops "are dormant keys concentrated in specific scopes?
// which scopes have keys nearing expiry?" governance views in one
// round-trip. Distinct from:
//  - M1.5 (scope 1D distribution): pivot only by scope, no lifecycle
//  - M1.8 (scope × status matrix): collapses lifecycle to 2-state
//    (active/revoked); M1.16 elevates to full 7-stage view
//  - M1.10 (lifecycle 1D distribution): pivot only by stage
//  - M1.11 (creator × lifecycle): different axis combination
//    (open-creator × closed-lifecycle)
//
// Mirror of M1.8 / M1.11 / M1.12 / M1.14 cross-tab matrix pattern
// combining two CLOSED axes (lifecycle × scope, both enumerated).

import {
  type ApiKeyEntry,
  type ApiKeyScope,
  VALID_SCOPES,
  isApiKeyScope,
} from './api_keys';
import {
  ALL_API_KEY_LIFECYCLE_STAGES,
  classifyApiKeyLifecycle,
  type ApiKeyLifecycleStage,
} from './api_key_lifecycle_distribution';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface LifecycleScopeMatrixRow {
  stage: ApiKeyLifecycleStage;
  total: number;
  /** Every ApiKeyScope key present at 0 when absent (stable SPA grid). */
  by_scope: Record<ApiKeyScope, number>;
  /** Scopes with zero bindings in this stage, canonical order. */
  scopes_without: ApiKeyScope[];
  /** Distinct count of scopes with > 0 bindings in this stage. */
  distinct_scopes: number;
}

export interface LifecycleScopeMatrixColumn {
  scope: ApiKeyScope;
  total: number;
  /** Every ApiKeyLifecycleStage key present at 0 when absent. */
  by_stage: Record<ApiKeyLifecycleStage, number>;
  /** Stages with zero bindings for this scope, canonical order. */
  stages_without: ApiKeyLifecycleStage[];
  /** Distinct count of stages with > 0 bindings for this scope. */
  distinct_stages: number;
}

export interface LifecycleScopeMatrixCell {
  stage: ApiKeyLifecycleStage;
  scope: ApiKeyScope;
  count: number;
  /** Sample key_ids in this cell, cap 5, sorted asc. */
  sample_key_ids: string[];
}

export interface ApiKeyLifecycleScopeMatrix {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  total_bindings: number;
  total_stages: number;
  total_scopes: number;
  rows: LifecycleScopeMatrixRow[];
  columns: LifecycleScopeMatrixColumn[];
  /**
   * Highest-count cell. Canonical iteration tie-break: stages in
   * ALL_API_KEY_LIFECYCLE_STAGES order × scopes in VALID_SCOPES
   * order. null when total_bindings=0.
   */
  peak_cell: LifecycleScopeMatrixCell | null;
  /**
   * Empty (zero-count) cells in canonical row-major order (stage
   * major, scope minor). Comprehensive gap list — useful for SPA
   * "which lifecycle×scope combinations have zero keys?" view.
   */
  empty_cells: Array<{ stage: ApiKeyLifecycleStage; scope: ApiKeyScope }>;
  /**
   * Stage with most distinct non-zero by_scope entries (i.e. the
   * stage where keys span the most varied scopes). Canonical
   * ALL_API_KEY_LIFECYCLE_STAGES tie-break — revoked wins over
   * expired at tied span. null when total_bindings=0.
   */
  most_diverse_stage: ApiKeyLifecycleStage | null;
  /**
   * Scope with most distinct non-zero by_stage entries (i.e. the
   * scope whose keys span the most lifecycle stages — likely a
   * widely-granted scope across many key generations). Canonical
   * VALID_SCOPES tie-break. null when total_bindings=0.
   */
  most_universal_scope: ApiKeyScope | null;
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

function zeroByScope(): Record<ApiKeyScope, number> {
  const out = {} as Record<ApiKeyScope, number>;
  for (const s of VALID_SCOPES) out[s] = 0;
  return out;
}

function zeroByStage(): Record<ApiKeyLifecycleStage, number> {
  const out = {} as Record<ApiKeyLifecycleStage, number>;
  for (const s of ALL_API_KEY_LIFECYCLE_STAGES) out[s] = 0;
  return out;
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export function buildApiKeyLifecycleScopeMatrix(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyLifecycleScopeMatrix {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('buildApiKeyLifecycleScopeMatrix: tenant_id required');
  }

  // 2D map { stage: { scope: { count, sample_key_ids } } } — built
  // up incrementally then projected into rows/columns/cells.
  type CellState = { count: number; sample_key_ids: string[] };
  const cellMap: Record<ApiKeyLifecycleStage, Record<ApiKeyScope, CellState>> =
    {} as never;
  for (const stage of ALL_API_KEY_LIFECYCLE_STAGES) {
    cellMap[stage] = {} as Record<ApiKeyScope, CellState>;
    for (const scope of VALID_SCOPES) {
      cellMap[stage][scope] = { count: 0, sample_key_ids: [] };
    }
  }

  let total_keys = 0;
  let total_bindings = 0;

  for (const entry of entries) {
    total_keys += 1;
    const stage = classifyApiKeyLifecycle(entry, now);
    // Defensive intra-key scope dedup + closed-enum filter via Set.
    const scopeSet = new Set<ApiKeyScope>();
    for (const s of entry.scopes ?? []) {
      if (isApiKeyScope(s)) scopeSet.add(s);
    }
    for (const scope of scopeSet) {
      const cell = cellMap[stage][scope];
      cell.count += 1;
      cell.sample_key_ids.push(entry.key_id);
      total_bindings += 1;
    }
  }

  // Project per-row metadata + per-col metadata + per-cell records
  const rows: LifecycleScopeMatrixRow[] = ALL_API_KEY_LIFECYCLE_STAGES.map(
    (stage) => {
      const by_scope = zeroByScope();
      const scopes_without: ApiKeyScope[] = [];
      let row_total = 0;
      let row_distinct = 0;
      for (const scope of VALID_SCOPES) {
        const cnt = cellMap[stage][scope].count;
        by_scope[scope] = cnt;
        row_total += cnt;
        if (cnt > 0) row_distinct += 1;
        else scopes_without.push(scope);
      }
      return {
        stage,
        total: row_total,
        by_scope,
        scopes_without,
        distinct_scopes: row_distinct,
      };
    },
  );

  const columns: LifecycleScopeMatrixColumn[] = VALID_SCOPES.map((scope) => {
    const by_stage = zeroByStage();
    const stages_without: ApiKeyLifecycleStage[] = [];
    let col_total = 0;
    let col_distinct = 0;
    for (const stage of ALL_API_KEY_LIFECYCLE_STAGES) {
      const cnt = cellMap[stage][scope].count;
      by_stage[stage] = cnt;
      col_total += cnt;
      if (cnt > 0) col_distinct += 1;
      else stages_without.push(stage);
    }
    return {
      scope,
      total: col_total,
      by_stage,
      stages_without,
      distinct_stages: col_distinct,
    };
  });

  // Build peak_cell + empty_cells via canonical row-major iteration
  let peak_cell: LifecycleScopeMatrixCell | null = null;
  const empty_cells: Array<{
    stage: ApiKeyLifecycleStage;
    scope: ApiKeyScope;
  }> = [];
  for (const stage of ALL_API_KEY_LIFECYCLE_STAGES) {
    for (const scope of VALID_SCOPES) {
      const cell = cellMap[stage][scope];
      if (cell.count === 0) {
        empty_cells.push({ stage, scope });
      } else if (!peak_cell || cell.count > peak_cell.count) {
        peak_cell = {
          stage,
          scope,
          count: cell.count,
          sample_key_ids: [...cell.sample_key_ids]
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 5),
        };
      }
    }
  }

  // most_diverse_stage: row with most distinct non-zero by_scope
  let most_diverse_stage: ApiKeyLifecycleStage | null = null;
  if (total_bindings > 0) {
    let max_span = 0;
    for (const row of rows) {
      if (row.distinct_scopes > max_span) {
        max_span = row.distinct_scopes;
        most_diverse_stage = row.stage;
      }
    }
  }

  // most_universal_scope: column with most distinct non-zero by_stage
  let most_universal_scope: ApiKeyScope | null = null;
  if (total_bindings > 0) {
    let max_span = 0;
    for (const col of columns) {
      if (col.distinct_stages > max_span) {
        max_span = col.distinct_stages;
        most_universal_scope = col.scope;
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys,
    total_bindings,
    total_stages: ALL_API_KEY_LIFECYCLE_STAGES.length,
    total_scopes: VALID_SCOPES.length,
    rows,
    columns,
    peak_cell,
    empty_cells,
    most_diverse_stage,
    most_universal_scope,
  };
}
