// services/bff/__tests__/audit_chain_sample.test.ts
//
// T6 M15.5 — Audit log integrity spot-check (sample window).

import request from 'supertest';
import {
  CHAIN_SAMPLE_DEFAULT_WINDOW,
  CHAIN_SAMPLE_MAX_WINDOW,
  InMemoryAuditTrailStore,
  type AuditEventInput,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkInput(n: number, overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor_username: overrides.actor_username ?? 'alice',
    actor_role: overrides.actor_role ?? 'admin',
    action: overrides.action ?? `test.event_${n}`,
    resource_type: overrides.resource_type ?? 'system',
    resource_id: overrides.resource_id ?? `resource-${n}`,
    outcome: overrides.outcome ?? 'success',
    severity: overrides.severity ?? 'info',
    metadata: overrides.metadata ?? { n },
  };
}

function seedChain(store: InMemoryAuditTrailStore, tenant: string, count: number) {
  for (let i = 0; i < count; i++) {
    store.record(tenant, mkInput(i), new Date(NOW.getTime() + i * 1000));
  }
}

// ─── verifyChainSample — store-level ──────────────────────────────────

describe('M15.5 — verifyChainSample — empty + zero state', () => {
  test('empty tenant → valid=true, sample_size=0, last_hash=GENESIS', () => {
    const store = new InMemoryAuditTrailStore();
    const out = store.verifyChainSample('BIL', 50, NOW);
    expect(out.valid).toBe(true);
    expect(out.total_events).toBe(0);
    expect(out.sample_size).toBe(0);
    expect(out.window_start_index).toBe(0);
    expect(out.last_hash).toBe('GENESIS');
  });

  test('non-positive window → returns sample_size=0 with valid=true (route is the validation gate)', () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 3);
    const out = store.verifyChainSample('BIL', 0, NOW);
    expect(out.valid).toBe(true);
    expect(out.sample_size).toBe(0);
  });
});

describe('M15.5 — verifyChainSample — clean chains', () => {
  test('window smaller than total → sample covers newest N, window_start_index correct', () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 10);
    const out = store.verifyChainSample('BIL', 3, NOW);
    expect(out.valid).toBe(true);
    expect(out.total_events).toBe(10);
    expect(out.sample_size).toBe(3);
    expect(out.window_start_index).toBe(7);
  });

  test('window larger than total → sample covers entire chain, window_start_index=0', () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 4);
    const out = store.verifyChainSample('BIL', 50, NOW);
    expect(out.valid).toBe(true);
    expect(out.total_events).toBe(4);
    expect(out.sample_size).toBe(4);
    expect(out.window_start_index).toBe(0);
  });

  test('result agrees with full verifyChain on a clean chain', () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 12);
    const full = store.verifyChain('BIL', NOW);
    const sample = store.verifyChainSample('BIL', 5, NOW);
    expect(sample.valid).toBe(full.valid); // both true
    expect(sample.last_hash).toBe(full.last_hash); // newest event's hash
  });
});

describe('M15.5 — verifyChainSample — tampering detection', () => {
  test('hash tampered on an event INSIDE the window → broken_at.reason=hash_mismatch', () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 10);
    // Tamper event at index 8 (within a window=3 → indices 7..9).
    const events = store._eventsForTenant('BIL')!;
    events[8] = { ...events[8]!, actor_username: 'mallory' };
    const out = store.verifyChainSample('BIL', 3, NOW);
    expect(out.valid).toBe(false);
    expect(out.broken_at?.index).toBe(8);
    expect(out.broken_at?.reason).toBe('hash_mismatch');
  });

  test('first-in-window prev_hash mismatch → caught against event-before-window', () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 10);
    // Tamper prev_hash on index 7 (the first event in a window=3 sample).
    const events = store._eventsForTenant('BIL')!;
    events[7] = { ...events[7]!, prev_hash: 'TAMPERED' };
    const out = store.verifyChainSample('BIL', 3, NOW);
    expect(out.valid).toBe(false);
    expect(out.broken_at?.index).toBe(7);
    expect(out.broken_at?.reason).toBe('hash_mismatch'); // prev_hash is part of the hash input
  });

  test('tampering OUTSIDE the window goes undetected by sample (full chain catches it)', () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 10);
    // Tamper an event at index 2 (well outside a window=3 sample over indices 7..9).
    const events = store._eventsForTenant('BIL')!;
    events[2] = { ...events[2]!, actor_username: 'mallory' };
    const sample = store.verifyChainSample('BIL', 3, NOW);
    expect(sample.valid).toBe(true); // sample window is clean
    const full = store.verifyChain('BIL', NOW);
    expect(full.valid).toBe(false); // full walk catches it
    expect(full.broken_at?.index).toBe(2);
  });
});

