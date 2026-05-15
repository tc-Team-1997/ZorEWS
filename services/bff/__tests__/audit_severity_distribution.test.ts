// services/bff/__tests__/audit_severity_distribution.test.ts
//
// T6 M15.9 — Audit event severity distribution.

import request from 'supertest';
import { summarizeAuditBySeverity } from '../src/audit_severity_distribution';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
  type AuditEventInput,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function record(
  store: InMemoryAuditTrailStore,
  tenant: string,
  input: AuditEventInput,
  at: Date,
): AuditEvent {
  return store.record(tenant, input, at);
}

function listAll(store: InMemoryAuditTrailStore, tenant: string): AuditEvent[] {
  return store.list(tenant, { page_size: 1000 }).items;
}

const baseInput = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  actor_username: 'alice',
  actor_role: 'admin',
  action: 'config.update',
  resource_type: 'config',
  resource_id: 'k1',
  outcome: 'success',
  ...overrides,
});

// ─── summarizeAuditBySeverity — pure ─────────────────────────────────

describe('M15.9 — empty input', () => {
  test('zero events → empty rollup', () => {
    const s = summarizeAuditBySeverity('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_events).toBe(0);
    expect(s.severities.length).toBe(3);
    for (const row of s.severities) {
      expect(row.total_count).toBe(0);
      expect(row.most_recent_at).toBeNull();
      expect(row.by_action_top).toEqual([]);
    }
    expect(s.most_common_severity).toBeNull();
    expect(s.last_critical_event_at).toBeNull();
  });
});

describe('M15.9 — severities emitted in canonical order', () => {
  test('order is critical → warning → info', () => {
    const s = summarizeAuditBySeverity('BIL', [], NOW);
    expect(s.severities.map((r) => r.severity)).toEqual(['critical', 'warning', 'info']);
  });
});

describe('M15.9 — single event populates the correct row', () => {
  test('info-severity event lands in info row only', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'info' }), NOW);
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    const info = s.severities.find((r) => r.severity === 'info')!;
    expect(info.total_count).toBe(1);
    const critical = s.severities.find((r) => r.severity === 'critical')!;
    expect(critical.total_count).toBe(0);
  });
});

describe('M15.9 — total_count sums', () => {
  test('Σ per-severity total_count = total_events', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'info' }), NOW);
    record(store, 'BIL', baseInput({ severity: 'warning' }), NOW);
    record(store, 'BIL', baseInput({ severity: 'critical' }), NOW);
    record(store, 'BIL', baseInput({ severity: 'critical' }), NOW);
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    const sum = s.severities.reduce((acc, r) => acc + r.total_count, 0);
    expect(sum).toBe(s.total_events);
    expect(s.total_events).toBe(4);
  });
});

describe('M15.9 — by_resource_type all keys present', () => {
  test('every AuditResourceType key surfaces at 0 when absent', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'config', severity: 'warning' }), NOW);
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    const warning = s.severities.find((r) => r.severity === 'warning')!;
    expect(warning.by_resource_type.config).toBe(1);
    expect(warning.by_resource_type.case).toBe(0);
    expect(warning.by_resource_type.user).toBe(0);
    expect(Object.keys(warning.by_resource_type).length).toBe(10);
  });
});

describe('M15.9 — by_outcome all keys present', () => {
  test('every AuditOutcome key surfaces at 0 when absent', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'warning', outcome: 'failure' }), NOW);
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    const warning = s.severities.find((r) => r.severity === 'warning')!;
    expect(warning.by_outcome.failure).toBe(1);
    expect(warning.by_outcome.success).toBe(0);
    expect(warning.by_outcome.denied).toBe(0);
    expect(Object.keys(warning.by_outcome).length).toBe(3);
  });
});

describe('M15.9 — by_action_top', () => {
  test('top 5 actions sorted by count desc with action asc tie-break', () => {
    const store = new InMemoryAuditTrailStore();
    const tenant = 'BIL';
    for (let i = 0; i < 5; i++) record(store, tenant, baseInput({ action: 'a1', severity: 'critical' }), NOW);
    for (let i = 0; i < 4; i++) record(store, tenant, baseInput({ action: 'a2', severity: 'critical' }), NOW);
    for (let i = 0; i < 1; i++) record(store, tenant, baseInput({ action: 'a3', severity: 'critical' }), NOW);
    for (let i = 0; i < 1; i++) record(store, tenant, baseInput({ action: 'a4', severity: 'critical' }), NOW);
    for (let i = 0; i < 1; i++) record(store, tenant, baseInput({ action: 'a5', severity: 'critical' }), NOW);
    for (let i = 0; i < 1; i++) record(store, tenant, baseInput({ action: 'a6', severity: 'critical' }), NOW);
    const s = summarizeAuditBySeverity(tenant, listAll(store, tenant), NOW);
    const critical = s.severities.find((r) => r.severity === 'critical')!;
    expect(critical.by_action_top.length).toBe(5);
    expect(critical.by_action_top[0]).toEqual({ action: 'a1', count: 5 });
    expect(critical.by_action_top[1]).toEqual({ action: 'a2', count: 4 });
    // a3..a6 tied at 1 — alphabetical → a3 wins, a6 cut at top-5
    expect(critical.by_action_top[4]!.action).toBe('a5');
  });
});

