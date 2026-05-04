// services/bff/__tests__/case_checklists.test.ts
//
// T6 M9.2 — Custom investigation checklists.

import request from 'supertest';
import {
  BUILT_IN_TEMPLATE_ID,
  ChecklistError,
  InMemoryChecklistTemplateStore,
  isChecklistCategory,
  listChecklistCategories,
  materialiseSteps,
  validateTemplateInput,
  type ChecklistTemplate,
  type ChecklistTemplateStep,
  type CreateTemplateInput,
} from '../src/case_checklists';
import { defaultSteps, InMemoryCaseInvestigationStore } from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeChlApp(
  role: string = 'admin',
  checklistTemplateStore?: InMemoryChecklistTemplateStore,
  caseInvestigationStore?: InMemoryCaseInvestigationStore,
) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    checklistTemplateStore: checklistTemplateStore ?? new InMemoryChecklistTemplateStore(),
    caseInvestigationStore: caseInvestigationStore ?? new InMemoryCaseInvestigationStore(),
  });
}

const KYC_TEMPLATE_INPUT: CreateTemplateInput = {
  name: 'KYC Quarterly Review',
  description: 'Standard KYC document refresh per RBI quarterly cadence',
  category: 'kyc_review',
  steps: [
    { step_id: 'pull_kyc_pack', name: 'Pull current KYC pack', description: 'Fetch ID + address proofs from DMS' },
    { step_id: 'verify_expiry', name: 'Verify expiry dates', description: 'Confirm no doc expires in next 90 days' },
    { step_id: 'request_refresh', name: 'Request refresh if needed', description: 'Send KYC_REMINDER SMS' },
  ],
};

// ─── Type guards + helpers ─────────────────────────────────────────────

describe('Type guards + helpers', () => {
  test('isChecklistCategory', () => {
    expect(isChecklistCategory('claim_fraud')).toBe(true);
    expect(isChecklistCategory('kyc_review')).toBe(true);
    expect(isChecklistCategory('sanctions')).toBe(true);
    expect(isChecklistCategory('complaint')).toBe(true);
    expect(isChecklistCategory('other')).toBe(true);
    expect(isChecklistCategory('whatever')).toBe(false);
  });

  test('listChecklistCategories canonical order', () => {
    expect(listChecklistCategories()).toEqual([
      'claim_fraud',
      'kyc_review',
      'sanctions',
      'complaint',
      'other',
    ]);
  });

  test('materialiseSteps fills in runtime fields', () => {
    const steps: ChecklistTemplateStep[] = [
      { step_id: 'a', name: 'Step A', description: 'desc' },
    ];
    const live = materialiseSteps({
      id: 'tpl-x',
      tenant_id: 'BIL',
      name: 'x',
      description: 'x',
      category: 'other',
      is_built_in: false,
      steps,
      created_at: NOW.toISOString(),
      created_by: 't',
    });
    expect(live.length).toBe(1);
    expect(live[0]!.completed).toBe(false);
    expect(live[0]!.completed_at).toBeNull();
    expect(live[0]!.completed_by).toBeNull();
    expect(live[0]!.evidence_link).toBeNull();
  });

  test('materialiseSteps returns fresh objects (not aliased)', () => {
    const a = materialiseSteps({
      id: 'tpl-x',
      tenant_id: 'BIL',
      name: 'x',
      description: 'x',
      category: 'other',
      is_built_in: false,
      steps: [{ step_id: 'a', name: 'A', description: 'd' }],
      created_at: NOW.toISOString(),
      created_by: 't',
    });
    const b = materialiseSteps({
      id: 'tpl-x',
      tenant_id: 'BIL',
      name: 'x',
      description: 'x',
      category: 'other',
      is_built_in: false,
      steps: [{ step_id: 'a', name: 'A', description: 'd' }],
      created_at: NOW.toISOString(),
      created_by: 't',
    });
    a[0]!.completed = true;
    expect(b[0]!.completed).toBe(false);
  });
});

// ─── validateTemplateInput ─────────────────────────────────────────────

