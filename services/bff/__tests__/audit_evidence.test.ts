// services/bff/__tests__/audit_evidence.test.ts
//
// T6 M15.3 — Audit evidence packaging.

import request from 'supertest';
import {
  EvidenceError,
  InMemoryEvidencePackageStore,
  buildEvidencePackage,
  validateFilters,
} from '../src/audit_evidence';
import {
  InMemoryAuditTrailStore,
  type AuditEventInput,
  type AuditTrailStore,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── Helpers ──────────────────────────────────────────────────────────

function seededAudit(events: Array<{ at?: Date; ev: AuditEventInput }> = []): AuditTrailStore {
  const store = new InMemoryAuditTrailStore();
  for (const { at, ev } of events) {
    store.record('BIL', ev, at ?? NOW);
  }
  return store;
}

function ev(over: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor_username: 'admin',
    actor_role: 'admin',
    action: 'config.update',
    resource_type: 'config',
    resource_id: 'res-1',
    outcome: 'success',
    ...over,
  };
}

// ─── validateFilters ──────────────────────────────────────────────────

describe('validateFilters', () => {
  test('empty input returns empty filters', () => {
    expect(validateFilters({})).toEqual({});
    expect(validateFilters(undefined)).toEqual({});
    expect(validateFilters(null)).toEqual({});
  });

  test('non-object input → invalid_input', () => {
    expect(() => validateFilters('foo')).toThrow(EvidenceError);
    expect(() => validateFilters([])).toThrow(EvidenceError);
  });

  test('valid since/until pass through', () => {
    const out = validateFilters({
      since: '2026-04-01T00:00:00Z',
      until: '2026-04-30T23:59:59Z',
    });
    expect(out.since).toBe('2026-04-01T00:00:00Z');
    expect(out.until).toBe('2026-04-30T23:59:59Z');
  });

  test('non-ISO since rejected', () => {
    expect(() => validateFilters({ since: 'yesterday' })).toThrow(/ISO-8601/);
  });

  test('since > until rejected', () => {
    expect(() =>
      validateFilters({
        since: '2026-04-30T00:00:00Z',
        until: '2026-04-01T00:00:00Z',
      }),
    ).toThrow(/since must be ≤ until/);
  });

  test('actor_username/action/resource_id pass through', () => {
    const out = validateFilters({
      actor_username: 'alice',
      action: 'config.update',
      resource_id: 'CASE-123',
    });
    expect(out.actor_username).toBe('alice');
    expect(out.action).toBe('config.update');
    expect(out.resource_id).toBe('CASE-123');
  });

  test('blank string rejected', () => {
    expect(() => validateFilters({ actor_username: '   ' })).toThrow(/non-empty/);
  });

  test('overlong string rejected (> 200 chars)', () => {
    expect(() => validateFilters({ resource_id: 'x'.repeat(201) })).toThrow(/≤ 200/);
  });

  test('invalid resource_type → invalid_resource_type', () => {
    try {
      validateFilters({ resource_type: 'crypto' });
      fail('expected throw');
    } catch (e) {
      expect((e as EvidenceError).code).toBe('invalid_resource_type');
    }
  });

  test('invalid outcome → invalid_outcome', () => {
    try {
      validateFilters({ outcome: 'maybe' });
      fail('expected throw');
    } catch (e) {
      expect((e as EvidenceError).code).toBe('invalid_outcome');
    }
  });

  test('invalid severity → invalid_severity', () => {
    try {
      validateFilters({ severity: 'extreme' });
      fail('expected throw');
    } catch (e) {
      expect((e as EvidenceError).code).toBe('invalid_severity');
    }
  });

  test('valid resource_type / outcome / severity pass through', () => {
    const out = validateFilters({
      resource_type: 'case',
      outcome: 'success',
      severity: 'critical',
    });
    expect(out.resource_type).toBe('case');
    expect(out.outcome).toBe('success');
    expect(out.severity).toBe('critical');
  });
});

// ─── buildEvidencePackage ─────────────────────────────────────────────

