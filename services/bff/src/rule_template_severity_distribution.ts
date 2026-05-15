// services/bff/src/rule_template_severity_distribution.ts
//
// T6 M5.16 — Rule template severity distribution.
//
// M5.15 ships the inverted index of templates → recommended_actions.
// M5.16 ships the orthogonal pivot: templates grouped by
// `recommended_severity` (critical / high / medium / low) with
// per-category and per-vertical breakdowns.
//
// Lets the SPA render "severity mix" chips on the templates page
// header + spot gaps (e.g. "no critical-severity templates exist
// for the fraud_detection category — should we add one?").
//
// Pure — platform-static. Same response across every tenant.

import {
  RULE_TEMPLATES,
  type RecommendedSeverity,
  type RuleTemplateCategory,
  type RuleTemplateVertical,
} from './rule_templates';

// ─── Public types ─────────────────────────────────────────────────────

const ALL_SEVERITIES: readonly RecommendedSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
] as const;

const ALL_CATEGORIES: readonly RuleTemplateCategory[] = [
  'risk_monitoring',
  'fraud_detection',
  'compliance',
  'operational',
  'underwriting',
] as const;

const ALL_VERTICALS: readonly RuleTemplateVertical[] = [
  'banking',
  'insurance',
  'both',
] as const;

export interface SeverityDistributionRow {
  severity: RecommendedSeverity;
  total_count: number;
  /** Per-category breakdown — every category key always present
   *  (zero when absent) for stable SPA grid rendering. */
  by_category: Record<RuleTemplateCategory, number>;
  /** Per-vertical breakdown — every vertical key always present. */
  by_vertical: Record<RuleTemplateVertical, number>;
  /** Template ids in this severity bucket, sorted asc. */
  template_ids: string[];
}

export interface SeverityDistributionSummary {
  total_templates: number;
  /** Every severity in canonical order (critical → high → medium →
   *  low) even when zero templates use it. */
  severities: SeverityDistributionRow[];
  /** Severity with the highest total_count. Ties broken by canonical
   *  severity order via iteration (critical wins over high at same
   *  count). null when no templates. */
  most_common_severity: RecommendedSeverity | null;
  /** Severities with zero templates. Sorted by canonical order. */
  unused_severities: RecommendedSeverity[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

function emptyCategoryCounts(): Record<RuleTemplateCategory, number> {
  return {
    risk_monitoring: 0,
    fraud_detection: 0,
    compliance: 0,
    operational: 0,
    underwriting: 0,
  };
}

function emptyVerticalCounts(): Record<RuleTemplateVertical, number> {
  return {
    banking: 0,
    insurance: 0,
    both: 0,
  };
}

export function buildTemplateSeverityDistribution(): SeverityDistributionSummary {
  // Pre-populate every severity row so the SPA gets a stable shape.
  const rows = new Map<RecommendedSeverity, SeverityDistributionRow>();
  for (const sev of ALL_SEVERITIES) {
    rows.set(sev, {
      severity: sev,
      total_count: 0,
      by_category: emptyCategoryCounts(),
      by_vertical: emptyVerticalCounts(),
      template_ids: [],
    });
  }

  for (const tpl of RULE_TEMPLATES) {
    const row = rows.get(tpl.recommended_severity);
    if (!row) continue; // unknown severity — shouldn't happen
    row.total_count++;
    row.by_category[tpl.category]++;
    row.by_vertical[tpl.vertical]++;
    row.template_ids.push(tpl.id);
  }

  for (const row of rows.values()) row.template_ids.sort();

  // Emit in canonical severity order (critical → high → medium → low).
  const severities: SeverityDistributionRow[] = ALL_SEVERITIES.map((sev) => rows.get(sev)!);

  // most_common_severity: iterate in canonical order; flip only on
  // strict greater-than so canonical order acts as tie-break.
  let most_common_severity: RecommendedSeverity | null = null;
  let mostCount = 0;
  for (const sev of ALL_SEVERITIES) {
    const row = rows.get(sev)!;
    if (row.total_count > mostCount) {
      mostCount = row.total_count;
      most_common_severity = sev;
    }
  }
  if (mostCount === 0) most_common_severity = null;

  const unused_severities = ALL_SEVERITIES.filter((sev) => rows.get(sev)!.total_count === 0);

  return {
    total_templates: RULE_TEMPLATES.length,
    severities,
    most_common_severity,
    unused_severities,
  };
}

// Ensure consumed enums show as imports for tsc strict.
type _Unused = ReturnType<typeof emptyCategoryCounts>;
