// services/bff/__tests__/rule_template_bundle.test.ts
//
// T6 M5.11 — Custom rule template export/import bundle.

import request from 'supertest';
import {
  BUNDLE_MAX_ITEMS,
  BUNDLE_SCHEMA_VERSION,
  BundleError,
  exportBundle,
  importBundle,
  validateBundle,
} from '../src/rule_template_bundle';
import { InMemoryCustomRuleTemplateStore } from '../src/rule_templates_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T20:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID = {
  name: 'Sudden cash withdrawals',
  description: 'Detects unusual ATM withdrawal patterns within 24h.',
  vertical: 'banking' as const,
  category: 'fraud_detection' as const,
  condition_pseudocode: 'count(atm_withdrawal, 24h) > 10 AND amount_total > 50000',
  recommended_severity: 'high' as const,
  recommended_actions: ['open_case', 'notify_supervisor'] as const,
  supporting_indicators: ['TXN-001', 'BEH-007'],
  source_doc: 'BIL Fraud Playbook §3.2',
};

const VALID2 = {
  ...VALID,
  name: 'Insurance claim spike',
  vertical: 'insurance' as const,
  category: 'risk_monitoring' as const,
  condition_pseudocode: 'claims_count_30d > 3 AND avg_claim_amount > 100000',
  recommended_actions: ['flag_for_review'] as const,
  supporting_indicators: ['CLM-001'],
};

function makeBundleApp(role = 'admin') {
  const store = new InMemoryCustomRuleTemplateStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customRuleTemplateStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

// ─── validateBundle ───────────────────────────────────────────────────

describe('M5.11 — validateBundle', () => {
  function mkBundle(over: Partial<Record<string, unknown>> = {}) {
    return {
      schema_version: BUNDLE_SCHEMA_VERSION,
      exported_at: NOW.toISOString(),
      exported_by: 'admin',
      source_tenant_id: 'BIL',
      items: [
        {
          id: 'cust-1',
          name: 'Test',
          description: 'd',
          vertical: 'banking',
          category: 'fraud_detection',
          condition_pseudocode: 'a > b',
          recommended_severity: 'high',
          recommended_actions: ['open_case'],
          supporting_indicators: ['TXN-001'],
          source_doc: 'doc',
        },
      ],
      ...over,
    };
  }

  test('happy: valid bundle round-trips', () => {
    const out = validateBundle(mkBundle());
    expect(out.schema_version).toBe(BUNDLE_SCHEMA_VERSION);
    expect(out.items).toHaveLength(1);
  });

  test('rejects wrong schema_version', () => {
    expect(() => validateBundle(mkBundle({ schema_version: '99' }))).toThrow(
      /schema_version/,
    );
  });

  test('rejects missing exported_by', () => {
    expect(() => validateBundle(mkBundle({ exported_by: '' }))).toThrow(/exported_by/);
  });

  test('rejects missing source_tenant_id', () => {
    expect(() => validateBundle(mkBundle({ source_tenant_id: '' }))).toThrow(
      /source_tenant_id/,
    );
  });

  test('rejects empty items[]', () => {
    expect(() => validateBundle(mkBundle({ items: [] }))).toThrow(/at least 1 item/);
  });

  test('rejects items > BUNDLE_MAX_ITEMS', () => {
    const items = Array.from({ length: BUNDLE_MAX_ITEMS + 1 }, (_, i) => ({
      id: `c-${i}`,
      name: `n-${i}`,
      description: 'd',
      vertical: 'banking',
      category: 'fraud_detection',
      condition_pseudocode: 'a > b',
      recommended_severity: 'high',
      recommended_actions: ['open_case'],
      supporting_indicators: ['TXN-001'],
      source_doc: 'doc',
    }));
    expect(() => validateBundle(mkBundle({ items }))).toThrow(/cap/);
  });

  test('rejects item missing id', () => {
    expect(() =>
      validateBundle(
        mkBundle({
          items: [
            {
              name: 'x',
              description: 'd',
              vertical: 'banking',
              category: 'fraud_detection',
              condition_pseudocode: 'a > b',
              recommended_severity: 'high',
              recommended_actions: ['open_case'],
              supporting_indicators: ['TXN-001'],
              source_doc: 'doc',
            },
          ],
        }),
      ),
    ).toThrow(/items\[0\]\.id/);
  });

  test('rejects empty supporting_indicators', () => {
    expect(() =>
      validateBundle(
        mkBundle({
          items: [
            {
              id: 'c-1',
              name: 'x',
              description: 'd',
              vertical: 'banking',
              category: 'fraud_detection',
              condition_pseudocode: 'a > b',
              recommended_severity: 'high',
              recommended_actions: ['open_case'],
              supporting_indicators: [],
              source_doc: 'doc',
            },
          ],
        }),
      ),
    ).toThrow(/supporting_indicators/);
  });
});

// ─── exportBundle ─────────────────────────────────────────────────────

describe('M5.11 — exportBundle', () => {
  test('happy: snapshots requested templates into envelope', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const t1 = s.create('BIL', VALID, 'admin', NOW);
    const t2 = s.create('BIL', VALID2, 'admin', NOW);
    const bundle = exportBundle(s, {
      tenant_id: 'BIL',
      template_ids: [t1.id, t2.id],
      exported_by: 'compliance.lead',
      now: NOW,
    });
    expect(bundle.schema_version).toBe(BUNDLE_SCHEMA_VERSION);
    expect(bundle.source_tenant_id).toBe('BIL');
    expect(bundle.exported_by).toBe('compliance.lead');
    expect(bundle.items).toHaveLength(2);
    expect(bundle.items[0]!.id).toBe(t1.id);
    expect(bundle.items[1]!.id).toBe(t2.id);
  });

  test('items are deep-copied — mutating bundle does not leak into store', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const t = s.create('BIL', VALID, 'admin', NOW);
    const bundle = exportBundle(s, {
      tenant_id: 'BIL',
      template_ids: [t.id],
      exported_by: 'admin',
      now: NOW,
    });
    bundle.items[0]!.name = 'TAMPERED';
    bundle.items[0]!.supporting_indicators.push('LEAKED');
    const live = s.get('BIL', t.id)!;
    expect(live.name).toBe(VALID.name);
    expect(live.supporting_indicators).toEqual(['TXN-001', 'BEH-007']);
  });

  test('unknown template_id → unknown_template', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(() =>
      exportBundle(s, {
        tenant_id: 'BIL',
        template_ids: ['cust-nope'],
        exported_by: 'admin',
        now: NOW,
      }),
    ).toThrow(/not found/);
  });

  test('duplicate template_id → invalid_input', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const t = s.create('BIL', VALID, 'admin', NOW);
    expect(() =>
      exportBundle(s, {
        tenant_id: 'BIL',
        template_ids: [t.id, t.id],
        exported_by: 'admin',
        now: NOW,
      }),
    ).toThrow(/duplicate/);
  });

  test('empty template_ids[] → invalid_input', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(() =>
      exportBundle(s, {
        tenant_id: 'BIL',
        template_ids: [],
        exported_by: 'admin',
        now: NOW,
      }),
    ).toThrow(/non-empty/);
  });

  test('cross-tenant: BIL template_ids do not export from BANK_DEMO', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const t = s.create('BIL', VALID, 'admin', NOW);
    expect(() =>
      exportBundle(s, {
        tenant_id: 'BANK_DEMO',
        template_ids: [t.id],
        exported_by: 'admin',
        now: NOW,
      }),
    ).toThrow(/not found/);
  });
});