describe('buildEvidencePackage', () => {
  test('empty audit → empty package + chain_verified=true', () => {
    const audit = seededAudit();
    const pkg = buildEvidencePackage(audit, 'BIL', {}, 'admin', NOW, 1);
    expect(pkg.tenant_id).toBe('BIL');
    expect(pkg.event_count).toBe(0);
    expect(pkg.events).toEqual([]);
    expect(pkg.integrity.chain_verified).toBe(true);
    expect(pkg.integrity.first_event_hash).toBeNull();
    expect(pkg.integrity.last_event_hash).toBeNull();
    expect(pkg.size_bytes).toBe(2); // "[]"
  });

  test('package_id format EVD-{tenant}-{ts}-{seq}', () => {
    const audit = seededAudit();
    const pkg = buildEvidencePackage(audit, 'BIL', {}, 'admin', NOW, 7);
    expect(pkg.package_id).toMatch(/^EVD-BIL-\d{14}-0007$/);
  });

  test('captures all events when no filters', () => {
    const audit = seededAudit([
      { ev: ev({ resource_id: 'A' }) },
      { ev: ev({ resource_id: 'B' }) },
      { ev: ev({ resource_id: 'C' }) },
    ]);
    const pkg = buildEvidencePackage(audit, 'BIL', {}, 'admin', NOW, 1);
    expect(pkg.event_count).toBe(3);
    // Oldest-first order (matches chain order)
    expect(pkg.events.map((e) => e.resource_id)).toEqual(['A', 'B', 'C']);
  });

  test('filters by resource_id (post-filter, M15.1 doesnt index)', () => {
    const audit = seededAudit([
      { ev: ev({ resource_id: 'A' }) },
      { ev: ev({ resource_id: 'B' }) },
      { ev: ev({ resource_id: 'A' }) },
    ]);
    const pkg = buildEvidencePackage(audit, 'BIL', { resource_id: 'A' }, 'admin', NOW, 1);
    expect(pkg.event_count).toBe(2);
    expect(pkg.events.every((e) => e.resource_id === 'A')).toBe(true);
  });

  test('filters by actor_username', () => {
    const audit = seededAudit([
      { ev: ev({ actor_username: 'alice' }) },
      { ev: ev({ actor_username: 'bob' }) },
    ]);
    const pkg = buildEvidencePackage(audit, 'BIL', { actor_username: 'alice' }, 'admin', NOW, 1);
    expect(pkg.event_count).toBe(1);
    expect(pkg.events[0]!.actor_username).toBe('alice');
  });

  test('filters by resource_type', () => {
    const audit = seededAudit([
      { ev: ev({ resource_type: 'case' }) },
      { ev: ev({ resource_type: 'config' }) },
      { ev: ev({ resource_type: 'case' }) },
    ]);
    const pkg = buildEvidencePackage(audit, 'BIL', { resource_type: 'case' }, 'admin', NOW, 1);
    expect(pkg.event_count).toBe(2);
  });

  test('filters by outcome', () => {
    const audit = seededAudit([
      { ev: ev({ outcome: 'success' }) },
      { ev: ev({ outcome: 'failure' }) },
      { ev: ev({ outcome: 'denied' }) },
    ]);
    const pkg = buildEvidencePackage(audit, 'BIL', { outcome: 'failure' }, 'admin', NOW, 1);
    expect(pkg.event_count).toBe(1);
    expect(pkg.events[0]!.outcome).toBe('failure');
  });

  test('integrity carries chain_last_hash, first/last event hashes', () => {
    const audit = seededAudit([{ ev: ev() }, { ev: ev() }, { ev: ev() }]);
    const pkg = buildEvidencePackage(audit, 'BIL', {}, 'admin', NOW, 1);
    expect(pkg.integrity.chain_verified).toBe(true);
    expect(pkg.integrity.first_event_hash).toBe(pkg.events[0]!.hash);
    expect(pkg.integrity.last_event_hash).toBe(pkg.events[pkg.events.length - 1]!.hash);
    expect(pkg.integrity.chain_last_hash).toBe(pkg.events[pkg.events.length - 1]!.hash);
  });

  test('size_bytes is canonical JSON length', () => {
    const audit = seededAudit([{ ev: ev() }]);
    const pkg = buildEvidencePackage(audit, 'BIL', {}, 'admin', NOW, 1);
    expect(pkg.size_bytes).toBe(Buffer.byteLength(JSON.stringify(pkg.events), 'utf8'));
    expect(pkg.size_bytes).toBeGreaterThan(0);
  });

  test('generated_by + generated_at echoed', () => {
    const audit = seededAudit();
    const pkg = buildEvidencePackage(audit, 'BIL', {}, 'compliance.lead', NOW, 1);
    expect(pkg.generated_by).toBe('compliance.lead');
    expect(pkg.generated_at).toBe(NOW.toISOString());
  });

  test('rejects empty generated_by', () => {
    const audit = seededAudit();
    expect(() => buildEvidencePackage(audit, 'BIL', {}, '', NOW, 1)).toThrow(/generated_by/);
    expect(() => buildEvidencePackage(audit, 'BIL', {}, '   ', NOW, 1)).toThrow(/generated_by/);
  });

  test('rejects empty tenant_id', () => {
    const audit = seededAudit();
    expect(() => buildEvidencePackage(audit, '', {}, 'admin', NOW, 1)).toThrow(/tenant_id/);
  });

  test('cross-tenant isolation — only BIL events captured', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', ev({ resource_id: 'BIL-1' }), NOW);
    store.record('BANK_DEMO', ev({ resource_id: 'BANK-1' }), NOW);
    store.record('BIL', ev({ resource_id: 'BIL-2' }), NOW);
    const pkg = buildEvidencePackage(store, 'BIL', {}, 'admin', NOW, 1);
    expect(pkg.event_count).toBe(2);
    expect(pkg.events.every((e) => e.tenant_id === 'BIL')).toBe(true);
  });
});

