// services/bff/src/rule_template_complexity.ts
//
// T6 M5.22 — Rule template complexity scoring.
//
// Scores each template in the M5.1 library by complexity:
//   complexity_score = supporting_indicators.length * 10
//                    + recommended_actions.length * 8
//                    + (vertical === 'both' ? 5 : 0)
//
// Tiers: simple (<20), moderate (20-40), complex (>40)

import { RULE_TEMPLATES, type RuleTemplate } from './rule_templates';

// ─── Public types ──────────────────────────────────────────────────────

export type ComplexityTier = 'simple' | 'moderate' | 'complex';

export interface TemplateComplexityScore {
  template_id: string;
  name: string;
  category: string;
  vertical: string;
  supporting_indicators_count: number;
  actions_count: number;
  complexity_score: number;
  tier: ComplexityTier;
}

export interface RuleTemplateComplexityReport {
  generated_at: string;
  total_templates: number;
  scores: TemplateComplexityScore[];
  most_complex: { template_id: string; name: string; score: number } | null;
  avg_complexity: number;
  tier_distribution: { simple: number; moderate: number; complex: number };
}

// ─── Pure function ─────────────────────────────────────────────────────

function tierFor(score: number): ComplexityTier {
  if (score < 20) return 'simple';
  if (score <= 40) return 'moderate';
  return 'complex';
}

export function buildRuleTemplateComplexityScores(now: Date): RuleTemplateComplexityReport {
  const generated_at = now.toISOString();

  const scores: TemplateComplexityScore[] = RULE_TEMPLATES.map(t => {
    const complexity_score =
      t.supporting_indicators.length * 10 +
      t.recommended_actions.length * 8 +
      (t.vertical === 'both' ? 5 : 0);

    return {
      template_id: t.id,
      name: t.name,
      category: t.category,
      vertical: t.vertical,
      supporting_indicators_count: t.supporting_indicators.length,
      actions_count: t.recommended_actions.length,
      complexity_score,
      tier: tierFor(complexity_score),
    };
  });

  // Sort by complexity_score desc, then template_id asc for stability
  scores.sort((a, b) =>
    b.complexity_score !== a.complexity_score
      ? b.complexity_score - a.complexity_score
      : a.template_id.localeCompare(b.template_id),
  );

  const most_complex = scores[0]
    ? { template_id: scores[0].template_id, name: scores[0].name, score: scores[0].complexity_score }
    : null;

  const total = scores.length;
  const avg_complexity = total > 0
    ? Math.round((scores.reduce((s, x) => s + x.complexity_score, 0) / total) * 100) / 100
    : 0;

  const tier_distribution = {
    simple: scores.filter(s => s.tier === 'simple').length,
    moderate: scores.filter(s => s.tier === 'moderate').length,
    complex: scores.filter(s => s.tier === 'complex').length,
  };

  return {
    generated_at,
    total_templates: total,
    scores,
    most_complex,
    avg_complexity,
    tier_distribution,
  };
}
