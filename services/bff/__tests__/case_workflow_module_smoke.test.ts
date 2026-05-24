// services/bff/__tests__/case_workflow_module_smoke.test.ts
//
// Module 3.2 — Case Workflow smoke.
//
// Per cross-cutting #1 + the user's "if already exist please dont do
// that again" guard: the 4 spec routes ALL pre-existed —
//   GET    /v1/cms/cases/stats                       (M3.1)
//   GET    /v1/cases/maker-checker?status=&action_type=  (M9.3)
//   POST   /v1/cases/maker-checker/:id/{approve,reject}  (M9.3)
//   POST   /v1/cms/cases/bulk-assign                 (M3.1)
//
// M3.2 closes the missing acceptance criterion — "Rejection requires
// reason" — by tightening the reject route to require a non-empty
// decision_notes (≥ 3 chars after trim) BEFORE the engine is called.
// The other acceptance "Same user can't be both maker and checker"
// was already enforced by M9.3 (self_approval_forbidden 409); this
// smoke re-asserts both end-to-end.

import request from 'supertest';
import {
  InMemoryMakerCheckerEngine,
  type SubmitActionInput,
} from '../src/case_maker_checker';
import { InMemoryCmsCaseStore } from '../src/cms_store';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-24T12:00:00.000Z');
const TH_BIL = {
  'x-tenant-id': 'BIL',
  'x-channel': 'API',
  'x-apex-user': 'alice.admin',
};
const TH_BANK = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-apex-user': 'alice.admin',
};

function makeSmokeApp(role = 'admin') {
  const makerCheckerEngine = new InMemoryMakerCheckerEngine();
  const cmsCaseStore = new InMemoryCmsCaseStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    cmsCaseStore,
    makerCheckerEngine,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, cmsCaseStore, makerCheckerEngine };
}

const VALID_INPUT: SubmitActionInput = {
  case_id: 'CASE-WF-1',
  action_type: 'case.close',
  payload: { outcome: 'cured', justification: 'paid in full' },
  rationale: 'Customer paid outstanding balance and confirmed via call',
};

