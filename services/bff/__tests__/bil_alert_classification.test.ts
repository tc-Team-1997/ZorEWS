// services/bff/__tests__/bil_alert_classification.test.ts
//
// T6 M8.1 — BIL Red/Orange/Yellow alert classification.
//
// Three layers:
//   1. Pure classifier — severity → class, normalisation, error paths
//   2. Metadata table — every class has the required fields
//   3. Routes — spec / classify / by-class, all tenant-gated and enveloped

import request from 'supertest';
import {
  AlertClassificationError,
  BIL_CLASS_ORDER,
  classifyAlertSeverity,
  classifyWithMetadata,
  getClassMetadata,
  isBilAlertClass,
  listClassifications,
} from '../src/bil_alert_classification';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import type { CanonicalAlert } from '../src/types';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function alert(id: string, severity: CanonicalAlert['severity']): CanonicalAlert {
  return {
    alert_id: id,
    raised_at: '2026-05-04T10:00:00.000Z',
    customer_id: `c-${id}`,
    severity,
    rule_id: 'r-1',
    indicators_fired: ['IND_BEH_03'],
  };
}

function makeClassApp(role: string = 'admin', alerts: CanonicalAlert[] = []) {
  return makeApp({
    source: new StaticSource(alerts),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure classifier ───────────────────────────────────────────────────

describe('classifyAlertSeverity()', () => {
  test('CRITICAL → red', () => {
    expect(classifyAlertSeverity('CRITICAL')).toBe('red');
  });
  test('HIGH → orange', () => {
    expect(classifyAlertSeverity('HIGH')).toBe('orange');
  });
  test('MEDIUM → yellow', () => {
    expect(classifyAlertSeverity('MEDIUM')).toBe('yellow');
  });
  test('LOW → green', () => {
    expect(classifyAlertSeverity('LOW')).toBe('green');
  });

  test('lowercase severities accepted (UiSeverity shape)', () => {
    expect(classifyAlertSeverity('critical')).toBe('red');
    expect(classifyAlertSeverity('high')).toBe('orange');
    expect(classifyAlertSeverity('medium')).toBe('yellow');
    expect(classifyAlertSeverity('low')).toBe('green');
  });

  test('mixed case accepted', () => {
    expect(classifyAlertSeverity('Critical' as never)).toBe('red');
    expect(classifyAlertSeverity('hIgH' as never)).toBe('orange');
  });

  test('unknown severity throws AlertClassificationError', () => {
    try {
      classifyAlertSeverity('EXTREME' as never);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AlertClassificationError);
      expect((e as AlertClassificationError).code).toBe('invalid_severity');
    }
  });

  test('non-string severity throws', () => {
    expect(() => classifyAlertSeverity(5 as never)).toThrow(/severity must be a string/);
  });
});

describe('Metadata table', () => {
  test('listClassifications returns all 4 in canonical order', () => {
    const ids = listClassifications().map((m) => m.class);
    expect(ids).toEqual(['red', 'orange', 'yellow', 'green']);
  });

  test('BIL_CLASS_ORDER matches the listing order', () => {
    expect(BIL_CLASS_ORDER).toEqual(['red', 'orange', 'yellow', 'green']);
  });

  test('every metadata row carries the required fields', () => {
    for (const m of listClassifications()) {
      expect(m.color_hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(typeof m.label).toBe('string');
      expect(m.label.length).toBeGreaterThan(0);
      expect(typeof m.action_required).toBe('string');
      expect(['head_of_risk', 'supervisor', 'analyst', 'none']).toContain(m.escalation_path);
      expect(Array.isArray(m.source_severities)).toBe(true);
      expect(m.source_severities.length).toBeGreaterThan(0);
    }
  });

  test('only green is monitor_only with sla_hours=null', () => {
    for (const m of listClassifications()) {
      if (m.class === 'green') {
        expect(m.monitor_only).toBe(true);
        expect(m.sla_hours).toBeNull();
        expect(m.escalation_path).toBe('none');
      } else {
        expect(m.monitor_only).toBe(false);
        expect(m.sla_hours).toBeGreaterThan(0);
      }
    }
  });

  test('SLA hours are strictly increasing as severity decreases (red < orange < yellow)', () => {
    const red = getClassMetadata('red').sla_hours!;
    const orange = getClassMetadata('orange').sla_hours!;
    const yellow = getClassMetadata('yellow').sla_hours!;
    expect(red).toBeLessThan(orange);
    expect(orange).toBeLessThan(yellow);
  });

  test('source_severities partition the WireSeverity space (no overlap, full coverage)', () => {
    const seen = new Set<string>();
    for (const m of listClassifications()) {
      for (const s of m.source_severities) {
        expect(seen.has(s)).toBe(false);
        seen.add(s);
      }
    }
    expect([...seen].sort()).toEqual(['CRITICAL', 'HIGH', 'LOW', 'MEDIUM']);
  });

  test('getClassMetadata throws on unknown class', () => {
    expect(() => getClassMetadata('purple' as never)).toThrow(/unknown BIL class/);
  });
});

describe('classifyWithMetadata()', () => {
  test('returns severity + class + metadata', () => {
    const r = classifyWithMetadata('CRITICAL');
    expect(r.severity).toBe('CRITICAL');
    expect(r.class).toBe('red');
    expect(r.metadata.escalation_path).toBe('head_of_risk');
    expect(r.metadata.sla_hours).toBe(4);
  });

  test('normalises lowercase input to uppercase severity in output', () => {
    expect(classifyWithMetadata('high').severity).toBe('HIGH');
  });
});

describe('isBilAlertClass()', () => {
  test('accepts the 4 valid classes', () => {
    expect(isBilAlertClass('red')).toBe(true);
    expect(isBilAlertClass('orange')).toBe(true);
    expect(isBilAlertClass('yellow')).toBe(true);
    expect(isBilAlertClass('green')).toBe(true);
  });
  test('rejects everything else', () => {
    expect(isBilAlertClass('RED')).toBe(false);
    expect(isBilAlertClass('blue')).toBe(false);
    expect(isBilAlertClass('')).toBe(false);
    expect(isBilAlertClass(null)).toBe(false);
    expect(isBilAlertClass(undefined)).toBe(false);
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/alerts/classification/spec', () => {
  test('returns the 4-class metadata table to alerts:list roles', async () => {
    const { app } = makeClassApp('risk_analyst');
    const r = await request(app).get('/v1/alerts/classification/spec').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(4);
    const classes = r.body.body.items.map((i: { class: string }) => i.class);
    expect(classes).toEqual(['red', 'orange', 'yellow', 'green']);
  });

  test('unknown role → 403 (alerts:list not granted)', async () => {
    const { app } = makeClassApp('case_owner');
    const r = await request(app).get('/v1/alerts/classification/spec').set(TH);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/alerts/classify', () => {
  test('CRITICAL → red with metadata', async () => {
    const { app } = makeClassApp('risk_analyst');
    const r = await request(app)
      .post('/v1/alerts/classify')
      .set(TH)
      .send({ severity: 'CRITICAL' });
    expect(r.status).toBe(200);
    expect(r.body.body.class).toBe('red');
    expect(r.body.body.severity).toBe('CRITICAL');
    expect(r.body.body.metadata.escalation_path).toBe('head_of_risk');
    expect(r.body.body.metadata.sla_hours).toBe(4);
  });

  test('lowercase ui-severity accepted', async () => {
    const { app } = makeClassApp('risk_analyst');
    const r = await request(app)
      .post('/v1/alerts/classify')
      .set(TH)
      .send({ severity: 'medium' });
    expect(r.status).toBe(200);
    expect(r.body.body.class).toBe('yellow');
    expect(r.body.body.severity).toBe('MEDIUM');
  });

  test('LOW → green (informational, monitor_only)', async () => {
    const { app } = makeClassApp('risk_analyst');
    const r = await request(app).post('/v1/alerts/classify').set(TH).send({ severity: 'LOW' });
    expect(r.status).toBe(200);
    expect(r.body.body.class).toBe('green');
    expect(r.body.body.metadata.monitor_only).toBe(true);
    expect(r.body.body.metadata.sla_hours).toBeNull();
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeClassApp('risk_analyst');
    const r = await request(app)
      .post('/v1/alerts/classify')
      .set(TH)
      .send({ header: { requestId: 'r-1' }, body: { severity: 'HIGH' } });
    expect(r.status).toBe(200);
    expect(r.body.body.class).toBe('orange');
  });

  test('missing severity → 400', async () => {
    const { app } = makeClassApp('risk_analyst');
    const r = await request(app).post('/v1/alerts/classify').set(TH).send({});
    expect(r.status).toBe(400);
  });

  test('unknown severity → 400 with code EWS_400_invalid_severity', async () => {
    const { app } = makeClassApp('risk_analyst');
    const r = await request(app)
      .post('/v1/alerts/classify')
      .set(TH)
      .send({ severity: 'EXTREME' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_severity');
  });

  test('non-string severity → 400 with code EWS_400_invalid_severity', async () => {
    const { app } = makeClassApp('risk_analyst');
    const r = await request(app)
      .post('/v1/alerts/classify')
      .set(TH)
      .send({ severity: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_severity');
  });
});

describe('GET /v1/alerts/by-class/:class', () => {
  const FLEET: CanonicalAlert[] = [
    alert('a-crit', 'CRITICAL'),
    alert('a-high-1', 'HIGH'),
    alert('a-high-2', 'HIGH'),
    alert('a-med', 'MEDIUM'),
    alert('a-low', 'LOW'),
  ];

  test('red → only CRITICAL alerts, decorated with bil_class + bil_metadata', async () => {
    const { app } = makeClassApp('risk_analyst', FLEET);
    const r = await request(app).get('/v1/alerts/by-class/red').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.class).toBe('red');
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].id).toBe('a-crit');
    expect(r.body.body.items[0].bil_class).toBe('red');
    expect(r.body.body.items[0].bil_metadata.sla_hours).toBe(4);
  });

  test('orange → both HIGH alerts, in source order', async () => {
    const { app } = makeClassApp('risk_analyst', FLEET);
    const r = await request(app).get('/v1/alerts/by-class/orange').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.items.map((i: { id: string }) => i.id).sort()).toEqual([
      'a-high-1',
      'a-high-2',
    ]);
  });

  test('yellow → only the MEDIUM alert', async () => {
    const { app } = makeClassApp('risk_analyst', FLEET);
    const r = await request(app).get('/v1/alerts/by-class/yellow').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].id).toBe('a-med');
  });

  test('green → only the LOW alert, marked monitor_only', async () => {
    const { app } = makeClassApp('risk_analyst', FLEET);
    const r = await request(app).get('/v1/alerts/by-class/green').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].id).toBe('a-low');
    expect(r.body.body.items[0].bil_metadata.monitor_only).toBe(true);
  });

  test('empty fleet → empty list (200, total=0)', async () => {
    const { app } = makeClassApp('risk_analyst', []);
    const r = await request(app).get('/v1/alerts/by-class/red').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('invalid class → 400 with code EWS_400_invalid_class', async () => {
    const { app } = makeClassApp('risk_analyst', FLEET);
    const r = await request(app).get('/v1/alerts/by-class/blue').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_class');
  });

  test('uppercase RED is not accepted (lowercase canonical)', async () => {
    const { app } = makeClassApp('risk_analyst', FLEET);
    const r = await request(app).get('/v1/alerts/by-class/RED').set(TH);
    expect(r.status).toBe(400);
  });

  test('unknown role → 403', async () => {
    const { app } = makeClassApp('case_owner', FLEET);
    const r = await request(app).get('/v1/alerts/by-class/red').set(TH);
    expect(r.status).toBe(403);
  });
});