describe('M15.5 — verifyChainSample — tenant isolation', () => {
  test('per-tenant verification: tampering in tenant A does not affect tenant B sample', () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 5);
    seedChain(store, 'BANK_DEMO', 5);
    const events = store._eventsForTenant('BIL')!;
    events[2] = { ...events[2]!, actor_username: 'mallory' };
    const bilSample = store.verifyChainSample('BIL', 5, NOW);
    const demoSample = store.verifyChainSample('BANK_DEMO', 5, NOW);
    expect(bilSample.valid).toBe(false);
    expect(demoSample.valid).toBe(true);
  });
});

// ─── GET /v1/audit/integrity/sample ──────────────────────────────────

function makeSampleApp(role = 'admin', store?: InMemoryAuditTrailStore) {
  const auditTrailStore = store ?? new InMemoryAuditTrailStore();
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

describe('M15.5 — GET /v1/audit/integrity/sample', () => {
  test('empty tenant → 200 valid=true, default window', async () => {
    const { app } = makeSampleApp('admin');
    const r = await request(app).get('/v1/audit/integrity/sample').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(true);
    expect(r.body.body.window_size).toBe(CHAIN_SAMPLE_DEFAULT_WINDOW);
    expect(r.body.body.sample_size).toBe(0);
  });

  test('?window=5 honoured', async () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 12);
    const { app } = makeSampleApp('admin', store);
    const r = await request(app).get('/v1/audit/integrity/sample?window=5').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.window_size).toBe(5);
    expect(r.body.body.sample_size).toBe(5);
    expect(r.body.body.window_start_index).toBe(7);
    expect(r.body.body.valid).toBe(true);
  });

  test('?window=0 → 400', async () => {
    const { app } = makeSampleApp('admin');
    const r = await request(app).get('/v1/audit/integrity/sample?window=0').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test(`?window > ${CHAIN_SAMPLE_MAX_WINDOW} → 400`, async () => {
    const { app } = makeSampleApp('admin');
    const r = await request(app)
      .get(`/v1/audit/integrity/sample?window=${CHAIN_SAMPLE_MAX_WINDOW + 1}`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('?window=abc → 400 (NaN)', async () => {
    const { app } = makeSampleApp('admin');
    const r = await request(app).get('/v1/audit/integrity/sample?window=abc').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('tampering in window → 200 valid=false with broken_at', async () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 10);
    const events = store._eventsForTenant('BIL')!;
    events[8] = { ...events[8]!, actor_username: 'mallory' };
    const { app } = makeSampleApp('admin', store);
    const r = await request(app).get('/v1/audit/integrity/sample?window=3').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(false);
    expect(r.body.body.broken_at.index).toBe(8);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSampleApp('case_owner');
    const r = await request(app).get('/v1/audit/integrity/sample').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL tampering invisible to BANK_DEMO sample', async () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 5);
    seedChain(store, 'BANK_DEMO', 5);
    const events = store._eventsForTenant('BIL')!;
    events[2] = { ...events[2]!, actor_username: 'mallory' };
    const { app } = makeSampleApp('admin', store);
    const r = await request(app)
      .get('/v1/audit/integrity/sample?window=5')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.body.body.valid).toBe(true);
  });

  test('M15.2 /v1/audit/integrity still works (sample route is additive)', async () => {
    const store = new InMemoryAuditTrailStore();
    seedChain(store, 'BIL', 3);
    const { app } = makeSampleApp('admin', store);
    const r = await request(app).get('/v1/audit/integrity').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(true);
  });
});
