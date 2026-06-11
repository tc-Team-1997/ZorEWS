// @ts-nocheck
import { buildScoringPresetVariance } from '../src/scoring_preset_variance';
import { WEIGHT_PRESETS } from '../src/scoring_presets';

const NOW = new Date('2026-06-01T10:00:00Z');

describe('buildScoringPresetVariance', () => {
  it('returns report with required fields', () => {
    const report = buildScoringPresetVariance('BANK_DEMO', NOW);
    expect(report.tenant_id).toBe('BANK_DEMO');
    expect(report.generated_at).toBeDefined();
    expect(report.portfolio_size).toBe(20);
  });

  it('returns one entry per library preset', () => {
    const report = buildScoringPresetVariance('BANK_DEMO', NOW);
    expect(report.presets).toHaveLength(WEIGHT_PRESETS.length);
  });

  it('each preset entry has 20 scores', () => {
    const report = buildScoringPresetVariance('BANK_DEMO', NOW);
    for (const p of report.presets) {
      expect(p.scores).toHaveLength(20);
    }
  });

  it('all scores are in [0, 100]', () => {
    const report = buildScoringPresetVariance('BANK_DEMO', NOW);
    for (const p of report.presets) {
      for (const s of p.scores) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(100);
      }
    }
  });

  it('sorted by variance_coefficient desc', () => {
    const report = buildScoringPresetVariance('BANK_DEMO', NOW);
    for (let i = 1; i < report.presets.length; i++) {
      expect(report.presets[i].variance_coefficient).toBeLessThanOrEqual(
        report.presets[i - 1].variance_coefficient,
      );
    }
  });

  it('most_volatile_preset is first in sorted list', () => {
    const report = buildScoringPresetVariance('BANK_DEMO', NOW);
    if (report.presets.length > 0) {
      expect(report.most_volatile_preset).toBe(report.presets[0].preset_id);
    }
  });

  it('most_stable_preset is last in sorted list', () => {
    const report = buildScoringPresetVariance('BANK_DEMO', NOW);
    if (report.presets.length > 0) {
      expect(report.most_stable_preset).toBe(report.presets[report.presets.length - 1].preset_id);
    }
  });

  it('std_dev and mean_score are computed', () => {
    const report = buildScoringPresetVariance('BANK_DEMO', NOW);
    for (const p of report.presets) {
      expect(p.mean_score).toBeGreaterThanOrEqual(0);
      expect(p.std_dev).toBeGreaterThanOrEqual(0);
      expect(p.min_score).toBeLessThanOrEqual(p.max_score);
    }
  });

  it('throws on empty tenant_id', () => {
    expect(() => buildScoringPresetVariance('', NOW)).toThrow();
  });

  it('is deterministic', () => {
    const r1 = buildScoringPresetVariance('BANK_DEMO', NOW);
    const r2 = buildScoringPresetVariance('BANK_DEMO', NOW);
    expect(r1.most_volatile_preset).toBe(r2.most_volatile_preset);
  });
});