// ─── importBundle ─────────────────────────────────────────────────────

describe('M5.11 — importBundle', () => {
  test('happy: every item created in target tenant', () => {
    const src = new InMemoryCustomRuleTemplateStore();
    const t1 = src.create('BIL', VALID, 'admin', NOW);
    const t2 = src.create('BIL', VALID2, 'admin', NOW);
    const bundle = exportBundle(src, {
      tenant_id: 'BIL',
      template_ids: [t1.id, t2.id],
      exported_by: 'admin',
      now: NOW,
    });
    const target = new InMemoryCustomRuleTemplateStore();
    const result = importBundle(target, {
      target_tenant_id: 'BANK_DEMO',
      bundle,
      imported_by: 'admin',
      now: NOW,
    });
    expect(result.total).toBe(2);
    expect(result.created_count).toBe(2);
    expect(result.skipped_count).toBe(0);
    expect(result.error_count).toBe(0);
    expect(target.list('BANK_DEMO')).toHaveLength(2);
    expect(target.list('BIL')).toHaveLength(0);
  });

  test('per-row outcome shape: source_id, status=created, new_id, name', () => {
    const src = new InMemoryCustomRuleTemplateStore();
    const t = src.create('BIL', VALID, 'admin', NOW);
    const bundle = exportBundle(src, {
      tenant_id: 'BIL',
      template_ids: [t.id],
      exported_by: 'admin',
      now: NOW,
    });
    const target = new InMemoryCustomRuleTemplateStore();
    const result = importBundle(target, {
      target_tenant_id: 'BANK_DEMO',
      bundle,
      imported_by: 'admin',
      now: NOW,
    });
    expect(result.rows[0]).toMatchObject({
      source_id: t.id,
      status: 'created',
      name: VALID.name,
    });
    expect((result.rows[0] as { new_id: string }).new_id).toMatch(/.+/);
  });

  test('name_prefix is applied to every imported template', () => {
    const src = new InMemoryCustomRuleTemplateStore();
    const t = src.create('BIL', VALID, 'admin', NOW);
    const bundle = exportBundle(src, {
      tenant_id: 'BIL',
      template_ids: [t.id],
      exported_by: 'admin',
      now: NOW,
    });
    const result = importBundle(src, {
      target_tenant_id: 'BIL', // re-import into SAME tenant with prefix
      bundle,
      imported_by: 'admin',
      name_prefix: 'COPY — ',
      now: NOW,
    });
    expect(result.created_count).toBe(1);
    const live = src.list('BIL').map((x) => x.name);
    expect(live).toContain('COPY — ' + VALID.name);
  });

  test('already_exists collision skips with reason', () => {
    const target = new InMemoryCustomRuleTemplateStore();
    target.create('BANK_DEMO', VALID, 'admin', NOW); // pre-exists
    const src = new InMemoryCustomRuleTemplateStore();
    const t = src.create('BIL', VALID, 'admin', NOW);
    const bundle = exportBundle(src, {
      tenant_id: 'BIL',
      template_ids: [t.id],
      exported_by: 'admin',
      now: NOW,
    });
    const result = importBundle(target, {
      target_tenant_id: 'BANK_DEMO',
      bundle,
      imported_by: 'admin',
      now: NOW,
    });
    expect(result.created_count).toBe(0);
    expect(result.skipped_count).toBe(1);
    expect(result.rows[0]).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('already_exists'),
    });
  });

  test('intra-bundle name collision: second occurrence skipped', () => {
    const src = new InMemoryCustomRuleTemplateStore();
    const t1 = src.create('BIL', VALID, 'admin', NOW);
    const t2 = src.create('BIL', { ...VALID2, name: 'X' }, 'admin', NOW);
    // Forge a bundle with two items having the same name (manually
    // crafted — the export path wouldn't normally produce this since
    // the store enforces unique names within a tenant, but a user
    // could hand-edit a bundle)
    const bundle = exportBundle(src, {
      tenant_id: 'BIL',
      template_ids: [t1.id, t2.id],
      exported_by: 'admin',
      now: NOW,
    });
    bundle.items[1]!.name = bundle.items[0]!.name;
    const target = new InMemoryCustomRuleTemplateStore();
    const result = importBundle(target, {
      target_tenant_id: 'BANK_DEMO',
      bundle,
      imported_by: 'admin',
      now: NOW,
    });
    expect(result.created_count).toBe(1);
    expect(result.skipped_count).toBe(1);
  });

  test('rejects bundle with wrong schema_version', () => {
    const target = new InMemoryCustomRuleTemplateStore();
    expect(() =>
      importBundle(target, {
        target_tenant_id: 'BIL',
        bundle: {
          schema_version: '99',
          exported_at: NOW.toISOString(),
          exported_by: 'admin',
          source_tenant_id: 'BIL',
          items: [],
        },
        imported_by: 'admin',
        now: NOW,
      }),
    ).toThrow(/schema_version/);
  });

  test('name_prefix > 24 chars → invalid_input', () => {
    const src = new InMemoryCustomRuleTemplateStore();
    const t = src.create('BIL', VALID, 'admin', NOW);
    const bundle = exportBundle(src, {
      tenant_id: 'BIL',
      template_ids: [t.id],
      exported_by: 'admin',
      now: NOW,
    });
    expect(() =>
      importBundle(src, {
        target_tenant_id: 'BIL',
        bundle,
        imported_by: 'admin',
        name_prefix: 'X'.repeat(25),
        now: NOW,
      }),
    ).toThrow(/name_prefix/);
  });

  test('error rows: bad item shape (mutated bundle) surfaces as error, not throw', () => {
    const src = new InMemoryCustomRuleTemplateStore();
    const t = src.create('BIL', VALID, 'admin', NOW);
    const bundle = exportBundle(src, {
      tenant_id: 'BIL',
      template_ids: [t.id],
      exported_by: 'admin',
      now: NOW,
    });
    // Hand-edit to violate the store's validate (description too long)
    bundle.items[0]!.description = 'x'.repeat(501);
    const target = new InMemoryCustomRuleTemplateStore();
    const result = importBundle(target, {
      target_tenant_id: 'BANK_DEMO',
      bundle,
      imported_by: 'admin',
      now: NOW,
    });
    expect(result.error_count).toBe(1);
    expect(result.rows[0]?.status).toBe('error');
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('M5.11 — POST /v1/rules/templates/custom/export-bundle', () => {
  test('happy: 200 with bundle', async () => {
    const { app, store } = makeBundleApp('admin');
    const t = store.create('BIL', VALID, 'admin', NOW);
    const r = await request(app)
      .post('/v1/rules/templates/custom/export-bundle')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send({ template_ids: [t.id] });
    expect(r.status).toBe(200);
    expect(r.body.body.schema_version).toBe(BUNDLE_SCHEMA_VERSION);
    expect(r.body.body.source_tenant_id).toBe('BIL');
    expect(r.body.body.exported_by).toBe('compliance.lead');
    expect(r.body.body.items).toHaveLength(1);
  });

  test('empty template_ids[] → 400', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/custom/export-bundle')
      .set(TH_BIL)
      .send({ template_ids: [] });
    expect(r.status).toBe(400);
  });

  test('unknown template_id → 404', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/custom/export-bundle')
      .set(TH_BIL)
      .send({ template_ids: ['cust-nope'] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
  });

  test('cross-tenant: BANK_DEMO cannot export BIL template', async () => {
    const { app, store } = makeBundleApp('admin');
    const t = store.create('BIL', VALID, 'admin', NOW);
    const r = await request(app)
      .post('/v1/rules/templates/custom/export-bundle')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send({ template_ids: [t.id] });
    expect(r.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBundleApp('case_owner');
    const r = await request(app)
      .post('/v1/rules/templates/custom/export-bundle')
      .set(TH_BIL)
      .send({ template_ids: ['x'] });
    expect(r.status).toBe(403);
  });
});

describe('M5.11 — POST /v1/rules/templates/custom/import-bundle', () => {
  test('happy: 201 with import result', async () => {
    const { app, store } = makeBundleApp('admin');
    const src = store.create('BIL', VALID, 'admin', NOW);
    const ex = await request(app)
      .post('/v1/rules/templates/custom/export-bundle')
      .set(TH_BIL)
      .send({ template_ids: [src.id] });
    const bundle = ex.body.body;

    // Re-import into BIL with a name_prefix to avoid collision
    const r = await request(app)
      .post('/v1/rules/templates/custom/import-bundle')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send({ bundle, name_prefix: 'COPY — ' });
    expect(r.status).toBe(201);
    expect(r.body.body.created_count).toBe(1);
    expect(r.body.body.imported_by).toBe('compliance.lead');
    expect(r.body.body.target_tenant_id).toBe('BIL');
  });

  test('bad bundle (wrong schema_version) → 400', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/custom/import-bundle')
      .set(TH_BIL)
      .send({
        bundle: {
          schema_version: '99',
          exported_at: NOW.toISOString(),
          exported_by: 'admin',
          source_tenant_id: 'BIL',
          items: [{ id: 'x', name: 'y', supporting_indicators: ['TXN-001'] }],
        },
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_unsupported_schema_version');
  });

  test('missing bundle field → 400', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/custom/import-bundle')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });

  test('cross-tenant import: BIL bundle imported into BANK_DEMO succeeds', async () => {
    const { app, store } = makeBundleApp('admin');
    const src = store.create('BIL', VALID, 'admin', NOW);
    const ex = await request(app)
      .post('/v1/rules/templates/custom/export-bundle')
      .set(TH_BIL)
      .send({ template_ids: [src.id] });
    const bundle = ex.body.body;
    const r = await request(app)
      .post('/v1/rules/templates/custom/import-bundle')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send({ bundle });
    expect(r.status).toBe(201);
    expect(r.body.body.created_count).toBe(1);
    expect(r.body.body.target_tenant_id).toBe('BANK_DEMO');
    expect(store.list('BANK_DEMO')).toHaveLength(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBundleApp('case_owner');
    const r = await request(app)
      .post('/v1/rules/templates/custom/import-bundle')
      .set(TH_BIL)
      .send({ bundle: {} });
    expect(r.status).toBe(403);
  });

  test('M5.8 PUT still works (literal /export-bundle did not shadow :template_id)', async () => {
    const { app, store } = makeBundleApp('admin');
    const t = store.create('BIL', VALID, 'admin', NOW);
    const r = await request(app)
      .put(`/v1/rules/templates/custom/${t.id}`)
      .set(TH_BIL)
      .send({ ...VALID, name: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.body.body.name).toBe('Renamed');
  });
});
