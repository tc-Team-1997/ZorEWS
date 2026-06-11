// services/bff/src/rule_coverage_by_segment.ts
// T6 M5.30 — Rule coverage by customer segment

import { type RuleStore } from './rules/store';

export type CustomerSegment = 'retail' | 'sme' | 'corporate' | 'all';

export const ALL_SEGMENTS: CustomerSegment[] = ['retail', 'sme', 'corporate', 'all'];

export interface SegmentCoverage {
  segment: CustomerSegment;
  applicable_rules: number;
  coverage_pct: number;
  exclusive_rules: number;
}

export interface RuleCoverageBySegment {
  tenant_id: string;
  generated_at: string;
  total_live_rules: number;
  by_segment: SegmentCoverage[];
  uncovered_segments: CustomerSegment[];
  most_covered_segment: CustomerSegment | null;
}

function ruleTextFor(r: unknown): string {
  const rule = r as Record<string, unknown>;
  // Try various field names that could contain condition info
  const cond = rule.conditions ?? rule.condition ?? rule.when ?? rule.title ?? rule.name ?? '';
  return typeof cond === 'string' ? cond.toLowerCase() : JSON.stringify(cond).toLowerCase();
}

function ruleAppliesTo(ruleText: string, segment: CustomerSegment): boolean {
  if (segment === 'all') return true;
  // A rule applies to a segment if it mentions it OR mentions 'all'
  return ruleText.includes(segment) || ruleText.includes('all');
}

export function buildRuleCoverageBySegment(
  ruleStore: RuleStore,
  tenant_id: string,
  now: Date
): RuleCoverageBySegment {
  const generated_at = now.toISOString();
  // Use 'active' state (the correct RuleState in types.ts)
  const liveRules = ruleStore.list({ state: 'active' as import('./rules/types').RuleState });
  const total = liveRules.length;

  const by_segment: SegmentCoverage[] = ALL_SEGMENTS.map((segment) => {
    const applicable = liveRules.filter((r) => {
      const text = ruleTextFor(r);
      return ruleAppliesTo(text, segment);
    });

    // exclusive = rules that apply ONLY to this segment (not to others except 'all')
    const exclusive = liveRules.filter((r) => {
      const text = ruleTextFor(r);
      if (segment === 'all') return false;
      const otherSegments = ALL_SEGMENTS.filter((s) => s !== segment && s !== 'all');
      const mentionsOther = otherSegments.some((s) => text.includes(s));
      return text.includes(segment) && !mentionsOther;
    });

    const coverage_pct = total > 0 ? Math.round((applicable.length / total) * 100) : 0;
    return {
      segment,
      applicable_rules: applicable.length,
      coverage_pct,
      exclusive_rules: exclusive.length,
    };
  });

  const uncovered_segments = by_segment
    .filter((s) => s.applicable_rules === 0 && s.segment !== 'all')
    .map((s) => s.segment);

  const nonAllSegments = by_segment.filter((s) => s.segment !== 'all');
  const maxCoverage = nonAllSegments.reduce((m, s) => Math.max(m, s.coverage_pct), 0);
  const most_covered_segment = maxCoverage > 0
    ? nonAllSegments.reduce((best, curr) =>
        curr.coverage_pct > best.coverage_pct ? curr : best
      ).segment
    : null;

  return {
    tenant_id,
    generated_at,
    total_live_rules: total,
    by_segment,
    uncovered_segments,
    most_covered_segment,
  };
}
