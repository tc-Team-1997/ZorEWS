// services/bff/__tests__/alert_routing_preview.test.ts
//
// T6 M8.7 — Alert routing decision preview.

import request from 'supertest';
import { previewAlertRouting } from '../src/alert_routing_preview';
import { InMemoryAlertRoutingEngine } from '../src/alert_routing';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── previewAlertRouting — pure ──────────────────────────────────────

describe('M8.7 — previewAlertRouting — red class (default rule)', () => {
  test('red → primary head_of_risk + secondary supervisor across email + sms', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const out = previewAlertRouting(engine, 'BIL', 'CRITICAL', NOW);
    expect(out.class).toBe('red');
    expect(out.source).toBe('platform_default');
    expect(out.monitor_only).toBe(false);
    expect(out.rule.primary_assignee).toBe('head_of_risk');
    // Default red SLA is 4h, escalation 1h.
    expect(out.sla_deadline).toBe('2026-05-14T16:00:00.000Z');
    expect(out.escalation_deadline).toBe('2026-05-14T13:00:00.000Z');
    // Chain: 2 channels × primary + 2 channels × secondary = 4 links.
    expect(out.notifications_chain.length).toBe(4);
    expect(out.notifications_chain[0]).toEqual({
      step_no: 1,
      channel: 'email',
      assignee_role: 'head_of_risk',
      tier: 'primary',
    });
    expect(out.notifications_chain[1]).toEqual({
      step_no: 2,
      channel: 'sms',
      assignee_role: 'head_of_risk',
      tier: 'primary',
    });
    expect(out.notifications_chain[2]).toEqual({
      step_no: 3,
      channel: 'email',
      assignee_role: 'supervisor',
      tier: 'secondary',
    });
    expect(out.notifications_chain[3]).toEqual({
      step_no: 4,
      channel: 'sms',
      assignee_role: 'supervisor',
      tier: 'secondary',
    });
  });
});

describe('M8.7 — previewAlertRouting — orange + yellow', () => {
  test('orange → primary supervisor + secondary analyst, SLA 24h escalate 12h', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const out = previewAlertRouting(engine, 'BIL', 'HIGH', NOW);
    expect(out.class).toBe('orange');
    expect(out.sla_deadline).toBe('2026-05-15T12:00:00.000Z');
    expect(out.escalation_deadline).toBe('2026-05-15T00:00:00.000Z');
    expect(out.notifications_chain.map((l) => l.tier)).toEqual([
      'primary',
      'primary',
      'secondary',
      'secondary',
    ]);
  });

  test('yellow → primary analyst, NO secondary tier (null in default rule)', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const out = previewAlertRouting(engine, 'BIL', 'MEDIUM', NOW);
    expect(out.class).toBe('yellow');
    expect(out.rule.secondary_assignee).toBeNull();
    // 2 channels × 1 primary = 2 links, no secondary tier.
    expect(out.notifications_chain.length).toBe(2);
    expect(out.notifications_chain.every((l) => l.tier === 'primary')).toBe(true);
  });
});

describe('M8.7 — previewAlertRouting — green (monitor-only)', () => {
  test('green class → all deadline fields null, empty notification chain', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const out = previewAlertRouting(engine, 'BIL', 'LOW', NOW);
    expect(out.class).toBe('green');
    expect(out.monitor_only).toBe(true);
    expect(out.sla_deadline).toBeNull();
    expect(out.escalation_deadline).toBeNull();
    // primary='none' for green → no chain links.
    expect(out.notifications_chain).toEqual([]);
  });
});

describe('M8.7 — previewAlertRouting — tenant override', () => {
  test('tenant override is reflected in source + the chain it produces', () => {
    const engine = new InMemoryAlertRoutingEngine();
    engine.setOverride('BIL', {
      class: 'orange',
      primary_assignee: 'head_of_risk',
      secondary_assignee: null,
      channels: ['email'],
      sla_hours: 6, // tighter than default 24
      escalate_after_hours: 2,
      monitor_only: false,
    });
    const out = previewAlertRouting(engine, 'BIL', 'HIGH', NOW);
    expect(out.source).toBe('tenant_override');
    expect(out.sla_deadline).toBe('2026-05-14T18:00:00.000Z'); // +6h
    expect(out.escalation_deadline).toBe('2026-05-14T14:00:00.000Z'); // +2h
    // Single channel × head_of_risk primary; no secondary.
    expect(out.notifications_chain).toEqual([
      {
        step_no: 1,
        channel: 'email',
        assignee_role: 'head_of_risk',
        tier: 'primary',
      },
    ]);
  });
});

