// services/bff/__tests__/alert_routing.test.ts
//
// T6 M8.2 — Alert auto-routing per BIL class.

import request from 'supertest';
import {
  AlertRoutingError,
  DEFAULT_RULES,
  InMemoryAlertRoutingEngine,
  isAssigneeRole,
  isNotificationChannel,
  validateRule,
  type RoutingRule,
} from '../src/alert_routing';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeRtgApp(role: string = 'admin', alertRoutingEngine?: InMemoryAlertRoutingEngine) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    alertRoutingEngine: alertRoutingEngine ?? new InMemoryAlertRoutingEngine(),
  });
}

// ─── Type guards ───────────────────────────────────────────────────────

describe('Type guards', () => {
  test('isNotificationChannel', () => {
    expect(isNotificationChannel('email')).toBe(true);
    expect(isNotificationChannel('sms')).toBe(true);
    expect(isNotificationChannel('in_app')).toBe(true);
    expect(isNotificationChannel('push')).toBe(true);
    expect(isNotificationChannel('SMS')).toBe(false);
    expect(isNotificationChannel('fax')).toBe(false);
  });
  test('isAssigneeRole', () => {
    expect(isAssigneeRole('head_of_risk')).toBe(true);
    expect(isAssigneeRole('supervisor')).toBe(true);
    expect(isAssigneeRole('analyst')).toBe(true);
    expect(isAssigneeRole('none')).toBe(true);
    expect(isAssigneeRole('admin')).toBe(false);
  });
});

// ─── DEFAULT_RULES schema ──────────────────────────────────────────────

describe('DEFAULT_RULES — BIL §11 escalation matrix', () => {
  test('red has 4h SLA, 1h escalation, head_of_risk + supervisor, email + sms', () => {
    const r = DEFAULT_RULES.red;
    expect(r.sla_hours).toBe(4);
    expect(r.escalate_after_hours).toBe(1);
    expect(r.primary_assignee).toBe('head_of_risk');
    expect(r.secondary_assignee).toBe('supervisor');
    expect(r.channels).toEqual(['email', 'sms']);
    expect(r.monitor_only).toBe(false);
  });

  test('orange has 24h SLA, supervisor + analyst, email + in_app', () => {
    const r = DEFAULT_RULES.orange;
    expect(r.sla_hours).toBe(24);
    expect(r.primary_assignee).toBe('supervisor');
    expect(r.secondary_assignee).toBe('analyst');
    expect(r.channels).toContain('in_app');
  });

  test('yellow has 72h SLA, analyst, no secondary', () => {
    const r = DEFAULT_RULES.yellow;
    expect(r.sla_hours).toBe(72);
    expect(r.primary_assignee).toBe('analyst');
    expect(r.secondary_assignee).toBeNull();
  });

  test('green is monitor-only with null SLA + null escalation', () => {
    const r = DEFAULT_RULES.green;
    expect(r.monitor_only).toBe(true);
    expect(r.sla_hours).toBeNull();
    expect(r.escalate_after_hours).toBeNull();
    expect(r.primary_assignee).toBe('none');
  });

  test('escalation < SLA invariant for non-monitor-only classes', () => {
    for (const c of ['red', 'orange', 'yellow'] as const) {
      const r = DEFAULT_RULES[c];
      expect(r.escalate_after_hours!).toBeLessThan(r.sla_hours!);
    }
  });

  test('SLA hours strictly increasing red < orange < yellow', () => {
    expect(DEFAULT_RULES.red.sla_hours!).toBeLessThan(DEFAULT_RULES.orange.sla_hours!);
    expect(DEFAULT_RULES.orange.sla_hours!).toBeLessThan(DEFAULT_RULES.yellow.sla_hours!);
  });
});

// ─── validateRule ──────────────────────────────────────────────────────

