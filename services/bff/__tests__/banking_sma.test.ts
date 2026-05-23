// services/bff/__tests__/banking_sma.test.ts
//
// Unit tests for the SMA Classification module (RBI / RMA / CBK).

import {
  ALL_SMA_CATEGORIES,
  ALL_FRAMEWORKS,
  isSmaCategory,
  isFramework,
  categoryForDpd,
  buildSmaMovements,
  buildSmaSectorView,
  buildSmaTrend,
  runSmaClassification,
  buildSmaDrill,
  SmaError,
} from '../src/banking_sma';

const NOW = new Date('2026-05-23T12:00:00.000Z');
const YESTERDAY = new Date('2026-05-22T12:00:00.000Z');

describe('banking_sma — type guards + dpd mapping', () => {
  it('ALL_SMA_CATEGORIES is the closed enum', () => {
    expect(ALL_SMA_CATEGORIES).toEqual(['SMA-0', 'SMA-1', 'SMA-2', 'NPA']);
  });
  it('ALL_FRAMEWORKS is 3 codes', () => {
    expect(ALL_FRAMEWORKS).toEqual(['RBI', 'RMA', 'CBK']);
  });
  it('isSmaCategory accepts canonical + rejects others', () => {
    expect(isSmaCategory('SMA-0')).toBe(true);
    expect(isSmaCategory('NPA')).toBe(true);
    expect(isSmaCategory('sma-0')).toBe(false);
    expect(isSmaCategory('')).toBe(false);
  });
  it('isFramework accepts canonical + rejects others', () => {
    expect(isFramework('RBI')).toBe(true);
    expect(isFramework('rbi')).toBe(false);
  });
  it('categoryForDpd boundary classification', () => {
    expect(categoryForDpd(0)).toBe('SMA-0');
    expect(categoryForDpd(15)).toBe('SMA-0');
    expect(categoryForDpd(30)).toBe('SMA-0');
    expect(categoryForDpd(31)).toBe('SMA-1');
    expect(categoryForDpd(60)).toBe('SMA-1');
    expect(categoryForDpd(61)).toBe('SMA-2');
    expect(categoryForDpd(90)).toBe('SMA-2');
    expect(categoryForDpd(91)).toBe('NPA');
    expect(categoryForDpd(270)).toBe('NPA');
  });
});

describe('buildSmaMovements', () => {
  it('returns canonical envelope shape', () => {
    const out = buildSmaMovements('BANK_DEMO', NOW, 'RBI', NOW);
    expect(out.tenant_id).toBe('BANK_DEMO');
    expect(out.framework).toBe('RBI');
    expect(out.date).toBe('2026-05-23');
    expect(typeof out.generated_at).toBe('string');
    expect(out.movements).toBeInstanceOf(Array);
    expect(out.by_category_count).toEqual(
      expect.objectContaining({ 'SMA-0': expect.any(Number), 'SMA-1': expect.any(Number), 'SMA-2': expect.any(Number), NPA: expect.any(Number) }),
    );
  });

  it('deterministic per (tenant, date)', () => {
    const a = buildSmaMovements('BANK_DEMO', NOW, 'RBI', NOW);
    const b = buildSmaMovements('BANK_DEMO', NOW, 'RBI', NOW);
    expect(a.total_movements).toBe(b.total_movements);
    expect(a.movements[0]?.customer_id).toBe(b.movements[0]?.customer_id);
  });

  it('different tenant → different movement set', () => {
    const bank = buildSmaMovements('BANK_DEMO', NOW, 'RBI', NOW);
    const bil = buildSmaMovements('BIL', NOW, 'RBI', NOW);
    // Different cohort sizes (BIL has 60% scale)
    expect(bank.total_movements).not.toBe(bil.total_movements);
  });

  it('movements sorted worst-first (NPA before SMA-2 etc.)', () => {
    const out = buildSmaMovements('BANK_DEMO', NOW, 'RBI', NOW);
    if (out.movements.length > 1) {
      const catRank: Record<string, number> = { NPA: 0, 'SMA-2': 1, 'SMA-1': 2, 'SMA-0': 3 };
      for (let i = 1; i < out.movements.length; i++) {
        const prev = catRank[out.movements[i - 1].to_category];
        const cur = catRank[out.movements[i].to_category];
        expect(prev).toBeLessThanOrEqual(cur);
      }
    }
  });

  it('deteriorations + improvements + unchanged sums to total_movements', () => {
    const out = buildSmaMovements('BANK_DEMO', NOW, 'RBI', NOW);
    expect(out.deteriorations + out.improvements + out.unchanged).toBe(out.total_movements);
  });

  it('total_exposure equals sum of movement outstanding', () => {
    const out = buildSmaMovements('BANK_DEMO', NOW, 'RBI', NOW);
    const sum = out.movements.reduce((acc, m) => acc + m.outstanding_kes, 0);
    expect(out.total_exposure_at_risk_kes).toBe(sum);
  });

  it('empty tenant_id throws', () => {
    expect(() => buildSmaMovements('', NOW, 'RBI', NOW)).toThrow(SmaError);
  });
});

