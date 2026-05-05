// services/bff/__tests__/config_bulk.test.ts
//
// T6 M13.4 — Bulk config import/export.

import request from 'supertest';
import {
  ConfigBulkError,
  cloneTenantConfig,
  diffTenantConfig,
  exportConfig,
  importConfig,
} from '../src/config_bulk';
import { InMemoryConfigStore } from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T22:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeBulkApp(role = 'admin') {
  const cfg = new InMemoryConfigStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    configStore: cfg,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, cfg };
}

describe('exportConfig', () => {
  test('empty overrides → empty snapshot', () => {
    const cfg = new InMemoryConfigStore();
    const snap = exportConfig(cfg, 'BIL', NOW);
    expect(snap.source_tenant_id).toBe('BIL');
    expect(snap.overrides).toEqual({});
  });

  test('overrides surface as snapshot keys', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BIL', 'alerts.red_sla_hours', 8, 'admin', NOW);
    cfg.set('BIL', 'alerts.orange_sla_hours', 48, 'admin', NOW);
    const snap = exportConfig(cfg, 'BIL', NOW);
    expect(snap.overrides['alerts.red_sla_hours']).toBe(8);
    expect(snap.overrides['alerts.orange_sla_hours']).toBe(48);
  });

  test('cross-tenant: BIL export does not leak BANK_DEMO overrides', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BIL', 'alerts.red_sla_hours', 8, 'admin', NOW);
    cfg.set('BANK_DEMO', 'alerts.red_sla_hours', 12, 'admin', NOW);
    const bil = exportConfig(cfg, 'BIL', NOW);
    expect(bil.overrides['alerts.red_sla_hours']).toBe(8);
    const bd = exportConfig(cfg, 'BANK_DEMO', NOW);
    expect(bd.overrides['alerts.red_sla_hours']).toBe(12);
  });
});

describe('importConfig', () => {
  test('happy: all keys applied', () => {
    const cfg = new InMemoryConfigStore();
    const r = importConfig(
      cfg,
      'BIL',
      { overrides: { 'alerts.red_sla_hours': 6 } },
      'admin',
      false,
      NOW,
    );
    expect(r.applied).toEqual(['alerts.red_sla_hours']);
    expect(cfg.get('BIL', 'alerts.red_sla_hours')?.value).toBe(6);
  });

  test('dry_run: no mutation', () => {
    const cfg = new InMemoryConfigStore();
    const r = importConfig(
      cfg,
      'BIL',
      { overrides: { 'alerts.red_sla_hours': 6 } },
      'admin',
      true,
      NOW,
    );
    expect(r.applied).toEqual(['alerts.red_sla_hours']);
    expect(r.dry_run).toBe(true);
    // Underlying store still default
    expect(cfg.get('BIL', 'alerts.red_sla_hours')?.is_default).toBe(true);
  });

  test('unknown key reported as skipped (other keys still applied)', () => {
    const cfg = new InMemoryConfigStore();
    const r = importConfig(
      cfg,
      'BIL',
      { overrides: { 'alerts.red_sla_hours': 6, 'NOT-A-KEY': 1 } },
      'admin',
      false,
      NOW,
    );
    expect(r.applied).toEqual(['alerts.red_sla_hours']);
    expect(r.skipped[0]!.key).toBe('NOT-A-KEY');
  });

  test('value matching current = unchanged', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BIL', 'alerts.red_sla_hours', 6, 'admin', NOW);
    const r = importConfig(
      cfg,
      'BIL',
      { overrides: { 'alerts.red_sla_hours': 6 } },
      'admin',
      false,
      NOW,
    );
    expect(r.unchanged).toEqual(['alerts.red_sla_hours']);
    expect(r.applied).toEqual([]);
  });

  test('type-mismatched value → skipped (validation error)', () => {
    const cfg = new InMemoryConfigStore();
    const r = importConfig(
      cfg,
      'BIL',
      { overrides: { 'alerts.red_sla_hours': 'twelve' } },
      'admin',
      false,
      NOW,
    );
    expect(r.skipped[0]!.key).toBe('alerts.red_sla_hours');
    expect(r.skipped[0]!.reason).toMatch(/validation/);
  });

  test('non-object snapshot rejected', () => {
    const cfg = new InMemoryConfigStore();
    expect(() =>
      importConfig(cfg, 'BIL', 'foo', 'admin', false, NOW),
    ).toThrow(ConfigBulkError);
  });

  test('overrides must be a map', () => {
    const cfg = new InMemoryConfigStore();
    expect(() =>
      importConfig(cfg, 'BIL', { overrides: [] }, 'admin', false, NOW),
    ).toThrow(/overrides/);
  });

  test('rejects > 100 keys', () => {
    const cfg = new InMemoryConfigStore();
    const overrides: Record<string, number> = {};
    for (let i = 0; i < 101; i++) overrides[`k${i}`] = 1;
    expect(() =>
      importConfig(cfg, 'BIL', { overrides }, 'admin', false, NOW),
    ).toThrow(/> 100/);
  });

  test('missing applied_by rejected', () => {
    const cfg = new InMemoryConfigStore();
    expect(() =>
      importConfig(cfg, 'BIL', { overrides: {} }, '', false, NOW),
    ).toThrow(/applied_by/);
  });
});

