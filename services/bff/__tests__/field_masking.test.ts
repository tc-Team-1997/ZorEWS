// services/bff/__tests__/field_masking.test.ts
//
// Phase D.2 — Field-Level Masking admin tests.

import request from 'supertest';
import {
  ALL_MASKING_STRATEGIES,
  applyStrategy,
  applyMasking,
  selectApplicablePolicies,
  isMaskingStrategy,
  InMemoryFieldMaskingStore,
  FieldMaskingError,
  FIELD_MASKING_CAP_PER_TENANT,
  type FieldMaskingPolicy,
} from '../src/security/field_masking';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T10:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeMaskingApp(
  role: string = 'admin',
  overrides: { fieldMaskingStore?: InMemoryFieldMaskingStore } = {},
) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    fieldMaskingStore: overrides.fieldMaskingStore ?? new InMemoryFieldMaskingStore(),
  });
  return app;
}

// ── 1. Type guards + closed enum ──────────────────────────────────────

describe('field_masking constants', () => {
  test('ALL_MASKING_STRATEGIES is a stable 5-value enum', () => {
    expect(ALL_MASKING_STRATEGIES).toEqual([
      'redact', 'hash_last4', 'partial_email', 'fixed_label', 'null',
    ]);
  });

  test('isMaskingStrategy accepts every declared value', () => {
    for (const s of ALL_MASKING_STRATEGIES) {
      expect(isMaskingStrategy(s)).toBe(true);
    }
    expect(isMaskingStrategy('mystery')).toBe(false);
    expect(isMaskingStrategy(42)).toBe(false);
  });
});

// ── 2. applyStrategy ──────────────────────────────────────────────────

describe('applyStrategy', () => {
  test('redact replaces with [REDACTED]', () => {
    expect(applyStrategy('alice@example.com', 'redact', null)).toBe('[REDACTED]');
    expect(applyStrategy(12345, 'redact', null)).toBe('[REDACTED]');
  });

  test('fixed_label replaces with custom replacement', () => {
    expect(applyStrategy('1234', 'fixed_label', '****')).toBe('****');
  });

  test('null strategy returns JSON null', () => {
    expect(applyStrategy('anything', 'null', null)).toBeNull();
  });

  test('hash_last4 is deterministic per-value, hex-tail', () => {
    const a = applyStrategy('alice@example.com', 'hash_last4', null);
    const b = applyStrategy('alice@example.com', 'hash_last4', null);
    expect(a).toBe(b);
    expect(a).toMatch(/^\*\*\*[0-9a-f]{4}$/);
  });

  test('hash_last4 differs for different inputs', () => {
    const a = applyStrategy('alice@example.com', 'hash_last4', null);
    const b = applyStrategy('bob@example.com', 'hash_last4', null);
    expect(a).not.toBe(b);
  });

  test('partial_email keeps first letter + domain', () => {
    expect(applyStrategy('alice@example.com', 'partial_email', null)).toBe('a***@example.com');
  });

  test('partial_email on non-email string falls back to [REDACTED]', () => {
    expect(applyStrategy('not-an-email', 'partial_email', null)).toBe('[REDACTED]');
  });

  test('null/undefined input → null', () => {
    expect(applyStrategy(null, 'redact', null)).toBeNull();
    expect(applyStrategy(undefined, 'redact', null)).toBeNull();
  });
});

// ── 3. selectApplicablePolicies ───────────────────────────────────────

describe('selectApplicablePolicies', () => {
  const mk = (over: Partial<FieldMaskingPolicy>): FieldMaskingPolicy => ({
    policy_id: 'p1',
    tenant_id: 'BIL',
    role: 'analyst',
    field_path: 'foo',
    strategy: 'redact',
    replacement: null,
    active: true,
    created_at: NOW.toISOString(),
    created_by: 'admin',
    updated_at: NOW.toISOString(),
    updated_by: 'admin',
    deleted_at: null,
    deleted_by: null,
    ...over,
  });

  test('filters by role', () => {
    const policies = [mk({ policy_id: 'p1', role: 'analyst' }), mk({ policy_id: 'p2', role: 'admin' })];
    expect(selectApplicablePolicies(policies, 'analyst')).toHaveLength(1);
    expect(selectApplicablePolicies(policies, 'admin')).toHaveLength(1);
  });

  test('excludes inactive', () => {
    const policies = [mk({ active: false })];
    expect(selectApplicablePolicies(policies, 'analyst')).toHaveLength(0);
  });

  test('excludes soft-deleted', () => {
    const policies = [mk({ deleted_at: NOW.toISOString() })];
    expect(selectApplicablePolicies(policies, 'analyst')).toHaveLength(0);
  });
});

