// services/bff/__tests__/banking_branch_heatmap.test.ts

import {
  ALL_REGIONS,
  ALL_HEAT_LEVELS,
  ALL_DIMENSIONS,
  BRANCHES,
  buildBranchHeatmap,
  buildBranchSummary,
  buildBranchDeepDive,
  BranchHeatmapError,
} from '../src/banking_branch_heatmap';

const NOW = new Date('2026-05-29T12:00:00.000Z');

describe('catalog + enums', () => {
  it('16 branches across all 6 regions', () => {
    expect(BRANCHES).toHaveLength(16);
    const regions = new Set(BRANCHES.map((b) => b.region));
    for (const r of ALL_REGIONS) expect(regions.has(r)).toBe(true);
  });
  it('branch ids unique', () => {
    expect(new Set(BRANCHES.map((b) => b.branch_id)).size).toBe(BRANCHES.length);
  });
  it('ALL_HEAT_LEVELS + ALL_DIMENSIONS closed enums', () => {
    expect(ALL_HEAT_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
    expect(ALL_DIMENSIONS).toEqual(['branch', 'region']);
  });
});

describe('buildBranchHeatmap — branch dimension', () => {
  it('returns one cell per branch with by_heat_level partition', () => {
    const hm = buildBranchHeatmap('BANK_DEMO', 'branch', NOW);
    expect(hm.dimension).toBe('branch');
    expect(hm.cells).toHaveLength(BRANCHES.length);
    const sum = ALL_HEAT_LEVELS.reduce((a, l) => a + hm.by_heat_level[l], 0);
    expect(sum).toBe(BRANCHES.length);
  });

  it('cells sorted worst-first (heat rank then npa desc)', () => {
    const hm = buildBranchHeatmap('BANK_DEMO', 'branch', NOW);
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < hm.cells.length; i++) {
      const prev = hm.cells[i - 1];
      const cur = hm.cells[i];
      expect(rank[prev.heat_level]).toBeLessThanOrEqual(rank[cur.heat_level]);
    }
  });

  it('branch cells carry city + null branch_count', () => {
    const hm = buildBranchHeatmap('BANK_DEMO', 'branch', NOW);
    for (const c of hm.cells) {
      expect(c.city).not.toBeNull();
      expect(c.branch_count).toBeNull();
      expect(ALL_REGIONS).toContain(c.region);
      expect(c.heat_level).toBe(
        c.npa_ratio_pct >= 8 ? 'critical' : c.npa_ratio_pct >= 5 ? 'high' : c.npa_ratio_pct >= 2.5 ? 'medium' : 'low',
      );
    }
  });

  it('deterministic per (tenant, day)', () => {
    expect(buildBranchHeatmap('BANK_DEMO', 'branch', NOW)).toEqual(buildBranchHeatmap('BANK_DEMO', 'branch', NOW));
  });

  it('BIL scaled below BANK_DEMO on total outstanding', () => {
    const bank = buildBranchHeatmap('BANK_DEMO', 'branch', NOW);
    const bil = buildBranchHeatmap('BIL', 'branch', NOW);
    const sum = (h: typeof bank) => h.cells.reduce((a, c) => a + c.total_outstanding_kes, 0);
    expect(sum(bil)).toBeLessThan(sum(bank));
  });
});

describe('buildBranchHeatmap — region dimension', () => {
  it('returns one cell per region with branch_count set', () => {
    const hm = buildBranchHeatmap('BANK_DEMO', 'region', NOW);
    expect(hm.dimension).toBe('region');
    expect(hm.cells).toHaveLength(ALL_REGIONS.length);
    for (const c of hm.cells) {
      expect(c.city).toBeNull();
      expect(c.branch_count).toBeGreaterThan(0);
    }
  });

  it('region branch_count sums to total branches', () => {
    const hm = buildBranchHeatmap('BANK_DEMO', 'region', NOW);
    const sum = hm.cells.reduce((a, c) => a + (c.branch_count ?? 0), 0);
    expect(sum).toBe(BRANCHES.length);
  });

  it('region customer total equals sum of its branch customers (reconciles with branch view)', () => {
    const day = NOW.toISOString().slice(0, 10);
    void day;
    const branchHm = buildBranchHeatmap('BANK_DEMO', 'branch', NOW);
    const regionHm = buildBranchHeatmap('BANK_DEMO', 'region', NOW);
    for (const region of ALL_REGIONS) {
      const branchSum = branchHm.cells
        .filter((c) => c.region === region)
        .reduce((a, c) => a + c.total_customers, 0);
      const regionCell = regionHm.cells.find((c) => c.id === region)!;
      expect(regionCell.total_customers).toBe(branchSum);
    }
  });

  it('region npa is customer-weighted (within branch min/max range)', () => {
    const branchHm = buildBranchHeatmap('BANK_DEMO', 'branch', NOW);
    const regionHm = buildBranchHeatmap('BANK_DEMO', 'region', NOW);
    for (const region of ALL_REGIONS) {
      const branchNpas = branchHm.cells.filter((c) => c.region === region).map((c) => c.npa_ratio_pct);
      const regionCell = regionHm.cells.find((c) => c.id === region)!;
      expect(regionCell.npa_ratio_pct).toBeGreaterThanOrEqual(Math.min(...branchNpas) - 0.01);
      expect(regionCell.npa_ratio_pct).toBeLessThanOrEqual(Math.max(...branchNpas) + 0.01);
    }
  });
});

describe('buildBranchSummary', () => {
  it('returns a single branch cell + generated_at', () => {
    const s = buildBranchSummary('BANK_DEMO', 'BR-W-01', NOW);
    expect(s.id).toBe('BR-W-01');
    expect(s.label).toBe('Mumbai Fort');
    expect(s.region).toBe('West');
    expect(s.generated_at).toBeTruthy();
  });
  it('unknown branch throws', () => {
    expect(() => buildBranchSummary('BANK_DEMO', 'BR-XX-99', NOW)).toThrow(BranchHeatmapError);
  });
});

describe('buildBranchDeepDive', () => {
  it('returns 12m trend + top customers + sector mix', () => {
    const d = buildBranchDeepDive('BANK_DEMO', 'BR-S-01', NOW);
    expect(d.branch_id).toBe('BR-S-01');
    expect(d.npa_trend_12m).toHaveLength(12);
    expect(d.top_at_risk_customers).toHaveLength(5);
    expect(d.sector_mix.length).toBeGreaterThan(0);
  });
  it('top customers sorted by PD desc', () => {
    const d = buildBranchDeepDive('BANK_DEMO', 'BR-S-01', NOW);
    for (let i = 1; i < d.top_at_risk_customers.length; i++) {
      expect(d.top_at_risk_customers[i - 1].pd).toBeGreaterThanOrEqual(d.top_at_risk_customers[i].pd);
    }
  });
  it('trend last point anchored to current npa', () => {
    const d = buildBranchDeepDive('BANK_DEMO', 'BR-S-01', NOW);
    expect(d.npa_trend_12m[11].npa_pct).toBe(d.npa_ratio_pct);
  });
  it('unknown branch throws', () => {
    expect(() => buildBranchDeepDive('BANK_DEMO', 'BR-XX-99', NOW)).toThrow(BranchHeatmapError);
  });
});

describe('validation', () => {
  it('empty tenant_id throws', () => {
    expect(() => buildBranchHeatmap('', 'branch', NOW)).toThrow(BranchHeatmapError);
  });
  it('invalid dimension throws', () => {
    expect(() => buildBranchHeatmap('BANK_DEMO', 'bogus' as never, NOW)).toThrow(BranchHeatmapError);
  });
});
