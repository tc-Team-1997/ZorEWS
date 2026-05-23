// services/bff/__tests__/banking_ratios.test.ts

import {
  ALL_RATIO_CODES,
  ALL_CMA_FORMS,
  RATIO_CATALOG,
  RATIO_BY_CODE,
  isRatioCode,
  isCmaForm,
  buildCustomerRatios,
  buildSectorBenchmark,
  buildCmaPack,
  InMemoryRatioThresholdStore,
  RatiosError,
} from '../src/banking_ratios';

const NOW = new Date('2026-05-23T12:00:00.000Z');

describe('catalog', () => {
  it('ALL_RATIO_CODES = 8 entries', () => {
    expect(ALL_RATIO_CODES).toEqual(['DSCR', 'ICR', 'CR', 'QR', 'DER', 'TOL_TNW', 'STK_TO', 'DBT_TO']);
  });
  it('RATIO_CATALOG covers every code', () => {
    expect(RATIO_CATALOG).toHaveLength(ALL_RATIO_CODES.length);
    for (const c of ALL_RATIO_CODES) expect(RATIO_BY_CODE[c]).toBeDefined();
  });
  it('isRatioCode + isCmaForm closed enums', () => {
    expect(isRatioCode('DSCR')).toBe(true);
    expect(isRatioCode('dscr')).toBe(false);
    expect(isCmaForm('II')).toBe(true);
    expect(isCmaForm('VI')).toBe(false);
  });
  it('ALL_CMA_FORMS = II/III/IV/V', () => {
    expect(ALL_CMA_FORMS).toEqual(['II', 'III', 'IV', 'V']);
  });
});

describe('buildCustomerRatios', () => {
  it('returns canonical envelope with all 8 ratios in current + history', () => {
    const out = buildCustomerRatios('BANK_DEMO', 'c-100001', {}, NOW);
    expect(out.tenant_id).toBe('BANK_DEMO');
    expect(out.customer_id).toBe('c-100001');
    for (const c of ALL_RATIO_CODES) {
      expect(out.current[c]).toBeDefined();
      expect(out.history[c]).toBeInstanceOf(Array);
      expect(out.history[c].length).toBeGreaterThan(0);
    }
    expect(['green', 'amber', 'red']).toContain(out.worst_band);
  });

  it('deterministic per (tenant, customer)', () => {
    const a = buildCustomerRatios('BANK_DEMO', 'c-100001', {}, NOW);
    const b = buildCustomerRatios('BANK_DEMO', 'c-100001', {}, NOW);
    for (const c of ALL_RATIO_CODES) {
      expect(a.current[c].value).toBe(b.current[c].value);
      expect(a.current[c].band).toBe(b.current[c].band);
    }
  });

  it('threshold override flips band to amber/red', () => {
    // DSCR is higher_is_better with default warning=1.5, critical=1.2.
    // Override to a much higher warning so the value lands in amber/red.
    const out = buildCustomerRatios(
      'BANK_DEMO',
      'c-100001',
      { DSCR: { warning: 999, critical: 998 } },
      NOW,
    );
    expect(out.current.DSCR.band).toBe('red');
  });

  it('worst_ratios contains only ratios in red band', () => {
    const out = buildCustomerRatios('BANK_DEMO', 'c-100001', {}, NOW);
    for (const c of out.worst_ratios) expect(out.current[c].band).toBe('red');
  });

  it('history length = 12 by default', () => {
    const out = buildCustomerRatios('BANK_DEMO', 'c-100001', {}, NOW);
    for (const c of ALL_RATIO_CODES) {
      expect(out.history[c]).toHaveLength(12);
    }
  });

  it('rejects empty tenant_id + customer_id', () => {
    expect(() => buildCustomerRatios('', 'c-1', {}, NOW)).toThrow(RatiosError);
    expect(() => buildCustomerRatios('BANK_DEMO', '', {}, NOW)).toThrow(RatiosError);
  });
});

describe('buildSectorBenchmark', () => {
  it('returns quarterly envelope with all 8 ratios', () => {
    const out = buildSectorBenchmark('BANK_DEMO', 'Manufacturing', NOW);
    expect(out.sector).toBe('Manufacturing');
    expect(out.as_of_quarter).toMatch(/^Q[1-4] \d{4}$/);
    expect(out.ratios).toHaveLength(ALL_RATIO_CODES.length);
    for (const r of out.ratios) {
      expect(typeof r.rbi_median).toBe('number');
      expect(r.sample_size).toBeGreaterThanOrEqual(50);
    }
  });

  it('rejects empty tenant or sector', () => {
    expect(() => buildSectorBenchmark('', 'X', NOW)).toThrow(RatiosError);
    expect(() => buildSectorBenchmark('BANK_DEMO', '', NOW)).toThrow(RatiosError);
  });
});

