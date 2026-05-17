// services/bff/__tests__/audit_action_prefix_distribution.test.ts
//
// T6 M15.13 — Audit action prefix distribution.

import request from 'supertest';
import { summarizeAuditActionPrefixDistribution } from '../src/audit_action_prefix_distribution';
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

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

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

function makeApApp(role: string = 'admin') {
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

// ─── summarizeAuditActionPrefixDistribution — pure ───────────────────

describe('M15.13 — empty input', () => {
  test('zero events → empty prefixes[] + null leaderboard', () => {
    const s = summarizeAuditActionPrefixDistribution('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_events).toBe(0);
    expect(s.total_prefixes).toBe(0);
    expect(s.unprefixed_count).toBe(0);
    expect(s.prefixes).toEqual([]);
    expect(s.most_frequent_prefix).toBeNull();
  });
});

describe('M15.13 — single event with prefixed action', () => {
  test('1 config.update event → 1 prefix row', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'config.update' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.total_events).toBe(1);
    expect(s.total_prefixes).toBe(1);
    expect(s.unprefixed_count).toBe(0);
    expect(s.prefixes[0]!.prefix).toBe('config');
    expect(s.prefixes[0]!.total_count).toBe(1);
    expect(s.prefixes[0]!.distinct_verbs).toEqual(['update']);
    expect(s.prefixes[0]!.by_outcome.success).toBe(1);
    expect(s.prefixes[0]!.by_outcome.failure).toBe(0);
    expect(s.prefixes[0]!.by_outcome.denied).toBe(0);
    expect(s.prefixes[0]!.distinct_resource_types).toEqual(['config']);
    expect(s.prefixes[0]!.distinct_actors).toEqual(['alice']);
    expect(s.prefixes[0]!.most_recent_at).toBe(NOW.toISOString());
    expect(s.most_frequent_prefix).toEqual({ prefix: 'config', total_count: 1 });
  });
});

describe('M15.13 — multi-verb same prefix', () => {
  test('3 config.* events with distinct verbs → 1 row distinct_verbs=3', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'config.update' }), NOW);
    store.record('BIL', baseInput({ action: 'config.reset' }), NOW);
    store.record('BIL', baseInput({ action: 'config.create' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.prefixes).toHaveLength(1);
    expect(s.prefixes[0]!.prefix).toBe('config');
    expect(s.prefixes[0]!.total_count).toBe(3);
    expect(s.prefixes[0]!.distinct_verbs).toEqual(['create', 'reset', 'update']);
  });
});

describe('M15.13 — multi-prefix', () => {
  test('events from different prefixes get separate rows', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'config.update' }), NOW);
    store.record('BIL', baseInput({ action: 'config.reset' }), NOW);
    store.record('BIL', baseInput({ action: 'scenario.create', resource_type: 'scenario' }), NOW);
    store.record('BIL', baseInput({ action: 'case.assign', resource_type: 'case' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.total_events).toBe(4);
    expect(s.total_prefixes).toBe(3);
    expect(s.prefixes.map((r) => r.prefix)).toEqual(['config', 'case', 'scenario']);
    // config has 2; case + scenario have 1 each. case wins over scenario at tied 1 (asc).
  });
});

describe('M15.13 — sort total_count desc + prefix asc tie-break', () => {
  test('ordered by count then alphabetical', () => {
    const store = new InMemoryAuditTrailStore();
    // zebra=3, alpha=3, mike=1, bravo=2
    for (let i = 0; i < 3; i++) store.record('BIL', baseInput({ action: 'zebra.x' }), NOW);
    for (let i = 0; i < 3; i++) store.record('BIL', baseInput({ action: 'alpha.x' }), NOW);
    store.record('BIL', baseInput({ action: 'mike.x' }), NOW);
    for (let i = 0; i < 2; i++) store.record('BIL', baseInput({ action: 'bravo.x' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.prefixes.map((r) => r.prefix)).toEqual(['alpha', 'zebra', 'bravo', 'mike']);
    // alpha + zebra tied at 3 → alpha first (asc); then bravo (2); then mike (1).
  });
});

describe('M15.13 — by_outcome accumulation', () => {
  test('per-prefix outcomes track success / failure / denied', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'config.update', outcome: 'success' }), NOW);
    store.record('BIL', baseInput({ action: 'config.update', outcome: 'success' }), NOW);
    store.record('BIL', baseInput({ action: 'config.update', outcome: 'failure' }), NOW);
    store.record('BIL', baseInput({ action: 'config.update', outcome: 'denied' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    const cfg = s.prefixes[0]!;
    expect(cfg.by_outcome.success).toBe(2);
    expect(cfg.by_outcome.failure).toBe(1);
    expect(cfg.by_outcome.denied).toBe(1);
  });
});

describe('M15.13 — distinct_resource_types', () => {
  test('union of resource_types per prefix sorted asc', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'case.create', resource_type: 'case' }), NOW);
    store.record('BIL', baseInput({ action: 'case.update', resource_type: 'case' }), NOW); // dup
    store.record('BIL', baseInput({ action: 'case.note', resource_type: 'report' }), NOW); // different
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.prefixes[0]!.distinct_resource_types).toEqual(['case', 'report']);
  });
});

describe('M15.13 — distinct_actors', () => {
  test('union of actor_usernames per prefix sorted asc', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'config.update', actor_username: 'zoe' }), NOW);
    store.record('BIL', baseInput({ action: 'config.update', actor_username: 'alice' }), NOW);
    store.record('BIL', baseInput({ action: 'config.update', actor_username: 'mike' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.prefixes[0]!.distinct_actors).toEqual(['alice', 'mike', 'zoe']);
  });
});

