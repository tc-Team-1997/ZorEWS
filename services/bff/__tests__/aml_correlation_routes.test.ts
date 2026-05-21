// T3.3 closure — route tests for the AML ↔ EWS correlation endpoints.
//
// Pure-function tests live in `aml_alert_correlation.test.ts`. This file
// covers the HTTP layer: tenant gate, envelope, RBAC, error-code routing.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import type { AmlAdapter, AmlMatch } from '../src/integrations/aml';
import type { CanonicalAlert } from '../src/types';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const H_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeMatch(overrides: Partial<AmlMatch> = {}): AmlMatch {
  return {
    match_id: 'M-1',
    customer_id: 'C-1',
    match_type: 'sanctions',
    severity: 'high',
    list_name: 'OFAC SDN',
    list_entity_id: 'E-100',
    list_entity_name: 'Acme Holdings',
    confidence_score: 0.91,
    status: 'open',
    status_changed_at: null,
    status_changed_by: null,
    detected_at: NOW.toISOString(),
    ...overrides,
  } as AmlMatch;
}

function makeAdapter(opts: {
  match?: AmlMatch | null;
  matches?: AmlMatch[];
}): AmlAdapter {
  return {
    async getMatch() {
      return opts.match ?? null;
    },
    async listMatches() {
      return opts.matches ?? [];
    },
    async screenCustomer(_tenant: string, customer_id: string) {
      return {
        customer_id,
        screened_at: NOW.toISOString(),
        matches: [],
        total_matches: 0,
        highest_severity: null,
        requires_review: false,
      };
    },
    async updateMatchStatus() {
      throw new Error('not implemented');
    },
  };
}

function alertEvent(overrides: Partial<CanonicalAlert> = {}): CanonicalAlert {
  return {
    alert_id: 'a-1',
    raised_at: NOW.toISOString(),
    customer_id: 'C-1',
    severity: 'HIGH',
    rule_id: 'r-1',
    indicators_fired: ['FIN-001'],
    ...overrides,
  };
}

function makeRouteApp(opts: {
  role?: string;
  amlAdapter?: AmlAdapter;
  alerts?: CanonicalAlert[];
}) {
  return makeApp({
    source: new StaticSource(opts.alerts ?? []),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => opts.role ?? 'admin',
    amlAdapter: opts.amlAdapter,
  });
}

describe('POST /v1/aml/correlate/:match_id (forward)', () => {
  test('admin happy path returns envelope + recommended_action', async () => {
    const { app } = makeRouteApp({
      amlAdapter: makeAdapter({ match: makeMatch() }),
      alerts: [alertEvent({ alert_id: 'a-1', severity: 'CRITICAL' })],
    });
    const r = await request(app).post('/v1/aml/correlate/M-1').set(H_BIL).send({});
    expect(r.status).toBe(200);
    expect(r.body.header?.status).toBe('SUCCESS');
    expect(r.body.body.aml_match.match_id).toBe('M-1');
    expect(r.body.body.peak_alert_severity).toBe('critical');
    expect(r.body.body.bidirectional_high_flag).toBe(true);
    expect(r.body.body.recommended_action).toBe('escalate_case');
    expect(Array.isArray(r.body.body.linked_alerts)).toBe(true);
    expect(r.body.body.linked_alerts).toHaveLength(1);
  });

  test('analyst+ accepted', async () => {
    const { app } = makeRouteApp({
      role: 'risk_analyst',
      amlAdapter: makeAdapter({ match: makeMatch() }),
    });
    const r = await request(app).post('/v1/aml/correlate/M-1').set(H_BIL).send({});
    expect(r.status).toBe(200);
  });

  test('unknown_match → 404 EWS_404_unknown_match', async () => {
    const { app } = makeRouteApp({ amlAdapter: makeAdapter({ match: null }) });
    const r = await request(app).post('/v1/aml/correlate/M-nope').set(H_BIL).send({});
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toBe('EWS_404_unknown_match');
  });

  test('no linked alerts → empty arrays + null peak_alert_severity', async () => {
    const { app } = makeRouteApp({ amlAdapter: makeAdapter({ match: makeMatch() }) });
    const r = await request(app).post('/v1/aml/correlate/M-1').set(H_BIL).send({});
    expect(r.status).toBe(200);
    expect(r.body.body.linked_alerts).toEqual([]);
    expect(r.body.body.linked_cases).toEqual([]);
    expect(r.body.body.linked_investigations).toEqual([]);
    expect(r.body.body.peak_alert_severity).toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRouteApp({
      role: 'unknown_role',
      amlAdapter: makeAdapter({ match: makeMatch() }),
    });
    const r = await request(app).post('/v1/aml/correlate/M-1').set(H_BIL).send({});
    expect(r.status).toBe(403);
  });

  test('missing tenant header → 400', async () => {
    const { app } = makeRouteApp({ amlAdapter: makeAdapter({ match: makeMatch() }) });
    const r = await request(app).post('/v1/aml/correlate/M-1').send({});
    expect(r.status).toBe(400);
  });

  test('adapter throw routes to 502', async () => {
    const broken: AmlAdapter = {
      async getMatch() {
        throw new Error('upstream offline');
      },
      async listMatches() {
        return [];
      },
      async screenCustomer() {
        throw new Error('n/a');
      },
      async updateMatchStatus() {
        throw new Error('n/a');
      },
    };
    const { app } = makeRouteApp({ amlAdapter: broken });
    const r = await request(app).post('/v1/aml/correlate/M-1').set(H_BIL).send({});
    expect(r.status).toBe(502);
    expect(r.body.error?.code).toBe('EWS_502');
  });
});

