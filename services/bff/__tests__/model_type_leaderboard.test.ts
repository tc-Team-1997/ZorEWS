// @ts-nocheck
import { buildModelTypeLeaderboard } from '../src/model_type_leaderboard';

const NOW = new Date('2026-06-01T10:00:00Z');

describe('buildModelTypeLeaderboard', () => {
  it('returns report with required fields', () => {
    const report = buildModelTypeLeaderboard('BANK_DEMO', NOW);
    expect(report.tenant_id).toBe('BANK_DEMO');
    expect(report.generated_at).toBeDefined();
    expect(Array.isArray(report.leaderboard)).toBe(true);
  });

  it('returns 6 entries for the 6 model types', () => {
    const report = buildModelTypeLeaderboard('BANK_DEMO', NOW);
    expect(report.leaderboard).toHaveLength(6);
  });

  it('ranks start at 1 and are sequential', () => {
    const report = buildModelTypeLeaderboard('BANK_DEMO', NOW);
    const ranks = report.leaderboard.map(e => e.rank);
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('each entry has required fields', () => {
    const report = buildModelTypeLeaderboard('BANK_DEMO', NOW);
    for (const e of report.leaderboard) {
      expect(e.type).toBeDefined();
      expect(['auc', 'mae']).toContain(e.metric_name);
      expect(['exceeds', 'meets', 'below', 'no_data']).toContain(e.status);
      expect(e.benchmark_value).toBeGreaterThan(0);
    }
  });

  it('types_without_production only contains types with no production model', () => {
    const report = buildModelTypeLeaderboard('BANK_DEMO', NOW);
    for (const type of report.types_without_production) {
      const entry = report.leaderboard.find(e => e.type === type);
      expect(entry).toBeDefined();
      expect(entry.model_id).toBeNull();
    }
  });

  it('all_meeting_benchmark is false when any entry has below/no_data status', () => {
    const report = buildModelTypeLeaderboard('BANK_DEMO', NOW);
    const has_below = report.leaderboard.some(e => e.status === 'below' || e.status === 'no_data');
    if (has_below) {
      expect(report.all_meeting_benchmark).toBe(false);
    }
  });

  it('is deterministic', () => {
    const r1 = buildModelTypeLeaderboard('BANK_DEMO', NOW);
    const r2 = buildModelTypeLeaderboard('BANK_DEMO', NOW);
    expect(r1.leaderboard.map(e => e.type)).toEqual(r2.leaderboard.map(e => e.type));
  });

  it('throws on empty tenant_id', () => {
    expect(() => buildModelTypeLeaderboard('', NOW)).toThrow();
  });

  it('metric_value is null for no_data entries', () => {
    const report = buildModelTypeLeaderboard('BANK_DEMO', NOW);
    for (const e of report.leaderboard) {
      if (e.status === 'no_data') {
        expect(e.metric_value).toBeNull();
      }
    }
  });
});
