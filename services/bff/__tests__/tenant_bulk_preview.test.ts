// services/bff/__tests__/tenant_bulk_preview.test.ts
//
// T6 M2.4 — Staged bulk-import preview + apply.

import request from 'supertest';
import {
  InMemoryBulkImportPreviewStore,
  PreviewError,
  applyBulkImportPreview,
  createBulkImportPreview,
  effectiveStatus,
} from '../src/tenant_bulk_preview';
import { type Tenant, type TenantLookup } from '../src/tenant';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T20:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID_CSV = [
  'tenant_id,name,vertical,channels_allowed',
  'BIL_BRANCH_01,BIL Branch 01,banking,API;PARTNER',
  'BIL_BRANCH_02,BIL Branch 02,insurance,API',
].join('\n');

function makeMutableLookup(): TenantLookup {
  const map = new Map<string, Tenant>();
  map.set('BIL', {
    tenant_id: 'BIL',
    name: 'BIL',
    vertical: 'banking',
    channels_allowed: ['API'],
    active: true,
  });
  // BANK_DEMO registered so cross-tenant tests can authenticate
  // through requireTenantMw before hitting our 404 path.
  map.set('BANK_DEMO', {
    tenant_id: 'BANK_DEMO',
    name: 'Bank Demo',
    vertical: 'banking',
    channels_allowed: ['API'],
    active: true,
  });
  const lookup = ((id: string) => map.get(id)) as TenantLookup;
  lookup.create = (input) => {
    const t: Tenant = { ...input, active: input.active ?? true };
    map.set(t.tenant_id, t);
    return t;
  };
  lookup.all = () => [...map.values()];
  return lookup;
}

function makePreviewApp(role = 'admin') {
  const previewStore = new InMemoryBulkImportPreviewStore();
  const tenantLookup = makeMutableLookup();
  let nowVal = NOW;
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    bulkImportPreviewStore: previewStore,
    tenantLookup,
    now: () => nowVal,
    getRole: () => role,
  });
  return {
    ...built,
    previewStore,
    tenantLookup,
    setNow: (d: Date) => { nowVal = d; },
  };
}

// ─── Pure helpers ─────────────────────────────────────────────────────

describe('M2.4 — effectiveStatus', () => {
  const base = {
    preview_id: 'p',
    tenant_id: 'BIL',
    created_by: 'admin',
    created_at: '2026-05-05T20:00:00.000Z',
    expires_at: '2026-05-05T20:10:00.000Z',
    csv_sha256: 'x',
    rows: [],
    summary: {
      total: 0,
      created: 0,
      skipped: 0,
      errored: 0,
      rows: [],
      dry_run: true,
    },
    resolved_at: null,
  };

  test('pending stays pending before expiry', () => {
    expect(effectiveStatus({ ...base, status: 'pending' }, NOW)).toBe('pending');
  });

  test('pending flips to expired at-or-after expiry', () => {
    const after = new Date('2026-05-05T20:10:00.000Z');
    expect(effectiveStatus({ ...base, status: 'pending' }, after)).toBe('expired');
    const farLater = new Date('2026-05-05T21:00:00.000Z');
    expect(effectiveStatus({ ...base, status: 'pending' }, farLater)).toBe('expired');
  });

  test('non-pending status passes through unchanged', () => {
    expect(effectiveStatus({ ...base, status: 'consumed' }, NOW)).toBe('consumed');
    expect(effectiveStatus({ ...base, status: 'cancelled' }, NOW)).toBe('cancelled');
  });
});

// ─── Store ────────────────────────────────────────────────────────────

