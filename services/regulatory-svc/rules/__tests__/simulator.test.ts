import * as path from 'node:path';
import * as fs from 'node:fs';
import { writeCsv } from '../src/gen_history';
import { loadHistory, simulateRule, buildReport, loadSeedRules } from '../src/simulator';
import { Rule } from '../../../../rules/types';

const HISTORY_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'rules', 'sim', 'indicator_history.csv');

beforeAll(() => {
  // ensure deterministic history exists for the simulator tests
  if (!fs.existsSync(HISTORY_PATH)) {
    writeCsv();
  }
});

describe('Simulator', () => {
  test('simulator is deterministic given fixed seed', () => {
    // re-generate twice and compare hash of first 50 chars of every line
    writeCsv();
    const a = fs.readFileSync(HISTORY_PATH, 'utf8');
    writeCsv();
    const b = fs.readFileSync(HISTORY_PATH, 'utf8');
    expect(a).toEqual(b);
  });

  test('history has at least 200 customers x 12 months', () => {
    const rows = loadHistory();
    const customers = new Set(rows.map((r) => r.customer_id));
    expect(customers.size).toBeGreaterThanOrEqual(200);
    expect(rows.length).toBeGreaterThanOrEqual(200 * 12);
  });

  test('simulateRule returns sane stats for an obvious rule', () => {
    const rule: Rule = {
      id: 'RULE-880',
      version: 1,
      status: 'draft',
      severity: 'critical',
      description: 'IFRS 9 stage migration test',
      when: { indicator: 'CRD-005', op: 'gte', value: 1 },
      then: { title: 'Test alert', recommended_action: 'Test action' },
    };
    const rows = loadHistory();
    const r = simulateRule(rule, rows);
    expect(r.total_firings).toBeGreaterThan(0);
    // FP rate should be well within target on this clean signal
    expect(r.fp_rate).toBeLessThanOrEqual(0.4);
  });

  test('seed rules pass schema and produce a report', () => {
    const seeds = loadSeedRules();
    expect(seeds.length).toBeGreaterThanOrEqual(25);
    const rows = loadHistory();
    const report = buildReport(seeds, rows);
    expect(report.rules_simulated).toBe(seeds.length);
    expect(report.mean_fp_rate).toBeLessThanOrEqual(0.25);
  });
});
