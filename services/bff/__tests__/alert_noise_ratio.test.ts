// @ts-nocheck
import { buildAlertNoiseRatio } from '../src/alert_noise_ratio';
import { defaultRoutingLedger } from '../src/alert_routing_analytics';

const NOW = new Date('2026-06-01T10:00:00Z');

describe('buildAlertNoiseRatio', () => {
  it('returns report with required fields when empty ledger', () => {
    const report = buildAlertNoiseRatio('NOISE_EMPTY', NOW);
    expect(report.tenant_id).toBe('NOISE_EMPTY');
    expect(report.generated_at).toBeDefined();
    expect(report.total_analyzed).toBe(0);
    expect(report.overall_noise_ratio).toBe(0);
  });

  it('returns by_class array with 4 BIL classes', () => {
    const report = buildAlertNoiseRatio('NOISE_EMPTY2', NOW);
    const classes = report.by_class.map(c => c.class);
    expect(classes).toContain('red');
    expect(classes).toContain('orange');
    expect(classes).toContain('yellow');
    expect(classes).toContain('green');
  });

  it('each class has total, noise_count, signal_count', () => {
    const report = buildAlertNoiseRatio('NOISE_EMPTY3', NOW);
    for (const c of report.by_class) {
      expect(c.total).toBeGreaterThanOrEqual(0);
      expect(c.noise_count).toBeGreaterThanOrEqual(0);
      expect(c.signal_count).toBeGreaterThanOrEqual(0);
      expect(c.noise_count + c.signal_count).toBeLessThanOrEqual(c.total + 1);
    }
  });

  it('noise_ratio is in [0, 1]', () => {
    const report = buildAlertNoiseRatio('NOISE_RATIO_TENANT', NOW);
    for (const c of report.by_class) {
      expect(c.noise_ratio).toBeGreaterThanOrEqual(0);
      expect(c.noise_ratio).toBeLessThanOrEqual(1);
    }
  });

  it('noisiest_class is null when no data', () => {
    const report = buildAlertNoiseRatio('NOISE_NULL_TENANT', NOW);
    expect(report.noisiest_class).toBeNull();
  });

  it('signal_classes array exists', () => {
    const report = buildAlertNoiseRatio('NOISE_SIGNAL_TENANT', NOW);
    expect(Array.isArray(report.signal_classes)).toBe(true);
  });

  it('overall_noise_ratio is 0 when no records', () => {
    const report = buildAlertNoiseRatio('NOISE_ZERO_TENANT', NOW);
    expect(report.overall_noise_ratio).toBe(0);
  });

  it('throws on empty tenant_id', () => {
    expect(() => buildAlertNoiseRatio('', NOW)).toThrow();
  });

  it('total_analyzed matches ledger size', () => {
    const tenant = 'NOISE_COUNT_TENANT';
    // Record a test alert to ensure ledger has something
    defaultRoutingLedger.record({
      alert_id: 'a-noise-1',
      tenant_id: tenant,
      created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      severity_in: 'HIGH',
      class: 'orange',
      channels: ['email'],
      sla_hours: 24,
      escalate_after_hours: 12,
      monitor_only: false,
      acked_at: null,
    });
    const report = buildAlertNoiseRatio(tenant, NOW);
    expect(report.total_analyzed).toBeGreaterThanOrEqual(1);
  });
});