describe('InMemoryBulkImportPreviewStore', () => {
  test('put assigns id, ttl 10 min, hashes csv', () => {
    const s = new InMemoryBulkImportPreviewStore();
    const p = s.put({
      tenant_id: 'BIL',
      csv: 'foo',
      rows: [],
      summary: { total: 0, created: 0, skipped: 0, errored: 0, rows: [], dry_run: true },
      created_by: 'admin',
      now: NOW,
    });
    expect(p.preview_id).toMatch(/^prv-/);
    expect(p.expires_at).toBe('2026-05-05T20:10:00.000Z');
    expect(p.csv_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.status).toBe('pending');
  });

  test('rows are deep-copied so caller mutation does not bleed in', () => {
    const s = new InMemoryBulkImportPreviewStore();
    const rows = [{ tenant_id: 'A', name: 'A', vertical: 'banking' as const, channels_allowed: ['API'] }];
    const p = s.put({
      tenant_id: 'BIL',
      csv: 'x',
      rows,
      summary: { total: 1, created: 1, skipped: 0, errored: 0, rows: [], dry_run: true },
      created_by: 'admin',
      now: NOW,
    });
    rows[0]!.channels_allowed.push('LEAKED');
    expect(p.rows[0]!.channels_allowed).toEqual(['API']);
  });

  test('cap_reached after 5 active previews', () => {
    const s = new InMemoryBulkImportPreviewStore();
    for (let i = 0; i < 5; i++) {
      s.put({
        tenant_id: 'BIL',
        csv: `csv-${i}`,
        rows: [],
        summary: { total: 0, created: 0, skipped: 0, errored: 0, rows: [], dry_run: true },
        created_by: 'admin',
        now: NOW,
      });
    }
    try {
      s.put({
        tenant_id: 'BIL',
        csv: 'csv-overflow',
        rows: [],
        summary: { total: 0, created: 0, skipped: 0, errored: 0, rows: [], dry_run: true },
        created_by: 'admin',
        now: NOW,
      });
      fail('expected throw');
    } catch (e) {
      expect((e as PreviewError).code).toBe('cap_reached');
    }
  });

  test('expired previews do NOT count against the cap', () => {
    const s = new InMemoryBulkImportPreviewStore();
    for (let i = 0; i < 5; i++) {
      s.put({
        tenant_id: 'BIL',
        csv: `csv-${i}`,
        rows: [],
        summary: { total: 0, created: 0, skipped: 0, errored: 0, rows: [], dry_run: true },
        created_by: 'admin',
        now: NOW,
      });
    }
    // 11 minutes later all have expired
    const later = new Date(NOW.getTime() + 11 * 60_000);
    expect(() =>
      s.put({
        tenant_id: 'BIL',
        csv: 'fresh',
        rows: [],
        summary: { total: 0, created: 0, skipped: 0, errored: 0, rows: [], dry_run: true },
        created_by: 'admin',
        now: later,
      }),
    ).not.toThrow();
  });

  test('consume marks consumed; second consume throws', () => {
    const s = new InMemoryBulkImportPreviewStore();
    const p = s.put({
      tenant_id: 'BIL',
      csv: 'x',
      rows: [],
      summary: { total: 0, created: 0, skipped: 0, errored: 0, rows: [], dry_run: true },
      created_by: 'admin',
      now: NOW,
    });
    const c = s.consume('BIL', p.preview_id, NOW);
    expect(c.status).toBe('consumed');
    expect(c.resolved_at).toBe(NOW.toISOString());
    try {
      s.consume('BIL', p.preview_id, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as PreviewError).code).toBe('preview_not_pending');
    }
  });

  test('consume after expiry → preview_expired', () => {
    const s = new InMemoryBulkImportPreviewStore();
    const p = s.put({
      tenant_id: 'BIL',
      csv: 'x',
      rows: [],
      summary: { total: 0, created: 0, skipped: 0, errored: 0, rows: [], dry_run: true },
      created_by: 'admin',
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 11 * 60_000);
    try {
      s.consume('BIL', p.preview_id, later);
      fail('expected throw');
    } catch (e) {
      expect((e as PreviewError).code).toBe('preview_expired');
    }
  });

  test('cancel pending → cancelled; cancel cancelled → preview_not_pending', () => {
    const s = new InMemoryBulkImportPreviewStore();
    const p = s.put({
      tenant_id: 'BIL',
      csv: 'x',
      rows: [],
      summary: { total: 0, created: 0, skipped: 0, errored: 0, rows: [], dry_run: true },
      created_by: 'admin',
      now: NOW,
    });
    const c = s.cancel('BIL', p.preview_id, NOW);
    expect(c.status).toBe('cancelled');
    try {
      s.cancel('BIL', p.preview_id, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as PreviewError).code).toBe('preview_not_pending');
    }
  });

  test('unknown_preview on get/consume/cancel', () => {
    const s = new InMemoryBulkImportPreviewStore();
    expect(s.get('BIL', 'prv-nope', NOW)).toBeNull();
    expect(() => s.consume('BIL', 'prv-nope', NOW)).toThrow(/not found/);
    expect(() => s.cancel('BIL', 'prv-nope', NOW)).toThrow(/not found/);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryBulkImportPreviewStore();
    const p = s.put({
      tenant_id: 'BIL',
      csv: 'x',
      rows: [],
      summary: { total: 0, created: 0, skipped: 0, errored: 0, rows: [], dry_run: true },
      created_by: 'admin',
      now: NOW,
    });
    expect(s.get('BANK_DEMO', p.preview_id, NOW)).toBeNull();
    expect(() => s.consume('BANK_DEMO', p.preview_id, NOW)).toThrow(/not found/);
  });

  test('list reports effectiveStatus on each item', () => {
    const s = new InMemoryBulkImportPreviewStore();
    s.put({
      tenant_id: 'BIL',
      csv: 'x',
      rows: [],
      summary: { total: 0, created: 0, skipped: 0, errored: 0, rows: [], dry_run: true },
      created_by: 'admin',
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const items = s.list('BIL', later);
    expect(items[0]!.status).toBe('expired');
  });
});

// ─── createBulkImportPreview / applyBulkImportPreview ────────────────

describe('M2.4 — createBulkImportPreview', () => {
  test('happy: dry-runs and snapshots rows', async () => {
    const lookup = makeMutableLookup();
    const store = new InMemoryBulkImportPreviewStore();
    const p = await createBulkImportPreview(store, lookup, {
      tenant_id: 'BIL',
      csv: VALID_CSV,
      created_by: 'admin',
      now: NOW,
    });
    expect(p.summary.total).toBe(2);
    expect(p.summary.dry_run).toBe(true);
    expect(p.rows).toHaveLength(2);
    expect(p.status).toBe('pending');
  });

  test('bad CSV propagates TenantBulkError', async () => {
    const lookup = makeMutableLookup();
    const store = new InMemoryBulkImportPreviewStore();
    await expect(
      createBulkImportPreview(store, lookup, {
        tenant_id: 'BIL',
        csv: 'foo,bar\nx,y',
        created_by: 'admin',
        now: NOW,
      }),
    ).rejects.toThrow(/header/);
  });
});

describe('M2.4 — applyBulkImportPreview', () => {
  test('happy: consumes preview + creates tenants', async () => {
    const lookup = makeMutableLookup();
    const store = new InMemoryBulkImportPreviewStore();
    const p = await createBulkImportPreview(store, lookup, {
      tenant_id: 'BIL',
      csv: VALID_CSV,
      created_by: 'admin',
      now: NOW,
    });
    const out = await applyBulkImportPreview(store, lookup, {
      tenant_id: 'BIL',
      preview_id: p.preview_id,
      now: NOW,
    });
    expect(out.preview.status).toBe('consumed');
    expect(out.result.created).toBe(2);
    expect(out.result.dry_run).toBe(false);
    expect(await lookup('BIL_BRANCH_01')).toBeDefined();
    expect(await lookup('BIL_BRANCH_02')).toBeDefined();
  });

  test('apply with stale preview → preview_expired', async () => {
    const lookup = makeMutableLookup();
    const store = new InMemoryBulkImportPreviewStore();
    const p = await createBulkImportPreview(store, lookup, {
      tenant_id: 'BIL',
      csv: VALID_CSV,
      created_by: 'admin',
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 11 * 60_000);
    await expect(
      applyBulkImportPreview(store, lookup, {
        tenant_id: 'BIL',
        preview_id: p.preview_id,
        now: later,
      }),
    ).rejects.toThrow(/expired/);
  });

  test('apply commits the SNAPSHOT, not the live CSV', async () => {
    // The whole point of M2.4: even if the source CSV changes, the
    // committed rows should match the preview snapshot exactly.
    const lookup = makeMutableLookup();
    const store = new InMemoryBulkImportPreviewStore();
    const p = await createBulkImportPreview(store, lookup, {
      tenant_id: 'BIL',
      csv: VALID_CSV,
      created_by: 'admin',
      now: NOW,
    });
    // Imagine the operator changes their CSV behind the scenes —
    // the preview snapshot is unaffected.
    const out = await applyBulkImportPreview(store, lookup, {
      tenant_id: 'BIL',
      preview_id: p.preview_id,
      now: NOW,
    });
    expect(out.result.created).toBe(2);
    // Exactly the rows from the preview snapshot got created.
    expect(await lookup('BIL_BRANCH_01')).toBeDefined();
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('M2.4 — POST /v1/tenants/bulk-import/preview', () => {
  test('admin: 201 with preview_id + summary', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    expect(r.status).toBe(201);
    expect(r.body.body.preview_id).toMatch(/^prv-/);
    expect(r.body.body.summary.total).toBe(2);
    expect(r.body.body.summary.dry_run).toBe(true);
    expect(r.body.body.csv_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.body.status).toBe('pending');
  });

  test('captures X-APEX-USER as created_by', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send({ csv: VALID_CSV });
    expect(r.body.body.created_by).toBe('compliance.lead');
  });

  test('bad CSV → 400 invalid_input', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: 'wrong,headers\na,b' });
    expect(r.status).toBe(400);
  });

  test('cap_reached after 5 active → 409', async () => {
    const { app } = makePreviewApp('admin');
    for (let i = 0; i < 5; i++) {
      const u = `BIL_BRANCH_${String(i).padStart(2, '0')}`;
      await request(app)
        .post('/v1/tenants/bulk-import/preview')
        .set(TH_BIL)
        .send({
          csv: `tenant_id,name,vertical,channels_allowed\n${u},name,banking,API`,
        });
    }
    const r = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_cap_reached');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePreviewApp('case_owner');
    const r = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    expect(r.status).toBe(403);
  });
});

describe('M2.4 — GET /v1/tenants/bulk-import/previews', () => {
  test('lists active previews', async () => {
    const { app } = makePreviewApp('admin');
    await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    const r = await request(app).get('/v1/tenants/bulk-import/previews').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].status).toBe('pending');
  });
});

