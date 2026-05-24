// services/bff/__tests__/data_profiling.test.ts

import {
  KNOWN_SOURCES,
  isDataSourceId,
  profileSource,
  buildColumnDistribution,
  suggestDqRules,
  promoteDqRule,
  _resetDqSuggestionStore,
  DataProfilingError,
} from '../src/data_profiling';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetDqSuggestionStore());

describe('catalog', () => {
  it('KNOWN_SOURCES has 6 entries', () => {
    expect(KNOWN_SOURCES).toHaveLength(6);
    expect(KNOWN_SOURCES).toContain('cbs_loans');
  });
  it('isDataSourceId guard', () => {
    expect(isDataSourceId('cbs_loans')).toBe(true);
    expect(isDataSourceId('bogus')).toBe(false);
  });
});

describe('profileSource', () => {
  it('returns canonical envelope with columns', () => {
    const out = profileSource('BANK_DEMO', 'cbs_loans', NOW);
    expect(out.tenant_id).toBe('BANK_DEMO');
    expect(out.source_id).toBe('cbs_loans');
    expect(out.columns.length).toBeGreaterThan(0);
    for (const c of out.columns) {
      expect(['string', 'integer', 'number', 'boolean', 'date', 'enum']).toContain(c.type);
      expect(c.null_pct).toBeGreaterThanOrEqual(0);
      expect(c.null_pct).toBeLessThanOrEqual(1);
    }
  });

  it('deterministic per (tenant, source, day)', () => {
    const a = profileSource('BANK_DEMO', 'cbs_loans', NOW);
    const b = profileSource('BANK_DEMO', 'cbs_loans', NOW);
    expect(a.total_rows).toBe(b.total_rows);
    expect(a.columns[0].null_count).toBe(b.columns[0].null_count);
  });

  it('rejects unknown source', () => {
    expect(() => profileSource('BANK_DEMO', 'bogus', NOW)).toThrow(DataProfilingError);
  });
});

describe('buildColumnDistribution', () => {
  it('returns buckets summing to ~1 in pct', () => {
    const out = buildColumnDistribution('BANK_DEMO', 'cbs_loans', 'worst_dpd', NOW);
    const sum = out.buckets.reduce((a, b) => a + b.pct, 0);
    expect(sum).toBeGreaterThan(0.95);
    expect(sum).toBeLessThan(1.05);
  });

  it('enum/boolean columns get smaller bucket count', () => {
    const enumDist = buildColumnDistribution('BANK_DEMO', 'cbs_loans', 'product_code', NOW);
    expect(enumDist.buckets).toHaveLength(5);
  });

  it('rejects unknown column', () => {
    expect(() => buildColumnDistribution('BANK_DEMO', 'cbs_loans', 'bogus_col', NOW)).toThrow(DataProfilingError);
  });
});

describe('suggestDqRules + promoteDqRule', () => {
  it('returns ≥3 suggestions for cbs_loans', () => {
    const out = suggestDqRules('BANK_DEMO', 'cbs_loans', NOW);
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const r of out) {
      expect(['not_null', 'range', 'enum_membership', 'regex', 'unique', 'freshness']).toContain(r.rule_type);
      expect(r.status).toBe('suggested');
      expect(r.confidence).toBeGreaterThan(0);
    }
  });

  it('promote flips status to promoted', () => {
    const out = suggestDqRules('BANK_DEMO', 'cbs_loans', NOW);
    const promoted = promoteDqRule('BANK_DEMO', out[0].rule_id, 'alice', NOW);
    expect(promoted.status).toBe('promoted');
  });

  it('already-promoted rule rejected', () => {
    const out = suggestDqRules('BANK_DEMO', 'cbs_loans', NOW);
    promoteDqRule('BANK_DEMO', out[0].rule_id, 'alice', NOW);
    expect(() => promoteDqRule('BANK_DEMO', out[0].rule_id, 'alice', NOW)).toThrow(DataProfilingError);
  });

  it('cross-tenant promote rejected', () => {
    const out = suggestDqRules('BANK_DEMO', 'cbs_loans', NOW);
    expect(() => promoteDqRule('BIL', out[0].rule_id, 'alice', NOW)).toThrow(DataProfilingError);
  });

  it('unknown source rejected', () => {
    expect(() => suggestDqRules('BANK_DEMO', 'bogus', NOW)).toThrow(DataProfilingError);
  });
});