describe('validateRule', () => {
  function base(): RoutingRule {
    return {
      class: 'orange',
      primary_assignee: 'supervisor',
      secondary_assignee: 'analyst',
      channels: ['email', 'in_app'],
      sla_hours: 24,
      escalate_after_hours: 12,
      monitor_only: false,
    };
  }

  test('happy path returns the validated rule', () => {
    expect(validateRule(base())).toEqual(base());
  });

  test('missing class throws invalid_class', () => {
    const { class: _, ...rest } = base();
    expect(() => validateRule(rest)).toThrow(/class must be/);
  });

  test('invalid primary_assignee throws invalid_assignee', () => {
    const r = base();
    (r as Partial<RoutingRule>).primary_assignee = 'admin' as never;
    expect(() => validateRule(r)).toThrow(/primary_assignee/);
  });

  test('empty channels throws invalid_channels', () => {
    expect(() => validateRule({ ...base(), channels: [] })).toThrow(/non-empty/);
  });

  test('invalid channel throws invalid_channels', () => {
    expect(() => validateRule({ ...base(), channels: ['email', 'fax' as never] })).toThrow(
      /invalid channel/,
    );
  });

  test('escalate_after_hours >= sla_hours throws invalid_escalation', () => {
    expect(() => validateRule({ ...base(), escalate_after_hours: 24 })).toThrow(
      /must be < sla_hours/,
    );
  });

  test('monitor_only=true with non-null sla throws', () => {
    expect(() =>
      validateRule({
        ...base(),
        monitor_only: true,
        sla_hours: null,
        escalate_after_hours: 5,
      }),
    ).toThrow(/monitor_only=true/);
  });

  test('monitor_only=true valid: null SLA + null escalation', () => {
    const r = validateRule({
      class: 'green',
      primary_assignee: 'none',
      secondary_assignee: null,
      channels: ['in_app'],
      sla_hours: null,
      escalate_after_hours: null,
      monitor_only: true,
    });
    expect(r.monitor_only).toBe(true);
  });

  test('error code surfaced via AlertRoutingError', () => {
    try {
      validateRule({ ...base(), class: 'foo' as never });
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AlertRoutingError);
      expect((e as AlertRoutingError).code).toBe('invalid_class');
    }
  });
});

// ─── Engine — route + listRules + getRule ──────────────────────────────

describe('InMemoryAlertRoutingEngine — route', () => {
  test('CRITICAL → red rule', () => {
    const e = new InMemoryAlertRoutingEngine();
    const d = e.route('BIL', 'CRITICAL');
    expect(d.class).toBe('red');
    expect(d.severity_in).toBe('CRITICAL');
    expect(d.rule).toEqual(DEFAULT_RULES.red);
    expect(d.source).toBe('platform_default');
  });

  test('all 4 severities → matching default class rules', () => {
    const e = new InMemoryAlertRoutingEngine();
    expect(e.route('BIL', 'HIGH').class).toBe('orange');
    expect(e.route('BIL', 'MEDIUM').class).toBe('yellow');
    expect(e.route('BIL', 'LOW').class).toBe('green');
  });

  test('lowercase severities accepted (UiSeverity shape)', () => {
    const e = new InMemoryAlertRoutingEngine();
    expect(e.route('BIL', 'critical').class).toBe('red');
  });
});

describe('InMemoryAlertRoutingEngine — listRules + getRule', () => {
  test('listRules returns 4 rules in canonical order', () => {
    const e = new InMemoryAlertRoutingEngine();
    const rules = e.listRules('BIL');
    expect(rules.map((r) => r.class)).toEqual(['red', 'orange', 'yellow', 'green']);
  });

  test('getRule returns platform_default before any override', () => {
    const e = new InMemoryAlertRoutingEngine();
    const out = e.getRule('BIL', 'red');
    expect(out.source).toBe('platform_default');
    expect(out.rule).toEqual(DEFAULT_RULES.red);
  });
});

// ─── Engine — setOverride + clearOverride ──────────────────────────────