describe('M8.7 — previewAlertRouting — custom `at`', () => {
  test('custom `at` propagates to all deadline + applied_at fields', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const custom = new Date('2027-01-01T00:00:00.000Z');
    const out = previewAlertRouting(engine, 'BIL', 'CRITICAL', custom);
    expect(out.applied_at).toBe('2027-01-01T00:00:00.000Z');
    // Red default SLA 4h → 2027-01-01T04:00.
    expect(out.sla_deadline).toBe('2027-01-01T04:00:00.000Z');
  });
});

// ─── POST /v1/alerts/routing/preview ─────────────────────────────────

function makePreviewApp(role = 'admin', engine?: InMemoryAlertRoutingEngine) {
  const alertRoutingEngine = engine ?? new InMemoryAlertRoutingEngine();
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

describe('M8.7 — POST /v1/alerts/routing/preview', () => {
  test('200 with full preview envelope', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/alerts/routing/preview')
      .set(TH_BIL)
      .send({ severity: 'CRITICAL' });
    expect(r.status).toBe(200);
    expect(r.body.body.class).toBe('red');
    expect(r.body.body.applied_at).toBe(NOW.toISOString());
    expect(r.body.body.sla_deadline).toBe('2026-05-14T16:00:00.000Z');
    expect(r.body.body.notifications_chain.length).toBeGreaterThan(0);
  });

  test('?body.at honoured', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/alerts/routing/preview')
      .set(TH_BIL)
      .send({ severity: 'HIGH', at: '2027-01-01T00:00:00Z' });
    expect(r.status).toBe(200);
    expect(r.body.body.applied_at).toBe('2027-01-01T00:00:00.000Z');
    expect(r.body.body.sla_deadline).toBe('2027-01-02T00:00:00.000Z');
  });

  test('missing severity → 400', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/alerts/routing/preview')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });

  test('invalid severity → 400 (classification error)', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/alerts/routing/preview')
      .set(TH_BIL)
      .send({ severity: 'BANANAS' });
    expect(r.status).toBe(400);
  });

  test('invalid at → 400', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/alerts/routing/preview')
      .set(TH_BIL)
      .send({ severity: 'HIGH', at: 'not-a-date' });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePreviewApp('case_owner');
    const r = await request(app)
      .post('/v1/alerts/routing/preview')
      .set(TH_BIL)
      .send({ severity: 'HIGH' });
    expect(r.status).toBe(403);
  });

  test('tenant_override resolves correctly through the route', async () => {
    const engine = new InMemoryAlertRoutingEngine();
    engine.setOverride('BIL', {
      class: 'red',
      primary_assignee: 'head_of_risk',
      secondary_assignee: 'analyst',
      channels: ['email'],
      sla_hours: 2,
      escalate_after_hours: 1,
      monitor_only: false,
    });
    const { app } = makePreviewApp('admin', engine);
    const r = await request(app)
      .post('/v1/alerts/routing/preview')
      .set(TH_BIL)
      .send({ severity: 'CRITICAL' });
    expect(r.status).toBe(200);
    expect(r.body.body.source).toBe('tenant_override');
    expect(r.body.body.rule.sla_hours).toBe(2);
    expect(r.body.body.sla_deadline).toBe('2026-05-14T14:00:00.000Z');
  });

  test('cross-tenant: BANK_DEMO sees its own (platform default), not BIL\'s override', async () => {
    const engine = new InMemoryAlertRoutingEngine();
    engine.setOverride('BIL', {
      class: 'orange',
      primary_assignee: 'head_of_risk',
      secondary_assignee: null,
      channels: ['email'],
      sla_hours: 1,
      escalate_after_hours: null,
      monitor_only: false,
    });
    const { app } = makePreviewApp('admin', engine);
    const r = await request(app)
      .post('/v1/alerts/routing/preview')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send({ severity: 'HIGH' });
    expect(r.status).toBe(200);
    expect(r.body.body.source).toBe('platform_default');
    // Default orange SLA 24h, not the override's 1h.
    expect(r.body.body.rule.sla_hours).toBe(24);
  });
});
