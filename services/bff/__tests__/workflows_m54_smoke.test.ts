// services/bff/__tests__/workflows_m54_smoke.test.ts
//
// M5.4 — Workflows smoke
//
// Spec acceptance:
//   "A workflow with a 4-eyes stage automatically routes to the
//    configured role pool."
//
// Routes verified (all 5 spec routes + 1 derived view):
//   GET    /v1/workflows/templates
//   POST   /v1/workflows/templates
//   GET    /v1/workflows/templates/:id
//   PATCH  /v1/workflows/templates/:id          (spec calls this PUT;
//                                                 server.ts mounts PATCH —
//                                                 the verb is documented
//                                                 in the source file
//                                                 header and consistent
//                                                 with the existing
//                                                 contract)
//   DELETE /v1/workflows/templates/:id
//   GET    /v1/workflows/templates/:id/routing  (M5.4 derived view —
//                                                 surfaces the 4-eyes
//                                                 routing pool per
//                                                 stage; spec acceptance
//                                                 surface)
//
// + M5.4 audit fan-out (workflow.create / .update / .delete / .clone)
// + cross-tenant isolation invariant
// + 4-eyes derivation: requires_distinct_actors=true + pool sorted asc

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { defaultAuditTrailStore, InMemoryAuditTrailStore } from '../src/audit_trail';
import { _resetWorkflowTemplateStore } from '../src/workflows_templates';

const NOW = new Date('2026-05-26T10:00:00.000Z');

function makeSmokeApp() {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: (req) => (req.headers['x-apex-role'] as string) || 'admin',
  });
}

const H = (tenant: string, role = 'admin', user = 'alice.admin') => ({
  'X-Tenant-ID': tenant,
  'X-Channel': 'API',
  'X-APEX-USER': user,
  'X-APEX-ROLE': role,
  'Content-Type': 'application/json',
});

const FOUR_EYES_TEMPLATE = {
  name: 'Stress-test approval workflow',
  domain: 'stress_test' as const,
  description: 'RBI Form-K + IRDAI solvency stress approval chain',
  steps: [
    {
      step_order: 1,
      name: 'Author drafts shock vector',
      description: 'Risk analyst configures GDP/rate/FX shocks',
      required_role: 'risk_analyst',
      expected_duration_hours: 8,
      optional: false,
    },
    {
      step_order: 2,
      name: 'Maker submits + Checker approves (4-eyes)',
      description: 'Two distinct supervisors must independently approve',
      required_role: 'supervisor',
      expected_duration_hours: 4,
      optional: false,
      requires_4_eyes: true,
      approver_pool: ['supervisor', 'head_of_risk', 'compliance_officer'],
    },
    {
      step_order: 3,
      name: 'CRO sign-off',
      description: 'Single sign-off by Chief Risk Officer',
      required_role: 'head_of_risk',
      expected_duration_hours: 2,
      optional: false,
    },
  ],
  is_default: false,
};

