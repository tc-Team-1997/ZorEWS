// services/bff/__tests__/audit_correlation_rollup.test.ts
//
// T6 M15.10 — Audit log per-correlation rollup.

import request from 'supertest';
import { summarizeAuditByCorrelation } from '../src/audit_correlation_rollup';
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

// ─── summarizeAuditByCorrelation — pure ──────────────────────────────

describe('M15.10 — empty input', () => {
  test('zero events → empty rollup', () => {
    const s = summarizeAuditByCorrelation('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_events_observed).toBe(0);
    expect(s.total_events_with_correlation).toBe(0);
    expect(s.total_events_without_correlation).toBe(0);
    expect(s.total_correlations).toBe(0);
    expect(s.correlations).toEqual([]);
    expect(s.most_active_correlation).toBeNull();
    expect(s.longest_running_correlation).toBeNull();
    expect(s.failed_correlations).toEqual([]);
  });
});

describe('M15.10 — null correlation_id events excluded but counted', () => {
  test('events without correlation_id bump total_without but never appear in rows', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput(), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'corr-A' }), NOW);
    record(store, 'BIL', baseInput(), NOW);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.total_events_observed).toBe(3);
    expect(s.total_events_with_correlation).toBe(1);
    expect(s.total_events_without_correlation).toBe(2);
    expect(s.total_correlations).toBe(1);
    expect(s.correlations[0]!.correlation_id).toBe('corr-A');
  });
});

describe('M15.10 — single correlation populates one row', () => {
  test('one correlation with 3 events → event_count=3, distinct sets dedup', () => {
    const store = new InMemoryAuditTrailStore();
    const at1 = new Date('2026-05-01T00:00:00Z');
    const at2 = new Date('2026-05-01T00:05:00Z');
    const at3 = new Date('2026-05-01T00:10:00Z');
    record(store, 'BIL', baseInput({ correlation_id: 'c1', actor_username: 'alice', action: 'a1' }), at1);
    record(store, 'BIL', baseInput({ correlation_id: 'c1', actor_username: 'bob', action: 'a2' }), at2);
    record(store, 'BIL', baseInput({ correlation_id: 'c1', actor_username: 'alice', action: 'a1' }), at3);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.correlations.length).toBe(1);
    const row = s.correlations[0]!;
    expect(row.event_count).toBe(3);
    expect(row.distinct_actors).toEqual(['alice', 'bob']);
    expect(row.distinct_actions).toEqual(['a1', 'a2']);
    expect(row.distinct_resource_types).toEqual(['config']);
  });
});

describe('M15.10 — multi-correlation grouping', () => {
  test('events split across correlations land in separate rows', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ correlation_id: 'corr-A' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'corr-A' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'corr-B' }), NOW);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.total_correlations).toBe(2);
    const byId = Object.fromEntries(s.correlations.map((r) => [r.correlation_id, r]));
    expect(byId['corr-A']!.event_count).toBe(2);
    expect(byId['corr-B']!.event_count).toBe(1);
  });
});

describe('M15.10 — distinct sets are sorted asc', () => {
  test('distinct_actors / distinct_actions / distinct_resource_types all sorted', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ correlation_id: 'c1', actor_username: 'zoe', action: 'z.act', resource_type: 'rule' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c1', actor_username: 'alice', action: 'a.act', resource_type: 'alert' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c1', actor_username: 'mark', action: 'm.act', resource_type: 'case' }), NOW);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    const row = s.correlations[0]!;
    expect(row.distinct_actors).toEqual(['alice', 'mark', 'zoe']);
    expect(row.distinct_actions).toEqual(['a.act', 'm.act', 'z.act']);
    expect(row.distinct_resource_types).toEqual(['alert', 'case', 'rule']);
  });
});