describe('validateTemplateInput', () => {
  test('happy path returns the cleaned input', () => {
    const out = validateTemplateInput(KYC_TEMPLATE_INPUT);
    expect(out.name).toBe(KYC_TEMPLATE_INPUT.name);
    expect(out.steps.length).toBe(3);
  });

  test('missing name throws invalid_input', () => {
    expect(() =>
      validateTemplateInput({ ...KYC_TEMPLATE_INPUT, name: '' }),
    ).toThrow(/name is required/);
  });

  test('name > 200 chars throws', () => {
    expect(() =>
      validateTemplateInput({ ...KYC_TEMPLATE_INPUT, name: 'a'.repeat(201) }),
    ).toThrow(/≤ 200/);
  });

  test('description > 2000 chars throws', () => {
    expect(() =>
      validateTemplateInput({ ...KYC_TEMPLATE_INPUT, description: 'a'.repeat(2001) }),
    ).toThrow(/≤ 2000/);
  });

  test('invalid category throws invalid_category', () => {
    expect(() =>
      validateTemplateInput({ ...KYC_TEMPLATE_INPUT, category: 'foo' as never }),
    ).toThrow(/category must be one of/);
  });

  test('empty steps throws invalid_steps', () => {
    expect(() =>
      validateTemplateInput({ ...KYC_TEMPLATE_INPUT, steps: [] }),
    ).toThrow(/non-empty/);
  });

  test('> 32 steps throws invalid_steps', () => {
    const tooMany: ChecklistTemplateStep[] = [];
    for (let i = 0; i < 33; i++) {
      tooMany.push({ step_id: `s${i}`, name: `Step ${i}`, description: 'd' });
    }
    expect(() =>
      validateTemplateInput({ ...KYC_TEMPLATE_INPUT, steps: tooMany }),
    ).toThrow(/at most 32/);
  });

  test('duplicate step_id throws invalid_steps', () => {
    const dup: ChecklistTemplateStep[] = [
      { step_id: 'a', name: 'A', description: 'd' },
      { step_id: 'a', name: 'A2', description: 'd' },
    ];
    expect(() =>
      validateTemplateInput({ ...KYC_TEMPLATE_INPUT, steps: dup }),
    ).toThrow(/duplicate/);
  });

  test('step_id with spaces / uppercase rejected', () => {
    expect(() =>
      validateTemplateInput({
        ...KYC_TEMPLATE_INPUT,
        steps: [{ step_id: 'My Step', name: 'X', description: 'd' }],
      }),
    ).toThrow(/lowercase/);
  });

  test('error code surfaced via ChecklistError', () => {
    try {
      validateTemplateInput({});
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ChecklistError);
      expect((e as ChecklistError).code).toBe('invalid_input');
    }
  });
});

// ─── Store ─────────────────────────────────────────────────────────────

