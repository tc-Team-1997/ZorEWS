// services/bff/__tests__/rule_template_versions.test.ts
//
// T6 M5.12 — Rule template version snapshots.

import request from 'supertest';
import {
  InMemoryCustomRuleTemplateStore,
  type CustomRuleTemplateInput,
} from '../src/rule_templates_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkInput(overrides: Partial<CustomRuleTemplateInput> = {}): CustomRuleTemplateInput {
  return {
    name: overrides.name ?? 'Fraud uplift v1',
    description: overrides.description ?? 'Catches repeat-claim fraud signals',
    vertical: overrides.vertical ?? 'insurance',
    category: overrides.category ?? 'fraud_detection',
    condition_pseudocode:
      overrides.condition_pseudocode ?? 'CLM-001 > 0 AND CLM-002 > 0.3',
    recommended_severity: overrides.recommended_severity ?? 'high',
    recommended_actions: overrides.recommended_actions ?? ['open_case', 'notify_supervisor'],
    supporting_indicators: overrides.supporting_indicators ?? ['CLM-001', 'CLM-002'],
    ...(overrides.source_doc !== undefined ? { source_doc: overrides.source_doc } : {}),
  };
}

// ─── Store-level version tracking ─────────────────────────────────────

describe('M5.12 — create captures v1', () => {
  test('create pushes v1 snapshot mirroring the created template', () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const created = store.create('BIL', mkInput(), 'alice', NOW);
    const versions = store.listVersions('BIL', created.id);
    expect(versions.length).toBe(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.captured_by).toBe('alice');
    expect(versions[0]!.captured_at).toBe(NOW.toISOString());
    expect(versions[0]!.snapshot.name).toBe('Fraud uplift v1');
  });
});

describe('M5.12 — update pushes next version', () => {
  test('update increments version, snapshot reflects post-write state', () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput({ name: 'v1 name' }), 'alice', NOW);
    const updated = store.update(
      'BIL',
      c.id,
      mkInput({ name: 'v2 name' }),
      'bob',
      new Date(NOW.getTime() + 60_000),
    );
    expect(updated.name).toBe('v2 name');
    const versions = store.listVersions('BIL', c.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]!.snapshot.name).toBe('v1 name');
    expect(versions[1]!.snapshot.name).toBe('v2 name');
    expect(versions[1]!.captured_by).toBe('bob');
  });
});

describe('M5.12 — version numbers monotonic across cap eviction', () => {
  test('once cap (20) reached, oldest evicted but version numbers continue counting', () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput({ name: 'v1' }), 'alice', NOW);
    // Already v1 from create. Push 25 updates → version numbers reach 26.
    for (let i = 2; i <= 26; i++) {
      store.update(
        'BIL',
        c.id,
        mkInput({ name: `v${i}` }),
        'alice',
        new Date(NOW.getTime() + i * 60_000),
      );
    }
    const versions = store.listVersions('BIL', c.id);
    expect(versions.length).toBe(20); // cap
    // Oldest survivor is v7 (v1..v6 evicted), newest is v26.
    expect(versions[0]!.version).toBe(7);
    expect(versions[versions.length - 1]!.version).toBe(26);
    expect(versions[versions.length - 1]!.snapshot.name).toBe('v26');
  });
});

describe('M5.12 — restoreVersion', () => {
  test('restores the live template to the chosen version + returns restored_from_version', () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput({ name: 'original' }), 'alice', NOW);
    store.update(
      'BIL',
      c.id,
      mkInput({ name: 'changed' }),
      'alice',
      new Date(NOW.getTime() + 60_000),
    );
    // Currently at v2 ('changed'). Restore to v1.
    const result = store.restoreVersion(
      'BIL',
      c.id,
      1,
      'bob',
      new Date(NOW.getTime() + 120_000),
    );
    expect(result.restored_from_version).toBe(1);
    expect(result.template.name).toBe('original');
    // Live store now matches the v1 snapshot.
    expect(store.get('BIL', c.id)!.name).toBe('original');
  });

  test('restore pushes a NEW version snapshot (audit trail of the restore itself)', () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput({ name: 'v1' }), 'alice', NOW);
    store.update('BIL', c.id, mkInput({ name: 'v2' }), 'alice', new Date(NOW.getTime() + 60_000));
    store.restoreVersion('BIL', c.id, 1, 'bob', new Date(NOW.getTime() + 120_000));
    const versions = store.listVersions('BIL', c.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions[2]!.snapshot.name).toBe('v1'); // restored state
    expect(versions[2]!.captured_by).toBe('bob');
  });

  test('restoreVersion with unknown version → unknown_version', () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput(), 'alice', NOW);
    expect(() =>
      store.restoreVersion('BIL', c.id, 999, 'bob', NOW),
    ).toThrow(/version 999 not found/);
  });

  test('restoreVersion on unknown template → unknown_template', () => {
    const store = new InMemoryCustomRuleTemplateStore();
    expect(() =>
      store.restoreVersion('BIL', 'tpl_custom_does_not_exist', 1, 'bob', NOW),
    ).toThrow(/template tpl_custom_does_not_exist not found/);
  });

  test('versions list returns a defensive copy — caller mutation does not corrupt the store', () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput({ name: 'pristine' }), 'alice', NOW);
    const versions = store.listVersions('BIL', c.id);
    versions[0]!.snapshot.name = 'MUTATED';
    versions[0]!.snapshot.recommended_actions.push('flag_for_review');
    // Re-read — store is unchanged.
    const fresh = store.listVersions('BIL', c.id);
    expect(fresh[0]!.snapshot.name).toBe('pristine');
    expect(fresh[0]!.snapshot.recommended_actions).toEqual(['open_case', 'notify_supervisor']);
  });
});

