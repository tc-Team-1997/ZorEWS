import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { evaluateCase, summarise, type SlaCase } from '../src/sla/evaluator';
import { SLA_POLICY } from '../src/sla/policy';
import { makeFleet } from '../src/sla/data';

const NOW = new Date('2026-04-28T12:00:00.000Z');

function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

function makeSlaApp(fleet?: SlaCase[]) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    slaFleet: fleet,
    now: () => NOW,
    getRole: () => 'risk_analyst',
  });
}

describe('sla — policy table', () => {
  test('critical is the tightest deadline', () => {
    expect(SLA_POLICY.critical.ack_minutes).toBeLessThan(SLA_POLICY.high.ack_minutes);
    expect(SLA_POLICY.high.ack_minutes).toBeLessThan(SLA_POLICY.medium.ack_minutes);
    expect(SLA_POLICY.medium.ack_minutes).toBeLessThan(SLA_POLICY.low.ack_minutes);
  });

  test('every severity has ack < action < close', () => {
    for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
      const p = SLA_POLICY[sev];
      expect(p.ack_minutes).toBeLessThan(p.action_minutes);
      expect(p.action_minutes).toBeLessThan(p.close_minutes);
    }
  });
});

describe('sla — evaluateCase()', () => {
  test('open case fresh → on_track on the ack stage', () => {
    const c: SlaCase = {
      case_id: 'x',
      severity: 'critical',
      state: 'open',
      created_at: minutesAgo(2),
    };
    const e = evaluateCase(c, NOW);
    expect(e.stage).toBe('ack');
    expect(e.status).toBe('on_track');
    expect(e.minutes_remaining).toBeGreaterThan(10);
  });

  test('open case past 80% of ack window → approaching', () => {
    const c: SlaCase = {
      case_id: 'x',
      severity: 'critical',
      state: 'open',
      created_at: minutesAgo(13),
    };
    const e = evaluateCase(c, NOW);
    expect(e.status).toBe('approaching');
    expect(e.minutes_remaining).toBeGreaterThanOrEqual(0);
  });

  test('open case past ack deadline → breached with negative remaining', () => {
    const c: SlaCase = {
      case_id: 'x',
      severity: 'critical',
      state: 'open',
      created_at: minutesAgo(45),
    };
    const e = evaluateCase(c, NOW);
    expect(e.status).toBe('breached');
    expect(e.minutes_remaining).toBeLessThan(0);
  });

  test('assigned case races the action stage', () => {
    const c: SlaCase = {
      case_id: 'x',
      severity: 'high',
      state: 'assigned',
      created_at: minutesAgo(150),
      acked_at: minutesAgo(100),
    };
    const e = evaluateCase(c, NOW);
    expect(e.stage).toBe('action');
  });

  test('in_action case races the close stage', () => {
    const c: SlaCase = {
      case_id: 'x',
      severity: 'high',
      state: 'in_action',
      created_at: minutesAgo(900),
      acked_at: minutesAgo(800),
      first_action_at: minutesAgo(700),
    };
    const e = evaluateCase(c, NOW);
    expect(e.stage).toBe('close');
  });

  test('closed case → status closed, no deadline', () => {
    const c: SlaCase = {
      case_id: 'x',
      severity: 'critical',
      state: 'closed',
      created_at: minutesAgo(180),
      closed_at: minutesAgo(60),
    };
    const e = evaluateCase(c, NOW);
    expect(e.status).toBe('closed');
    expect(e.stage).toBeNull();
    expect(e.deadline_at).toBeNull();
  });

  test('deadline_at == created_at + allowed minutes', () => {
    const c: SlaCase = {
      case_id: 'x',
      severity: 'medium',
      state: 'open',
      created_at: minutesAgo(60),
    };
    const e = evaluateCase(c, NOW);
    const expected = new Date(
      new Date(c.created_at).getTime() + SLA_POLICY.medium.ack_minutes * 60_000,
    ).toISOString();
    expect(e.deadline_at).toBe(expected);
  });
});

describe('sla — summarise()', () => {
  test('counts cases per severity × status; totals add up', () => {
    const fleet = makeFleet(NOW);
    const s = summarise(fleet, NOW);
    expect(s.by_severity).toHaveLength(4);
    expect(s.by_severity.map((r) => r.severity).sort()).toEqual([
      'critical',
      'high',
      'low',
      'medium',
    ]);
    const grand = s.by_severity.reduce((acc, r) => acc + r.total, 0);
    expect(grand).toBe(fleet.length);
    expect(s.totals.total).toBe(fleet.length);
    expect(
      s.totals.on_track + s.totals.approaching + s.totals.breached + s.totals.closed,
    ).toBe(fleet.length);
  });

  test('breached_cases list is sorted most-overdue first', () => {
    const fleet = makeFleet(NOW);
    const s = summarise(fleet, NOW);
    expect(s.breached_cases.length).toBeGreaterThan(0);
    for (let i = 1; i < s.breached_cases.length; i++) {
      const prev = s.breached_cases[i - 1].minutes_remaining ?? 0;
      const curr = s.breached_cases[i].minutes_remaining ?? 0;
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  test('default fleet contains at least one breach in every severity', () => {
    const fleet = makeFleet(NOW);
    const s = summarise(fleet, NOW);
    for (const row of s.by_severity) {
      expect(row.breached).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('GET /v1/cases/sla-summary', () => {
  test('returns by_severity + totals + breached_cases', async () => {
    const { app } = makeSlaApp();
    const r = await request(app)
      .get('/v1/cases/sla-summary')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
    expect(r.body.by_severity).toHaveLength(4);
    expect(typeof r.body.totals.breached).toBe('number');
    expect(Array.isArray(r.body.breached_cases)).toBe(true);
  });

  test('field_officer can read (cases:list grants access)', async () => {
    const app = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      now: () => NOW,
      getRole: () => 'field_officer',
    });
    const r = await request(app.app)
      .get('/v1/cases/sla-summary')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
  });

  test('role-less request 403', async () => {
    const app = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      now: () => NOW,
      getRole: () => null,
    });
    const r = await request(app.app)
      .get('/v1/cases/sla-summary')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    // No role header → RBAC returns 401/403 depending on lib config.
    expect([401, 403]).toContain(r.status);
  });

  test('respects injected fleet override', async () => {
    const fleet: SlaCase[] = [
      { case_id: 'only', severity: 'low', state: 'open', created_at: minutesAgo(5) },
    ];
    const { app } = makeSlaApp(fleet);
    const r = await request(app)
      .get('/v1/cases/sla-summary')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
    expect(r.body.totals.total).toBe(1);
    expect(r.body.totals.on_track).toBe(1);
  });
});