describe('Routes', () => {
  test('GET _export 200 with snapshot shape', async () => {
    const { app, cfg } = makeBulkApp('admin');
    cfg.set('BIL', 'alerts.red_sla_hours', 9, 'admin', NOW);
    const r = await request(app).get('/v1/admin/config/_export').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.source_tenant_id).toBe('BIL');
    expect(r.body.body.overrides['alerts.red_sla_hours']).toBe(9);
  });

  test('POST _import dry_run shows applied without mutation', async () => {
    const { app, cfg } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/admin/config/_import')
      .set(TH_BIL)
      .send({
        dry_run: true,
        snapshot: { overrides: { 'alerts.red_sla_hours': 7 } },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.dry_run).toBe(true);
    expect(r.body.body.applied).toEqual(['alerts.red_sla_hours']);
    // Verify the store wasn't actually changed
    expect(cfg.get('BIL', 'alerts.red_sla_hours')?.is_default).toBe(true);
  });

  test('POST _import dry_run=false applies the change', async () => {
    const { app, cfg } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/admin/config/_import')
      .set(TH_BIL)
      .send({
        snapshot: { overrides: { 'alerts.red_sla_hours': 11 } },
      });
    expect(r.status).toBe(200);
    expect(cfg.get('BIL', 'alerts.red_sla_hours')?.value).toBe(11);
  });

  test('POST _import bad snapshot → 400', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/admin/config/_import')
      .set(TH_BIL)
      .send({ snapshot: 'foo' });
    expect(r.status).toBe(400);
  });

  test('GET _export non-allowed role → 403', async () => {
    const { app } = makeBulkApp('case_owner');
    const r = await request(app).get('/v1/admin/config/_export').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M13.1 GET /:key still works (literal _export didn\'t shadow)', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app).get('/v1/admin/config/alerts.red_sla_hours').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});

// ─── M13.5 — Config diff between tenants ─────────────────────────────

describe('diffTenantConfig', () => {
  test('all-default both → all entries status=same', () => {
    const cfg = new InMemoryConfigStore();
    const r = diffTenantConfig(cfg, 'BIL', 'BANK_DEMO', NOW);
    expect(r.tenant_a).toBe('BIL');
    expect(r.tenant_b).toBe('BANK_DEMO');
    expect(r.same_count).toBe(r.entries.length);
    expect(r.different_count).toBe(0);
    expect(r.changed_entries).toEqual([]);
  });

  test('a_only when tenant_a has override, tenant_b at default', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BIL', 'alerts.red_sla_hours', 6, 'admin', NOW);
    const r = diffTenantConfig(cfg, 'BIL', 'BANK_DEMO', NOW);
    const e = r.changed_entries.find((x) => x.key === 'alerts.red_sla_hours')!;
    expect(e.status).toBe('a_only');
    expect(e.value_a).toBe(6);
    expect(e.value_b).toBeNull();
    expect(e.is_default_b).toBe(true);
    expect(r.a_only_count).toBe(1);
  });

  test('b_only mirrored', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BANK_DEMO', 'alerts.red_sla_hours', 12, 'admin', NOW);
    const r = diffTenantConfig(cfg, 'BIL', 'BANK_DEMO', NOW);
    const e = r.changed_entries.find((x) => x.key === 'alerts.red_sla_hours')!;
    expect(e.status).toBe('b_only');
    expect(e.value_b).toBe(12);
    expect(r.b_only_count).toBe(1);
  });

  test('different when both override but with distinct values', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BIL', 'alerts.red_sla_hours', 6, 'admin', NOW);
    cfg.set('BANK_DEMO', 'alerts.red_sla_hours', 12, 'admin', NOW);
    const r = diffTenantConfig(cfg, 'BIL', 'BANK_DEMO', NOW);
    const e = r.changed_entries.find((x) => x.key === 'alerts.red_sla_hours')!;
    expect(e.status).toBe('different');
    expect(r.different_count).toBe(1);
  });

  test('same when both override to identical values', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BIL', 'alerts.red_sla_hours', 8, 'admin', NOW);
    cfg.set('BANK_DEMO', 'alerts.red_sla_hours', 8, 'admin', NOW);
    const r = diffTenantConfig(cfg, 'BIL', 'BANK_DEMO', NOW);
    const e = r.entries.find((x) => x.key === 'alerts.red_sla_hours')!;
    expect(e.status).toBe('same');
    expect(r.different_count).toBe(0);
  });

  test('rejects same-tenant compare', () => {
    const cfg = new InMemoryConfigStore();
    expect(() => diffTenantConfig(cfg, 'BIL', 'BIL', NOW)).toThrow(/must differ/);
  });

  test('rejects empty tenant ids', () => {
    const cfg = new InMemoryConfigStore();
    expect(() => diffTenantConfig(cfg, '', 'BANK_DEMO', NOW)).toThrow(ConfigBulkError);
    expect(() => diffTenantConfig(cfg, 'BIL', '', NOW)).toThrow(ConfigBulkError);
  });

  test('counters add to total', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BIL', 'alerts.red_sla_hours', 6, 'admin', NOW);
    cfg.set('BANK_DEMO', 'alerts.orange_sla_hours', 36, 'admin', NOW);
    const r = diffTenantConfig(cfg, 'BIL', 'BANK_DEMO', NOW);
    const total =
      r.same_count + r.a_only_count + r.b_only_count + r.different_count;
    expect(total).toBe(r.entries.length);
  });
});

