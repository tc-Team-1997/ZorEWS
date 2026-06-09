// services/bff/src/rule_template_category_activation.ts
//
// T6 M5.20 — Rule template by-category activation analytics.
//
// Per-category breakdown of the M5.1 rule template library showing:
//   - template count by vertical (banking / insurance / both)
//   - average number of supporting indicators
//   - severity distribution within category
//   - most common recommended action in category
//
// Drives the SPA "template catalogue overview by category" panel +
// "which category has the best coverage?" governance view.
//
// Distinct from:
//   M5.16 — severity distribution (overall, not per-category)
//   M5.17 — category × vertical cross-tab matrix (cell counts only)
//   M5.19 — action × severity cross-tab matrix
//
// Route: GET /v1/rules/templates/category-activation
//   RBAC: rules:list (analyst+)
//   Platform-static. Mounted BEFORE /:id catch-all.

import {
  RULE_TEMPLATES,
  listCategories,
  type RuleTemplateCategory,
  type RecommendedSeverity,
} from './rule_templates';

// ─── Public types ──────────────────────────────────────────────────────

export interface CategoryActivationEntry {
  category: RuleTemplateCategory;
  total_templates: number;
  banking_count: number;
  insurance_count: number;
  both_count: number;
  /** Mean supporting_indicators.length across templates in this category. */
  avg_supporting_indicators: number;
  severity_distribution: Record<RecommendedSeverity, number>;
  /** Most frequently referenced recommended_action within this category.
   *  null when no templates in this category. */
  most_common_action: string | null;
}

export interface RuleTemplateCategoryActivationAnalytics {
  generated_at: string;
  total_templates: number;
  /** Sorted total_templates desc + category asc tie-break. */
  categories: CategoryActivationEntry[];
  /** Category with the highest total_templates; null when no templates. */
  most_active_category: RuleTemplateCategory | null;
  /** Category with the lowest total_templates (but > 0); null when ≤1 category. */
  least_active_category: RuleTemplateCategory | null;
  /** Fraction of templates with vertical='both' (0..1). */
  cross_vertical_pct: number;
}

// ─── Implementation ─────────────────────────────────────────────────────

export function buildTemplateCategoryActivationAnalytics(
  now: Date,
): RuleTemplateCategoryActivationAnalytics {
  const generated_at = now.toISOString();
  const total_templates = RULE_TEMPLATES.length;
  const categories_order = listCategories();

  const crossVerticalCount = RULE_TEMPLATES.filter(
    t => t.vertical === 'both',
  ).length;
  const cross_vertical_pct =
    total_templates > 0
      ? Math.round((crossVerticalCount / total_templates) * 10000) / 10000
      : 0;

  const ALL_SEVERITIES: RecommendedSeverity[] = ['critical', 'high', 'medium', 'low'];

  const entries: CategoryActivationEntry[] = categories_order.map(category => {
    const templates = RULE_TEMPLATES.filter(t => t.category === category);
    const total = templates.length;
    const banking_count = templates.filter(t => t.vertical === 'banking').length;
    const insurance_count = templates.filter(t => t.vertical === 'insurance').length;
    const both_count = templates.filter(t => t.vertical === 'both').length;

    const avg_supporting_indicators =
      total > 0
        ? Math.round(
            (templates.reduce((s, t) => s + t.supporting_indicators.length, 0) / total) * 100,
          ) / 100
        : 0;

    const severity_distribution: Record<RecommendedSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const t of templates) {
      severity_distribution[t.recommended_severity] =
        (severity_distribution[t.recommended_severity] ?? 0) + 1;
    }

    // Most common action in this category
    const actionCounts = new Map<string, number>();
    for (const t of templates) {
      for (const action of t.recommended_actions) {
        actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
      }
    }
    let most_common_action: string | null = null;
    let maxActionCount = 0;
    for (const [action, count] of actionCounts.entries()) {
      if (count > maxActionCount || (count === maxActionCount && action < (most_common_action ?? ''))) {
        if (count > maxActionCount) {
          maxActionCount = count;
          most_common_action = action;
        }
      }
    }

    return {
      category,
      total_templates: total,
      banking_count,
      insurance_count,
      both_count,
      avg_supporting_indicators,
      severity_distribution,
      most_common_action,
    };
  });

  // Sort: total_templates desc + category asc tie-break
  entries.sort((a, b) => {
    if (b.total_templates !== a.total_templates) {
      return b.total_templates - a.total_templates;
    }
    return a.category.localeCompare(b.category);
  });

  const nonEmpty = entries.filter(e => e.total_templates > 0);

  const most_active_category =
    nonEmpty.length > 0 ? nonEmpty[0]!.category : null;

  const least_active_category =
    nonEmpty.length > 1 ? nonEmpty[nonEmpty.length - 1]!.category : null;

  return {
    generated_at,
    total_templates,
    categories: entries,
    most_active_category,
    least_active_category,
    cross_vertical_pct,
  };
}
