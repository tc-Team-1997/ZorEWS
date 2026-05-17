// services/bff/src/rule_template_category_vertical_matrix.ts
//
// T6 M5.17 — Rule template category × vertical cross-tab matrix.
//
// M5.14 ships per-template indicator coverage. M5.15 ships
// recommended-action inventory. M5.16 ships severity distribution.
// M5.17 lands the 2D category × vertical cross-tab — rows = 5
// RuleTemplateCategory values × cols = 3 RuleTemplateVertical values
// = 15 cells.
//
// Mirror of M13.15 / M14.28 / M3.11 / M9.13 matrix pattern for the
// rule template library surface. Pure resolver — operates entirely
// over RULE_TEMPLATES. Platform-static — same response across tenants.
//
// Drives the SPA "rule templates inventory" panel: "do we have
// underwriting templates for insurance? are there gaps in compliance
// × banking?".

import {
  RULE_TEMPLATES,
  listCategories,
  type RuleTemplateCategory,
  type RuleTemplateVertical,
} from './rule_templates';

// ─── Public types ─────────────────────────────────────────────────────

export const ALL_RULE_TEMPLATE_VERTICALS: readonly RuleTemplateVertical[] = [
  'banking',
  'insurance',
  'both',
] as const;

export interface RuleTemplateMatrixCell {
  category: RuleTemplateCategory;
  vertical: RuleTemplateVertical;
  count: number;
  /** Template ids in this cell, sorted asc for stable rendering. */
  template_ids: string[];
}

export interface RuleTemplateCategoryRow {
  category: RuleTemplateCategory;
  total: number;
  by_vertical: Record<RuleTemplateVertical, number>;
  verticals_without: RuleTemplateVertical[];
}

export interface RuleTemplateVerticalColumn {
  vertical: RuleTemplateVertical;
  total: number;
  by_category: Record<RuleTemplateCategory, number>;
  categories_without: RuleTemplateCategory[];
}