describe('InMemoryRatioThresholdStore', () => {
  it('list returns 8 entries (defaults) for never-touched tenant', () => {
    const s = new InMemoryRatioThresholdStore();
    const list = s.list('BANK_DEMO');
    expect(list).toHaveLength(8);
    expect(list.every((e) => e.is_default)).toBe(true);
  });

  it('set persists override + reads back via list + resolve', () => {
    const s = new InMemoryRatioThresholdStore();
    s.set('BANK_DEMO', 'DSCR', 2.0, 1.5, 'alice.admin', NOW);
    const entry = s.list('BANK_DEMO').find((e) => e.code === 'DSCR')!;
    expect(entry.warning).toBe(2.0);
    expect(entry.critical).toBe(1.5);
    expect(entry.is_default).toBe(false);
    expect(entry.updated_by).toBe('alice.admin');
    expect(s.resolve('BANK_DEMO').DSCR).toEqual({ warning: 2.0, critical: 1.5 });
  });

  it('reset clears override', () => {
    const s = new InMemoryRatioThresholdStore();
    s.set('BANK_DEMO', 'CR', 2.0, 1.5, 'alice', NOW);
    s.reset('BANK_DEMO', 'CR');
    const entry = s.list('BANK_DEMO').find((e) => e.code === 'CR')!;
    expect(entry.is_default).toBe(true);
  });

  it('set with non-finite throws', () => {
    const s = new InMemoryRatioThresholdStore();
    expect(() => s.set('BANK_DEMO', 'CR', NaN, 1, 'alice', NOW)).toThrow(RatiosError);
  });

  it('cross-tenant isolation', () => {
    const s = new InMemoryRatioThresholdStore();
    s.set('BANK_DEMO', 'CR', 2.5, 2.0, 'alice', NOW);
    expect(s.list('BIL').find((e) => e.code === 'CR')!.is_default).toBe(true);
  });
});

describe('buildCmaPack', () => {
  it('builds HTML for 1-customer cohort + all 4 forms', () => {
    const out = buildCmaPack(
      'BANK_DEMO',
      { cohort: ['c-100001'], forms: ['II', 'III', 'IV', 'V'] },
      'alice.admin',
      {},
      NOW,
    );
    expect(out.pack_id).toMatch(/^cma-BANK_DEMO-2026-05-23-[0-9a-f]+$/);
    expect(out.cohort_size).toBe(1);
    expect(out.forms).toEqual(['II', 'III', 'IV', 'V']);
    expect(out.html).toContain('CMA Pack');
    expect(out.html).toContain('Form II');
    expect(out.html).toContain('Form III');
    expect(out.html).toContain('Form IV');
    expect(out.html).toContain('Form V');
    expect(out.size_bytes).toBeGreaterThan(1000);
  });

  it('multi-customer cohort renders one article per customer', () => {
    const out = buildCmaPack(
      'BANK_DEMO',
      { cohort: ['c-100001', 'c-100002', 'c-100003'], forms: ['IV'] },
      'alice.admin',
      {},
      NOW,
    );
    expect(out.cohort_size).toBe(3);
    expect((out.html.match(/<article class="cma-customer"/g) || []).length).toBe(3);
  });

  it('rejects empty cohort + cohort > 50', () => {
    expect(() => buildCmaPack('BANK_DEMO', { cohort: [], forms: ['II'] }, 'a', {}, NOW)).toThrow(RatiosError);
    const big = new Array(51).fill('c-x');
    expect(() => buildCmaPack('BANK_DEMO', { cohort: big, forms: ['II'] }, 'a', {}, NOW)).toThrow(RatiosError);
  });

  it('rejects empty forms + unknown form', () => {
    expect(() => buildCmaPack('BANK_DEMO', { cohort: ['c-1'], forms: [] }, 'a', {}, NOW)).toThrow(RatiosError);
    expect(() => buildCmaPack('BANK_DEMO', { cohort: ['c-1'], forms: ['VI' as 'II'] }, 'a', {}, NOW)).toThrow(RatiosError);
  });

  it('rejects empty actor', () => {
    expect(() => buildCmaPack('BANK_DEMO', { cohort: ['c-1'], forms: ['II'] }, '', {}, NOW)).toThrow(RatiosError);
  });
});