describe('buildSmaSectorView', () => {
  it('returns sectors sorted worst-first (NPA → SMA-2 → SMA-1 → SMA-0)', () => {
    const out = buildSmaSectorView('BANK_DEMO', 'RBI', NOW);
    expect(out.sectors.length).toBeGreaterThan(0);
    const catRank: Record<string, number> = { NPA: 0, 'SMA-2': 1, 'SMA-1': 2, 'SMA-0': 3 };
    for (let i = 1; i < out.sectors.length; i++) {
      const prev = catRank[out.sectors[i - 1].worst_category];
      const cur = catRank[out.sectors[i].worst_category];
      expect(prev).toBeLessThanOrEqual(cur);
    }
  });

  it('per-sector npa_ratio_pct = npa_outstanding / total_outstanding × 100', () => {
    const out = buildSmaSectorView('BANK_DEMO', 'RBI', NOW);
    for (const r of out.sectors) {
      if (r.total_outstanding_kes > 0) {
        const expected = Math.round((r.npa_outstanding_kes / r.total_outstanding_kes) * 10000) / 100;
        expect(r.npa_ratio_pct).toBeCloseTo(expected, 1);
      }
    }
  });

  it('totals partition invariant', () => {
    const out = buildSmaSectorView('BANK_DEMO', 'RBI', NOW);
    const totalCust = out.sectors.reduce((a, r) => a + r.total_customers, 0);
    const totalOut = out.sectors.reduce((a, r) => a + r.total_outstanding_kes, 0);
    expect(totalCust).toBe(out.total_customers);
    expect(totalOut).toBe(out.total_outstanding_kes);
  });

  it('empty tenant_id throws', () => {
    expect(() => buildSmaSectorView('', 'RBI', NOW)).toThrow(SmaError);
  });
});

describe('buildSmaTrend', () => {
  const FROM = new Date('2026-05-01T00:00:00.000Z');
  const UNTIL = new Date('2026-05-23T00:00:00.000Z');

  it('returns one point per UTC day in the window', () => {
    const out = buildSmaTrend('BANK_DEMO', 'c-100001', 'RBI', FROM, UNTIL, NOW);
    expect(out.point_count).toBe(23); // 1st through 23rd inclusive
    expect(out.series.length).toBe(23);
  });

  it('series points carry date, dpd, category, outstanding_kes', () => {
    const out = buildSmaTrend('BANK_DEMO', 'c-100001', 'RBI', FROM, UNTIL, NOW);
    for (const p of out.series) {
      expect(typeof p.date).toBe('string');
      expect(typeof p.dpd).toBe('number');
      expect(typeof p.category).toBe('string');
      expect(typeof p.outstanding_kes).toBe('number');
    }
  });

  it('trend_direction ∈ deteriorating | improving | stable', () => {
    const out = buildSmaTrend('BANK_DEMO', 'c-100001', 'RBI', FROM, UNTIL, NOW);
    expect(['deteriorating', 'improving', 'stable']).toContain(out.trend_direction);
  });

  it('rejects missing customer_id', () => {
    expect(() => buildSmaTrend('BANK_DEMO', '', 'RBI', FROM, UNTIL, NOW)).toThrow(SmaError);
  });

  it('rejects from > until', () => {
    expect(() => buildSmaTrend('BANK_DEMO', 'c-1', 'RBI', UNTIL, FROM, NOW)).toThrow(SmaError);
  });
});

describe('runSmaClassification', () => {
  it('returns run_id + counters', () => {
    const out = runSmaClassification('BANK_DEMO', 'RBI', 'alice.admin', NOW);
    expect(out.run_id).toMatch(/^sma-BANK_DEMO-2026-05-23-\d{4}$/);
    expect(out.customers_evaluated).toBeGreaterThan(0);
    expect(out.customers_changed).toBeGreaterThanOrEqual(0);
    expect(out.triggered_by).toBe('alice.admin');
    expect(out.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('by_category_count has every category key', () => {
    const out = runSmaClassification('BANK_DEMO', 'RBI', 'alice.admin', NOW);
    expect(Object.keys(out.by_category_count).sort()).toEqual(
      ['NPA', 'SMA-0', 'SMA-1', 'SMA-2'],
    );
  });

  it('rejects empty triggered_by', () => {
    expect(() => runSmaClassification('BANK_DEMO', 'RBI', '', NOW)).toThrow(SmaError);
  });
});

describe('buildSmaDrill', () => {
  const FROM = new Date('2026-05-21T00:00:00.000Z');
  const UNTIL = new Date('2026-05-23T00:00:00.000Z');

  it('returns rows with reason field populated', () => {
    const out = buildSmaDrill('BANK_DEMO', FROM, UNTIL, 'RBI', NOW);
    expect(out.total).toBeGreaterThanOrEqual(0);
    expect(out.from).toBe('2026-05-21');
    expect(out.until).toBe('2026-05-23');
    for (const r of out.rows) {
      expect(r.reason).toMatch(/(overdue|increased|partial|Stable)/);
    }
  });

  it('rejects from > until', () => {
    expect(() => buildSmaDrill('BANK_DEMO', UNTIL, FROM, 'RBI', NOW)).toThrow(SmaError);
  });
});