describe('M5.12 — tenant isolation', () => {
  test('listVersions cannot see another tenant template', () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const a = store.create('BIL', mkInput({ name: 'BIL one' }), 'alice', NOW);
    store.create('BANK_DEMO', mkInput({ name: 'DEMO one' }), 'alice', NOW);
    expect(store.listVersions('BIL', a.id).length).toBe(1);
    expect(store.listVersions('BANK_DEMO', a.id).length).toBe(0);
  });

  test('restoreVersion with cross-tenant id → unknown_template', () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const a = store.create('BIL', mkInput(), 'alice', NOW);
    expect(() =>
      store.restoreVersion('BANK_DEMO', a.id, 1, 'bob', NOW),
    ).toThrow(/not found/);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

function makeVersionsApp(role = 'admin', store?: InMemoryCustomRuleTemplateStore) {
  const customRuleTemplateStore = store ?? new InMemoryCustomRuleTemplateStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customRuleTemplateStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, customRuleTemplateStore };
}

describe('M5.12 — GET /v1/rules/templates/custom/:template_id/versions', () => {
  test('returns version list oldest-first', async () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput({ name: 'v1' }), 'alice', NOW);
    store.update('BIL', c.id, mkInput({ name: 'v2' }), 'alice', new Date(NOW.getTime() + 60_000));
    const { app } = makeVersionsApp('admin', store);
    const r = await request(app)
      .get(`/v1/rules/templates/custom/${c.id}/versions`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.template_id).toBe(c.id);
    expect(r.body.body.items.map((v: { version: number }) => v.version)).toEqual([1, 2]);
  });

  test('unknown template → 404', async () => {
    const { app } = makeVersionsApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/custom/tpl_custom_does_not_exist/versions')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeVersionsApp('case_owner');
    const r = await request(app)
      .get('/v1/rules/templates/custom/anything/versions')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('M5.12 — POST /v1/rules/templates/custom/:template_id/versions/:version/restore', () => {
  test('restores + bumps the live template, response carries restored_from_version', async () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput({ name: 'v1' }), 'alice', NOW);
    store.update('BIL', c.id, mkInput({ name: 'v2' }), 'alice', new Date(NOW.getTime() + 60_000));
    const { app } = makeVersionsApp('admin', store);
    const r = await request(app)
      .post(`/v1/rules/templates/custom/${c.id}/versions/1/restore`)
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.body.restored_from_version).toBe(1);
    expect(r.body.body.template.name).toBe('v1');
    expect(store.get('BIL', c.id)!.name).toBe('v1');
    // A third version snapshot now records the restore.
    expect(store.listVersions('BIL', c.id).length).toBe(3);
  });

  test('unknown version → 404 unknown_version', async () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput(), 'alice', NOW);
    const { app } = makeVersionsApp('admin', store);
    const r = await request(app)
      .post(`/v1/rules/templates/custom/${c.id}/versions/99/restore`)
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_version');
  });

  test('unknown template → 404 unknown_template', async () => {
    const { app } = makeVersionsApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/custom/tpl_custom_does_not_exist/versions/1/restore')
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
  });

  test('non-integer version path param → 400', async () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput(), 'alice', NOW);
    const { app } = makeVersionsApp('admin', store);
    const r = await request(app)
      .post(`/v1/rules/templates/custom/${c.id}/versions/abc/restore`)
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({});
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeVersionsApp('case_owner');
    const r = await request(app)
      .post('/v1/rules/templates/custom/anything/versions/1/restore')
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({});
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BANK_DEMO cannot restore BIL template', async () => {
    const store = new InMemoryCustomRuleTemplateStore();
    const c = store.create('BIL', mkInput(), 'alice', NOW);
    const { app } = makeVersionsApp('admin', store);
    const r = await request(app)
      .post(`/v1/rules/templates/custom/${c.id}/versions/1/restore`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .set('x-apex-user', 'bob')
      .send({});
    expect(r.status).toBe(404);
  });
});