describe('M15.13 — most_recent_at', () => {
  test('newest ts across this prefix', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = new Date('2026-05-10T10:00:00.000Z');
    const t2 = new Date('2026-05-15T10:00:00.000Z');
    const t3 = new Date('2026-05-16T10:00:00.000Z');
    store.record('BIL', baseInput({ action: 'config.update' }), t1);
    store.record('BIL', baseInput({ action: 'config.update' }), t3);
    store.record('BIL', baseInput({ action: 'config.update' }), t2);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.prefixes[0]!.most_recent_at).toBe(t3.toISOString());
  });
});

describe('M15.13 — unprefixed actions', () => {
  test('flat actions (no `.`) counted in unprefixed_count only', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'config.update' }), NOW);
    store.record('BIL', baseInput({ action: 'flatverb' }), NOW);
    store.record('BIL', baseInput({ action: 'anotherflat' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.total_events).toBe(3);
    expect(s.unprefixed_count).toBe(2);
    expect(s.prefixes).toHaveLength(1);
    expect(s.prefixes[0]!.prefix).toBe('config');
  });
});

describe('M15.13 — most_frequent_prefix', () => {
  test('top row of sorted prefixes; canonical tie-break', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'alpha.x' }), NOW);
    store.record('BIL', baseInput({ action: 'beta.x' }), NOW);
    store.record('BIL', baseInput({ action: 'beta.x' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.most_frequent_prefix).toEqual({ prefix: 'beta', total_count: 2 });
  });

  test('alpha-tie-break when counts equal', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'zebra.x' }), NOW);
    store.record('BIL', baseInput({ action: 'alpha.x' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.most_frequent_prefix).toEqual({ prefix: 'alpha', total_count: 1 });
  });

  test('null when only unprefixed events', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'flat' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.most_frequent_prefix).toBeNull();
    expect(s.total_prefixes).toBe(0);
  });

  test('null on empty', () => {
    const s = summarizeAuditActionPrefixDistribution('BIL', [], NOW);
    expect(s.most_frequent_prefix).toBeNull();
  });
});

describe('M15.13 — partition invariant', () => {
  test('Σ prefix.total_count + unprefixed_count = total_events', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'config.update' }), NOW);
    store.record('BIL', baseInput({ action: 'config.update' }), NOW);
    store.record('BIL', baseInput({ action: 'scenario.create' }), NOW);
    store.record('BIL', baseInput({ action: 'flat' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    const sum = s.prefixes.reduce((acc, r) => acc + r.total_count, 0);
    expect(sum + s.unprefixed_count).toBe(s.total_events);
    expect(s.total_events).toBe(4);
  });

  test('Σ by_outcome per row = total_count per row', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'config.update', outcome: 'success' }), NOW);
    store.record('BIL', baseInput({ action: 'config.update', outcome: 'failure' }), NOW);
    store.record('BIL', baseInput({ action: 'config.reset', outcome: 'denied' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    for (const row of s.prefixes) {
      const sum = Object.values(row.by_outcome).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.total_count);
    }
  });
});

describe('M15.13 — leading-dot edge case', () => {
  test('action starting with `.` treated as unprefixed', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: '.justverb' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.unprefixed_count).toBe(1);
    expect(s.total_prefixes).toBe(0);
  });
});

describe('M15.13 — multi-dot action', () => {
  test('only first `.` splits — `a.b.c` → prefix=a, verb=b.c', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ action: 'case.maker_checker.approve' }), NOW);
    const events = listAll(store, 'BIL');
    const s = summarizeAuditActionPrefixDistribution('BIL', events, NOW);
    expect(s.prefixes).toHaveLength(1);
    expect(s.prefixes[0]!.prefix).toBe('case');
    expect(s.prefixes[0]!.distinct_verbs).toEqual(['maker_checker.approve']);
  });
});

// ─── GET /v1/audit/action-prefix-distribution ────────────────────────

describe('M15.13 — GET /v1/audit/action-prefix-distribution', () => {
  test('admin → 200 with empty rollup', async () => {
    const { app } = makeApApp('admin');
    const r = await request(app).get('/v1/audit/action-prefix-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.prefixes).toEqual([]);
    expect(r.body.body.most_frequent_prefix).toBeNull();
  });

  test('populated rollup reflects recorded events', async () => {
    const { app, auditTrailStore } = makeApApp('admin');
    auditTrailStore.record('BIL', baseInput({ action: 'config.update' }), NOW);
    auditTrailStore.record('BIL', baseInput({ action: 'config.reset' }), NOW);
    auditTrailStore.record('BIL', baseInput({ action: 'scenario.create' }), NOW);
    const r = await request(app).get('/v1/audit/action-prefix-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(3);
    expect(r.body.body.total_prefixes).toBe(2);
    expect(r.body.body.most_frequent_prefix.prefix).toBe('config');
    expect(r.body.body.most_frequent_prefix.total_count).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeApApp('case_owner');
    const r = await request(app).get('/v1/audit/action-prefix-distribution').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL events invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeApApp('admin');
    auditTrailStore.record('BIL', baseInput({ action: 'config.update' }), NOW);
    const bank = await request(app)
      .get('/v1/audit/action-prefix-distribution')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_events).toBe(0);
  });

  test('M15.12 /v1/audit/resource-type-distribution still 200 (sibling regression)', async () => {
    const { app } = makeApApp('admin');
    const r = await request(app).get('/v1/audit/resource-type-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