describe('GET /v1/admin/config/_diff', () => {
  test('200 with diff body', async () => {
    const { app, cfg } = makeBulkApp('admin');
    cfg.set('BIL', 'alerts.red_sla_hours', 5, 'admin', NOW);
    const r = await request(app)
      .get('/v1/admin/config/_diff?tenant_a=BIL&tenant_b=BANK_DEMO')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_a).toBe('BIL');
    expect(r.body.body.a_only_count).toBe(1);
  });

  test('missing tenant_a → 400', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/_diff?tenant_b=BANK_DEMO')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('same-tenant compare → 400', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/_diff?tenant_a=BIL&tenant_b=BIL')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBulkApp('case_owner');
    const r = await request(app)
      .get('/v1/admin/config/_diff?tenant_a=BIL&tenant_b=BANK_DEMO')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M13.1 GET /:key still works (literal _diff didn\'t shadow)', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app).get('/v1/admin/config/alerts.red_sla_hours').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});

// ─── M13.6 — Clone tenant config ─────────────────────────────────────

describe('cloneTenantConfig', () => {
  test('happy: copies source overrides into target', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BANK_DEMO', 'alerts.red_sla_hours', 8, 'admin', NOW);
    cfg.set('BANK_DEMO', 'alerts.orange_sla_hours', 36, 'admin', NOW);
    const r = cloneTenantConfig(cfg, 'BANK_DEMO', 'BIL', 'admin', false, NOW);
    expect(r.applied.sort()).toEqual(['alerts.orange_sla_hours', 'alerts.red_sla_hours']);
    expect(cfg.get('BIL', 'alerts.red_sla_hours')?.value).toBe(8);
    expect(cfg.get('BIL', 'alerts.orange_sla_hours')?.value).toBe(36);
  });

  test('dry_run: no mutation', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BANK_DEMO', 'alerts.red_sla_hours', 5, 'admin', NOW);
    const r = cloneTenantConfig(cfg, 'BANK_DEMO', 'BIL', 'admin', true, NOW);
    expect(r.dry_run).toBe(true);
    expect(r.applied).toEqual(['alerts.red_sla_hours']);
    expect(cfg.get('BIL', 'alerts.red_sla_hours')?.is_default).toBe(true);
  });

  test('source has no overrides → empty summary, no mutation', () => {
    const cfg = new InMemoryConfigStore();
    const r = cloneTenantConfig(cfg, 'BANK_DEMO', 'BIL', 'admin', false, NOW);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.unchanged).toEqual([]);
    expect(r.total_input).toBe(0);
  });

  test('target already has matching value → unchanged', () => {
    const cfg = new InMemoryConfigStore();
    cfg.set('BANK_DEMO', 'alerts.red_sla_hours', 7, 'admin', NOW);
    cfg.set('BIL', 'alerts.red_sla_hours', 7, 'admin', NOW);
    const r = cloneTenantConfig(cfg, 'BANK_DEMO', 'BIL', 'admin', false, NOW);
    expect(r.unchanged).toEqual(['alerts.red_sla_hours']);
    expect(r.applied).toEqual([]);
  });

  test('rejects same source + target', () => {
    const cfg = new InMemoryConfigStore();
    expect(() =>
      cloneTenantConfig(cfg, 'BIL', 'BIL', 'admin', false, NOW),
    ).toThrow(/must differ/);
  });

  test('rejects empty ids', () => {
    const cfg = new InMemoryConfigStore();
    expect(() => cloneTenantConfig(cfg, '', 'BIL', 'admin', false, NOW)).toThrow(
      ConfigBulkError,
    );
    expect(() => cloneTenantConfig(cfg, 'BIL', '', 'admin', false, NOW)).toThrow(
      ConfigBulkError,
    );
  });
});

