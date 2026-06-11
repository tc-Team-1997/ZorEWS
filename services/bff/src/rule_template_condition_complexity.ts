// services/bff/src/rule_template_condition_complexity.ts
//
// T6 M5.26 — Rule condition complexity score.
//
// For each template in M5.1 library, compute a "condition complexity score":
//   score = supporting_indicators.length * 3
//         + recommended_actions.length * 2
//         + (vertical === 'both' ? 5 : 0)
//
// Tier: simple(<15) / moderate(15-25) / complex(>25)
// Sort by score desc.
//
// Route: GET /v1/rules/templates/condition-complexity
//   RBAC: rules:list

import { RULE_TEMPLATES, type RuleTemplate } from './rule_templates';

// ─── Public types ─────────────────────────────────────────────────────

export type ComplexityTier = 'simple' | 'moderate' | 'complex';

export interface RuleTemplateComplexityRow {
  template_id: string;
  name: string;
  category: string;
  vertical: string;
  complexity_score: number;
  tier: ComplexityTier;
}

export interface RuleTemplateConditionComplexityReport {
  generated_at: string;
  total_templates: number;
  templates: RuleTemplateComplexityRow[];
  avg_complexity: number;
  most_complex_template: string | null;
}

function computeComplexityScore(t: RuleTemplate): number {
  const indicatorScore = (t.supporting_indicators?.length ?? 0) * 3;
  const actionScore = (t.recommended_actions?.length ?? 0) * 2;
  const verticalBonus = t.vertical === 'both' ? 5 : 0;
  return indicatorScore + actionScore + verticalBonus;
}

function tierFor(score: number): ComplexityTier {
  if (score < 15) return 'simple';
  if (score <= 25) return 'moderate';
  return 'complex';
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildRuleTemplateConditionComplexity(
  now: Date,
): RuleTemplateConditionComplexityReport {
  const rows: RuleTemplateComplexityRow[] = RULE_TEMPLATES.map((t) => {
    const score = computeComplexityScore(t);
    return {
      template_id: t.id,
      name: t.name,
      category: t.category,
      vertical: t.vertical,
      complexity_score: score,
      tier: tierFor(score),
    };
  });

  // Sort by score desc, then template_id asc tie-break
  rows.sort((a, b) => {
    if (b.complexity_score !== a.complexity_score) return b.complexity_score - a.complexity_score;
    return a.template_id.localeCompare(b.template_id);
  });

  const total_templates = rows.length;
  const avg_complexity =
    total_templates === 0
      ? 0
      : Math.round(rows.reduce((s, r) => s + r.complexity_score, 0) / total_templates);

  const most_complex_template = rows.length > 0 ? rows[0].template_id : null;

  return {
    generated_at: now.toISOString(),
    total_templates,
    templates: rows,
    avg_complexity,
    most_complex_template,
  };
}
