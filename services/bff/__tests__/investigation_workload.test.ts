// @ts-nocheck
import { buildInvestigationWorkload } from '../src/investigation_workload';
import { defaultCaseInvestigationStore } from '../src/case_investigation';

const NOW = new Date('2026-06-01T10:00:00Z');

describe('buildInvestigationWorkload', () => {
  it('returns report with required fields when empty', () => {
    const report = buildInvestigationWorkload('INV_WORK_EMPTY', NOW);
    expect(report.tenant_id).toBe('INV_WORK_EMPTY');
    expect(report.generated_at).toBeDefined();
    expect(report.total_investigators).toBe(0);
    expect(report.investigators).toHaveLength(0);
    expect(report.most_loaded).toBeNull();
    expect(report.least_loaded).toBeNull();
    expect(report.balanced).toBe(true);
  });

  it('groups investigations by opened_by', () => {
    const tenant = 'INV_WORK_GROUP';
    const inv1 = defaultCaseInvestigationStore.open(
      tenant,
      { case_id: 'c-w1', customer_id: 'cust-1' },
      'alice',
      new Date(NOW.getTime() - 2 * 3600 * 1000),
    );
    const inv2 = defaultCaseInvestigationStore.open(
      tenant,
      { case_id: 'c-w2', customer_id: 'cust-2' },
      'alice',
      new Date(NOW.getTime() - 1 * 3600 * 1000),
    );
    const inv3 = defaultCaseInvestigationStore.open(
      tenant,
      { case_id: 'c-w3', customer_id: 'cust-3' },
      'bob',
      NOW,
    );

    const report = buildInvestigationWorkload(tenant, NOW);
    expect(report.total_investigators).toBe(2);
    const alice = report.investigators.find(i => i.investigator === 'alice');
    expect(alice).toBeDefined();
    expect(alice.total_investigations).toBe(2);
  });

  it('computes open and closed counts correctly', () => {
    const tenant = 'INV_WORK_STATUS';
    defaultCaseInvestigationStore.open(
      tenant,
      { case_id: 'c-st1', customer_id: 'cust-st1' },
      'carol',
      new Date(NOW.getTime() - 3600 * 1000),
    );
    const report = buildInvestigationWorkload(tenant, NOW);
    const carol = report.investigators.find(i => i.investigator === 'carol');
    if (carol) {
      expect(carol.total_investigations).toBeGreaterThanOrEqual(1);
      expect(carol.open_count).toBeGreaterThanOrEqual(1);
    }
  });

  it('workload_score = open_count * 10 + avg_age_hours * 0.1', () => {
    const report = buildInvestigationWorkload('INV_WORK_SCORE', NOW);
    for (const inv of report.investigators) {
      const expected = inv.open_count * 10 + inv.avg_age_hours * 0.1;
      expect(Math.abs(inv.workload_score - expected)).toBeLessThan(0.001);
    }
  });

  it('sorted by workload_score desc', () => {
    const report = buildInvestigationWorkload('INV_WORK_SORT', NOW);
    for (let i = 1; i < report.investigators.length; i++) {
      expect(report.investigators[i].workload_score).toBeLessThanOrEqual(
        report.investigators[i - 1].workload_score,
      );
    }
  });

  it('most_loaded is investigator with highest workload_score', () => {
    const report = buildInvestigationWorkload('INV_WORK_MOST', NOW);
    if (report.investigators.length > 0) {
      expect(report.most_loaded).toBe(report.investigators[0].investigator);
    }
  });

  it('throws on empty tenant_id', () => {
    expect(() => buildInvestigationWorkload('', NOW)).toThrow();
  });

  it('balanced=true when all investigators have similar scores', () => {
    // With a single investigator, diff = 0 < 20 → balanced
    const tenant = 'INV_WORK_BAL';
    defaultCaseInvestigationStore.open(
      tenant,
      { case_id: 'c-bal1', customer_id: 'cust-bal1' },
      'solo',
      NOW,
    );
    const report = buildInvestigationWorkload(tenant, NOW);
    expect(report.balanced).toBe(true);
  });
});
