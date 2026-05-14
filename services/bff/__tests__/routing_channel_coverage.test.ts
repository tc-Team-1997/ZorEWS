// services/bff/__tests__/routing_channel_coverage.test.ts
//
// T6 M8.9 — Alert routing channel transport coverage.

import request from 'supertest';
import {
  checkRoutingChannelCoverage,
  WIRED_CHANNELS,
} from '../src/routing_channel_coverage';
import {
  InMemoryAlertRoutingEngine,
  DEFAULT_RULES,
  type RoutingRule,
} from '../src/alert_routing';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── checkRoutingChannelCoverage — pure ──────────────────────────────

describe('M8.9 — WIRED_CHANNELS invariant', () => {
  test('only email/sms/push are wired (in_app is intentionally absent)', () => {
    expect(WIRED_CHANNELS.has('email')).toBe(true);
    expect(WIRED_CHANNELS.has('sms')).toBe(true);
    expect(WIRED_CHANNELS.has('push')).toBe(true);
    expect(WIRED_CHANNELS.has('in_app')).toBe(false);
  });
});

describe('M8.9 — empty rules', () => {
  test('zero rules → zero envelope + all_wired=true (vacuous truth)', () => {
    const r = checkRoutingChannelCoverage([]);
    expect(r.total_rules).toBe(0);
    expect(r.all_wired).toBe(true);
    expect(r.distinct_unwired_channels).toEqual([]);
  });
});

describe('M8.9 — defaults: orange + yellow use in_app', () => {
  test('default routing matrix → orange and yellow are partially wired', () => {
    const rules: RoutingRule[] = Object.values(DEFAULT_RULES);
    const r = checkRoutingChannelCoverage(rules);
    expect(r.total_rules).toBe(4);
    // red (email+sms) is fully wired.
    // orange (email+in_app) is partial.
    // yellow (email+in_app) is partial.
    // green (in_app) is fully unwired.
    expect(r.partially_wired_count).toBe(3);
    expect(r.fully_wired_count).toBe(1);
    expect(r.all_wired).toBe(false);
    expect(r.distinct_unwired_channels).toEqual(['in_app']);
  });
});

describe('M8.9 — fully-wired rule', () => {
  test('rule with only email+sms+push → fully wired', () => {
    const rule: RoutingRule = {
      class: 'red',
      primary_assignee: 'head_of_risk',
      secondary_assignee: null,
      channels: ['email', 'sms', 'push'],
      sla_hours: 4,
      escalate_after_hours: 1,
      monitor_only: false,
    };
    const r = checkRoutingChannelCoverage([rule]);
    expect(r.all_wired).toBe(true);
    expect(r.fully_wired_count).toBe(1);
    expect(r.partially_wired_count).toBe(0);
    expect(r.rules_with_unwired_channels).toEqual([]);
    expect(r.rules[0]!.has_unwired_channel).toBe(false);
    expect(r.rules[0]!.unwired_channels).toEqual([]);
  });
});

describe('M8.9 — per-rule channel status', () => {
  test('every channel surfaces with wired flag', () => {
    const rule: RoutingRule = {
      class: 'orange',
      primary_assignee: 'supervisor',
      secondary_assignee: null,
      channels: ['email', 'in_app', 'push'],
      sla_hours: 24,
      escalate_after_hours: 12,
      monitor_only: false,
    };
    const r = checkRoutingChannelCoverage([rule]);
    const statuses = r.rules[0]!.channels;
    expect(statuses).toHaveLength(3);
    expect(statuses.find((s) => s.channel === 'email')!.wired).toBe(true);
    expect(statuses.find((s) => s.channel === 'in_app')!.wired).toBe(false);
    expect(statuses.find((s) => s.channel === 'push')!.wired).toBe(true);
    expect(r.rules[0]!.unwired_channels).toEqual(['in_app']);
  });
});

describe('M8.9 — partition invariant', () => {
  test('fully_wired_count + partially_wired_count = total_rules', () => {
    const rules: RoutingRule[] = Object.values(DEFAULT_RULES);
    const r = checkRoutingChannelCoverage(rules);
    expect(r.fully_wired_count + r.partially_wired_count).toBe(r.total_rules);
  });
});

// ─── GET /v1/alerts/routing/channel-coverage ─────────────────────────

function makeCoverageApp(role = 'admin') {
  const alertRoutingEngine = new InMemoryAlertRoutingEngine();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    alertRoutingEngine,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, alertRoutingEngine };
}

describe('M8.9 — GET /v1/alerts/routing/channel-coverage', () => {
  test('admin → 200; defaults expose in_app gap', async () => {
    const { app } = makeCoverageApp('admin');
    const r = await request(app).get('/v1/alerts/routing/channel-coverage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_rules).toBe(4);
    expect(r.body.body.all_wired).toBe(false);
    expect(r.body.body.distinct_unwired_channels).toEqual(['in_app']);
  });

  test('override that removes in_app fully wires the rule', async () => {
    const { app, alertRoutingEngine } = makeCoverageApp('admin');
    alertRoutingEngine.setOverride('BIL', {
      ...DEFAULT_RULES.orange,
      channels: ['email', 'sms'],
    });
    const r = await request(app).get('/v1/alerts/routing/channel-coverage').set(TH_BIL);
    expect(r.status).toBe(200);
    const orange = r.body.body.rules.find(
      (rule: { class: string }) => rule.class === 'orange',
    );
    expect(orange.has_unwired_channel).toBe(false);
    // Still partially wired overall because yellow + green still have in_app.
    expect(r.body.body.all_wired).toBe(false);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCoverageApp('readonly');
    const r = await request(app).get('/v1/alerts/routing/channel-coverage').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL override invisible to BANK_DEMO', async () => {
    const { app, alertRoutingEngine } = makeCoverageApp('admin');
    alertRoutingEngine.setOverride('BIL', {
      ...DEFAULT_RULES.green,
      channels: ['email'],
    });
    const bil = await request(app).get('/v1/alerts/routing/channel-coverage').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/alerts/routing/channel-coverage')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.fully_wired_count).toBeGreaterThan(bank.body.body.fully_wired_count);
  });

  test('M8.2 /routing/rules still works', async () => {
    const { app } = makeCoverageApp('admin');
    const r = await request(app).get('/v1/alerts/routing/rules').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