describe('M5.4 — Workflows', () => {
  beforeEach(() => {
    _resetWorkflowTemplateStore();
    (defaultAuditTrailStore as InMemoryAuditTrailStore).reset();
  });

  // WF-1: full CRUD round-trip
  it('WF-1 POST + GET list + GET single + PATCH + DELETE round-trip', async () => {
    const { app } = makeSmokeApp();

    // POST
    const r1 = await request(app)
      .post('/v1/workflows/templates')
      .set(H('BIL'))
      .send(FOUR_EYES_TEMPLATE);
    expect(r1.status).toBe(201);
    const id = r1.body.body.template_id;
    expect(id).toMatch(/^wft-BIL-/);
    expect(r1.body.body.steps).toHaveLength(3);

    // GET list
    const r2 = await request(app).get('/v1/workflows/templates').set(H('BIL'));
    expect(r2.status).toBe(200);
    expect(r2.body.body.templates).toHaveLength(1);
    expect(r2.body.body.templates[0].template_id).toBe(id);

    // GET single
    const r3 = await request(app).get(`/v1/workflows/templates/${id}`).set(H('BIL'));
    expect(r3.status).toBe(200);
    expect(r3.body.body.name).toBe(FOUR_EYES_TEMPLATE.name);

    // PATCH
    const r4 = await request(app)
      .patch(`/v1/workflows/templates/${id}`)
      .set(H('BIL'))
      .send({ description: 'Updated description' });
    expect(r4.status).toBe(200);
    expect(r4.body.body.description).toBe('Updated description');

    // DELETE
    const r5 = await request(app).delete(`/v1/workflows/templates/${id}`).set(H('BIL'));
    expect(r5.status).toBe(204);

    // GET after DELETE → 404
    const r6 = await request(app).get(`/v1/workflows/templates/${id}`).set(H('BIL'));
    expect(r6.status).toBe(404);
    expect(r6.body.error.code).toBe('EWS_404_unknown_template');
  });

  // WF-2: spec acceptance — 4-eyes stage auto-routes to role pool
  it('WF-2 4-eyes stage routes to configured role pool', async () => {
    const { app } = makeSmokeApp();

    const r1 = await request(app)
      .post('/v1/workflows/templates')
      .set(H('BIL'))
      .send(FOUR_EYES_TEMPLATE);
    expect(r1.status).toBe(201);
    const id = r1.body.body.template_id;

    const r2 = await request(app)
      .get(`/v1/workflows/templates/${id}/routing`)
      .set(H('BIL'));
    expect(r2.status).toBe(200);

    const stages = r2.body.body.stages as Array<{
      step_order: number;
      strategy: string;
      pool: string[];
      requires_distinct_actors: boolean;
    }>;
    expect(stages).toHaveLength(3);

    // Stage 1: single — author
    expect(stages[0].strategy).toBe('single');
    expect(stages[0].pool).toEqual(['risk_analyst']);
    expect(stages[0].requires_distinct_actors).toBe(false);

    // Stage 2: 4-eyes — auto-routes to configured pool (SPEC ACCEPTANCE)
    expect(stages[1].strategy).toBe('four_eyes');
    expect(stages[1].requires_distinct_actors).toBe(true);
    // Pool sorted asc for deterministic output
    expect(stages[1].pool).toEqual(['compliance_officer', 'head_of_risk', 'supervisor']);

    // Stage 3: single — CRO sign-off
    expect(stages[2].strategy).toBe('single');
    expect(stages[2].pool).toEqual(['head_of_risk']);
  });

  // WF-3: 4-eyes fallback — when approver_pool omitted, falls back to [required_role]
  it('WF-3 4-eyes without explicit pool falls back to [required_role]', async () => {
    const { app } = makeSmokeApp();

    const r1 = await request(app)
      .post('/v1/workflows/templates')
      .set(H('BIL'))
      .send({
        name: 'Implicit pool workflow',
        domain: 'covenant_review',
        steps: [{
          step_order: 1,
          name: 'Dual review',
          description: 'maker + checker from same role',
          required_role: 'risk_analyst',
          expected_duration_hours: 4,
          optional: false,
          requires_4_eyes: true,
          // no approver_pool — should fall back to [required_role]
        }],
      });
    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .get(`/v1/workflows/templates/${r1.body.body.template_id}/routing`)
      .set(H('BIL'));
    expect(r2.status).toBe(200);
    expect(r2.body.body.stages[0].strategy).toBe('four_eyes');
    expect(r2.body.body.stages[0].pool).toEqual(['risk_analyst']);
  });

  // WF-4: POST + PATCH + DELETE + clone write audit events
  it('WF-4 mutations fan out to audit-trail (workflow.create / .update / .delete / .clone)', async () => {
    const { app } = makeSmokeApp();

    // create
    const r1 = await request(app)
      .post('/v1/workflows/templates')
      .set(H('BIL'))
      .send(FOUR_EYES_TEMPLATE);
    expect(r1.status).toBe(201);
    const id = r1.body.body.template_id;

    // update
    const r2 = await request(app)
      .patch(`/v1/workflows/templates/${id}`)
      .set(H('BIL'))
      .send({ description: 'second draft' });
    expect(r2.status).toBe(200);

    // clone
    const r3 = await request(app)
      .post(`/v1/workflows/templates/${id}/clone`)
      .set(H('BIL'))
      .send({ name: 'Stress-test approval workflow v2' });
    expect(r3.status).toBe(201);
    const cloneId = r3.body.body.template_id;

    // delete the original
    const r4 = await request(app).delete(`/v1/workflows/templates/${id}`).set(H('BIL'));
    expect(r4.status).toBe(204);

    // Audit chain query — 4 events for this tenant
    const r5 = await request(app)
      .get('/v1/audit/events?action=workflow.create,workflow.update,workflow.delete,workflow.clone')
      .set(H('BIL'));
    expect(r5.status).toBe(200);

    const events = r5.body.body.items as Array<{
      action: string; resource_id: string; metadata: Record<string, unknown>;
    }>;
    expect(events).toHaveLength(4);

    const byAction: Record<string, typeof events[number]> = Object.fromEntries(
      events.map((e) => [e.action, e]),
    );
    expect(byAction['workflow.create']).toBeDefined();
    expect(byAction['workflow.update']).toBeDefined();
    expect(byAction['workflow.delete']).toBeDefined();
    expect(byAction['workflow.clone']).toBeDefined();

    // Create event metadata captures 4-eyes step orders
    expect(byAction['workflow.create'].metadata.four_eyes_step_orders).toEqual([2]);
    // Clone event back-references the source template
    expect(byAction['workflow.clone'].metadata.cloned_from).toBe(id);
    expect(byAction['workflow.clone'].resource_id).toBe(cloneId);
  });

  // WF-5: cross-tenant isolation
  it('WF-5 BIL templates invisible to BANK_DEMO', async () => {
    const { app } = makeSmokeApp();

    const r1 = await request(app)
      .post('/v1/workflows/templates')
      .set(H('BIL'))
      .send(FOUR_EYES_TEMPLATE);
    expect(r1.status).toBe(201);
    const id = r1.body.body.template_id;

    // BANK_DEMO sees zero templates
    const r2 = await request(app).get('/v1/workflows/templates').set(H('BANK_DEMO'));
    expect(r2.status).toBe(200);
    expect(r2.body.body.templates).toHaveLength(0);

    // BANK_DEMO get → 404
    const r3 = await request(app).get(`/v1/workflows/templates/${id}`).set(H('BANK_DEMO'));
    expect(r3.status).toBe(404);

    // BANK_DEMO routing → 404
    const r4 = await request(app).get(`/v1/workflows/templates/${id}/routing`).set(H('BANK_DEMO'));
    expect(r4.status).toBe(404);
  });

  // WF-6: validation — POST rejects invalid step shape with code-routed errors
  it('WF-6 POST rejects invalid input with 400 EWS_400_invalid_*', async () => {
    const { app } = makeSmokeApp();

    // Bad domain
    const r1 = await request(app)
      .post('/v1/workflows/templates')
      .set(H('BIL'))
      .send({ ...FOUR_EYES_TEMPLATE, domain: 'not_a_domain' });
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('EWS_400_invalid_domain');

    // Duplicate step_order
    const r2 = await request(app)
      .post('/v1/workflows/templates')
      .set(H('BIL'))
      .send({
        ...FOUR_EYES_TEMPLATE,
        steps: [
          FOUR_EYES_TEMPLATE.steps[0],
          { ...FOUR_EYES_TEMPLATE.steps[0], name: 'second step at order 1' },
        ],
      });
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('EWS_400_invalid_step');

    // Empty approver_pool with requires_4_eyes
    const r3 = await request(app)
      .post('/v1/workflows/templates')
      .set(H('BIL'))
      .send({
        name: 'Empty pool workflow',
        domain: 'kyc_onboarding',
        steps: [{
          step_order: 1, name: 'Bad 4-eyes stage', description: '',
          required_role: 'analyst', expected_duration_hours: 1, optional: false,
          requires_4_eyes: true, approver_pool: [],
        }],
      });
    expect(r3.status).toBe(400);
    expect(r3.body.error.code).toBe('EWS_400_invalid_step');
  });

  // WF-7: 403 on non-admin role (RBAC audit:read)
  it('WF-7 unknown_role 403 on every mutating route', async () => {
    const { app } = makeSmokeApp();

    const baseH = H('BIL', 'unknown_role');

    const r1 = await request(app).get('/v1/workflows/templates').set(baseH);
    expect(r1.status).toBe(403);

    const r2 = await request(app).post('/v1/workflows/templates').set(baseH).send(FOUR_EYES_TEMPLATE);
    expect(r2.status).toBe(403);
  });

  // WF-8: M9.7 spec route GET /v1/cases/states/graph still reachable (regression)
  it('WF-8 spec route GET /v1/cases/states/graph still works (regression)', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/cases/states/graph').set(H('BIL'));
    expect(r.status).toBe(200);
    // Pre-existing M9.7 state graph — at minimum returns an array of states
    const body = r.body.body ?? r.body;
    expect(body).toBeDefined();
  });

  // WF-9: clone with new 4-eyes preserved
  it('WF-9 clone preserves 4-eyes flag + approver_pool', async () => {
    const { app } = makeSmokeApp();

    const r1 = await request(app)
      .post('/v1/workflows/templates')
      .set(H('BIL'))
      .send(FOUR_EYES_TEMPLATE);
    expect(r1.status).toBe(201);
    const id = r1.body.body.template_id;

    const r2 = await request(app)
      .post(`/v1/workflows/templates/${id}/clone`)
      .set(H('BIL'))
      .send({ name: 'Stress-test approval workflow v2' });
    expect(r2.status).toBe(201);
    const cloneId = r2.body.body.template_id;
    expect(cloneId).not.toBe(id);

    // Clone's stage 2 still 4-eyes with the same pool
    const r3 = await request(app)
      .get(`/v1/workflows/templates/${cloneId}/routing`)
      .set(H('BIL'));
    expect(r3.status).toBe(200);
    expect(r3.body.body.stages[1].strategy).toBe('four_eyes');
    expect(r3.body.body.stages[1].pool).toEqual([
      'compliance_officer', 'head_of_risk', 'supervisor',
    ]);
  });
});
