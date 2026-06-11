// @ts-nocheck
// services/bff/__tests__/rule_firing_time_distribution.test.ts
// T6 M5.21 — Rule firing pattern by time of day.

import request from 'supertest';
import { buildRuleFiringTimeDistribution } from '../src/rule_firing_time_distribution';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryAuditTrailStore } from '../src/audit_trail';

const NOW = new Date('2026-05-20T15:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeAuditStore() {
  return new InMemoryAuditTrailStore();
}

function fakeApp(role = 'admin', store = makeAuditStore()) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore: store,
    getRole: () => role,
    now: () => NOW,
  });
}

function makeRuleFiredEvent(store, tenantId, hourUtc, extraFields = {}) {
  store.record(tenantId, {
    actor_username: 'system',
    actor_role: 'admin',
    action: 'rule.fired',
    resource_type: 'rule',
    resource_id: `rule-${Math.random().toString(36).slice(2)}`,
    outcome: 'success',
    severity: 'info',
    metadata: { rule_id: 'r1' },
    ...extraFields,
  }, new Date(`2026-05-20T${String(hourUtc).padStart(2, '0')}:00:00.000Z`));
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M5.21 — buildRuleFiringTimeDistribution — empty', () => {
  test('empty events → all zeros, 24 quiet_hours, null peak', () => {
    const out = buildRuleFiringTimeDistribution('BIL', [], NOW);
    expect(out.total_rule_fires).toBe(0);
    expect(out.by_hour).toHaveLength(24);
    expect(out.by_hour.every(b => b.count === 0)).toBe(true);
    expect(out.peak_hour).toBeNull();
    expect(out.quiet_hours).toHaveLength(24);
    expect(out.mean_fires_per_hour).toBe(0);
  });
});

describe('M5.21 — canonical hour order', () => {
  test('by_hour is in 0..23 order', () => {
    const out = buildRuleFiringTimeDistribution('BIL', [], NOW);
    for (let h = 0; h < 24; h++) {
      expect(out.by_hour[h].hour).toBe(h);
    }
  });
});

describe('M5.21 — single event placement', () => {
  test('event at 14:00 UTC places in bucket 14', () => {
    const store = makeAuditStore();
    makeRuleFiredEvent(store, 'BIL', 14);
    const events = store.list('BIL', {}).items;
    const out = buildRuleFiringTimeDistribution('BIL', events, NOW);
    expect(out.by_hour[14].count).toBe(1);
    expect(out.peak_hour).toBe(14);
    expect(out.total_rule_fires).toBe(1);
  });
});

describe('M5.21 — only rule.fired events counted', () => {
  test('config.update + other actions not counted', () => {
    const store = makeAuditStore();
    store.record('BIL', {
      actor_username: 'admin', actor_role: 'admin',
      action: 'config.update', resource_type: 'config',
      resource_id: 'key1', outcome: 'success', severity: 'info',
    }, new Date('2026-05-20T10:00:00.000Z'));
    makeRuleFiredEvent(store, 'BIL', 10);
    const events = store.list('BIL', {}).items;
    const out = buildRuleFiringTimeDistribution('BIL', events, NOW);
    expect(out.total_rule_fires).toBe(1);
    expect(out.by_hour[10].count).toBe(1);
  });
});

describe('M5.21 — peak_hour tie-break', () => {
  test('earlier hour wins at tied count', () => {
    const store = makeAuditStore();
    makeRuleFiredEvent(store, 'BIL', 5);
    makeRuleFiredEvent(store, 'BIL', 10);
    const events = store.list('BIL', {}).items;
    const out = buildRuleFiringTimeDistribution('BIL', events, NOW);
    expect(out.peak_hour).toBe(5);
  });
});

describe('M5.21 — pct sums to 1', () => {
  test('sum of pct across by_hour ≈ 1.0 when fires>0', () => {
    const store = makeAuditStore();
    makeRuleFiredEvent(store, 'BIL', 2);
    makeRuleFiredEvent(store, 'BIL', 10);
    makeRuleFiredEvent(store, 'BIL', 20);
    const events = store.list('BIL', {}).items;
    const out = buildRuleFiringTimeDistribution('BIL', events, NOW);
    const sum = out.by_hour.reduce((s, b) => s + b.pct, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });
});

describe('M5.21 — tenant scoping', () => {
  test('BANK_DEMO events not counted for BIL', () => {
    const store = makeAuditStore();
    makeRuleFiredEvent(store, 'BANK_DEMO', 10);
    const events = store.list('BANK_DEMO', {}).items;
    const out = buildRuleFiringTimeDistribution('BIL', events, NOW);
    expect(out.total_rule_fires).toBe(0);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M5.21 — route', () => {
  test('GET /v1/rules/firing-time-distribution → 200 with by_hour[24]', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/rules/firing-time-distribution')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.by_hour).toHaveLength(24);
    expect(typeof res.body.body.total_rule_fires).toBe('number');
  });

  test('403 for unknown role', async () => {
    const { app } = fakeApp('viewer');
    const res = await request(app)
      .get('/v1/rules/firing-time-distribution')
      .set(TH_BIL)
      .set('x-apex-role', 'viewer');
    expect(res.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/rules/firing-time-distribution')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