describe('M15.10 — action_chain ordered oldest-first', () => {
  test('chain reflects ts order regardless of insertion order', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = new Date('2026-05-01T00:00:00Z');
    const t2 = new Date('2026-05-01T00:05:00Z');
    const t3 = new Date('2026-05-01T00:10:00Z');
    // Insert out-of-order
    record(store, 'BIL', baseInput({ correlation_id: 'c1', action: 'second' }), t2);
    record(store, 'BIL', baseInput({ correlation_id: 'c1', action: 'third' }), t3);
    record(store, 'BIL', baseInput({ correlation_id: 'c1', action: 'first' }), t1);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    const chain = s.correlations[0]!.action_chain;
    expect(chain.map((c) => c.action)).toEqual(['first', 'second', 'third']);
    expect(chain[0]!.ts).toBe(t1.toISOString());
    expect(chain[2]!.ts).toBe(t3.toISOString());
  });

  test('chain carries actor + outcome on every entry', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ correlation_id: 'c1', actor_username: 'alice', outcome: 'success', action: 'a1' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c1', actor_username: 'bob', outcome: 'denied', action: 'a2' }), NOW);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    const chain = s.correlations[0]!.action_chain;
    expect(chain.find((c) => c.action === 'a1')!.actor_username).toBe('alice');
    expect(chain.find((c) => c.action === 'a1')!.outcome).toBe('success');
    expect(chain.find((c) => c.action === 'a2')!.actor_username).toBe('bob');
    expect(chain.find((c) => c.action === 'a2')!.outcome).toBe('denied');
  });
});

describe('M15.10 — duration_ms = last - first', () => {
  test('arithmetic correct across multi-event correlation', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = new Date('2026-05-01T00:00:00.000Z');
    const t2 = new Date('2026-05-01T00:00:00.500Z');
    const t3 = new Date('2026-05-01T00:00:01.250Z');
    record(store, 'BIL', baseInput({ correlation_id: 'c1' }), t1);
    record(store, 'BIL', baseInput({ correlation_id: 'c1' }), t2);
    record(store, 'BIL', baseInput({ correlation_id: 'c1' }), t3);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.correlations[0]!.duration_ms).toBe(1250);
  });

  test('single-event correlation has duration_ms = 0', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ correlation_id: 'c1' }), NOW);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.correlations[0]!.duration_ms).toBe(0);
  });
});

describe('M15.10 — sort order', () => {
  test('event_count desc with correlation_id asc tie-break', () => {
    const store = new InMemoryAuditTrailStore();
    // c-low: 1 event, c-mid: 2 events, c-tied-a/c-tied-b: 3 events each
    record(store, 'BIL', baseInput({ correlation_id: 'c-low' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c-mid' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c-mid' }), NOW);
    for (let i = 0; i < 3; i++) record(store, 'BIL', baseInput({ correlation_id: 'c-tied-b' }), NOW);
    for (let i = 0; i < 3; i++) record(store, 'BIL', baseInput({ correlation_id: 'c-tied-a' }), NOW);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.correlations.map((r) => r.correlation_id)).toEqual([
      'c-tied-a', // 3 events, alphabetical tie-break
      'c-tied-b', // 3 events
      'c-mid',    // 2 events
      'c-low',    // 1 event
    ]);
  });
});

describe('M15.10 — most_active_correlation', () => {
  test('points at the row with highest event_count', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ correlation_id: 'c-quiet' }), NOW);
    for (let i = 0; i < 5; i++) record(store, 'BIL', baseInput({ correlation_id: 'c-busy' }), NOW);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.most_active_correlation).toEqual({ correlation_id: 'c-busy', event_count: 5 });
  });

  test('null when no correlations observed', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput(), NOW); // no correlation_id
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.most_active_correlation).toBeNull();
  });
});

describe('M15.10 — longest_running_correlation', () => {
  test('points at the row with highest duration_ms', () => {
    const store = new InMemoryAuditTrailStore();
    // c-short: spans 1 second
    record(store, 'BIL', baseInput({ correlation_id: 'c-short' }), new Date('2026-05-01T00:00:00Z'));
    record(store, 'BIL', baseInput({ correlation_id: 'c-short' }), new Date('2026-05-01T00:00:01Z'));
    // c-long: spans 1 hour
    record(store, 'BIL', baseInput({ correlation_id: 'c-long' }), new Date('2026-05-01T00:00:00Z'));
    record(store, 'BIL', baseInput({ correlation_id: 'c-long' }), new Date('2026-05-01T01:00:00Z'));
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.longest_running_correlation!.correlation_id).toBe('c-long');
    expect(s.longest_running_correlation!.duration_ms).toBe(60 * 60 * 1000);
  });

  test('tie-broken by correlation_id asc', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = new Date('2026-05-01T00:00:00Z');
    const t2 = new Date('2026-05-01T00:00:10Z');
    record(store, 'BIL', baseInput({ correlation_id: 'c-b' }), t1);
    record(store, 'BIL', baseInput({ correlation_id: 'c-b' }), t2);
    record(store, 'BIL', baseInput({ correlation_id: 'c-a' }), t1);
    record(store, 'BIL', baseInput({ correlation_id: 'c-a' }), t2);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.longest_running_correlation!.correlation_id).toBe('c-a');
  });

  test('null when no correlations', () => {
    const s = summarizeAuditByCorrelation('BIL', [], NOW);
    expect(s.longest_running_correlation).toBeNull();
  });
});

