// @ts-nocheck
import { buildDashboardUsageRanking } from '../src/dashboard_usage_ranking';
import { defaultCustomDashboardStore } from '../src/custom_dashboards';

const NOW = new Date('2026-06-01T10:00:00Z');

let _col = 0;
const W = (id, type) => ({ widget_id: id, widget_type: type, position: { row: 0, col: (_col++ % 3) * 4 }, span: { rows: 2, cols: 4 }, config: {} });

describe('buildDashboardUsageRanking', () => {
  it('returns empty report when no dashboards', () => {
    const report = buildDashboardUsageRanking('RANK_EMPTY', NOW);
    expect(report.tenant_id).toBe('RANK_EMPTY');
    expect(report.total_dashboards).toBe(0);
    expect(report.rankings).toHaveLength(0);
    expect(report.active_count).toBe(0);
    expect(report.inactive_count).toBe(0);
  });

  it('ranks dashboards by usage_score desc', () => {
    const t = 'RANK_SORT';
    defaultCustomDashboardStore.create(t, { name: 'd1', description: '', widgets: [W('w1','alerts_by_class'), W('w2','open_cases'), W('w3','tenant_kpi')] }, 'alice', NOW);
    defaultCustomDashboardStore.create(t, { name: 'd2', description: '', widgets: [W('w4','alerts_by_class')] }, 'bob', NOW);
    const report = buildDashboardUsageRanking(t, NOW);
    expect(report.total_dashboards).toBe(2);
    const scores = report.rankings.map(r => r.usage_score);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);
  });

  it('ranks start at 1 and are sequential', () => {
    const t = 'RANK_SEQ';
    defaultCustomDashboardStore.create(t, { name: 'r1', description: '', widgets: [W('wr1','open_cases')] }, 'alice', NOW);
    const report = buildDashboardUsageRanking(t, NOW);
    const ranks = report.rankings.map(r => r.rank);
    for (let i = 0; i < ranks.length; i++) expect(ranks[i]).toBe(i + 1);
  });

  it('usage_tier is valid', () => {
    const report = buildDashboardUsageRanking('RANK_TIER', NOW);
    for (const r of report.rankings) {
      expect(['active', 'moderate', 'inactive']).toContain(r.usage_tier);
    }
  });

  it('active_count + inactive_count + moderate count = total', () => {
    const t = 'RANK_CNT';
    defaultCustomDashboardStore.create(t, { name: 'c1', description: '', widgets: [W('wc1','connector_health')] }, 'alice', NOW);
    const report = buildDashboardUsageRanking(t, NOW);
    const moderate = report.rankings.filter(r => r.usage_tier === 'moderate').length;
    expect(report.active_count + report.inactive_count + moderate).toBe(report.total_dashboards);
  });

  it('throws on empty tenant_id', () => {
    expect(() => buildDashboardUsageRanking('', NOW)).toThrow();
  });

  it('each ranking entry has required fields', () => {
    const t = 'RANK_FIELDS';
    defaultCustomDashboardStore.create(t, { name: 'f1', description: '', widgets: [W('wf1','audit_recent')] }, 'dave', NOW);
    const report = buildDashboardUsageRanking(t, NOW);
    for (const r of report.rankings) {
      expect(r.dashboard_id).toBeDefined();
      expect(r.name).toBeDefined();
      expect(typeof r.usage_score).toBe('number');
      expect(r.last_updated_days_ago).toBeGreaterThanOrEqual(0);
      expect(typeof r.widget_count).toBe('number');
      expect(r.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    const t = 'RANK_DET';
    defaultCustomDashboardStore.create(t, { name: 'det1', description: '', widgets: [W('wd1','top_breaches')] }, 'eve', NOW);
    const r1 = buildDashboardUsageRanking(t, NOW);
    const r2 = buildDashboardUsageRanking(t, NOW);
    expect(r1.total_dashboards).toBe(r2.total_dashboards);
  });
});
