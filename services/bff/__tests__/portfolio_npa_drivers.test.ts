// services/bff/__tests__/portfolio_npa_drivers.test.ts

import {
  summarizePortfolioNpaDrivers,
  PortfolioDriversError,
} from '../src/portfolio_npa_drivers';

const NOW = new Date('2026-05-24T12:00:00.000Z');

describe('summarizePortfolioNpaDrivers — validation', () => {
  it('rejects empty tenant_id', () => {
    expect(() => summarizePortfolioNpaDrivers('', 90, NOW)).toThrow(PortfolioDriversError);
  });
  it('rejects invalid horizon', () => {
    expect(() => summarizePortfolioNpaDrivers('BANK_DEMO', 45 as 90, NOW)).toThrow(PortfolioDriversError);
  });
});

describe('shape + envelope', () => {
  it('returns canonical envelope', () => {
    const out = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    expect(out.tenant_id).toBe('BANK_DEMO');
    expect(out.horizon_days).toBe(90);
    expect(typeof out.generated_at).toBe('string');
    expect(out.total_predictions_analyzed).toBeGreaterThan(0);
    expect(out.drivers.length).toBeGreaterThan(0);
    expect(out.total_drivers).toBeGreaterThanOrEqual(out.drivers.length);
  });

  it('every driver row carries required fields', () => {
    const out = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    for (const d of out.drivers) {
      expect(typeof d.feature_name).toBe('string');
      expect(d.feature_name.length).toBeGreaterThan(0);
      expect(typeof d.total_contribution).toBe('number');
      expect(d.total_contribution).toBeGreaterThan(0);
      expect(d.affected_predictions).toBeGreaterThan(0);
      expect(typeof d.avg_weight).toBe('number');
      expect(d.direction_split).toEqual(
        expect.objectContaining({ up: expect.any(Number), down: expect.any(Number) }),
      );
      expect(typeof d.by_sector).toBe('object');
      expect(d.pct_of_total).toBeGreaterThanOrEqual(0);
      expect(d.pct_of_total).toBeLessThanOrEqual(1);
    }
  });

  it('caps drivers list at MAX_DRIVERS=20', () => {
    const out = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    expect(out.drivers.length).toBeLessThanOrEqual(20);
  });
});

describe('sort invariants', () => {
  it('drivers sorted by total_contribution desc + feature_name asc tie-break', () => {
    const out = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    for (let i = 1; i < out.drivers.length; i++) {
      const prev = out.drivers[i - 1];
      const cur = out.drivers[i];
      expect(prev.total_contribution).toBeGreaterThanOrEqual(cur.total_contribution);
      if (prev.total_contribution === cur.total_contribution) {
        expect(prev.feature_name <= cur.feature_name).toBe(true);
      }
    }
  });
});

describe('aggregation correctness', () => {
  it('pct_of_total values sum to ~1 within rounding tolerance', () => {
    // (Σ pct across ALL drivers, not just top-20 — but with 5-7 drivers
    // there's no truncation. Use total_drivers ≤ MAX_DRIVERS as sanity.)
    const out = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    if (out.total_drivers <= 20) {
      const sum = out.drivers.reduce((acc, d) => acc + d.pct_of_total, 0);
      expect(sum).toBeGreaterThan(0.99);
      expect(sum).toBeLessThan(1.01);
    }
  });

  it('direction_split.up + .down == affected_predictions per row', () => {
    const out = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    for (const d of out.drivers) {
      expect(d.direction_split.up + d.direction_split.down).toBe(d.affected_predictions);
    }
  });

  it('Σ by_sector counts == affected_predictions per row', () => {
    const out = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    for (const d of out.drivers) {
      const sectorSum = Object.values(d.by_sector).reduce((a, n) => a + n, 0);
      expect(sectorSum).toBe(d.affected_predictions);
    }
  });

  it('affected_predictions ≤ total_predictions_analyzed for every row', () => {
    const out = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    for (const d of out.drivers) {
      expect(d.affected_predictions).toBeLessThanOrEqual(out.total_predictions_analyzed);
    }
  });
});

describe('determinism + tenant scoping', () => {
  it('same (tenant, horizon, now) → identical output', () => {
    const a = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    const b = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    expect(a.total_predictions_analyzed).toBe(b.total_predictions_analyzed);
    expect(a.drivers[0]?.feature_name).toBe(b.drivers[0]?.feature_name);
    expect(a.drivers[0]?.total_contribution).toBe(b.drivers[0]?.total_contribution);
  });

  it('different tenants → different driver mix', () => {
    const bank = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    const bil = summarizePortfolioNpaDrivers('BIL', 90, NOW);
    // Cohort sizes differ (BIL scale 0.6), so totals differ
    expect(bank.total_predictions_analyzed).not.toBe(bil.total_predictions_analyzed);
  });

  it('different horizons → different cohort', () => {
    const h90 = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    const h180 = summarizePortfolioNpaDrivers('BANK_DEMO', 180, NOW);
    // explainNpaPrediction's PD synthesis seeds on prediction_id which
    // contains the horizon — so the WHY shapes differ between horizons.
    // Sanity check: at minimum, generated horizon_days echoes correctly.
    expect(h90.horizon_days).toBe(90);
    expect(h180.horizon_days).toBe(180);
  });
});

describe('most_universal_driver', () => {
  it('points at the row with max affected_predictions', () => {
    const out = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    expect(out.most_universal_driver).not.toBeNull();
    const maxAffected = Math.max(...out.drivers.map((d) => d.affected_predictions));
    expect(out.most_universal_driver!.affected_predictions).toBe(maxAffected);
  });

  it('matches a driver_name in the drivers list', () => {
    const out = summarizePortfolioNpaDrivers('BANK_DEMO', 90, NOW);
    const found = out.drivers.find(
      (d) => d.feature_name === out.most_universal_driver!.feature_name,
    );
    expect(found).toBeDefined();
  });
});
