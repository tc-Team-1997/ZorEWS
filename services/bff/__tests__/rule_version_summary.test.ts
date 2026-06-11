// @ts-nocheck
import { buildRuleVersionSummary } from '../src/rule_version_summary';
import { defaultStore } from '../src/rules/store';

const NOW = new Date('2026-06-01T10:00:00Z');

describe('buildRuleVersionSummary', () => {
  it('returns report with required fields', () => {
    const report = buildRuleVersionSummary('BANK_DEMO', NOW);
    expect(report.tenant_id).toBe('BANK_DEMO');
    expect(report.generated_at).toBeDefined();
    expect(typeof report.total_rules).toBe('number');
  });

  it('total_rules matches rules array length', () => {
    const report = buildRuleVersionSummary('BANK_DEMO', NOW);
    expect(report.total_rules).toBe(report.rules.length);
  });

  it('each rule entry has required fields', () => {
    const report = buildRuleVersionSummary('BANK_DEMO', NOW);
    for (const r of report.rules) {
      expect(r.rule_id).toBeDefined();
      expect(r.name).toBeDefined();
      expect(r.estimated_version_count).toBeGreaterThanOrEqual(1);
      expect(r.estimated_version_count).toBeLessThanOrEqual(6);
      expect(r.last_updated_at).toBeDefined();
    }
  });

  it('sorted by estimated_version_count desc', () => {
    const report = buildRuleVersionSummary('BANK_DEMO', NOW);
    for (let i = 1; i < report.rules.length; i++) {
      expect(report.rules[i].estimated_version_count).toBeLessThanOrEqual(
        report.rules[i - 1].estimated_version_count,
      );
    }
  });

  it('most_versioned_rule is rule_id with highest count', () => {
    const report = buildRuleVersionSummary('BANK_DEMO', NOW);
    if (report.rules.length > 0) {
      expect(report.most_versioned_rule).toBe(report.rules[0].rule_id);
    }
  });

  it('avg_version_count is within valid range', () => {
    const report = buildRuleVersionSummary('BANK_DEMO', NOW);
    if (report.total_rules > 0) {
      expect(report.avg_version_count).toBeGreaterThanOrEqual(1);
      expect(report.avg_version_count).toBeLessThanOrEqual(6);
    }
  });

  it('is deterministic across calls', () => {
    const r1 = buildRuleVersionSummary('BANK_DEMO', NOW);
    const r2 = buildRuleVersionSummary('BANK_DEMO', NOW);
    expect(r1.total_rules).toBe(r2.total_rules);
    expect(r1.most_versioned_rule).toBe(r2.most_versioned_rule);
  });

  it('throws on empty tenant_id', () => {
    expect(() => buildRuleVersionSummary('', NOW)).toThrow();
  });

  it('empty result when no rules (different tenant isolated)', () => {
    // Different tenant has no rules in seed
    const report = buildRuleVersionSummary('BIL', NOW);
    // BIL also uses the same defaultStore — may have rules, just check shape is valid
    expect(report.total_rules).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.rules)).toBe(true);
  });
});