describe('POST /v1/admin/config/_clone', () => {
  test('200 with summary applies source overrides', async () => {
    const { app, cfg } = makeBulkApp('admin');
    cfg.set('BANK_DEMO', 'alerts.red_sla_hours', 9, 'admin', NOW);
    const r = await request(app)
      .post('/v1/admin/config/_clone')
      .set(TH_BIL)
      .send({ source_tenant_id: 'BANK_DEMO' });
    expect(r.status).toBe(200);
    expect(r.body.body.applied).toContain('alerts.red_sla_hours');
    expect(cfg.get('BIL', 'alerts.red_sla_hours')?.value).toBe(9);
  });

  test('dry_run honoured', async () => {
    const { app, cfg } = makeBulkApp('admin');
    cfg.set('BANK_DEMO', 'alerts.red_sla_hours', 11, 'admin', NOW);
    const r = await request(app)
      .post('/v1/admin/config/_clone')
      .set(TH_BIL)
      .send({ source_tenant_id: 'BANK_DEMO', dry_run: true });
    expect(r.body.body.dry_run).toBe(true);
    expect(cfg.get('BIL', 'alerts.red_sla_hours')?.is_default).toBe(true);
  });

  test('missing source_tenant_id → 400', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app).post('/v1/admin/config/_clone').set(TH_BIL).send({});
    expect(r.status).toBe(400);
  });

  test('clone-into-self → 400', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/admin/config/_clone')
      .set(TH_BIL)
      .send({ source_tenant_id: 'BIL' });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBulkApp('case_owner');
    const r = await request(app)
      .post('/v1/admin/config/_clone')
      .set(TH_BIL)
      .send({ source_tenant_id: 'BANK_DEMO' });
    expect(r.status).toBe(403);
  });
});
