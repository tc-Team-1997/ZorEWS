// @ts-nocheck
// T6 M5.28 — Rule conflict detection.

import request from 'supertest';
import { buildRuleConflictDetection } from '../src/rule_conflict_detection';
import { RuleStore } from '../src/rules/store';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeConflictApp(role = 'admin', store = new RuleStore()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, ruleStore: store });
  return app;
}

describe('M5.28 — empty rule store', () => {
  test('no rules → no conflicts', () => {
    const store = new RuleStore([]);
    const out = buildRuleConflictDetection('BIL', store, NOW);
    expect(out.total_live_rules).toBe(0);
    expect(out.conflicts).toEqual([]);
    expect(out.high_risk_count).toBe(0);
  });
});

describe('M5.28 — with seed rules', () => {
  test('returns valid envelope shape', () => {
    const store = new RuleStore();
    const out = buildRuleConflictDetection('BIL', store, NOW);
    expect(typeof out.total_live_rules).toBe('number');
    expect(Array.isArray(out.conflicts)).toBe(true);
    expect(typeof out.high_risk_count).toBe('number');
    expect(Array.isArray(out.recommendations)).toBe(true);
  });

  test('conflict_risk values are valid', () => {
    const store = new RuleStore();
    const out = buildRuleConflictDetection('BIL', store, NOW);
    for (const c of out.conflicts) {
      expect(['high', 'medium', 'low']).toContain(c.conflict_risk);
      expect(typeof c.rule_a_id).toBe('string');
      expect(typeof c.rule_b_id).toBe('string');
      expect(typeof c.reason).toBe('string');
    }
  });

  test('high_risk_count matches filter', () => {
    const store = new RuleStore();
    const out = buildRuleConflictDetection('BIL', store, NOW);
    const manual = out.conflicts.filter((c) => c.conflict_risk === 'high').length;
    expect(out.high_risk_count).toBe(manual);
  });

  test('no duplicate pairs (a+b and b+a)', () => {
    const store = new RuleStore();
    const out = buildRuleConflictDetection('BIL', store, NOW);
    const seen = new Set();
    for (const c of out.conflicts) {
      const key = [c.rule_a_id, c.rule_b_id].sort().join('|');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('M5.28 — route', () => {
  test('analyst GET /v1/rules/conflict-detection returns 200', async () => {
    const app = makeConflictApp('risk_analyst');
    const res = await request(app).get('/v1/rules/conflict-detection').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('conflicts');
  });

  test('non-allowed role gets 403', async () => {
    const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => 'unknown_role' });
    const res = await request(app).get('/v1/rules/conflict-detection').set(TH);
    expect(res.status).toBe(403);
  });
});