// ── 4. applyMasking (top-level resolver) ──────────────────────────────

describe('applyMasking', () => {
  const mk = (over: Partial<FieldMaskingPolicy>): FieldMaskingPolicy => ({
    policy_id: 'p1',
    tenant_id: 'BIL',
    role: 'analyst',
    field_path: 'foo',
    strategy: 'redact',
    replacement: null,
    active: true,
    created_at: NOW.toISOString(),
    created_by: 'admin',
    updated_at: NOW.toISOString(),
    updated_by: 'admin',
    deleted_at: null,
    deleted_by: null,
    ...over,
  });

  test('no applicable policies → payload unchanged (by value)', () => {
    const payload = { name: 'Alice', email: 'a@x.com' };
    const out = applyMasking(payload, [], 'analyst');
    expect(out).toEqual(payload);
  });

  test('redact masks a top-level scalar', () => {
    const payload = { name: 'Alice', email: 'a@x.com' };
    const out = applyMasking(
      payload,
      [mk({ field_path: 'email', strategy: 'redact' })],
      'analyst',
    );
    expect(out.email).toBe('[REDACTED]');
    expect(out.name).toBe('Alice');
  });

  test('dotted path masks nested field', () => {
    const payload = { pii: { aadhaar: '1234 5678 9012', pan: 'ABCDE1234F' } };
    const out = applyMasking(
      payload,
      [mk({ field_path: 'pii.aadhaar', strategy: 'fixed_label', replacement: '****' })],
      'analyst',
    );
    expect(out.pii.aadhaar).toBe('****');
    expect(out.pii.pan).toBe('ABCDE1234F');
  });

  test('does NOT mutate original payload', () => {
    const payload = { email: 'a@x.com' };
    applyMasking(payload, [mk({ field_path: 'email' })], 'analyst');
    expect(payload.email).toBe('a@x.com');
  });

  test('array field — masks every element', () => {
    const payload = {
      customers: [
        { name: 'Alice', email: 'a@x.com' },
        { name: 'Bob', email: 'b@y.com' },
      ],
    };
    const out = applyMasking(
      payload,
      [mk({ field_path: 'customers.email', strategy: 'redact' })],
      'analyst',
    );
    expect(out.customers[0].email).toBe('[REDACTED]');
    expect(out.customers[1].email).toBe('[REDACTED]');
    expect(out.customers[0].name).toBe('Alice');
  });

  test('missing path is a no-op (does not introduce keys)', () => {
    const payload = { name: 'Alice' };
    const out = applyMasking(
      payload,
      [mk({ field_path: 'pii.aadhaar', strategy: 'redact' })],
      'analyst',
    );
    expect(out).toEqual({ name: 'Alice' });
    expect('pii' in out).toBe(false);
  });

  test('wrong-role policy is ignored', () => {
    const payload = { email: 'a@x.com' };
    const out = applyMasking(
      payload,
      [mk({ field_path: 'email', strategy: 'redact', role: 'admin' })],
      'analyst',
    );
    expect(out.email).toBe('a@x.com');
  });

  test('multiple policies stack', () => {
    const payload = { email: 'a@x.com', pan: 'ABCDE1234F' };
    const out = applyMasking(
      payload,
      [
        mk({ policy_id: 'p1', field_path: 'email', strategy: 'partial_email' }),
        mk({ policy_id: 'p2', field_path: 'pan', strategy: 'hash_last4' }),
      ],
      'analyst',
    );
    expect(out.email).toBe('a***@x.com');
    expect(out.pan).toMatch(/^\*\*\*[0-9a-f]{4}$/);
  });

  test('numeric field with null strategy → JSON null', () => {
    const payload = { customer: { bureau_score: 720 } };
    const out = applyMasking(
      payload,
      [mk({ field_path: 'customer.bureau_score', strategy: 'null' })],
      'analyst',
    );
    expect(out.customer.bureau_score).toBeNull();
  });
});

// ── 5. InMemoryFieldMaskingStore — CRUD ───────────────────────────────