describe('M15.9 — most_recent_at', () => {
  test('takes the newest ts within the severity bucket', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = new Date('2026-05-01T00:00:00Z');
    const t2 = new Date('2026-05-10T00:00:00Z');
    const t3 = new Date('2026-05-05T00:00:00Z');
    record(store, 'BIL', baseInput({ severity: 'warning' }), t1);
    record(store, 'BIL', baseInput({ severity: 'warning' }), t2);
    record(store, 'BIL', baseInput({ severity: 'warning' }), t3);
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    const warning = s.severities.find((r) => r.severity === 'warning')!;
    expect(warning.most_recent_at).toBe(t2.toISOString());
  });
});

describe('M15.9 — most_common_severity', () => {
  test('points at the row with highest total_count', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'info' }), NOW);
    record(store, 'BIL', baseInput({ severity: 'info' }), NOW);
    record(store, 'BIL', baseInput({ severity: 'critical' }), NOW);
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    expect(s.most_common_severity).toBe('info');
  });

  test('null when no events', () => {
    const s = summarizeAuditBySeverity('BIL', [], NOW);
    expect(s.most_common_severity).toBeNull();
  });

  test('canonical order tie-break: critical wins over warning at same count', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'critical' }), NOW);
    record(store, 'BIL', baseInput({ severity: 'warning' }), NOW);
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    expect(s.most_common_severity).toBe('critical');
  });
});

describe('M15.9 — last_critical_event_at', () => {
  test('newest critical event ts', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'critical' }), new Date('2026-05-01T00:00:00Z'));
    record(store, 'BIL', baseInput({ severity: 'critical' }), new Date('2026-05-10T00:00:00Z'));
    record(store, 'BIL', baseInput({ severity: 'critical' }), new Date('2026-05-05T00:00:00Z'));
    record(store, 'BIL', baseInput({ severity: 'warning' }), new Date('2026-05-14T00:00:00Z'));
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    expect(s.last_critical_event_at).toBe('2026-05-10T00:00:00.000Z');
  });

  test('null when no critical events', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'info' }), NOW);
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    expect(s.last_critical_event_at).toBeNull();
  });
});

describe('M15.9 — by_resource_type aggregate consistency', () => {
  test('Σ by_resource_type values = total_count per row', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'warning', resource_type: 'config' }), NOW);
    record(store, 'BIL', baseInput({ severity: 'warning', resource_type: 'case' }), NOW);
    record(store, 'BIL', baseInput({ severity: 'warning', resource_type: 'alert' }), NOW);
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    const warning = s.severities.find((r) => r.severity === 'warning')!;
    const rsum = Object.values(warning.by_resource_type).reduce((a, b) => a + b, 0);
    expect(rsum).toBe(warning.total_count);
  });
});

describe('M15.9 — by_outcome aggregate consistency', () => {
  test('Σ by_outcome values = total_count per row', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'warning', outcome: 'success' }), NOW);
    record(store, 'BIL', baseInput({ severity: 'warning', outcome: 'failure' }), NOW);
    record(store, 'BIL', baseInput({ severity: 'warning', outcome: 'denied' }), NOW);
    const s = summarizeAuditBySeverity('BIL', listAll(store, 'BIL'), NOW);
    const warning = s.severities.find((r) => r.severity === 'warning')!;
    const osum = Object.values(warning.by_outcome).reduce((a, b) => a + b, 0);
    expect(osum).toBe(warning.total_count);
  });
});

// ─── GET /v1/audit/severity-distribution ─────────────────────────────

function makeSevApp(role = 'admin') {
  const auditTrailStore = new InMemoryAuditTrailStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, auditTrailStore };
}

describe('M15.9 — GET /v1/audit/severity-distribution', () => {
  test('admin → 200 with empty rollup for fresh tenant', async () => {
    const { app } = makeSevApp('admin');
    const r = await request(app).get('/v1/audit/severity-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.severities.length).toBe(3);
  });

  test('populated rollup reflects events', async () => {
    const { app, auditTrailStore } = makeSevApp('admin');
    record(auditTrailStore, 'BIL', baseInput({ severity: 'critical' }), NOW);
    record(auditTrailStore, 'BIL', baseInput({ severity: 'info' }), NOW);
    const r = await request(app).get('/v1/audit/severity-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(2);
    expect(r.body.body.last_critical_event_at).not.toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSevApp('case_owner');
    const r = await request(app).get('/v1/audit/severity-distribution').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL events invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeSevApp('admin');
    record(auditTrailStore, 'BIL', baseInput({ severity: 'critical' }), NOW);
    const bank = await request(app)
      .get('/v1/audit/severity-distribution')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_events).toBe(0);
  });

  test('M15.8 /v1/audit/per-actor-activity still works (sibling)', async () => {
    const { app } = makeSevApp('admin');
    const r = await request(app).get('/v1/audit/per-actor-activity').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
