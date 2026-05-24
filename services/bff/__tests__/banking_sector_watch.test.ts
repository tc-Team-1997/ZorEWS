// services/bff/__tests__/banking_sector_watch.test.ts

import {
  SECTOR_CODES,
  ALL_HEAT_LEVELS,
  buildSectorHeatmap,
  buildSectorDeepDive,
  listWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  _resetSectorWatchlist,
  SectorWatchError,
} from '../src/banking_sector_watch';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetSectorWatchlist());

describe('catalog', () => {
  it('SECTOR_CODES = 12 entries', () => {
    expect(SECTOR_CODES).toHaveLength(12);
    expect(SECTOR_CODES).toContain('Manufacturing');
    expect(SECTOR_CODES).toContain('Power');
  });
  it('ALL_HEAT_LEVELS = 4-value enum', () => {
    expect(ALL_HEAT_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
  });
});

describe('buildSectorHeatmap', () => {
  it('returns 12 cells with by_heat_level partition', () => {
    const out = buildSectorHeatmap('BANK_DEMO', NOW);
    expect(out.cells).toHaveLength(12);
    const sum = ALL_HEAT_LEVELS.reduce((a, lvl) => a + out.by_heat_level[lvl], 0);
    expect(sum).toBe(12);
  });

  it('cells sorted worst-first', () => {
    const out = buildSectorHeatmap('BANK_DEMO', NOW);
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < out.cells.length; i++) {
      const prev = rank[out.cells[i - 1].heat_level];
      const cur = rank[out.cells[i].heat_level];
      expect(prev).toBeLessThanOrEqual(cur);
    }
  });

  it('deterministic per (tenant, day)', () => {
    const a = buildSectorHeatmap('BANK_DEMO', NOW);
    const b = buildSectorHeatmap('BANK_DEMO', NOW);
    expect(a.cells[0].sector).toBe(b.cells[0].sector);
    expect(a.cells[0].npa_ratio_pct).toBe(b.cells[0].npa_ratio_pct);
  });

  it('different tenants → different scale', () => {
    const a = buildSectorHeatmap('BANK_DEMO', NOW);
    const b = buildSectorHeatmap('BIL', NOW);
    const aSum = a.cells.reduce((acc, c) => acc + c.total_outstanding_kes, 0);
    const bSum = b.cells.reduce((acc, c) => acc + c.total_outstanding_kes, 0);
    expect(aSum).not.toBe(bSum);
  });

  it('watchlist reflected in cells', () => {
    addToWatchlist('BANK_DEMO', 'Manufacturing');
    const out = buildSectorHeatmap('BANK_DEMO', NOW);
    const cell = out.cells.find((c) => c.sector === 'Manufacturing')!;
    expect(cell.is_watchlisted).toBe(true);
  });

  it('rejects empty tenant', () => {
    expect(() => buildSectorHeatmap('', NOW)).toThrow(SectorWatchError);
  });
});

describe('buildSectorDeepDive', () => {
  it('returns 12-month trend + top-5 + rules', () => {
    const out = buildSectorDeepDive('BANK_DEMO', 'Manufacturing', NOW);
    expect(out.sector).toBe('Manufacturing');
    expect(out.npa_trend_12m).toHaveLength(12);
    expect(out.top_at_risk_customers).toHaveLength(5);
    expect(out.contributing_rules).toHaveLength(5);
  });

  it('top customers sorted by pd desc', () => {
    const out = buildSectorDeepDive('BANK_DEMO', 'Manufacturing', NOW);
    for (let i = 1; i < out.top_at_risk_customers.length; i++) {
      expect(out.top_at_risk_customers[i - 1].pd).toBeGreaterThanOrEqual(out.top_at_risk_customers[i].pd);
    }
  });

  it('contributing rules sorted by firings desc', () => {
    const out = buildSectorDeepDive('BANK_DEMO', 'Manufacturing', NOW);
    for (let i = 1; i < out.contributing_rules.length; i++) {
      expect(out.contributing_rules[i - 1].firings_30d).toBeGreaterThanOrEqual(out.contributing_rules[i].firings_30d);
    }
  });

  it('rejects unknown sector', () => {
    // @ts-expect-error testing unknown
    expect(() => buildSectorDeepDive('BANK_DEMO', 'Bogus', NOW)).toThrow(SectorWatchError);
  });

  it('rejects empty tenant', () => {
    expect(() => buildSectorDeepDive('', 'Manufacturing', NOW)).toThrow(SectorWatchError);
  });
});

describe('watchlist CRUD', () => {
  it('empty by default', () => {
    expect(listWatchlist('BANK_DEMO')).toEqual([]);
  });

  it('add + list + remove round-trip', () => {
    addToWatchlist('BANK_DEMO', 'Power');
    addToWatchlist('BANK_DEMO', 'Textiles');
    expect(listWatchlist('BANK_DEMO').sort()).toEqual(['Power', 'Textiles']);
    removeFromWatchlist('BANK_DEMO', 'Power');
    expect(listWatchlist('BANK_DEMO')).toEqual(['Textiles']);
  });

  it('add unknown sector throws', () => {
    // @ts-expect-error testing unknown
    expect(() => addToWatchlist('BANK_DEMO', 'Bogus')).toThrow(SectorWatchError);
  });

  it('add idempotent', () => {
    addToWatchlist('BANK_DEMO', 'Power');
    addToWatchlist('BANK_DEMO', 'Power');
    expect(listWatchlist('BANK_DEMO')).toEqual(['Power']);
  });

  it('tenant scoping', () => {
    addToWatchlist('BANK_DEMO', 'Power');
    expect(listWatchlist('BIL')).toEqual([]);
  });
});
