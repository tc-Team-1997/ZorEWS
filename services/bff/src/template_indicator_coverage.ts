// services/bff/src/template_indicator_coverage.ts
//
// T6 M5.14 — Rule template indicator-coverage check.
//
// Cross-module consistency validator. Every M5.1 rule template carries
// a `supporting_indicators` array of indicator ids; every id should
// resolve to a real catalog entry, and the indicator's vertical
// should align with the template's vertical (banking template → banking
// indicators, etc; `both` accepts either).
//
// M5.1 + M4.1 evolve independently — this check catches drift: a
// template was authored when an indicator existed, the indicator was
// later renamed in the catalog, and now the template references a
// dead id. Surfaces those gaps before the rule fires in production.
//
// Pure — no I/O. Caller passes both registries.

import { STUB_CATALOG } from './bil_scoring_v2';
import { listTemplates as listRuleTemplates, type RuleTemplate } from './rule_templates';

// ─── Public types ─────────────────────────────────────────────────────

export type TemplateCoverageStatus =
  | 'fully_resolved'    // every indicator known + vertical matches
  | 'has_unknown'        // ≥1 indicator id not in the catalog
  | 'has_mismatch'       // every id known but ≥1 vertical mismatched
  | 'no_indicators';     // template declares zero supporting_indicators

export interface IndicatorCoverageItem {
  indicator_id: string;
  /** True iff the id resolves to a catalog entry. */
  exists: boolean;
  /** Indicator's vertical per the catalog. null when not in catalog. */
  catalog_vertical: string | null;
  /** True iff the indicator's vertical aligns with the template's
   *  vertical. Templates with `vertical='both'` always match. False
   *  when `exists=false` (can't match what doesn't exist). */
  matches_template_vertical: boolean;
}

export interface TemplateCoverage {
  template_id: string;
  name: string;
  vertical: string;
  indicators_total: number;
  known_count: number;
  unknown_count: number;
  vertical_mismatch_count: number;
  status: TemplateCoverageStatus;
  items: IndicatorCoverageItem[];
}

export interface TemplateIndicatorCoverageReport {
  total_templates: number;
  fully_resolved_count: number;
  has_unknown_count: number;
  has_mismatch_count: number;
  no_indicators_count: number;
  templates: TemplateCoverage[];
}

// ─── Pure validator ──────────────────────────────────────────────────

function classify(
  total: number,
  unknown: number,
  mismatch: number,
): TemplateCoverageStatus {
  if (total === 0) return 'no_indicators';
  if (unknown > 0) return 'has_unknown';
  if (mismatch > 0) return 'has_mismatch';
  return 'fully_resolved';
}

function verticalAligns(
  template_vertical: string,
  catalog_vertical: string,
): boolean {
  if (template_vertical === 'both') return true;
  return template_vertical === catalog_vertical;
}

/**
 * Cross-references each template's supporting_indicators against
 * the supplied indicator catalog. Defaults to the M5.1 templates +
 * M6.2 STUB_CATALOG; tests inject custom registries.
 */
export function checkTemplateIndicatorCoverage(
  templates: readonly RuleTemplate[] = listRuleTemplates(),
  catalog: Readonly<Record<string, { vertical: string }>> = STUB_CATALOG,
): TemplateIndicatorCoverageReport {
  const out: TemplateCoverage[] = [];
  let fully_resolved_count = 0;
  let has_unknown_count = 0;
  let has_mismatch_count = 0;
  let no_indicators_count = 0;

  for (const tpl of templates) {
    let unknown = 0;
    let mismatch = 0;
    const items: IndicatorCoverageItem[] = [];
    for (const id of tpl.supporting_indicators) {
      const entry = catalog[id];
      if (!entry) {
        unknown += 1;
        items.push({
          indicator_id: id,
          exists: false,
          catalog_vertical: null,
          matches_template_vertical: false,
        });
        continue;
      }
      const matches = verticalAligns(tpl.vertical, entry.vertical);
      if (!matches) mismatch += 1;
      items.push({
        indicator_id: id,
        exists: true,
        catalog_vertical: entry.vertical,
        matches_template_vertical: matches,
      });
    }
    const total = items.length;
    const known = total - unknown;
    const status = classify(total, unknown, mismatch);
    if (status === 'fully_resolved') fully_resolved_count += 1;
    else if (status === 'has_unknown') has_unknown_count += 1;
    else if (status === 'has_mismatch') has_mismatch_count += 1;
    else no_indicators_count += 1;
    out.push({
      template_id: tpl.id,
      name: tpl.name,
      vertical: tpl.vertical,
      indicators_total: total,
      known_count: known,
      unknown_count: unknown,
      vertical_mismatch_count: mismatch,
      status,
      items,
    });
  }

  return {
    total_templates: templates.length,
    fully_resolved_count,
    has_unknown_count,
    has_mismatch_count,
    no_indicators_count,
    templates: out,
  };
}