describe('InMemoryChecklistTemplateStore — list + get', () => {
  test('built-in template visible to every tenant', () => {
    const s = new InMemoryChecklistTemplateStore();
    expect(s.list('BIL').length).toBe(1);
    expect(s.list('BANK_DEMO').length).toBe(1);
    const builtIn = s.list('BIL')[0]!;
    expect(builtIn.id).toBe(BUILT_IN_TEMPLATE_ID);
    expect(builtIn.is_built_in).toBe(true);
    expect(builtIn.tenant_id).toBe('PLATFORM');
  });

  test('built-in steps match M9.1 defaultSteps()', () => {
    const s = new InMemoryChecklistTemplateStore();
    const builtIn = s.get('BIL', BUILT_IN_TEMPLATE_ID)!;
    expect(builtIn.steps.length).toBe(defaultSteps().length);
    expect(builtIn.steps.map((x) => x.step_id)).toEqual(
      defaultSteps().map((x) => x.step_id),
    );
  });

  test('create stores per-tenant; visible alongside built-in', () => {
    const s = new InMemoryChecklistTemplateStore();
    const tpl = s.create('BIL', KYC_TEMPLATE_INPUT, 'taniya', NOW);
    expect(tpl.id).toMatch(/^tpl-/);
    expect(tpl.tenant_id).toBe('BIL');
    expect(tpl.is_built_in).toBe(false);
    expect(tpl.created_by).toBe('taniya');
    const list = s.list('BIL');
    expect(list.length).toBe(2); // built-in + custom
    expect(list.find((x) => x.id === tpl.id)).toBeDefined();
  });

  test('cross-tenant isolation — BIL custom not visible to BANK_DEMO', () => {
    const s = new InMemoryChecklistTemplateStore();
    const tpl = s.create('BIL', KYC_TEMPLATE_INPUT, 'taniya', NOW);
    expect(s.get('BANK_DEMO', tpl.id)).toBeNull();
    expect(s.list('BANK_DEMO').length).toBe(1); // just built-in
  });

  test('category filter narrows', () => {
    const s = new InMemoryChecklistTemplateStore();
    s.create('BIL', KYC_TEMPLATE_INPUT, 't', NOW);
    s.create(
      'BIL',
      { ...KYC_TEMPLATE_INPUT, name: 'Sanctions', category: 'sanctions' },
      't',
      NOW,
    );
    expect(s.list('BIL', { category: 'kyc_review' }).length).toBe(1);
    expect(s.list('BIL', { category: 'claim_fraud' }).length).toBe(1); // built-in
    expect(s.list('BIL', { category: 'sanctions' }).length).toBe(1);
  });

  test('create rejects bad input via validateTemplateInput', () => {
    const s = new InMemoryChecklistTemplateStore();
    expect(() => s.create('BIL', { ...KYC_TEMPLATE_INPUT, name: '' }, 't', NOW)).toThrow(
      /name is required/,
    );
  });
});