describe('POST /v1/aml/correlate/by-alert/:alert_id (reverse)', () => {
  test('happy path with sanctions hit → sanctions_review', async () => {
    const { app } = makeRouteApp({
      amlAdapter: makeAdapter({
        matches: [makeMatch({ match_type: 'sanctions', status: 'open' })],
      }),
      alerts: [alertEvent({ alert_id: 'a-1', severity: 'HIGH' })],
    });
    const r = await request(app).post('/v1/aml/correlate/by-alert/a-1').set(H_BIL).send({});
    expect(r.status).toBe(200);
    expect(r.body.body.alert.id).toBe('a-1');
    expect(r.body.body.alert.severity).toBe('high');
    expect(r.body.body.recommended_action).toBe('sanctions_review');
    expect(r.body.body.aml_matches).toHaveLength(1);
  });

  test('no AML matches → no_action recommendation', async () => {
    const { app } = makeRouteApp({
      amlAdapter: makeAdapter({ matches: [] }),
      alerts: [alertEvent({ alert_id: 'a-1' })],
    });
    const r = await request(app).post('/v1/aml/correlate/by-alert/a-1').set(H_BIL).send({});
    expect(r.status).toBe(200);
    expect(r.body.body.aml_matches).toEqual([]);
    expect(r.body.body.peak_aml_severity).toBeNull();
    expect(r.body.body.recommended_action).toBe('no_action');
  });

  test('unknown alert → 404 EWS_404_unknown_alert', async () => {
    const { app } = makeRouteApp({ amlAdapter: makeAdapter({ matches: [] }), alerts: [] });
    const r = await request(app)
      .post('/v1/aml/correlate/by-alert/a-missing')
      .set(H_BIL)
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toBe('EWS_404_unknown_alert');
  });

  test('cleared AML matches do NOT trigger sanctions_review', async () => {
    const { app } = makeRouteApp({
      amlAdapter: makeAdapter({
        matches: [makeMatch({ status: 'cleared', match_type: 'sanctions' })],
      }),
      alerts: [alertEvent({ alert_id: 'a-1', severity: 'MEDIUM' })],
    });
    const r = await request(app).post('/v1/aml/correlate/by-alert/a-1').set(H_BIL).send({});
    expect(r.status).toBe(200);
    expect(r.body.body.recommended_action).not.toBe('sanctions_review');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRouteApp({
      role: 'unknown_role',
      amlAdapter: makeAdapter({ matches: [] }),
      alerts: [alertEvent({ alert_id: 'a-1' })],
    });
    const r = await request(app).post('/v1/aml/correlate/by-alert/a-1').set(H_BIL).send({});
    expect(r.status).toBe(403);
  });

  test('open AML high + medium alert → kyc_refresh', async () => {
    const { app } = makeRouteApp({
      amlAdapter: makeAdapter({
        matches: [makeMatch({ match_type: 'pep', severity: 'high', status: 'open' })],
      }),
      alerts: [alertEvent({ alert_id: 'a-2', severity: 'MEDIUM' })],
    });
    const r = await request(app).post('/v1/aml/correlate/by-alert/a-2').set(H_BIL).send({});
    expect(r.status).toBe(200);
    expect(r.body.body.recommended_action).toBe('kyc_refresh');
  });
});