describe('M15.10 — has_failure + failed_correlations', () => {
  test('any non-success outcome flips has_failure=true', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ correlation_id: 'c-ok', outcome: 'success' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c-bad', outcome: 'success' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c-bad', outcome: 'failure' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c-denied', outcome: 'denied' }), NOW);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    const byId = Object.fromEntries(s.correlations.map((r) => [r.correlation_id, r]));
    expect(byId['c-ok']!.has_failure).toBe(false);
    expect(byId['c-bad']!.has_failure).toBe(true);
    expect(byId['c-denied']!.has_failure).toBe(true);
  });

  test('failed_correlations[] only contains has_failure=true rows, sorted asc', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ correlation_id: 'c-zeta', outcome: 'denied' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c-clean', outcome: 'success' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c-alpha', outcome: 'failure' }), NOW);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.failed_correlations).toEqual(['c-alpha', 'c-zeta']);
  });
});

describe('M15.10 — totals partition invariant', () => {
  test('with + without = observed; correlations.count = total_correlations', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ correlation_id: 'c1' }), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c2' }), NOW);
    record(store, 'BIL', baseInput(), NOW);
    record(store, 'BIL', baseInput(), NOW);
    record(store, 'BIL', baseInput({ correlation_id: 'c1' }), NOW);
    const s = summarizeAuditByCorrelation('BIL', listAll(store, 'BIL'), NOW);
    expect(s.total_events_with_correlation + s.total_events_without_correlation)
      .toBe(s.total_events_observed);
    expect(s.correlations.length).toBe(s.total_correlations);
    const eventCountSum = s.correlations.reduce((acc, r) => acc + r.event_count, 0);
    expect(eventCountSum).toBe(s.total_events_with_correlation);
  });
});

// ─── GET /v1/audit/correlations ──────────────────────────────────────

function makeCorrApp(role = 'admin') {
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

describe('M15.10 — GET /v1/audit/correlations', () => {
  test('admin → 200 with empty rollup on fresh tenant', async () => {
    const { app } = makeCorrApp('admin');
    const r = await request(app).get('/v1/audit/correlations').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_correlations).toBe(0);
    expect(r.body.body.correlations).toEqual([]);
    expect(r.body.body.most_active_correlation).toBeNull();
    expect(r.body.body.longest_running_correlation).toBeNull();
    expect(r.body.body.failed_correlations).toEqual([]);
  });

  test('populated rollup reflects recorded events', async () => {
    const { app, auditTrailStore } = makeCorrApp('admin');
    record(auditTrailStore, 'BIL', baseInput({ correlation_id: 'req-42' }), new Date('2026-05-01T00:00:00Z'));
    record(auditTrailStore, 'BIL', baseInput({ correlation_id: 'req-42', outcome: 'failure' }), new Date('2026-05-01T00:00:05Z'));
    const r = await request(app).get('/v1/audit/correlations').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_correlations).toBe(1);
    expect(r.body.body.correlations[0].correlation_id).toBe('req-42');
    expect(r.body.body.correlations[0].event_count).toBe(2);
    expect(r.body.body.correlations[0].has_failure).toBe(true);
    expect(r.body.body.correlations[0].duration_ms).toBe(5000);
    expect(r.body.body.most_active_correlation.correlation_id).toBe('req-42');
    expect(r.body.body.failed_correlations).toEqual(['req-42']);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCorrApp('case_owner');
    const r = await request(app).get('/v1/audit/correlations').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL correlations invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeCorrApp('admin');
    record(auditTrailStore, 'BIL', baseInput({ correlation_id: 'bil-only' }), NOW);
    const bank = await request(app)
      .get('/v1/audit/correlations')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_correlations).toBe(0);
  });

  test('M15.9 /v1/audit/severity-distribution still works (sibling regression)', async () => {
    const { app } = makeCorrApp('admin');
    const r = await request(app).get('/v1/audit/severity-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