describe('InMemoryChecklistTemplateStore — delete', () => {
  test('deletes a custom template', () => {
    const s = new InMemoryChecklistTemplateStore();
    const tpl = s.create('BIL', KYC_TEMPLATE_INPUT, 't', NOW);
    s.delete('BIL', tpl.id);
    expect(s.get('BIL', tpl.id)).toBeNull();
  });

  test('refuses to delete built-in (cannot_delete_builtin)', () => {
    const s = new InMemoryChecklistTemplateStore();
    try {
      s.delete('BIL', BUILT_IN_TEMPLATE_ID);
      fail('expected throw');
    } catch (e) {
      expect((e as ChecklistError).code).toBe('cannot_delete_builtin');
    }
  });

  test('unknown id throws unknown_template', () => {
    const s = new InMemoryChecklistTemplateStore();
    try {
      s.delete('BIL', 'tpl-nope');
      fail('expected throw');
    } catch (e) {
      expect((e as ChecklistError).code).toBe('unknown_template');
    }
  });

  test('cross-tenant delete throws unknown_template (BIL\'s id invisible to BANK_DEMO)', () => {
    const s = new InMemoryChecklistTemplateStore();
    const tpl = s.create('BIL', KYC_TEMPLATE_INPUT, 't', NOW);
    try {
      s.delete('BANK_DEMO', tpl.id);
      fail('expected throw');
    } catch (e) {
      expect((e as ChecklistError).code).toBe('unknown_template');
    }
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/investigations/checklists', () => {
  test('returns built-in alone for a fresh tenant', async () => {
    const { app } = makeChlApp('admin');
    const r = await request(app).get('/v1/investigations/checklists').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].id).toBe(BUILT_IN_TEMPLATE_ID);
  });

  test('after create, list shows built-in + custom', async () => {
    const store = new InMemoryChecklistTemplateStore();
    store.create('BIL', KYC_TEMPLATE_INPUT, 'taniya', NOW);
    const { app } = makeChlApp('admin', store);
    const r = await request(app).get('/v1/investigations/checklists').set(TH_BIL);
    expect(r.body.body.total).toBe(2);
  });

  test('?category=kyc_review narrows', async () => {
    const store = new InMemoryChecklistTemplateStore();
    store.create('BIL', KYC_TEMPLATE_INPUT, 't', NOW);
    const { app } = makeChlApp('admin', store);
    const r = await request(app)
      .get('/v1/investigations/checklists?category=kyc_review')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].category).toBe('kyc_review');
  });

  test('?category=invalid → 400 EWS_400_invalid_category', async () => {
    const { app } = makeChlApp('admin');
    const r = await request(app)
      .get('/v1/investigations/checklists?category=foo')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('analyst+ accepted', async () => {
    const { app } = makeChlApp('risk_analyst');
    const r = await request(app).get('/v1/investigations/checklists').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeChlApp('case_owner');
    const r = await request(app).get('/v1/investigations/checklists').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/investigations/checklists/:id', () => {
  test('built-in id → 200', async () => {
    const { app } = makeChlApp('admin');
    const r = await request(app)
      .get(`/v1/investigations/checklists/${BUILT_IN_TEMPLATE_ID}`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.is_built_in).toBe(true);
  });

  test('unknown id → 404 EWS_404_unknown_template', async () => {
    const { app } = makeChlApp('admin');
    const r = await request(app).get('/v1/investigations/checklists/tpl-nope').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
  });

  test('cross-tenant lookup → 404 (BIL custom invisible to BANK_DEMO)', async () => {
    const store = new InMemoryChecklistTemplateStore();
    const tpl = store.create('BIL', KYC_TEMPLATE_INPUT, 't', NOW);
    const { app } = makeChlApp('admin', store);
    const r = await request(app).get(`/v1/investigations/checklists/${tpl.id}`).set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('POST /v1/investigations/checklists', () => {
  test('admin: 201 with the new template', async () => {
    const store = new InMemoryChecklistTemplateStore();
    const { app } = makeChlApp('admin', store);
    const r = await request(app)
      .post('/v1/investigations/checklists')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send(KYC_TEMPLATE_INPUT);
    expect(r.status).toBe(201);
    expect(r.body.body.id).toMatch(/^tpl-/);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.created_by).toBe('taniya');
  });

  test('accepts an enveloped request body', async () => {
    const store = new InMemoryChecklistTemplateStore();
    const { app } = makeChlApp('admin', store);
    const r = await request(app)
      .post('/v1/investigations/checklists')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: KYC_TEMPLATE_INPUT });
    expect(r.status).toBe(201);
  });

  test('400 EWS_400_invalid_input on missing name', async () => {
    const { app } = makeChlApp('admin');
    const r = await request(app)
      .post('/v1/investigations/checklists')
      .set(TH_BIL)
      .send({ ...KYC_TEMPLATE_INPUT, name: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('400 EWS_400_invalid_steps on duplicate step_id', async () => {
    const { app } = makeChlApp('admin');
    const r = await request(app)
      .post('/v1/investigations/checklists')
      .set(TH_BIL)
      .send({
        ...KYC_TEMPLATE_INPUT,
        steps: [
          { step_id: 'a', name: 'A', description: 'd' },
          { step_id: 'a', name: 'A2', description: 'd' },
        ],
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_steps');
  });

  test('non-admin → 403', async () => {
    const { app } = makeChlApp('risk_analyst');
    const r = await request(app)
      .post('/v1/investigations/checklists')
      .set(TH_BIL)
      .send(KYC_TEMPLATE_INPUT);
    expect(r.status).toBe(403);
  });
});

describe('DELETE /v1/investigations/checklists/:id', () => {
  test('deletes a custom template', async () => {
    const store = new InMemoryChecklistTemplateStore();
    const tpl = store.create('BIL', KYC_TEMPLATE_INPUT, 't', NOW);
    const { app } = makeChlApp('admin', store);
    const r = await request(app).delete(`/v1/investigations/checklists/${tpl.id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.deleted).toBe(true);
    expect(store.get('BIL', tpl.id)).toBeNull();
  });

  test('built-in → 409 EWS_409_cannot_delete_builtin', async () => {
    const { app } = makeChlApp('admin');
    const r = await request(app)
      .delete(`/v1/investigations/checklists/${BUILT_IN_TEMPLATE_ID}`)
      .set(TH_BIL);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_cannot_delete_builtin');
  });

  test('unknown id → 404', async () => {
    const { app } = makeChlApp('admin');
    const r = await request(app).delete('/v1/investigations/checklists/tpl-nope').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('non-admin → 403', async () => {
    const { app } = makeChlApp('risk_analyst');
    const r = await request(app)
      .delete(`/v1/investigations/checklists/${BUILT_IN_TEMPLATE_ID}`)
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── Integration with POST /v1/investigations ──────────────────────────

describe('POST /v1/investigations with checklist_template_id', () => {
  test('built-in id → seeded with M9.1 default 8 steps, checklist_template_id recorded', async () => {
    const { app } = makeChlApp('admin');
    const r = await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({
        case_id: 'CASE-1',
        customer_id: 'c-1',
        checklist_template_id: BUILT_IN_TEMPLATE_ID,
      });
    expect(r.status).toBe(201);
    expect(r.body.body.steps.length).toBe(8);
    expect(r.body.body.checklist_template_id).toBe(BUILT_IN_TEMPLATE_ID);
  });

  test('omitted template_id → defaults work, checklist_template_id="BUILT_IN"', async () => {
    const { app } = makeChlApp('admin');
    const r = await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({ case_id: 'CASE-2', customer_id: 'c-2' });
    expect(r.status).toBe(201);
    expect(r.body.body.steps.length).toBe(8);
    expect(r.body.body.checklist_template_id).toBe('BUILT_IN');
  });

  test('custom template id → seeded with that template\'s steps', async () => {
    const store = new InMemoryChecklistTemplateStore();
    const tpl = store.create('BIL', KYC_TEMPLATE_INPUT, 't', NOW);
    const { app } = makeChlApp('admin', store);
    const r = await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({
        case_id: 'CASE-3',
        customer_id: 'c-3',
        checklist_template_id: tpl.id,
      });
    expect(r.status).toBe(201);
    expect(r.body.body.steps.length).toBe(KYC_TEMPLATE_INPUT.steps.length);
    expect(r.body.body.steps.map((s: { step_id: string }) => s.step_id)).toEqual(
      KYC_TEMPLATE_INPUT.steps.map((s) => s.step_id),
    );
    expect(r.body.body.checklist_template_id).toBe(tpl.id);
  });

  test('unknown template_id → 404 EWS_404_unknown_template (does not open the investigation)', async () => {
    const invStore = new InMemoryCaseInvestigationStore();
    const { app } = makeChlApp('admin', undefined, invStore);
    const r = await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({
        case_id: 'CASE-4',
        customer_id: 'c-4',
        checklist_template_id: 'tpl-nope',
      });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
    // Confirm no investigation was created
    expect(invStore.list('BIL', {}).total).toBe(0);
  });

  test('cross-tenant template_id → 404 (BIL custom invisible to BANK_DEMO)', async () => {
    const store = new InMemoryChecklistTemplateStore();
    const tpl = store.create('BIL', KYC_TEMPLATE_INPUT, 't', NOW);
    const { app } = makeChlApp('admin', store);
    const r = await request(app)
      .post('/v1/investigations')
      .set(TH_BANK)
      .send({
        case_id: 'CASE-5',
        customer_id: 'c-5',
        checklist_template_id: tpl.id,
      });
    expect(r.status).toBe(404);
  });

  test('opening with a custom template still works through the rest of M9.1 flow', async () => {
    const tplStore = new InMemoryChecklistTemplateStore();
    const tpl = tplStore.create('BIL', KYC_TEMPLATE_INPUT, 't', NOW);
    const invStore = new InMemoryCaseInvestigationStore();
    const { app } = makeChlApp('admin', tplStore, invStore);
    const open = await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({
        case_id: 'CASE-6',
        customer_id: 'c-6',
        checklist_template_id: tpl.id,
      });
    const id = open.body.body.investigation_id;
    // Mark the first KYC step complete
    const step = await request(app)
      .post(`/v1/investigations/${id}/steps/pull_kyc_pack/complete`)
      .set(TH_BIL)
      .send({ evidence_link: 'docs:KYC-9' });
    expect(step.status).toBe(200);
    const updated = step.body.body.steps as Array<{ step_id: string; completed: boolean }>;
    expect(updated.find((s) => s.step_id === 'pull_kyc_pack')!.completed).toBe(true);
  });
});
