// services/bff/src/rule_conflict_detection.ts
// T6 M5.28 — Rule conflict detection.

import { defaultStore as defaultRuleStore, type RuleStore } from './rules/store';

export type ConflictRisk = 'high' | 'medium' | 'low';

export interface RuleConflict {
  rule_a_id: string;
  rule_b_id: string;
  conflict_risk: ConflictRisk;
  reason: string;
}

export interface RuleConflictDetection {
  tenant_id: string;
  generated_at: string;
  total_live_rules: number;
  conflicts: RuleConflict[];
  high_risk_count: number;
  recommendations: string[];
}

/** Derive a family prefix from a rule id or name — fallback to 'generic'. */
function extractFamily(ruleId: string, name: string): string {
  const src = (ruleId + ' ' + name).toLowerCase();
  if (src.includes('fin') || src.includes('dpd') || src.includes('credit') || src.includes('loan')) return 'FIN';
  if (src.includes('beh') || src.includes('behav') || src.includes('balance')) return 'BEH';
  if (src.includes('txn') || src.includes('trans') || src.includes('velocity')) return 'TXN';
  if (src.includes('crd') || src.includes('card')) return 'CRD';
  if (src.includes('fraud') || src.includes('frd') || src.includes('suspicious')) return 'FRD';
  return 'GENERIC';
}

/** Derive a broad category from the rule. */
function extractCategory(ruleId: string, name: string): string {
  const src = (ruleId + ' ' + name).toLowerCase();
  if (src.includes('fraud') || src.includes('suspicious')) return 'fraud_detection';
  if (src.includes('comply') || src.includes('kyc') || src.includes('aml')) return 'compliance';
  if (src.includes('risk') || src.includes('default') || src.includes('dpd')) return 'risk_monitoring';
  return 'operational';
}

export function buildRuleConflictDetection(
  tenant_id: string,
  store: RuleStore,
  now: Date,
): RuleConflictDetection {
  const liveRules = store.list({ state: 'active' });

  const conflicts: RuleConflict[] = [];

  for (let i = 0; i < liveRules.length; i++) {
    for (let j = i + 1; j < liveRules.length; j++) {
      const a = liveRules[i];
      const b = liveRules[j];
      const familyA = extractFamily(a.id, a.name);
      const familyB = extractFamily(b.id, b.name);
      const categoryA = extractCategory(a.id, a.name);
      const categoryB = extractCategory(b.id, b.name);

      if (familyA === familyB && categoryA === categoryB) {
        const severityA = a.outcome?.severity ?? 'medium';
        const severityB = b.outcome?.severity ?? 'medium';
        const sameSeverity = severityA === severityB;
        const conflict_risk: ConflictRisk = sameSeverity ? 'high' : 'medium';
        const reason = sameSeverity
          ? `Both rules target the ${familyA} family with ${categoryA} category and identical severity (${severityA}) — may generate duplicate alerts for the same customer event.`
          : `Rules share the ${familyA} family and ${categoryA} category but have different severities (${severityA} vs ${severityB}) — severity ambiguity for overlapping customer cohorts.`;
        conflicts.push({ rule_a_id: a.id, rule_b_id: b.id, conflict_risk, reason });
      } else if (categoryA === categoryB && categoryA !== 'operational') {
        conflicts.push({
          rule_a_id: a.id,
          rule_b_id: b.id,
          conflict_risk: 'low',
          reason: `Rules share the ${categoryA} category across different indicator families — low risk of double-alerting; review thresholds for consistency.`,
        });
      }
    }
  }

  // Deduplicate: keep only highest-risk conflict per pair
  const seen = new Map<string, RuleConflict>();
  for (const c of conflicts) {
    const key = [c.rule_a_id, c.rule_b_id].sort().join('|');
    const prev = seen.get(key);
    if (!prev) { seen.set(key, c); continue; }
    const rank = (r: ConflictRisk) => r === 'high' ? 2 : r === 'medium' ? 1 : 0;
    if (rank(c.conflict_risk) > rank(prev.conflict_risk)) seen.set(key, c);
  }
  const finalConflicts = Array.from(seen.values());
  const high_risk_count = finalConflicts.filter((c) => c.conflict_risk === 'high').length;

  const recommendations: string[] = [];
  if (high_risk_count > 0) recommendations.push(`Review ${high_risk_count} high-risk rule pair(s) for overlapping customer cohorts.`);
  if (finalConflicts.filter((c) => c.conflict_risk === 'medium').length > 0) recommendations.push('Audit medium-risk pairs to align severity thresholds and reduce alert noise.');

  return { tenant_id, generated_at: now.toISOString(), total_live_rules: liveRules.length, conflicts: finalConflicts, high_risk_count, recommendations };
}

export { defaultRuleStore };