describe('InMemoryAlertRoutingEngine — overrides', () => {
  test('setOverride validates + persists; getRule reflects tenant_override', () => {
    const e = new InMemoryAlertRoutingEngine();
    e.setOverride('BIL', {
      class: 'red',
      primary_assignee: 'head_of_risk',
      secondary_assignee: 'supervisor',
      channels: ['email', 'sms', 'push'],
      sla_hours: 2, // BIL tightens to 2h
      escalate_after_hours: 1,
      monitor_only: false,
    });
    const out = e.getRule('BIL', 'red');
    expect(out.source).toBe('tenant_override');
    expect(out.rule.sla_hours).toBe(2);
    expect(out.rule.channels).toEqual(['email', 'sms', 'push']);
  });

  test('route() picks up the override', () => {
    const e = new InMemoryAlertRoutingEngine();
    e.setOverride('BIL', {
      class: 'red',
      primary_assignee: 'head_of_risk',
      secondary_assignee: null,
      channels: ['email'],
      sla_hours: 1,
      escalate_after_hours: null,
      monitor_only: false,
    });
    const d = e.route('BIL', 'CRITICAL');
    expect(d.source).toBe('tenant_override');
    expect(d.rule.sla_hours).toBe(1);
  });

  test('clearOverride reverts to platform_default', () => {
    const e = new InMemoryAlertRoutingEngine();
    e.setOverride('BIL', {
      class: 'red',
      primary_assignee: 'head_of_risk',
      secondary_assignee: null,
      channels: ['email'],
      sla_hours: 2,
      escalate_after_hours: 1,
      monitor_only: false,
    });
    e.clearOverride('BIL', 'red');
    expect(e.getRule('BIL', 'red').source).toBe('platform_default');
  });

  test('tenant isolation: BIL override does not affect BANK_DEMO', () => {
    const e = new InMemoryAlertRoutingEngine();
    e.setOverride('BIL', {
      class: 'red',
      primary_assignee: 'head_of_risk',
      secondary_assignee: null,
      channels: ['email'],
      sla_hours: 2,
      escalate_after_hours: 1,
      monitor_only: false,
    });
    expect(e.getRule('BANK_DEMO', 'red').source).toBe('platform_default');
    expect(e.getRule('BANK_DEMO', 'red').rule.sla_hours).toBe(4);
  });

  test('setOverride rejects invalid rule (escalation >= sla)', () => {
    const e = new InMemoryAlertRoutingEngine();
    expect(() =>
      e.setOverride('BIL', {
        class: 'red',
        primary_assignee: 'head_of_risk',
        secondary_assignee: null,
        channels: ['email'],
        sla_hours: 4,
        escalate_after_hours: 4,
        monitor_only: false,
      }),
    ).toThrow(/must be < sla_hours/);
  });

  test('clearOverride on unknown class throws invalid_class', () => {
    const e = new InMemoryAlertRoutingEngine();
    expect(() => e.clearOverride('BIL', 'purple' as never)).toThrow(/class must be/);
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/alerts/routing/rules', () => {
  test('returns 4 rules with source field; analyst+ accepted', async () => {
    const { app } = makeRtgApp('risk_analyst');
    const r = await request(app).get('/v1/alerts/routing/rules').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(4);
    for (const item of r.body.body.items) {
      expect(item.source).toBe('platform_default');
    }
  });

  test('after override, that rule reports tenant_override', async () => {
    const engine = new InMemoryAlertRoutingEngine();
    engine.setOverride('BIL', {
      class: 'red',
      primary_assignee: 'head_of_risk',
      secondary_assignee: null,
      channels: ['email'],
      sla_hours: 2,
      escalate_after_hours: 1,
      monitor_only: false,
    });
    const { app } = makeRtgApp('admin', engine);
    const r = await request(app).get('/v1/alerts/routing/rules').set(TH_BIL);
    const red = (r.body.body.items as Array<{ class: string; source: string }>).find(
      (i) => i.class === 'red',
    )!;
    expect(red.source).toBe('tenant_override');
  });

  test('unknown role → 403', async () => {
    const { app } = makeRtgApp('case_owner');
    const r = await request(app).get('/v1/alerts/routing/rules').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/alerts/routing/decide', () => {
  test('returns RoutingDecision for CRITICAL', async () => {
    const { app } = makeRtgApp('admin');
    const r = await request(app)
      .post('/v1/alerts/routing/decide')
      .set(TH_BIL)
      .send({ severity: 'CRITICAL' });
    expect(r.status).toBe(200);
    expect(r.body.body.class).toBe('red');
    expect(r.body.body.rule.sla_hours).toBe(4);
    expect(r.body.body.source).toBe('platform_default');
  });

  test('lowercase ui-severity accepted', async () => {
    const { app } = makeRtgApp('admin');
    const r = await request(app)
      .post('/v1/alerts/routing/decide')
      .set(TH_BIL)
      .send({ severity: 'medium' });
    expect(r.status).toBe(200);
    expect(r.body.body.class).toBe('yellow');
  });

  test('reflects tenant override', async () => {
    const engine = new InMemoryAlertRoutingEngine();
    engine.setOverride('BIL', {
      class: 'red',
      primary_assignee: 'head_of_risk',
      secondary_assignee: null,
      channels: ['email'],
      sla_hours: 1,
      escalate_after_hours: null,
      monitor_only: false,
    });
    const { app } = makeRtgApp('admin', engine);
    const r = await request(app)
      .post('/v1/alerts/routing/decide')
      .set(TH_BIL)
      .send({ severity: 'CRITICAL' });
    expect(r.body.body.source).toBe('tenant_override');
    expect(r.body.body.rule.sla_hours).toBe(1);
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeRtgApp('admin');
    const r = await request(app)
      .post('/v1/alerts/routing/decide')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { severity: 'HIGH' } });
    expect(r.status).toBe(200);
    expect(r.body.body.class).toBe('orange');
  });

  test('missing severity → 400', async () => {
    const { app } = makeRtgApp('admin');
    const r = await request(app).post('/v1/alerts/routing/decide').set(TH_BIL).send({});
    expect(r.status).toBe(400);
  });

  test('unknown severity → 400 EWS_400_invalid_severity', async () => {
    const { app } = makeRtgApp('admin');
    const r = await request(app)
      .post('/v1/alerts/routing/decide')
      .set(TH_BIL)
      .send({ severity: 'EXTREME' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_severity');
  });
});

describe('PUT /v1/alerts/routing/rules/:class', () => {
  test('sets override; subsequent list reflects tenant_override', async () => {
    const engine = new InMemoryAlertRoutingEngine();
    const { app } = makeRtgApp('admin', engine);
    const r = await request(app)
      .put('/v1/alerts/routing/rules/red')
      .set(TH_BIL)
      .send({
        primary_assignee: 'head_of_risk',
        secondary_assignee: 'supervisor',
        channels: ['email', 'sms'],
        sla_hours: 2,
        escalate_after_hours: 1,
        monitor_only: false,
      });
    expect(r.status).toBe(200);
    expect(r.body.body.source).toBe('tenant_override');
    expect(r.body.body.sla_hours).toBe(2);
    expect(engine.getRule('BIL', 'red').source).toBe('tenant_override');
  });

  test('invalid class in path → 400 EWS_400_invalid_class', async () => {
    const { app } = makeRtgApp('admin');
    const r = await request(app).put('/v1/alerts/routing/rules/purple').set(TH_BIL).send({
      primary_assignee: 'analyst',
      channels: ['email'],
      sla_hours: 24,
      escalate_after_hours: 12,
      monitor_only: false,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_class');
  });

  test('escalation >= sla → 400 EWS_400_invalid_escalation', async () => {
    const { app } = makeRtgApp('admin');
    const r = await request(app).put('/v1/alerts/routing/rules/red').set(TH_BIL).send({
      primary_assignee: 'head_of_risk',
      channels: ['email'],
      sla_hours: 4,
      escalate_after_hours: 4,
      monitor_only: false,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_escalation');
  });

  test('monitor_only=true with non-null sla → 400 EWS_400_invalid_monitor_only', async () => {
    const { app } = makeRtgApp('admin');
    const r = await request(app).put('/v1/alerts/routing/rules/green').set(TH_BIL).send({
      primary_assignee: 'none',
      channels: ['in_app'],
      sla_hours: 5,
      escalate_after_hours: null,
      monitor_only: true,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_monitor_only');
  });

  test('non-admin → 403', async () => {
    const { app } = makeRtgApp('risk_analyst');
    const r = await request(app)
      .put('/v1/alerts/routing/rules/red')
      .set(TH_BIL)
      .send({
        primary_assignee: 'head_of_risk',
        channels: ['email'],
        sla_hours: 2,
        escalate_after_hours: 1,
        monitor_only: false,
      });
    expect(r.status).toBe(403);
  });
});

describe('DELETE /v1/alerts/routing/rules/:class', () => {
  test('clears override and reverts to platform_default', async () => {
    const engine = new InMemoryAlertRoutingEngine();
    engine.setOverride('BIL', {
      class: 'red',
      primary_assignee: 'head_of_risk',
      secondary_assignee: null,
      channels: ['email'],
      sla_hours: 2,
      escalate_after_hours: 1,
      monitor_only: false,
    });
    const { app } = makeRtgApp('admin', engine);
    const r = await request(app).delete('/v1/alerts/routing/rules/red').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.source).toBe('platform_default');
    expect(r.body.body.sla_hours).toBe(4);
  });

  test('invalid class → 400', async () => {
    const { app } = makeRtgApp('admin');
    const r = await request(app).delete('/v1/alerts/routing/rules/purple').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-admin → 403', async () => {
    const { app } = makeRtgApp('risk_analyst');
    const r = await request(app).delete('/v1/alerts/routing/rules/red').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL override does not affect BANK_DEMO decide', async () => {
    const engine = new InMemoryAlertRoutingEngine();
    const { app } = makeRtgApp('admin', engine);
    await request(app)
      .put('/v1/alerts/routing/rules/red')
      .set(TH_BIL)
      .send({
        primary_assignee: 'head_of_risk',
        channels: ['email'],
        sla_hours: 1,
        escalate_after_hours: null,
        monitor_only: false,
      });
    const bil = await request(app)
      .post('/v1/alerts/routing/decide')
      .set(TH_BIL)
      .send({ severity: 'CRITICAL' });
    const bank = await request(app)
      .post('/v1/alerts/routing/decide')
      .set(TH_BANK)
      .send({ severity: 'CRITICAL' });
    expect(bil.body.body.source).toBe('tenant_override');
    expect(bil.body.body.rule.sla_hours).toBe(1);
    expect(bank.body.body.source).toBe('platform_default');
    expect(bank.body.body.rule.sla_hours).toBe(4);
  });
});
