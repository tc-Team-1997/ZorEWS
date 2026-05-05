// services/bff/__tests__/tenant_bulk.test.ts
//
// T6 M2.3 — Bulk-tenant CSV onboarding.

import request from 'supertest';
import {
  TenantBulkError,
  applyBulkTenants,
  parseTenantCsv,
} from '../src/tenant_bulk';
import { defaultTenantLookup, type TenantLookup, type Tenant } from '../src/tenant';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID_CSV = [
  'tenant_id,name,vertical,channels_allowed',
  'BIL_BRANCH_01,BIL Branch 01,banking,API;PARTNER',
  'BIL_BRANCH_02,BIL Branch 02,insurance,API',
].join('\n');

describe('parseTenantCsv', () => {
  test('happy: 2 valid rows', () => {
    const rows = parseTenantCsv(VALID_CSV);
    expect(rows.length).toBe(2);
    expect(rows[0]!.tenant_id).toBe('BIL_BRANCH_01');
    expect(rows[0]!.channels_allowed).toEqual(['API', 'PARTNER']);
    expect(rows[1]!.vertical).toBe('insurance');
  });

  test('empty csv → invalid_input', () => {
    expect(() => parseTenantCsv('')).toThrow(TenantBulkError);
    expect(() => parseTenantCsv('   ')).toThrow(TenantBulkError);
  });

  test('bad header → invalid_input', () => {
    expect(() => parseTenantCsv('foo,bar\nX,Y')).toThrow(/header/);
  });

  test('column count mismatch → invalid_input', () => {
    const csv = 'tenant_id,name,vertical,channels_allowed\nA,B,C';
    expect(() => parseTenantCsv(csv)).toThrow(/columns/);
  });

  test('missing tenant_id → invalid_input', () => {
    const csv = 'tenant_id,name,vertical,channels_allowed\n,foo,banking,API';
    expect(() => parseTenantCsv(csv)).toThrow(/tenant_id/);
  });

  test('invalid vertical → invalid_input', () => {
    const csv = 'tenant_id,name,vertical,channels_allowed\nA,B,crypto,API';
    expect(() => parseTenantCsv(csv)).toThrow(/vertical/);
  });

  test('empty channels_allowed → invalid_input', () => {
    const csv = 'tenant_id,name,vertical,channels_allowed\nA,B,banking,';
    expect(() => parseTenantCsv(csv)).toThrow(/channels_allowed/);
  });

  test('strips empty lines', () => {
    const csv = 'tenant_id,name,vertical,channels_allowed\n\nA,B,banking,API\n\n';
    expect(parseTenantCsv(csv).length).toBe(1);
  });
});

describe('applyBulkTenants', () => {
  function makeMutableLookup(): TenantLookup {
    const map = new Map<string, Tenant>();
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
    return lookup;
  }

  test('dry_run: reports created without mutating', async () => {
    const lookup = makeMutableLookup();
    const rows = parseTenantCsv(VALID_CSV);
    const r = await applyBulkTenants(rows, lookup, { dry_run: true });
    expect(r.created).toBe(2);
    expect(r.dry_run).toBe(true);
    expect(await lookup('BIL_BRANCH_01')).toBeUndefined();
  });

  test('apply: creates new tenants', async () => {
    const lookup = makeMutableLookup();
    const rows = parseTenantCsv(VALID_CSV);
    const r = await applyBulkTenants(rows, lookup, { dry_run: false });
    expect(r.created).toBe(2);
    expect(await lookup('BIL_BRANCH_01')).toBeDefined();
  });

  test('skipped: existing tenant_id (idempotent)', async () => {
    const lookup = makeMutableLookup();
    const csv = [
      'tenant_id,name,vertical,channels_allowed',
      'BANK_DEMO,Bank Demo Existing,banking,API',
      'BIL_NEW_01,BIL New,banking,API',
    ].join('\n');
    const rows = parseTenantCsv(csv);
    const r = await applyBulkTenants(rows, lookup, { dry_run: false });
    expect(r.skipped).toBe(1);
    expect(r.created).toBe(1);
  });

  test('error: duplicate within CSV itself', async () => {
    const lookup = makeMutableLookup();
    const csv = [
      'tenant_id,name,vertical,channels_allowed',
      'BIL_DUP,BIL Dup A,banking,API',
      'BIL_DUP,BIL Dup B,banking,API',
    ].join('\n');
    const rows = parseTenantCsv(csv);
    const r = await applyBulkTenants(rows, lookup, { dry_run: false });
    expect(r.errored).toBe(1);
    const dupRow = r.rows.find((x) => x.status === 'error');
    expect(dupRow?.reason).toBe('duplicate_in_csv');
  });

  test('error when lookup.create is missing', async () => {
    // Static lookup with no .create method
    const lookup = (() => undefined) as TenantLookup;
    const rows = parseTenantCsv(VALID_CSV);
    const r = await applyBulkTenants(rows, lookup, { dry_run: false });
    expect(r.errored).toBe(2);
    const errRow = r.rows[0]!;
    if (errRow.status === 'error') {
      expect(errRow.reason).toBe('lookup_does_not_support_create');
    }
  });

  test('cap: > 100 rows rejected', async () => {
    const lookup = makeMutableLookup();
    const tooMany = new Array(101).fill(0).map((_, i) => ({
      tenant_id: `T_${i}`,
      name: `T ${i}`,
      vertical: 'banking' as const,
      channels_allowed: ['API'],
    }));
    await expect(
      applyBulkTenants(tooMany, lookup, { dry_run: true }),
    ).rejects.toThrow(/max 100/);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

function makeBulkApp(role = 'admin') {
  // Use the default tenant lookup (read-only for many op tests, but
  // the bulk path will surface lookup_does_not_support_create when
  // .create is absent — which IS the case for default static lookup).
  void defaultTenantLookup;
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => new Date('2026-05-05T23:30:00Z'),
    getRole: () => role,
  });
}

describe('POST /v1/tenants/bulk-import', () => {
  test('admin: dry_run 200 with summary', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/tenants/bulk-import')
      .set(TH_BIL)
      .send({ csv: VALID_CSV, dry_run: true });
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.dry_run).toBe(true);
  });

  test('non-string csv → 400', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/tenants/bulk-import')
      .set(TH_BIL)
      .send({ csv: 42 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('bad CSV header → 400 EWS_400_invalid_input', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/tenants/bulk-import')
      .set(TH_BIL)
      .send({ csv: 'foo,bar\nA,B' });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBulkApp('case_owner');
    const r = await request(app)
      .post('/v1/tenants/bulk-import')
      .set(TH_BIL)
      .send({ csv: VALID_CSV });
    expect(r.status).toBe(403);
  });
});
