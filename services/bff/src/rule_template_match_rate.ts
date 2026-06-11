// services/bff/src/rule_template_match_rate.ts
//
// T6 M5.23 — Rule template recommendation match rate.
//
// For each rule template in the M5.1 library, compute how well it
// matches the current tenant's active rules by shared category and
// vertical.

import { RULE_TEMPLATES, type RuleTemplate } from './rule_templates';
import { RuleStore } from './rules/store';

// ─── Public types ──────────────────────────────────────────────────────

export interface RuleTemplateMatchRateEntry {
  template_id: string;
  name: string;
  category: string;
  vertical: string;
  matched_active_rules: number;
  total_active_rules: number;
  match_rate: number; // 0–1
  coverage_score: number; // 0–100
}

export interface RuleTemplateMatchRateResult {
  tenant_id: string;
  generated_at: string;
  templates: RuleTemplateMatchRateEntry[];
  total_active_rules: number;
  overall_coverage_rate: number; // fraction of templates with match_rate > 0
}

// ─── Main function ────────────────────────────────────────────────────

export function computeTemplateMatchRates(
  tenant_id: string,
  ruleStore: RuleStore,
  now: Date,
): RuleTemplateMatchRateResult {
  // Get active rules from the store
  const activeRules = ruleStore.list({ state: 'active' });
  const total_active_rules = activeRules.length;

  const entries: RuleTemplateMatchRateEntry[] = [];

  for (const template of RULE_TEMPLATES) {
    // Count active rules matching this template's category and vertical
    const matched_active_rules = activeRules.filter((rule) => {
      // Match by family/category approximate mapping
      // RuleV2 has 'family', template has 'category'
      const categoryMatch = matchesCategoryFamily(template.category, rule.family);
      return categoryMatch;
    }).length;

    const match_rate =
      total_active_rules > 0
        ? Math.round((matched_active_rules / total_active_rules) * 10000) / 10000
        : 0;

    const coverage_score = Math.min(100, matched_active_rules * 20);

    entries.push({
      template_id: template.id,
      name: template.name,
      category: template.category,
      vertical: template.vertical,
      matched_active_rules,
      total_active_rules,
      match_rate,
      coverage_score,
    });
  }

  // Sort by match_rate desc, then coverage_score desc
  entries.sort((a, b) => {
    if (b.match_rate !== a.match_rate) return b.match_rate - a.match_rate;
    return b.coverage_score - a.coverage_score;
  });

  const templates_with_matches = entries.filter((e) => e.match_rate > 0).length;
  const overall_coverage_rate =
    entries.length > 0
      ? Math.round((templates_with_matches / entries.length) * 10000) / 10000
      : 0;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    templates: entries,
    total_active_rules,
    overall_coverage_rate,
  };
}

// Map template categories to rule family values
function matchesCategoryFamily(category: string, family: string): boolean {
  const mapping: Record<string, string[]> = {
    risk_monitoring: ['Financial', 'Credit'],
    fraud_detection: ['Fraud', 'Behavioural'],
    compliance: ['Financial', 'Credit'],
    operational: ['Transaction', 'Behavioural'],
    underwriting: ['Financial', 'Credit'],
  };
  const allowed = mapping[category] ?? [];
  return allowed.includes(family);
}
