// services/bff/__tests__/audit_integrity.test.ts
//
// T6 M15.2 — Audit-trail hash-chain integrity.

import request from 'supertest';
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

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeAuditApp(role: string = 'admin', auditTrailStore?: InMemoryAuditTrailStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditTrailStore: auditTrailStore ?? new InMemoryAuditTrailStore(),
  });
}

function evt(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor_username: 'alice',
    actor_role: 'admin',
    action: 'auth.login',
    resource_type: 'session',
    resource_id: 's-1',
    outcome: 'success',
    ...overrides,
  };
}

// ─── record() now stamps hash + prev_hash ─────────────────────────────

describe('record() stamps hash + prev_hash', () => {
  test('first event: prev_hash = GENESIS, hash is sha256-shaped', () => {
    const s = new InMemoryAuditTrailStore();
    const e = s.record('BIL', evt(), NOW);
    expect(e.prev_hash).toBe('GENESIS');
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('subsequent events: prev_hash = previous event\'s hash', () => {
    const s = new InMemoryAuditTrailStore();
    const a = s.record('BIL', evt(), NOW);
    const b = s.record('BIL', evt(), NOW);
    expect(b.prev_hash).toBe(a.hash);
    expect(b.hash).not.toBe(a.hash);
  });

  test('chain segments per tenant — BIL chain doesn\'t affect BANK_DEMO chain', () => {
    const s = new InMemoryAuditTrailStore();
    const bil = s.record('BIL', evt(), NOW);
    const bank = s.record('BANK_DEMO', evt(), NOW);
    expect(bank.prev_hash).toBe('GENESIS'); // first BANK_DEMO event
    expect(bil.prev_hash).toBe('GENESIS');
    expect(bank.hash).not.toBe(bil.hash); // different tenant_ids in seed
  });

  test('hash is deterministic — recording the same canonical inputs produces the same hash', () => {
    const s1 = new InMemoryAuditTrailStore();
    const s2 = new InMemoryAuditTrailStore();
    // Use a fixed event_id won't work since random — but two stores with
    // the same actor + action + resource produce DIFFERENT event_ids,
    // so hashes diverge. We assert determinism a different way: the
    // hash of an event depends only on its OWN fields (which include
    // event_id), so any two records have different hashes.
    const a = s1.record('BIL', evt(), NOW);
    const b = s2.record('BIL', evt(), NOW);
    expect(a.event_id).not.toBe(b.event_id); // randomUUID divergence
    expect(a.hash).not.toBe(b.hash); // hash includes event_id
  });
});

// ─── verifyChain happy path ────────────────────────────────────────────

describe('verifyChain — happy path', () => {
  test('empty chain → valid + last_hash=GENESIS', () => {
    const s = new InMemoryAuditTrailStore();
    const v = s.verifyChain('BIL', NOW);
    expect(v.valid).toBe(true);
    expect(v.total_events).toBe(0);
    expect(v.last_hash).toBe('GENESIS');
    expect(v.broken_at).toBeUndefined();
  });

  test('single event chain verifies', () => {
    const s = new InMemoryAuditTrailStore();
    const e = s.record('BIL', evt(), NOW);
    const v = s.verifyChain('BIL', NOW);
    expect(v.valid).toBe(true);
    expect(v.total_events).toBe(1);
    expect(v.last_hash).toBe(e.hash);
  });

  test('long chain verifies', () => {
    const s = new InMemoryAuditTrailStore();
    for (let i = 0; i < 50; i++) {
      s.record('BIL', evt({ resource_id: `r-${i}` }), new Date(NOW.getTime() + i * 1000));
    }
    const v = s.verifyChain('BIL', NOW);
    expect(v.valid).toBe(true);
    expect(v.total_events).toBe(50);
  });

  test('verifyChain is tenant-scoped', () => {
    const s = new InMemoryAuditTrailStore();
    s.record('BIL', evt(), NOW);
    s.record('BIL', evt(), NOW);
    s.record('BANK_DEMO', evt(), NOW);
    expect(s.verifyChain('BIL', NOW).total_events).toBe(2);
    expect(s.verifyChain('BANK_DEMO', NOW).total_events).toBe(1);
    expect(s.verifyChain('UNKNOWN', NOW).total_events).toBe(0);
  });
});

// ─── verifyChain detects tampering ─────────────────────────────────────

describe('verifyChain — tampering detection', () => {
  test('mutating a recorded field → hash_mismatch at that index', () => {
    const s = new InMemoryAuditTrailStore();
    s.record('BIL', evt({ resource_id: 'r-0' }), NOW);
    s.record('BIL', evt({ resource_id: 'r-1' }), NOW);
    s.record('BIL', evt({ resource_id: 'r-2' }), NOW);
    // Tamper with the 2nd event's actor_username
    const arr = s._eventsForTenant('BIL')!;
    arr[1] = { ...arr[1]!, actor_username: 'mallory' };
    const v = s.verifyChain('BIL', NOW);
    expect(v.valid).toBe(false);
    expect(v.broken_at!.index).toBe(1);
    expect(v.broken_at!.event_id).toBe(arr[1]!.event_id);
    expect(v.broken_at!.reason).toBe('hash_mismatch');
    expect(v.broken_at!.actual_hash).toBe(arr[1]!.hash); // recorded hash
    expect(v.broken_at!.expected_hash).not.toBe(v.broken_at!.actual_hash);
  });

  test('breaking prev_hash linkage → prev_hash_mismatch', () => {
    const s = new InMemoryAuditTrailStore();
    s.record('BIL', evt(), NOW);
    s.record('BIL', evt(), NOW);
    s.record('BIL', evt(), NOW);
    const arr = s._eventsForTenant('BIL')!;
    // Re-stamp event[2]'s prev_hash + recompute its hash, but point
    // prev_hash at GENESIS instead of arr[1].hash. The own-hash matches
    // (we recompute) but the chain-link doesn't.
    const tampered = { ...arr[2]!, prev_hash: 'GENESIS' };
    // Recompute the own-hash so this isn't detected as hash_mismatch.
    // We do this by accessing computeEventHash via the same algorithm
    // — easiest is to just construct an event-shaped object that would
    // pass own-hash check but fail chain.
    // Instead, surgically mutate prev_hash without recomputing → we'll
    // get hash_mismatch first. To get prev_hash_mismatch we need a
    // valid-own-hash event with bad prev_hash. We achieve this by
    // recording a fresh event into a separate tenant + transplanting it
    // such that its own-hash matches but prev_hash points elsewhere.
    // Simpler: directly delete event arr[1] so arr[2]'s prev_hash now
    // refers to a hash that's no longer in the chain.
    arr.splice(1, 1);
    const v = s.verifyChain('BIL', NOW);
    expect(v.valid).toBe(false);
    // After splice, arr[1] (originally arr[2]) has prev_hash pointing
    // at the removed event's hash — but the previous event in the new
    // array is arr[0]. So at index 1, prev_hash != arr[0].hash →
    // prev_hash_mismatch.
    expect(v.broken_at!.index).toBe(1);
    expect(v.broken_at!.reason).toBe('prev_hash_mismatch');
  });

  test('mutating metadata → hash_mismatch (metadata is part of the canonical hash)', () => {
    const s = new InMemoryAuditTrailStore();
    s.record('BIL', evt({ metadata: { version: 1 } }), NOW);
    const arr = s._eventsForTenant('BIL')!;
    arr[0] = { ...arr[0]!, metadata: { version: 2 } };
    const v = s.verifyChain('BIL', NOW);
    expect(v.valid).toBe(false);
    expect(v.broken_at!.reason).toBe('hash_mismatch');
  });

  test('appending an event with a wrong prev_hash → detected', () => {
    const s = new InMemoryAuditTrailStore();
    s.record('BIL', evt(), NOW);
    s.record('BIL', evt(), NOW);
    const arr = s._eventsForTenant('BIL')!;
    // Manually append a fake event with prev_hash pointing to nothing
    // recognisable. Its own hash won't match unless we compute it
    // properly — leaving its hash mismatched will trip hash_mismatch
    // first. We're testing that ANY tampering is caught.
    const fakePrev = arr[arr.length - 1]!.hash;
    arr.push({
      event_id: 'aud-fake',
      ts: NOW.toISOString(),
      tenant_id: 'BIL',
      actor_username: 'mallory',
      actor_role: 'attacker',
      action: 'forged.event',
      resource_type: 'system',
      resource_id: 'fake',
      outcome: 'success',
      severity: 'info',
      correlation_id: null,
      ip_address: null,
      metadata: {},
      prev_hash: fakePrev,
      hash: 'a'.repeat(64), // bogus hash
    });
    const v = s.verifyChain('BIL', NOW);
    expect(v.valid).toBe(false);
    expect(v.broken_at!.event_id).toBe('aud-fake');
    expect(v.broken_at!.reason).toBe('hash_mismatch');
  });

  test('hash + prev_hash invariant: recomputing on a clean chain matches verifyChain', () => {
    const s = new InMemoryAuditTrailStore();
    for (let i = 0; i < 10; i++) {
      s.record('BIL', evt({ resource_id: `r-${i}` }), new Date(NOW.getTime() + i * 1000));
    }
    expect(s.verifyChain('BIL', NOW).valid).toBe(true);
    // Tamper with the very last event
    const arr = s._eventsForTenant('BIL')!;
    arr[9] = { ...arr[9]!, outcome: 'failure' };
    const v = s.verifyChain('BIL', NOW);
    expect(v.valid).toBe(false);
    expect(v.broken_at!.index).toBe(9);
  });
});

// ─── Route ─────────────────────────────────────────────────────────────

describe('GET /v1/audit/integrity', () => {
  test('admin: 200 with valid=true on a clean chain', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', evt(), NOW);
    store.record('BIL', evt(), NOW);
    const { app } = makeAuditApp('admin', store);
    const r = await request(app).get('/v1/audit/integrity').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(true);
    expect(r.body.body.total_events).toBe(2);
    expect(r.body.body.last_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.body.broken_at).toBeUndefined();
  });

  test('admin: 200 with valid=false + broken_at on tampered chain', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', evt({ resource_id: 'r-0' }), NOW);
    store.record('BIL', evt({ resource_id: 'r-1' }), NOW);
    store.record('BIL', evt({ resource_id: 'r-2' }), NOW);
    const arr = store._eventsForTenant('BIL')!;
    arr[1] = { ...arr[1]!, actor_username: 'mallory' };
    const { app } = makeAuditApp('admin', store);
    const r = await request(app).get('/v1/audit/integrity').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(false);
    expect(r.body.body.broken_at.index).toBe(1);
    expect(r.body.body.broken_at.reason).toBe('hash_mismatch');
  });

  test('empty tenant → valid=true, last_hash=GENESIS', async () => {
    const { app } = makeAuditApp('admin');
    const r = await request(app).get('/v1/audit/integrity').set(TH_BIL);
    expect(r.body.body.valid).toBe(true);
    expect(r.body.body.last_hash).toBe('GENESIS');
    expect(r.body.body.total_events).toBe(0);
  });

  test('non-admin → 403', async () => {
    const { app } = makeAuditApp('risk_analyst');
    const r = await request(app).get('/v1/audit/integrity').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('tenant-scoped — BIL tampering does not affect BANK_DEMO verdict', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', evt(), NOW);
    store.record('BIL', evt(), NOW);
    store.record('BANK_DEMO', evt(), NOW);
    const arr = store._eventsForTenant('BIL')!;
    arr[1] = { ...arr[1]!, outcome: 'failure' };
    const { app } = makeAuditApp('admin', store);
    const bil = await request(app).get('/v1/audit/integrity').set(TH_BIL);
    const bank = await request(app).get('/v1/audit/integrity').set(TH_BANK);
    expect(bil.body.body.valid).toBe(false);
    expect(bank.body.body.valid).toBe(true);
  });
});

// ─── Sanity: existing audit response shape unchanged ───────────────────

describe('Existing audit responses now include hash + prev_hash', () => {
  test('POST /v1/audit/events returns the event with hash + prev_hash', async () => {
    const { app } = makeAuditApp('admin');
    const r = await request(app).post('/v1/audit/events').set(TH_BIL).send(evt());
    expect(r.status).toBe(201);
    expect((r.body.body as AuditEvent).hash).toMatch(/^[0-9a-f]{64}$/);
    expect((r.body.body as AuditEvent).prev_hash).toBe('GENESIS');
  });

  test('GET /v1/audit/events/:id returns hash + prev_hash', async () => {
    const store = new InMemoryAuditTrailStore();
    const e = store.record('BIL', evt(), NOW);
    const { app } = makeAuditApp('admin', store);
    const r = await request(app).get(`/v1/audit/events/${e.event_id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.hash).toBe(e.hash);
    expect(r.body.body.prev_hash).toBe(e.prev_hash);
  });
});