describe('InMemoryFieldMaskingStore', () => {
  test('create + get round-trip', () => {
    const s = new InMemoryFieldMaskingStore();
    const e = s.create(
      'BIL',
      { policy_id: 'p1', role: 'analyst', field_path: 'email', strategy: 'redact' },
      'admin',
      NOW,
    );
    expect(e.policy_id).toBe('p1');
    expect(e.tenant_id).toBe('BIL');
    expect(e.active).toBe(true);
    expect(e.created_at).toBe(NOW.toISOString());

    const re = s.get('BIL', 'p1');
    expect(re).not.toBeNull();
    expect(re?.policy_id).toBe('p1');
  });

  test('list sorted by (role, field_path, policy_id)', () => {
    const s = new InMemoryFieldMaskingStore();
    s.create('BIL', { policy_id: 'p3', role: 'analyst', field_path: 'b', strategy: 'redact' }, 'admin', NOW);
    s.create('BIL', { policy_id: 'p1', role: 'admin', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    s.create('BIL', { policy_id: 'p2', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    const items = s.list('BIL');
    expect(items.map((i) => i.policy_id)).toEqual(['p1', 'p2', 'p3']);
  });

  test('list filtered by role', () => {
    const s = new InMemoryFieldMaskingStore();
    s.create('BIL', { policy_id: 'p1', role: 'admin', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    s.create('BIL', { policy_id: 'p2', role: 'analyst', field_path: 'b', strategy: 'redact' }, 'admin', NOW);
    expect(s.list('BIL', { role: 'analyst' }).map((i) => i.policy_id)).toEqual(['p2']);
  });

  test('duplicate policy_id throws', () => {
    const s = new InMemoryFieldMaskingStore();
    s.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    expect(() =>
      s.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'b', strategy: 'redact' }, 'admin', NOW),
    ).toThrow(FieldMaskingError);
  });

  test('soft-delete excludes from list by default', () => {
    const s = new InMemoryFieldMaskingStore();
    s.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    s.softDelete('BIL', 'p1', 'admin', NOW);
    expect(s.list('BIL')).toHaveLength(0);
    expect(s.list('BIL', { include_deleted: true })).toHaveLength(1);
    expect(s.get('BIL', 'p1')).toBeNull();
  });

  test('update merges patch + re-validates fixed_label invariant', () => {
    const s = new InMemoryFieldMaskingStore();
    s.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    // Switch to fixed_label without a replacement → must throw.
    expect(() =>
      s.update('BIL', 'p1', { strategy: 'fixed_label' }, 'admin', NOW),
    ).toThrow(FieldMaskingError);
    // Switch with replacement → ok; replacement preserved.
    const ok = s.update('BIL', 'p1', { strategy: 'fixed_label', replacement: '****' }, 'admin', NOW);
    expect(ok.strategy).toBe('fixed_label');
    expect(ok.replacement).toBe('****');
  });

  test('update strategy=non-fixed_label clears replacement', () => {
    const s = new InMemoryFieldMaskingStore();
    s.create(
      'BIL',
      { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'fixed_label', replacement: '****' },
      'admin', NOW,
    );
    const ok = s.update('BIL', 'p1', { strategy: 'redact' }, 'admin', NOW);
    expect(ok.replacement).toBeNull();
  });

  test('restore returns true on missing row, false on conflict', () => {
    const s = new InMemoryFieldMaskingStore();
    const original = s.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    s.softDelete('BIL', 'p1', 'admin', NOW);
    expect(s.restore({ ...original, deleted_at: NOW.toISOString(), deleted_by: 'admin' })).toBe(true);
    expect(s.get('BIL', 'p1')?.deleted_at).toBeNull();
    // Second restore over a live row → conflict.
    expect(s.restore({ ...original })).toBe(false);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryFieldMaskingStore();
    s.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    expect(s.list('BANK_DEMO')).toHaveLength(0);
    expect(s.get('BANK_DEMO', 'p1')).toBeNull();
  });

  test('validation: bogus policy_id', () => {
    const s = new InMemoryFieldMaskingStore();
    expect(() =>
      s.create('BIL', { policy_id: 'BAD ID', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW),
    ).toThrow(/invalid_policy_id/);
  });

  test('validation: bogus role', () => {
    const s = new InMemoryFieldMaskingStore();
    expect(() =>
      s.create('BIL', { policy_id: 'p1', role: 'BadRole', field_path: 'a', strategy: 'redact' }, 'admin', NOW),
    ).toThrow(/invalid_role/);
  });

  test('validation: bogus field_path with array index', () => {
    const s = new InMemoryFieldMaskingStore();
    expect(() =>
      s.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'foo[0].bar', strategy: 'redact' }, 'admin', NOW),
    ).toThrow(/invalid_field_path/);
  });

  test('validation: fixed_label requires replacement', () => {
    const s = new InMemoryFieldMaskingStore();
    expect(() =>
      s.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'fixed_label' }, 'admin', NOW),
    ).toThrow(/invalid_replacement/);
  });

  test('validation: replacement disallowed on non-fixed_label', () => {
    const s = new InMemoryFieldMaskingStore();
    expect(() =>
      s.create(
        'BIL',
        { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact', replacement: 'NO' },
        'admin', NOW,
      ),
    ).toThrow(/invalid_replacement/);
  });
});

// ── 6. Routes ─────────────────────────────────────────────────────────

describe('GET /v1/admin/field-masking/strategies', () => {
  test('admin → 200 with closed enum', async () => {
    const app = makeMaskingApp('admin');
    const r = await request(app).get('/v1/admin/field-masking/strategies').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.strategies).toEqual([...ALL_MASKING_STRATEGIES]);
  });

  test('field_officer → 403', async () => {
    const app = makeMaskingApp('field_officer');
    const r = await request(app).get('/v1/admin/field-masking/strategies').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/admin/field-masking', () => {
  test('happy path → 201 + entry shape', async () => {
    const app = makeMaskingApp('admin');
    const r = await request(app)
      .post('/v1/admin/field-masking')
      .set(TH_BIL)
      .send({
        policy_id: 'mask_email_analyst',
        role: 'analyst',
        field_path: 'customer.email',
        strategy: 'partial_email',
      });
    expect(r.status).toBe(201);
    const e = r.body.body;
    expect(e.policy_id).toBe('mask_email_analyst');
    expect(e.tenant_id).toBe('BIL');
    expect(e.active).toBe(true);
    expect(e.created_by).toBe('alice.admin');
  });

  test('accepts enveloped body shape', async () => {
    const app = makeMaskingApp('admin');
    const r = await request(app)
      .post('/v1/admin/field-masking')
      .set(TH_BIL)
      .send({
        header: { requestId: 'x' },
        body: {
          policy_id: 'mask_email_analyst',
          role: 'analyst',
          field_path: 'customer.email',
          strategy: 'redact',
        },
      });
    expect(r.status).toBe(201);
  });

  test('duplicate policy_id → 409', async () => {
    const app = makeMaskingApp('admin');
    const body = {
      policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact',
    };
    await request(app).post('/v1/admin/field-masking').set(TH_BIL).send(body);
    const r = await request(app).post('/v1/admin/field-masking').set(TH_BIL).send(body);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_policy_id');
  });

  test('invalid strategy → 400 with code-routed error', async () => {
    const app = makeMaskingApp('admin');
    const r = await request(app)
      .post('/v1/admin/field-masking')
      .set(TH_BIL)
      .send({ policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'not_a_strategy' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_strategy');
  });

  test('invalid field_path with array index → 400', async () => {
    const app = makeMaskingApp('admin');
    const r = await request(app)
      .post('/v1/admin/field-masking')
      .set(TH_BIL)
      .send({ policy_id: 'p1', role: 'analyst', field_path: 'customers[0].name', strategy: 'redact' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_field_path');
  });

  test('field_officer → 403', async () => {
    const app = makeMaskingApp('field_officer');
    const r = await request(app)
      .post('/v1/admin/field-masking')
      .set(TH_BIL)
      .send({ policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' });
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/admin/field-masking', () => {
  test('admin → returns list', async () => {
    const store = new InMemoryFieldMaskingStore();
    const app = makeMaskingApp('admin', { fieldMaskingStore: store });
    store.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    store.create('BIL', { policy_id: 'p2', role: 'admin', field_path: 'b', strategy: 'redact' }, 'admin', NOW);
    const r = await request(app).get('/v1/admin/field-masking').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('?role=analyst narrows list', async () => {
    const store = new InMemoryFieldMaskingStore();
    const app = makeMaskingApp('admin', { fieldMaskingStore: store });
    store.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    store.create('BIL', { policy_id: 'p2', role: 'admin', field_path: 'b', strategy: 'redact' }, 'admin', NOW);
    const r = await request(app).get('/v1/admin/field-masking?role=analyst').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].policy_id).toBe('p1');
  });

  test('cross-tenant invisibility', async () => {
    const store = new InMemoryFieldMaskingStore();
    const app = makeMaskingApp('admin', { fieldMaskingStore: store });
    store.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    const r = await request(app).get('/v1/admin/field-masking').set(TH_BANK);
    expect(r.body.body.total).toBe(0);
  });
});

describe('GET /v1/admin/field-masking/:policy_id', () => {
  test('happy path + 404', async () => {
    const store = new InMemoryFieldMaskingStore();
    const app = makeMaskingApp('admin', { fieldMaskingStore: store });
    store.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    const ok = await request(app).get('/v1/admin/field-masking/p1').set(TH_BIL);
    expect(ok.status).toBe(200);
    const miss = await request(app).get('/v1/admin/field-masking/nope').set(TH_BIL);
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('EWS_404_unknown_policy');
  });

  test('cross-tenant lookup → 404', async () => {
    const store = new InMemoryFieldMaskingStore();
    const app = makeMaskingApp('admin', { fieldMaskingStore: store });
    store.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    const r = await request(app).get('/v1/admin/field-masking/p1').set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /v1/admin/field-masking/:policy_id', () => {
  test('happy path → updates + returns merged row', async () => {
    const store = new InMemoryFieldMaskingStore();
    const app = makeMaskingApp('admin', { fieldMaskingStore: store });
    store.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    const r = await request(app)
      .patch('/v1/admin/field-masking/p1')
      .set(TH_BIL)
      .send({ active: false });
    expect(r.status).toBe(200);
    expect(r.body.body.active).toBe(false);
  });

  test('unknown policy → 404', async () => {
    const app = makeMaskingApp('admin');
    const r = await request(app)
      .patch('/v1/admin/field-masking/nope')
      .set(TH_BIL)
      .send({ active: false });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_policy');
  });

  test('invariant violation on merge → 400', async () => {
    const store = new InMemoryFieldMaskingStore();
    const app = makeMaskingApp('admin', { fieldMaskingStore: store });
    store.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    // Switching to fixed_label without replacement → invariant fails.
    const r = await request(app)
      .patch('/v1/admin/field-masking/p1')
      .set(TH_BIL)
      .send({ strategy: 'fixed_label' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_replacement');
  });
});

describe('DELETE /v1/admin/field-masking/:policy_id', () => {
  test('happy path → 204 + soft-deleted', async () => {
    const store = new InMemoryFieldMaskingStore();
    const app = makeMaskingApp('admin', { fieldMaskingStore: store });
    store.create('BIL', { policy_id: 'p1', role: 'analyst', field_path: 'a', strategy: 'redact' }, 'admin', NOW);
    const r = await request(app).delete('/v1/admin/field-masking/p1').set(TH_BIL);
    expect(r.status).toBe(204);
    expect(store.get('BIL', 'p1')).toBeNull();
    // Tombstoned row still in store via include_deleted.
    expect(store.list('BIL', { include_deleted: true })).toHaveLength(1);
  });

  test('unknown → 404', async () => {
    const app = makeMaskingApp('admin');
    const r = await request(app).delete('/v1/admin/field-masking/nope').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_policy');
  });

  test('field_officer → 403', async () => {
    const app = makeMaskingApp('field_officer');
    const r = await request(app).delete('/v1/admin/field-masking/p1').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('cap_reached', () => {
  test('cap enforced at FIELD_MASKING_CAP_PER_TENANT', () => {
    const s = new InMemoryFieldMaskingStore();
    // Fill to cap.
    for (let i = 0; i < FIELD_MASKING_CAP_PER_TENANT; i++) {
      s.create(
        'BIL',
        { policy_id: `p${i}_aa`, role: 'analyst', field_path: `f${i}`, strategy: 'redact' },
        'admin',
        NOW,
      );
    }
    expect(() =>
      s.create(
        'BIL',
        { policy_id: 'p_over', role: 'analyst', field_path: 'over', strategy: 'redact' },
        'admin',
        NOW,
      ),
    ).toThrow(/cap_reached/);
  });
});