export interface RuleTemplateCategoryVerticalMatrix {
  generated_at: string;
  total_templates: number;
  total_categories: number;
  total_verticals: number;
  rows: RuleTemplateCategoryRow[];
  columns: RuleTemplateVerticalColumn[];
  /** Highest-count cell. Canonical iteration tie-break (cats in
   *  listCategories order × verticals in ALL_RULE_TEMPLATE_VERTICALS
   *  order). null on empty. */
  peak_cell: RuleTemplateMatrixCell | null;
  /** Zero-count (category, vertical) pairs in canonical row-major
   *  order. */
  empty_cells: Array<{ category: RuleTemplateCategory; vertical: RuleTemplateVertical }>;
  /** Category with the most distinct non-zero verticals. Canonical
   *  category-order tie-break. null on empty. */
  most_covered_category: { category: RuleTemplateCategory; verticals_covered: number } | null;
  /** Vertical with the most distinct non-zero categories. Canonical
   *  vertical-order tie-break. null on empty. */
  most_covered_vertical: { vertical: RuleTemplateVertical; categories_covered: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByVertical(): Record<RuleTemplateVertical, number> {
  return { banking: 0, insurance: 0, both: 0 };
}

function emptyByCategory(categories: readonly RuleTemplateCategory[]): Record<RuleTemplateCategory, number> {
  const out: Partial<Record<RuleTemplateCategory, number>> = {};
  for (const c of categories) out[c] = 0;
  return out as Record<RuleTemplateCategory, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildRuleTemplateCategoryVerticalMatrix(
  now: Date,
): RuleTemplateCategoryVerticalMatrix {
  const categories = listCategories();

  // (category, vertical) → string[] of template_ids
  const cellTemplateIds = new Map<
    RuleTemplateCategory,
    Map<RuleTemplateVertical, string[]>
  >();
  for (const c of categories) cellTemplateIds.set(c, new Map());

  for (const tpl of RULE_TEMPLATES) {
    const inner = cellTemplateIds.get(tpl.category)!;
    const arr = inner.get(tpl.vertical) ?? [];
    arr.push(tpl.id);
    inner.set(tpl.vertical, arr);
  }

  // Rows (categories × all verticals).
  const rows: RuleTemplateCategoryRow[] = categories.map((category) => {
    const inner = cellTemplateIds.get(category)!;
    const by_vertical = emptyByVertical();
    let total = 0;
    for (const v of ALL_RULE_TEMPLATE_VERTICALS) {
      const ids = inner.get(v) ?? [];
      by_vertical[v] = ids.length;
      total += ids.length;
    }
    const verticals_without = ALL_RULE_TEMPLATE_VERTICALS.filter((v) => by_vertical[v] === 0);
    return { category, total, by_vertical, verticals_without };
  });

  // Columns (verticals × all categories).
  const columns: RuleTemplateVerticalColumn[] = ALL_RULE_TEMPLATE_VERTICALS.map((vertical) => {
    const by_category = emptyByCategory(categories);
    let total = 0;
    for (const c of categories) {
      const ids = cellTemplateIds.get(c)!.get(vertical) ?? [];
      by_category[c] = ids.length;
      total += ids.length;
    }
    const categories_without = categories.filter((c) => by_category[c] === 0);
    return { vertical, total, by_category, categories_without };
  });

  // peak_cell — canonical iteration tie-break (cats × verticals order).
  let peak: RuleTemplateMatrixCell | null = null;
  for (const c of categories) {
    for (const v of ALL_RULE_TEMPLATE_VERTICALS) {
      const ids = cellTemplateIds.get(c)!.get(v) ?? [];
      const count = ids.length;
      if (count > 0 && (!peak || count > peak.count)) {
        peak = {
          category: c,
          vertical: v,
          count,
          template_ids: [...ids].sort((a, z) => a.localeCompare(z)),
        };
      }
    }
  }

  // empty_cells canonical row-major (category × vertical).
  const empty_cells: Array<{ category: RuleTemplateCategory; vertical: RuleTemplateVertical }> = [];
  for (const c of categories) {
    for (const v of ALL_RULE_TEMPLATE_VERTICALS) {
      const ids = cellTemplateIds.get(c)!.get(v) ?? [];
      if (ids.length === 0) empty_cells.push({ category: c, vertical: v });
    }
  }

  // most_covered_category — highest distinct non-zero by_vertical count.
  let bestCatSpan = 0;
  let mostCoveredCat: RuleTemplateCategoryRow | null = null;
  for (const row of rows) {
    const span = ALL_RULE_TEMPLATE_VERTICALS.filter((v) => row.by_vertical[v] > 0).length;
    if (span > bestCatSpan) {
      bestCatSpan = span;
      mostCoveredCat = row;
    }
  }
  const most_covered_category = mostCoveredCat
    ? { category: mostCoveredCat.category, verticals_covered: bestCatSpan }
    : null;

  // most_covered_vertical — highest distinct non-zero by_category count.
  let bestVertSpan = 0;
  let mostCoveredVert: RuleTemplateVerticalColumn | null = null;
  for (const col of columns) {
    const span = categories.filter((c) => col.by_category[c] > 0).length;
    if (span > bestVertSpan) {
      bestVertSpan = span;
      mostCoveredVert = col;
    }
  }
  const most_covered_vertical = mostCoveredVert
    ? { vertical: mostCoveredVert.vertical, categories_covered: bestVertSpan }
    : null;

  return {
    generated_at: now.toISOString(),
    total_templates: RULE_TEMPLATES.length,
    total_categories: categories.length,
    total_verticals: ALL_RULE_TEMPLATE_VERTICALS.length,
    rows,
    columns,
    peak_cell: peak,
    empty_cells,
    most_covered_category,
    most_covered_vertical,
  };
}
