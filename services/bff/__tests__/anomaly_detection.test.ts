// services/bff/__tests__/anomaly_detection.test.ts

import {
  ANOMALY_PATTERNS,
  ALL_ANOMALY_STATUSES,
  isAnomalyStatus,
  isAnomalyPattern,
  listAnomalies,
  getAnomaly,
  getPatternConfig,
  setPatternConfig,
  triggerAnomalyRerun,
  _resetAnomalyStore,
  AnomalyError,
} from '../src/anomaly_detection';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetAnomalyStore());

describe('enums', () => {
  it('ANOMALY_PATTERNS has 8 entries', () => {
    expect(ANOMALY_PATTERNS).toHaveLength(8);
  });
  it('ALL_ANOMALY_STATUSES has 5 entries', () => {
    expect(ALL_ANOMALY_STATUSES).toEqual(['open', 'acknowledged', 'investigating', 'resolved', 'false_positive']);
  });
  it('type guards', () => {
    expect(isAnomalyStatus('open')).toBe(true);
    expect(isAnomalyStatus('bogus')).toBe(false);
    expect(isAnomalyPattern('txn_volume_spike')).toBe(true);
    expect(isAnomalyPattern('bogus')).toBe(false);
  });
});

describe('listAnomalies', () => {
  it('returns canonical envelope on first call (auto-seeded)', () => {
    const out = listAnomalies('BANK_DEMO', {}, NOW);
    expect(out.tenant_id).toBe('BANK_DEMO');
    expect(out.total).toBeGreaterThan(0);
    expect(out.anomalies.length).toBe(out.total);
    expect(out.by_severity).toEqual(expect.objectContaining({ low: expect.any(Number), medium: expect.any(Number), high: expect.any(Number), critical: expect.any(Number) }));
  });

  it('sorted by severity then score desc', () => {
    const out = listAnomalies('BANK_DEMO', {}, NOW);
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < out.anomalies.length; i++) {
      const prev = rank[out.anomalies[i - 1].severity];
      const cur = rank[out.anomalies[i].severity];
      expect(prev).toBeLessThanOrEqual(cur);
      if (prev === cur) {
        expect(out.anomalies[i - 1].anomaly_score).toBeGreaterThanOrEqual(out.anomalies[i].anomaly_score);
      }
    }
  });

  it('filter by pattern narrows result', () => {
    const all = listAnomalies('BANK_DEMO', {}, NOW);
    const onePattern = all.anomalies[0].pattern;
    const filtered = listAnomalies('BANK_DEMO', { pattern: onePattern }, NOW);
    expect(filtered.anomalies.every((a) => a.pattern === onePattern)).toBe(true);
  });

  it('filter by severity', () => {
    const out = listAnomalies('BANK_DEMO', { severity: 'critical' }, NOW);
    expect(out.anomalies.every((a) => a.severity === 'critical')).toBe(true);
  });

  it('by_status partition equals total', () => {
    const out = listAnomalies('BANK_DEMO', {}, NOW);
    const sum = Object.values(out.by_status).reduce((a, n) => a + n, 0);
    expect(sum).toBe(out.total);
  });

  it('tenant scoping', () => {
    const a = listAnomalies('BANK_DEMO', {}, NOW);
    const b = listAnomalies('BIL', {}, NOW);
    expect(a.anomalies[0].anomaly_id).not.toBe(b.anomalies[0].anomaly_id);
  });

  it('rejects empty tenant', () => {
    expect(() => listAnomalies('', {}, NOW)).toThrow(AnomalyError);
  });
});

describe('getAnomaly', () => {
  it('hit returns same shape', () => {
    const list = listAnomalies('BANK_DEMO', {}, NOW);
    const fetched = getAnomaly('BANK_DEMO', list.anomalies[0].anomaly_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.anomaly_id).toBe(list.anomalies[0].anomaly_id);
  });

  it('cross-tenant returns null', () => {
    const list = listAnomalies('BANK_DEMO', {}, NOW);
    expect(getAnomaly('BIL', list.anomalies[0].anomaly_id)).toBeNull();
  });
});

describe('pattern config', () => {
  it('default config has all patterns enabled', () => {
    const out = getPatternConfig('BANK_DEMO');
    expect(out).toHaveLength(8);
    expect(out.every((p) => p.enabled)).toBe(true);
    expect(out.every((p) => p.threshold === 0.7)).toBe(true);
  });

  it('set threshold + disable persists', () => {
    setPatternConfig('BANK_DEMO', [{ pattern: 'geo_velocity', threshold: 0.5, enabled: false }], 'alice');
    const out = getPatternConfig('BANK_DEMO');
    const geo = out.find((p) => p.pattern === 'geo_velocity')!;
    expect(geo.enabled).toBe(false);
    expect(geo.threshold).toBe(0.5);
  });

  it('threshold out of range rejected', () => {
    expect(() => setPatternConfig('BANK_DEMO', [{ pattern: 'geo_velocity', threshold: 1.5 }], 'alice')).toThrow(AnomalyError);
    expect(() => setPatternConfig('BANK_DEMO', [{ pattern: 'geo_velocity', threshold: -0.1 }], 'alice')).toThrow(AnomalyError);
  });

  it('unknown pattern rejected', () => {
    // @ts-expect-error test unknown
    expect(() => setPatternConfig('BANK_DEMO', [{ pattern: 'bogus', threshold: 0.5 }], 'alice')).toThrow(AnomalyError);
  });

  it('actor required', () => {
    expect(() => setPatternConfig('BANK_DEMO', [{ pattern: 'geo_velocity', threshold: 0.5 }], '')).toThrow(AnomalyError);
  });
});

describe('triggerAnomalyRerun', () => {
  it('returns run summary with new anomalies', () => {
    const out = triggerAnomalyRerun('BANK_DEMO', 'alice', NOW);
    expect(out.run_id).toMatch(/^run-BANK_DEMO-\d{8}-\d{4}$/);
    expect(out.new_anomalies).toBeGreaterThan(0);
    expect(out.patterns_evaluated).toBe(ANOMALY_PATTERNS.length);
    expect(out.scanned_records).toBeGreaterThan(0);
  });

  it('new anomalies appear in list', () => {
    triggerAnomalyRerun('BANK_DEMO', 'alice', NOW);
    const list = listAnomalies('BANK_DEMO', {}, NOW);
    expect(list.anomalies.some((a) => a.anomaly_id.includes('rerun'))).toBe(true);
  });

  it('rejects empty actor', () => {
    expect(() => triggerAnomalyRerun('BANK_DEMO', '', NOW)).toThrow(AnomalyError);
  });
});