describe('M3.2 Case Workflow — full smoke', () => {
  it('CW-A: full pipeline — submit (maker) → list pending → approve (different user) → reflects in stats', async () => {
    const { app, makerCheckerEngine, cmsCaseStore } = makeSmokeApp('admin');

    // Seed a CMS case so the stats counter has something to count.
    cmsCaseStore.create(
      'BIL',
      { title: 'Workflow smoke parent case', description: 'For pipeline counter', priority: 'P2' },
      'alice.admin',
      NOW,
    );

    // Maker submits a workflow action via POST /v1/cases/maker-checker
    const submit = await request(app)
      .post('/v1/cases/maker-checker')
      .set({ ...TH_BIL, 'x-apex-user': 'taniya.maker', 'x-apex-role': 'admin' })
      .send(VALID_INPUT);
    expect(submit.status).toBe(201);
    expect(submit.body.body.status).toBe('pending');
    const actionId = submit.body.body.action_id as string;

    // Pending list shows it
    const list = await request(app)
      .get('/v1/cases/maker-checker?status=pending')
      .set(TH_BIL);
    expect(list.status).toBe(200);
    expect(list.body.body.items.find((a: { action_id: string }) => a.action_id === actionId)).toBeTruthy();

    // Approve as a DIFFERENT user
    const approve = await request(app)
      .post(`/v1/cases/maker-checker/${actionId}/approve`)
      .set({ ...TH_BIL, 'x-apex-user': 'bob.checker' })
      .send({ decision_notes: 'verified payment' });
    expect(approve.status).toBe(200);
    expect(approve.body.body.status).toBe('approved');
    expect(approve.body.body.checker_username).toBe('bob.checker');

    // /v1/cms/cases/stats (the spec endpoint) still serves + reflects the seeded case
    const stats = await request(app).get('/v1/cms/cases/stats').set(TH_BIL);
    expect(stats.status).toBe(200);
    expect(stats.body.body.total).toBe(1);
    expect(stats.body.body.by_status.OPEN).toBe(1);

    // Engine state confirms decision
    const stored = makerCheckerEngine.get('BIL', actionId);
    expect(stored?.status).toBe('approved');
    expect(stored?.maker_username).toBe('taniya.maker');
    expect(stored?.checker_username).toBe('bob.checker');
  });

  it('CW-B SPEC ACCEPTANCE — rejection requires reason: empty body → 400 EWS_400_invalid_input', async () => {
    const { app, makerCheckerEngine } = makeSmokeApp('admin');
    const a = makerCheckerEngine.submit('BIL', VALID_INPUT, 'taniya.maker', NOW);

    // Empty body — no decision_notes
    const r1 = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/reject`)
      .set({ ...TH_BIL, 'x-apex-user': 'bob.checker' })
      .send({});
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('EWS_400_invalid_input');
    expect(r1.body.error.message).toMatch(/decision_notes/);

    // Whitespace-only — also 400 (trimmed length < 3)
    const r2 = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/reject`)
      .set({ ...TH_BIL, 'x-apex-user': 'bob.checker' })
      .send({ decision_notes: '   ' });
    expect(r2.status).toBe(400);

    // Too short
    const r3 = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/reject`)
      .set({ ...TH_BIL, 'x-apex-user': 'bob.checker' })
      .send({ decision_notes: 'no' });
    expect(r3.status).toBe(400);

    // Action remains pending — none of the 400s mutated state
    const after = makerCheckerEngine.get('BIL', a.action_id);
    expect(after?.status).toBe('pending');
  });

  it('CW-C SPEC ACCEPTANCE — rejection with valid reason: 200 + status=rejected + trimmed notes stored', async () => {
    const { app, makerCheckerEngine } = makeSmokeApp('admin');
    const a = makerCheckerEngine.submit('BIL', VALID_INPUT, 'taniya.maker', NOW);

    const r = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/reject`)
      .set({ ...TH_BIL, 'x-apex-user': 'bob.checker' })
      .send({ decision_notes: '  Missing supporting docs  ' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('rejected');
    expect(r.body.body.checker_username).toBe('bob.checker');
    // Stored value should be the trimmed form per route normalisation.
    expect(r.body.body.decision_notes).toBe('Missing supporting docs');
  });

  it('CW-D SPEC ACCEPTANCE — same user cannot be both maker + checker (self-approval 409)', async () => {
    const { app, makerCheckerEngine } = makeSmokeApp('admin');
    const a = makerCheckerEngine.submit('BIL', VALID_INPUT, 'taniya.maker', NOW);

    // Self-approve attempt
    const ap = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/approve`)
      .set({ ...TH_BIL, 'x-apex-user': 'taniya.maker' })
      .send({ decision_notes: 'looks good to me' });
    expect(ap.status).toBe(409);
    expect(ap.body.error.code).toBe('EWS_409_self_approval_forbidden');

    // Self-reject attempt (with a valid reason — to prove the 409 fires on the user identity check, not the reason check)
    const rj = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/reject`)
      .set({ ...TH_BIL, 'x-apex-user': 'taniya.maker' })
      .send({ decision_notes: 'changed my mind' });
    expect(rj.status).toBe(409);
    expect(rj.body.error.code).toBe('EWS_409_self_approval_forbidden');

    // Action still pending — neither self-attempt mutated
    const after = makerCheckerEngine.get('BIL', a.action_id);
    expect(after?.status).toBe('pending');
  });

  it('CW-E bulk-assign integration: workflow page Reassign-load modal hits POST /v1/cms/cases/bulk-assign', async () => {
    const { app, cmsCaseStore } = makeSmokeApp('admin');
    const c1 = cmsCaseStore.create(
      'BIL',
      { title: 'A', description: 'a a', priority: 'P3' },
      'alice.admin',
      NOW,
    );
    const c2 = cmsCaseStore.create(
      'BIL',
      { title: 'B', description: 'b b', priority: 'P3' },
      'alice.admin',
      NOW,
    );

    const r = await request(app)
      .post('/v1/cms/cases/bulk-assign')
      .set(TH_BIL)
      .send({ case_ids: [c1.case_id, c2.case_id], assigned_to: 'carla.analyst', reason: 'workload rebalance' });
    expect(r.status).toBe(200);
    expect(r.body.body.ok_count).toBe(2);
    expect(r.body.body.total).toBe(2);

    expect(cmsCaseStore.get('BIL', c1.case_id)?.assigned_to).toBe('carla.analyst');
    expect(cmsCaseStore.get('BIL', c2.case_id)?.assigned_to).toBe('carla.analyst');
  });

  it('CW-F RBAC — viewer rejected on list (cases:list) + reject (audit:read)', async () => {
    const { app, makerCheckerEngine } = makeSmokeApp('viewer');
    const a = makerCheckerEngine.submit('BIL', VALID_INPUT, 'taniya.maker', NOW);

    const list = await request(app)
      .get('/v1/cases/maker-checker?status=pending')
      .set(TH_BIL);
    expect(list.status).toBe(403);

    const rj = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/reject`)
      .set(TH_BIL)
      .send({ decision_notes: 'rejecting via viewer' });
    expect(rj.status).toBe(403);
  });

  it('CW-G tenant isolation — BIL workflow invisible to BANK_DEMO across all 4 spec routes', async () => {
    const { app, makerCheckerEngine, cmsCaseStore } = makeSmokeApp('admin');
    cmsCaseStore.create('BIL', { title: 'BIL case', description: 'bil', priority: 'P3' }, 'alice.admin', NOW);
    makerCheckerEngine.submit('BIL', VALID_INPUT, 'taniya.maker', NOW);

    // BIL sees its data
    const bilList = await request(app).get('/v1/cases/maker-checker').set(TH_BIL);
    expect(bilList.body.body.total).toBe(1);
    const bilStats = await request(app).get('/v1/cms/cases/stats').set(TH_BIL);
    expect(bilStats.body.body.total).toBe(1);

    // BANK_DEMO sees nothing
    const bdList = await request(app).get('/v1/cases/maker-checker').set(TH_BANK);
    expect(bdList.body.body.total).toBe(0);
    const bdStats = await request(app).get('/v1/cms/cases/stats').set(TH_BANK);
    expect(bdStats.body.body.total).toBe(0);
    const bdBulk = await request(app)
      .post('/v1/cms/cases/bulk-assign')
      .set(TH_BANK)
      .send({ case_ids: ['BIL-FAKE'], assigned_to: 'someone' });
    expect(bdBulk.status).toBe(200);
    expect(bdBulk.body.body.ok_count).toBe(0);
  });
});
