// @ts-nocheck
// T6 M8.27 — Alert resolution time by assignee role.

import request from 'supertest';
import { buildAlertResolutionByRole } from '../src/alert_resolution_by_role';
import { InMemoryRoutingLedger } from '../src/alert_routing_analytics';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeLedger() { return new InMemoryRoutingLedger(); }

function makeResApp(role = 'admin', ledger = makeLedger()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, routingLedger: ledger });
  return app;
}

describe('M8.27 — empty ledger', () => {
  test('returns empty by_role', () => {
    const ledger = makeLedger();
    const out = buildAlertResolutionByRole('BIL', ledger, NOW);
    expect(out.by_role).toEqual([]);
    expect(out.fastest_role).toBeNull();
    expect(out.overall_ack_rate).toBe(0);
  });
});

describe('M8.27 — with records', () => {
  test('ack_rate is between 0 and 1', () => {
    const ledger = makeLedger();
    ledger.record({ alert_id: 'a1', tenant_id: 'BIL', class: 'red', severity_in: 'CRITICAL', created_at: new Date(NOW.getTime() - 3600000).toISOString(), channels: ['email'], sla_hours: 4, escalate_after_hours: 1, acked_at: NOW.toISOString(), monitor_only: false });
    const out = buildAlertResolutionByRole('BIL', ledger, NOW);
    for (const row of out.by_role) {
      expect(row.ack_rate).toBeGreaterThanOrEqual(0);
      expect(row.ack_rate).toBeLessThanOrEqual(1);
    }
  });

  test('fastest_role is set when some are acked', () => {
    const ledger = makeLedger();
    ledger.record({ alert_id: 'a1', tenant_id: 'BIL', class: 'orange', severity_in: 'HIGH', created_at: new Date(NOW.getTime() - 7200000).toISOString(), channels: ['email'], sla_hours: 24, escalate_after_hours: 12, acked_at: NOW.toISOString(), monitor_only: false });
    const out = buildAlertResolutionByRole('BIL', ledger, NOW);
    expect(out.fastest_role).not.toBeNull();
  });

  test('cross-tenant isolation', () => {
    const ledger = makeLedger();
    ledger.record({ alert_id: 'a1', tenant_id: 'BIL', class: 'red', severity_in: 'CRITICAL', created_at: NOW.toISOString(), channels: ['email'], sla_hours: 4, escalate_after_hours: 1, acked_at: null, monitor_only: false });
    const out = buildAlertResolutionByRole('BANK_DEMO', ledger, NOW);
    expect(out.by_role).toEqual([]);
  });
});

describe('M8.27 — route', () => {
  test('admin GET /v1/alerts/resolution-by-role returns 200', async () => {
    const app = makeResApp();
    const res = await request(app).get('/v1/alerts/resolution-by-role').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('by_role');
  });

  test('non-admin gets 403', async () => {
    const app = makeResApp('field_officer');
    const res = await request(app).get('/v1/alerts/resolution-by-role').set(TH);
    expect(res.status).toBe(403);
  });
});