describe('M2.4 — POST /v1/tenants/bulk-import/apply', () => {
  test('admin: consumes preview + commits', async () => {
    const { app, tenantLookup } = makePreviewApp('admin');
    const c = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    const id = c.body.body.preview_id;
    const a = await request(app)
      .post('/v1/tenants/bulk-import/apply')
      .set(TH_BIL)
      .send({ preview_id: id });
    expect(a.status).toBe(200);
    expect(a.body.body.preview.status).toBe('consumed');
    expect(a.body.body.result.created).toBe(2);
    expect(a.body.body.result.dry_run).toBe(false);
    expect(await tenantLookup('BIL_BRANCH_01')).toBeDefined();
  });

  test('apply twice → second is 410 preview_not_pending', async () => {
    const { app } = makePreviewApp('admin');
    const c = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    const id = c.body.body.preview_id;
    await request(app).post('/v1/tenants/bulk-import/apply').set(TH_BIL).send({ preview_id: id });
    const second = await request(app)
      .post('/v1/tenants/bulk-import/apply')
      .set(TH_BIL)
      .send({ preview_id: id });
    expect(second.status).toBe(410);
    expect(second.body.error.code).toBe('EWS_410_preview_not_pending');
  });

  test('apply expired → 410 preview_expired', async () => {
    const { app, setNow } = makePreviewApp('admin');
    const c = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    const id = c.body.body.preview_id;
    setNow(new Date(NOW.getTime() + 11 * 60_000));
    const a = await request(app)
      .post('/v1/tenants/bulk-import/apply')
      .set(TH_BIL)
      .send({ preview_id: id });
    expect(a.status).toBe(410);
    expect(a.body.error.code).toBe('EWS_410_preview_expired');
  });

  test('unknown preview_id → 404', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/tenants/bulk-import/apply')
      .set(TH_BIL)
      .send({ preview_id: 'prv-nope' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preview');
  });

  test('missing preview_id → 400', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/tenants/bulk-import/apply')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });

  test('cross-tenant: BIL preview cannot be applied by BANK_DEMO', async () => {
    const { app } = makePreviewApp('admin');
    const c = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    const id = c.body.body.preview_id;
    const r = await request(app)
      .post('/v1/tenants/bulk-import/apply')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send({ preview_id: id });
    expect(r.status).toBe(404);
  });
});

describe('M2.4 — DELETE /v1/tenants/bulk-import/preview/:id', () => {
  test('cancels pending → 200 cancelled', async () => {
    const { app } = makePreviewApp('admin');
    const c = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    const id = c.body.body.preview_id;
    const d = await request(app).delete(`/v1/tenants/bulk-import/preview/${id}`).set(TH_BIL);
    expect(d.status).toBe(200);
    expect(d.body.body.status).toBe('cancelled');
  });

  test('cancel after consume → 410', async () => {
    const { app } = makePreviewApp('admin');
    const c = await request(app)
      .post('/v1/tenants/bulk-import/preview')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    const id = c.body.body.preview_id;
    await request(app).post('/v1/tenants/bulk-import/apply').set(TH_BIL).send({ preview_id: id });
    const d = await request(app).delete(`/v1/tenants/bulk-import/preview/${id}`).set(TH_BIL);
    expect(d.status).toBe(410);
  });

  test('cancel unknown → 404', async () => {
    const { app } = makePreviewApp('admin');
    const d = await request(app).delete('/v1/tenants/bulk-import/preview/prv-nope').set(TH_BIL);
    expect(d.status).toBe(404);
  });

  test('M2.3 bulk-import still works (literal /preview did not shadow)', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .post('/v1/tenants/bulk-import')
      .set(TH_BIL)
      .send({ csv: VALID_CSV, dry_run: true });
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
  });
});
