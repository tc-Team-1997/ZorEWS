// @ts-nocheck
import { buildTenantFeatureComparison } from '../src/tenant_feature_comparison';

const NOW = new Date('2026-06-01T10:00:00Z');

describe('buildTenantFeatureComparison', () => {
  it('returns report with generated_at', () => {
    const report = buildTenantFeatureComparison(NOW);
    expect(report.generated_at).toBeDefined();
  });

  it('includes both known tenants', () => {
    const report = buildTenantFeatureComparison(NOW);
    expect(report.tenants).toContain('BANK_DEMO');
    expect(report.tenants).toContain('BIL');
  });

  it('returns exactly 3 feature flags', () => {
    const report = buildTenantFeatureComparison(NOW);
    expect(report.features).toHaveLength(3);
  });

  it('includes all expected feature keys', () => {
    const report = buildTenantFeatureComparison(NOW);
    const keys = report.features.map(f => f.feature_key);
    expect(keys).toContain('features.scenario_simulation_enabled');
    expect(keys).toContain('features.copilot_enabled');
    expect(keys).toContain('features.maker_checker_enabled');
  });

  it('each feature has values_by_tenant for both tenants', () => {
    const report = buildTenantFeatureComparison(NOW);
    for (const f of report.features) {
      expect(f.values_by_tenant).toHaveProperty('BANK_DEMO');
      expect(f.values_by_tenant).toHaveProperty('BIL');
      expect(typeof f.values_by_tenant['BANK_DEMO']).toBe('boolean');
      expect(typeof f.values_by_tenant['BIL']).toBe('boolean');
    }
  });

  it('each feature has default_value as boolean', () => {
    const report = buildTenantFeatureComparison(NOW);
    for (const f of report.features) {
      expect(typeof f.default_value).toBe('boolean');
    }
  });

  it('divergent_features is a subset of features', () => {
    const report = buildTenantFeatureComparison(NOW);
    const allKeys = report.features.map(f => f.feature_key);
    for (const dk of report.divergent_features) {
      expect(allKeys).toContain(dk);
    }
  });

  it('divergent flag matches values_by_tenant', () => {
    const report = buildTenantFeatureComparison(NOW);
    for (const f of report.features) {
      const vals = Object.values(f.values_by_tenant);
      const expected_divergent = vals.length > 1 && !vals.every(v => v === vals[0]);
      expect(f.divergent).toBe(expected_divergent);
    }
  });

  it('returns deterministic results on multiple calls', () => {
    const r1 = buildTenantFeatureComparison(NOW);
    const r2 = buildTenantFeatureComparison(NOW);
    expect(r1.features.map(f => f.feature_key)).toEqual(r2.features.map(f => f.feature_key));
  });
});
