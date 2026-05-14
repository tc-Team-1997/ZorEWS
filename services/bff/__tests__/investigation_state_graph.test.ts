// services/bff/__tests__/investigation_state_graph.test.ts
//
// T6 M9.7 — Case investigation state-machine introspection.

import request from 'supertest';
import { listInvestigationStateGraph } from '../src/investigation_state_graph';
import { TRANSITIONS } from '../src/case_investigation';
import { DEFAULT_SLA_HOURS_BY_STATE } from '../src/case_sla_breach';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── listInvestigationStateGraph — pure ──────────────────────────────

describe('M9.7 — listInvestigationStateGraph — shape', () => {
  test('emits 6 states matching the M9.1 enum', () => {
    const g = listInvestigationStateGraph();
    expect(g.total_states).toBe(6);
    expect(g.states.map((s) => s.state)).toEqual([
      'triage',
      'gathering_evidence',
      'awaiting_response',
      'review',
      'decision',
      'closed',
    ]);
  });

  test('closed is the only terminal state', () => {
    const g = listInvestigationStateGraph();
    const closed = g.states.find((s) => s.state === 'closed')!;
    expect(closed.terminal).toBe(true);
    for (const s of g.states) {
      if (s.state !== 'closed') expect(s.terminal).toBe(false);
    }
  });

  test('sla_hours_default mirrors DEFAULT_SLA_HOURS_BY_STATE', () => {
    const g = listInvestigationStateGraph();
    for (const node of g.states) {
      expect(node.sla_hours_default).toBe(DEFAULT_SLA_HOURS_BY_STATE[node.state]);
    }
    // closed has no SLA.
    expect(g.states.find((s) => s.state === 'closed')!.sla_hours_default).toBeNull();
  });

  test('allowed_next_states match TRANSITIONS sorted asc', () => {
    const g = listInvestigationStateGraph();
    for (const node of g.states) {
      const expected = [...TRANSITIONS[node.state]].sort();
      expect(node.allowed_next_states).toEqual(expected);
    }
  });

  test('triage has 2 outgoing transitions (per M9.1 contract)', () => {
    const g = listInvestigationStateGraph();
    const triage = g.states.find((s) => s.state === 'triage')!;
    expect(triage.allowed_next_states).toEqual(['closed', 'gathering_evidence']);
  });

  test('review cannot jump to closed (must go via decision)', () => {
    const g = listInvestigationStateGraph();
    const review = g.states.find((s) => s.state === 'review')!;
    expect(review.allowed_next_states).not.toContain('closed');
    expect(review.allowed_next_states).toContain('decision');
  });
});

// ─── GET /v1/cases/states/graph ──────────────────────────────────────

function makeGraphApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M9.7 — GET /v1/cases/states/graph', () => {
  test('admin role → 200 with full state graph', async () => {
    const { app } = makeGraphApp('admin');
    const r = await request(app).get('/v1/cases/states/graph').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_states).toBe(6);
    const states = r.body.body.states as Array<{ state: string }>;
    expect(states.map((s) => s.state)).toContain('triage');
    expect(states.map((s) => s.state)).toContain('closed');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeGraphApp('readonly');
    const r = await request(app).get('/v1/cases/states/graph').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('response is tenant-isolated only by RBAC — same graph for any tenant', async () => {
    const { app } = makeGraphApp('admin');
    const bil = await request(app).get('/v1/cases/states/graph').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/cases/states/graph')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.status).toBe(200);
    expect(bank.status).toBe(200);
    expect(bil.body.body).toEqual(bank.body.body);
  });
});
