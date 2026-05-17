// services/bff/src/admin_config_type_matrix.ts
//
// T6 M13.15 — Admin config category × type cross-tab matrix.
//
// M13.1 ships the platform config schema. M13.10 ships the per-category
// catalog introspection. M13.12 ships the per-tenant override-rate
// snapshot. M13.13 ships the Markdown schema export. M13.14 ships
// cross-tenant feature flag adoption. M13.15 lands the 2D cross-tab
// over the static schema: rows = category, cols = type.
//
// Mirror of M3.11 (connector schema type-matrix) + M14.28 (adapter
// operation method × adapter matrix) + M9.13 (investigation age ×
// status matrix) pattern.
//
// Pure resolver — operates entirely over the static DEFAULTS schema.
// Platform-static — same response across tenants.
//
// Drives the SPA admin config "schema audit" panel: "which categories
// are dominated by boolean toggles vs numbers?" + "are there gaps
// (e.g. no JSON-type keys in reporting?)".

import {
  DEFAULTS,
  listCategories,
  type ConfigCategory,
  type ConfigType,
} from './admin_config';

// ─── Public types ─────────────────────────────────────────────────────

export const ALL_CONFIG_TYPES: readonly ConfigType[] = [
  'number',
  'string',
  'boolean',
  'json',
] as const;

export interface ConfigTypeCell {
  category: ConfigCategory;
  type: ConfigType;
  count: number;
}

export interface ConfigCategoryRow {
  category: ConfigCategory;
  total: number;
  /** Per-type counts; every ConfigType key present at 0 when absent. */
  by_type: Record<ConfigType, number>;
  /** Types this category does NOT have. Sorted in canonical
   *  ALL_CONFIG_TYPES order. */
  types_without: ConfigType[];
}

export interface ConfigTypeColumn {
  type: ConfigType;
  total: number;
  /** Per-category counts; every ConfigCategory key present at 0
   *  when absent. */
  by_category: Record<ConfigCategory, number>;
  /** Categories that have NO key of this type. Sorted in canonical
   *  listCategories() order. */
  categories_without: ConfigCategory[];
}

export interface AdminConfigTypeMatrix {
  generated_at: string;
  total_keys: number;
  total_categories: number;
  total_types: number;
  rows: ConfigCategoryRow[];
  columns: ConfigTypeColumn[];
  /** Peak cell — highest count (category, type). Canonical iteration
   *  tie-break (categories in listCategories order × types in
   *  ALL_CONFIG_TYPES order). null when total_keys=0. */
  peak_cell: ConfigTypeCell | null;
  /** Cells with count=0 — coverage gaps. Sorted canonical category
   *  order × ALL_CONFIG_TYPES order. */
  empty_cells: ConfigTypeCell[];
  /** Category with the most distinct types covered. Canonical
   *  listCategories order tie-break. null when total_keys=0. */
  most_diverse_category: { category: ConfigCategory; types_covered: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByType(): Record<ConfigType, number> {
  const out: Partial<Record<ConfigType, number>> = {};
  for (const t of ALL_CONFIG_TYPES) out[t] = 0;
  return out as Record<ConfigType, number>;
}

function emptyByCategory(categories: readonly ConfigCategory[]): Record<ConfigCategory, number> {
  const out: Partial<Record<ConfigCategory, number>> = {};
  for (const c of categories) out[c] = 0;
  return out as Record<ConfigCategory, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildAdminConfigTypeMatrix(now: Date): AdminConfigTypeMatrix {
  const categories = listCategories();

  // (category, type) → count
  const cell = new Map<ConfigCategory, Map<ConfigType, number>>();
  for (const cat of categories) cell.set(cat, new Map());

  for (const def of DEFAULTS) {
    const inner = cell.get(def.category)!;
    inner.set(def.type, (inner.get(def.type) ?? 0) + 1);
  }

  // Rows (categories × all types).
  const rows: ConfigCategoryRow[] = categories.map((category) => {
    const inner = cell.get(category)!;
    const by_type = emptyByType();
    let total = 0;
    for (const t of ALL_CONFIG_TYPES) {
      const c = inner.get(t) ?? 0;
      by_type[t] = c;
      total += c;
    }
    const types_without = ALL_CONFIG_TYPES.filter((t) => by_type[t] === 0);
    return { category, total, by_type, types_without };
  });

  // Columns (types × all categories).
  const columns: ConfigTypeColumn[] = ALL_CONFIG_TYPES.map((type) => {
    const by_category = emptyByCategory(categories);
    let total = 0;
    for (const cat of categories) {
      const c = cell.get(cat)!.get(type) ?? 0;
      by_category[cat] = c;
      total += c;
    }
    const categories_without = categories.filter((c) => by_category[c] === 0);
    return { type, total, by_category, categories_without };
  });

  // peak_cell — canonical iteration tie-break (cats × types order).
  let peak: ConfigTypeCell | null = null;
  for (const cat of categories) {
    for (const t of ALL_CONFIG_TYPES) {
      const count = cell.get(cat)!.get(t) ?? 0;
      if (count > 0 && (!peak || count > peak.count)) {
        peak = { category: cat, type: t, count };
      }
    }
  }

  // empty_cells in canonical category × type order.
  const empty_cells: ConfigTypeCell[] = [];
  for (const cat of categories) {
    for (const t of ALL_CONFIG_TYPES) {
      const count = cell.get(cat)!.get(t) ?? 0;
      if (count === 0) empty_cells.push({ category: cat, type: t, count: 0 });
    }
  }

  // most_diverse_category — highest distinct non-zero by_type count.
  let bestSpan = 0;
  let mostDiverse: ConfigCategoryRow | null = null;
  for (const row of rows) {
    const span = ALL_CONFIG_TYPES.filter((t) => row.by_type[t] > 0).length;
    if (span > bestSpan) {
      bestSpan = span;
      mostDiverse = row;
    }
  }
  const most_diverse_category = mostDiverse
    ? { category: mostDiverse.category, types_covered: bestSpan }
    : null;

  return {
    generated_at: now.toISOString(),
    total_keys: DEFAULTS.length,
    total_categories: categories.length,
    total_types: ALL_CONFIG_TYPES.length,
    rows,
    columns,
    peak_cell: peak,
    empty_cells,
    most_diverse_category,
  };
}