// ─── InMemoryEvidencePackageStore ─────────────────────────────────────

describe('InMemoryEvidencePackageStore', () => {
  test('create + get round-trip', () => {
    const audit = seededAudit([{ ev: ev() }]);
    const store = new InMemoryEvidencePackageStore();
    const pkg = store.create('BIL', audit, 'admin', {}, NOW);
    const fetched = store.get('BIL', pkg.package_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.package_id).toBe(pkg.package_id);
  });

  test('seq increments per tenant', () => {
    const audit = seededAudit();
    const store = new InMemoryEvidencePackageStore();
    const a = store.create('BIL', audit, 'admin', {}, NOW);
    const b = store.create('BIL', audit, 'admin', {}, NOW);
    expect(a.package_id).toMatch(/-0001$/);
    expect(b.package_id).toMatch(/-0002$/);
  });

  test('cap = 100 default — oldest evicted', () => {
    const audit = seededAudit();
    const store = new InMemoryEvidencePackageStore({ cap: 3 });
    const a = store.create('BIL', audit, 'admin', {}, NOW);
    store.create('BIL', audit, 'admin', {}, NOW);
    store.create('BIL', audit, 'admin', {}, NOW);
    store.create('BIL', audit, 'admin', {}, NOW); // evicts a
    expect(store.get('BIL', a.package_id)).toBeNull();
    const r = store.list('BIL', 1, 10);
    expect(r.total).toBe(3);
  });

  test('list newest-first + paginated', () => {
    const audit = seededAudit();
    const store = new InMemoryEvidencePackageStore();
    for (let i = 0; i < 5; i++) {
      store.create('BIL', audit, 'admin', {}, NOW);
    }
    const r = store.list('BIL', 1, 2);
    expect(r.items.length).toBe(2);
    expect(r.total).toBe(5);
    expect(r.items[0]!.package_id).toMatch(/-0005$/);
    expect(r.items[1]!.package_id).toMatch(/-0004$/);
  });

  test('cross-tenant isolation', () => {
    const audit = seededAudit();
    const store = new InMemoryEvidencePackageStore();
    const a = store.create('BIL', audit, 'admin', {}, NOW);
    const b = store.create('BANK_DEMO', audit, 'admin', {}, NOW);
    expect(store.get('BIL', a.package_id)?.package_id).toBe(a.package_id);
    expect(store.get('BIL', b.package_id)).toBeNull();
    expect(store.get('BANK_DEMO', a.package_id)).toBeNull();
  });

  test('get returns null on miss', () => {
    const store = new InMemoryEvidencePackageStore();
    expect(store.get('BIL', 'NO-SUCH')).toBeNull();
  });

  test('list page_size capped at 50', () => {
    const audit = seededAudit();
    const store = new InMemoryEvidencePackageStore();
    const r = store.list('BIL', 1, 9999);
    expect(r.page_size).toBe(50);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

function makeEvidenceApp(role: string = 'admin') {
  // Per-test isolated stores so cross-test state doesn't leak.
  const audit = new InMemoryAuditTrailStore();
  const evidence = new InMemoryEvidencePackageStore();
  // Seed a few events.
  audit.record('BIL', ev({ resource_id: 'CASE-1', actor_username: 'alice' }), NOW);
  audit.record('BIL', ev({ resource_id: 'CASE-2', actor_username: 'bob' }), NOW);
  audit.record('BIL', ev({ resource_id: 'CASE-1', actor_username: 'alice', outcome: 'failure' }), NOW);
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore: audit,
    evidenceStore: evidence,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, audit, evidence };
}

describe('POST /v1/audit/evidence', () => {
  test('admin: 201 with package body', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app)
      .post('/v1/audit/evidence')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send({});
    expect(r.status).toBe(201);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.event_count).toBe(3);
    expect(r.body.body.generated_by).toBe('compliance.lead');
  });

  test('accepts enveloped body', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app)
      .post('/v1/audit/evidence')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { resource_id: 'CASE-1' } });
    expect(r.status).toBe(201);
    expect(r.body.body.event_count).toBe(2);
  });

  test('filter by actor_username', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app)
      .post('/v1/audit/evidence')
      .set(TH_BIL)
      .send({ actor_username: 'bob' });
    expect(r.status).toBe(201);
    expect(r.body.body.event_count).toBe(1);
    expect(r.body.body.events[0].actor_username).toBe('bob');
  });

  test('filter by resource_id captures only matching events', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app)
      .post('/v1/audit/evidence')
      .set(TH_BIL)
      .send({ resource_id: 'CASE-1' });
    expect(r.status).toBe(201);
    expect(r.body.body.event_count).toBe(2);
    expect(r.body.body.events.every((e: { resource_id: string }) => e.resource_id === 'CASE-1')).toBe(true);
  });

  test('integrity carries chain_verified=true on clean chain', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app).post('/v1/audit/evidence').set(TH_BIL).send({});
    expect(r.body.body.integrity.chain_verified).toBe(true);
    expect(r.body.body.integrity.chain_last_hash).toMatch(/^[0-9a-f]+$/);
  });

  test('invalid resource_type → 400 EWS_400_invalid_resource_type', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app)
      .post('/v1/audit/evidence')
      .set(TH_BIL)
      .send({ resource_type: 'crypto' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_resource_type');
  });

  test('invalid outcome → 400 EWS_400_invalid_outcome', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app)
      .post('/v1/audit/evidence')
      .set(TH_BIL)
      .send({ outcome: 'maybe' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_outcome');
  });

  test('non-ISO since → 400 EWS_400_invalid_input', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app)
      .post('/v1/audit/evidence')
      .set(TH_BIL)
      .send({ since: 'yesterday' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('since > until → 400 EWS_400_invalid_input', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app)
      .post('/v1/audit/evidence')
      .set(TH_BIL)
      .send({
        since: '2026-04-30T00:00:00Z',
        until: '2026-04-01T00:00:00Z',
      });
    expect(r.status).toBe(400);
  });

  test('default generated_by = admin when no X-APEX-USER', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app).post('/v1/audit/evidence').set(TH_BIL).send({});
    expect(r.body.body.generated_by).toBe('admin');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeEvidenceApp('case_owner');
    const r = await request(app).post('/v1/audit/evidence').set(TH_BIL).send({});
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/audit/evidence', () => {
  test('admin: 200, lists newest-first', async () => {
    const { app } = makeEvidenceApp('admin');
    await request(app).post('/v1/audit/evidence').set(TH_BIL).send({});
    await request(app).post('/v1/audit/evidence').set(TH_BIL).send({ resource_id: 'CASE-1' });
    const r = await request(app).get('/v1/audit/evidence').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.items[0].package_id).toMatch(/-0002$/);
  });

  test('pagination', async () => {
    const { app } = makeEvidenceApp('admin');
    for (let i = 0; i < 4; i++) {
      await request(app).post('/v1/audit/evidence').set(TH_BIL).send({});
    }
    const r = await request(app).get('/v1/audit/evidence?page=2&page_size=2').set(TH_BIL);
    expect(r.body.body.items.length).toBe(2);
    expect(r.body.body.page).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeEvidenceApp('case_owner');
    const r = await request(app).get('/v1/audit/evidence').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/audit/evidence/:package_id', () => {
  test('admin: 200 with package', async () => {
    const { app } = makeEvidenceApp('admin');
    const created = await request(app).post('/v1/audit/evidence').set(TH_BIL).send({});
    const id = created.body.body.package_id;
    const r = await request(app).get(`/v1/audit/evidence/${id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.package_id).toBe(id);
  });

  test('unknown id → 404 EWS_404_unknown_package', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app).get('/v1/audit/evidence/EVD-NO-SUCH').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_package');
  });

  test('cross-tenant 404 — BANK_DEMO cannot fetch BIL package', async () => {
    const { app } = makeEvidenceApp('admin');
    const created = await request(app).post('/v1/audit/evidence').set(TH_BIL).send({});
    const id = created.body.body.package_id;
    const r = await request(app)
      .get(`/v1/audit/evidence/${id}`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeEvidenceApp('case_owner');
    const r = await request(app).get('/v1/audit/evidence/EVD-X').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M15.1 + M15.2 audit routes still work', () => {
  test('GET /v1/audit/events still 200', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app).get('/v1/audit/events').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(3);
  });

  test('GET /v1/audit/integrity still 200', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app).get('/v1/audit/integrity').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(true);
  });

  test('GET /v1/audit/events/:event_id still 200 (sub-path didnt shadow)', async () => {
    const { app, audit } = makeEvidenceApp('admin');
    const event_id = audit.list('BIL', { page_size: 1 }).items[0]!.event_id;
    const r = await request(app).get(`/v1/audit/events/${event_id}`).set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/audit/summary still 200', async () => {
    const { app } = makeEvidenceApp('admin');
    const r = await request(app).get('/v1/audit/summary').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
