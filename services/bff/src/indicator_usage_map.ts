// services/bff/src/indicator_usage_map.ts
//
// T6 M4.11 — Indicator usage / orphan detection.
//
// M5.14 ships the forward cross-reference: rule template →
// supporting_indicators. M4.11 ships the reverse: for each indicator
// in the M6.2 catalog, which rule templates (M5.1) reference it?
// Plus orphan detection — indicators with zero references are
// candidates for either retiring or wiring into a new template.
//
// Pure — no I/O. Caller passes the catalog + template registries.
// Platform-static (same response across tenants).

import { STUB_CATALOG } from './bil_scoring_v2';
import {
  listTemplates as listRuleTemplates,
  type RuleTemplate,
} from './rule_templates';
import { getThreshold } from './indicator_thresholds';

// ─── Public types ─────────────────────────────────────────────────────

export interface TemplateReference {
  template_id: string;
  name: string;
  category: string;
  /** True iff the template's vertical aligns with the indicator's
   *  vertical (vertical='both' always matches). */
  vertical_matches: boolean;
}

export interface IndicatorUsage {
  indicator_id: string;
  name: string;
  vertical: string;
  catalog_weight: number;
  referenced_by_templates: TemplateReference[];
  reference_count: number;
  /** True iff a default threshold exists for this indicator
   *  (M4.3 / M4.10). Indicators without thresholds + zero
   *  references are dead config that ops can clean up. */
  has_threshold: boolean;
}

export interface IndicatorUsageReport {
  total_indicators: number;
  /** Indicators with reference_count === 0 — orphan candidates. */
  orphaned_count: number;
  /** Top 5 most-referenced indicators, sorted by reference_count desc
   *  then indicator_id asc. */
  most_referenced: Pick<IndicatorUsage, 'indicator_id' | 'name' | 'reference_count'>[];
  by_vertical: Record<'banking' | 'insurance' | 'both' | 'other', number>;
  indicators: IndicatorUsage[];
}

// ─── Pure reverse-indexer ─────────────────────────────────────────────

function verticalAligns(
  template_vertical: string,
  indicator_vertical: string,
): boolean {
  if (template_vertical === 'both') return true;
  return template_vertical === indicator_vertical;
}

export function mapIndicatorUsage(
  catalog: Readonly<Record<string, { vertical: string; weight: number; name: string }>> = STUB_CATALOG,
  templates: readonly RuleTemplate[] = listRuleTemplates(),
): IndicatorUsageReport {
  const out: IndicatorUsage[] = [];
  const by_vertical: IndicatorUsageReport['by_vertical'] = {
    banking: 0,
    insurance: 0,
    both: 0,
    other: 0,
  };
  let orphaned_count = 0;

  for (const [indicator_id, entry] of Object.entries(catalog)) {
    const refs: TemplateReference[] = [];
    for (const tpl of templates) {
      if (!tpl.supporting_indicators.includes(indicator_id)) continue;
      refs.push({
        template_id: tpl.id,
        name: tpl.name,
        category: tpl.category,
        vertical_matches: verticalAligns(tpl.vertical, entry.vertical),
      });
    }
    refs.sort((a, b) => (a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0));
    if (refs.length === 0) orphaned_count += 1;
    const has_threshold = getThreshold(indicator_id) !== null;
    out.push({
      indicator_id,
      name: entry.name,
      vertical: entry.vertical,
      catalog_weight: entry.weight,
      referenced_by_templates: refs,
      reference_count: refs.length,
      has_threshold,
    });
    if (entry.vertical === 'banking') by_vertical.banking += 1;
    else if (entry.vertical === 'insurance') by_vertical.insurance += 1;
    else if (entry.vertical === 'both') by_vertical.both += 1;
    else by_vertical.other += 1;
  }

  out.sort((a, b) => (a.indicator_id < b.indicator_id ? -1 : a.indicator_id > b.indicator_id ? 1 : 0));

  const most_referenced = [...out]
    .sort((a, b) => {
      if (b.reference_count !== a.reference_count) return b.reference_count - a.reference_count;
      return a.indicator_id < b.indicator_id ? -1 : 1;
    })
    .slice(0, 5)
    .map((i) => ({
      indicator_id: i.indicator_id,
      name: i.name,
      reference_count: i.reference_count,
    }));

  return {
    total_indicators: out.length,
    orphaned_count,
    most_referenced,
    by_vertical,
    indicators: out,
  };
}
