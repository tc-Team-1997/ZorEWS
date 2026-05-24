// services/bff/__tests__/reconciliation_module_smoke.test.ts
//
// Module 1.6 — Reconciliation smoke test.
//
// Walks the complete user journey end-to-end:
//
//   GET    /v1/recon/definitions
//   POST   /v1/recon/definitions
//   GET    /v1/recon/definitions/:recon_id
//   PATCH  /v1/recon/definitions/:recon_id     (spec wording is PUT, existing API is PATCH)
//   DELETE /v1/recon/definitions/:recon_id
//   POST   /v1/recon/definitions/:recon_id/run     (synthesises records when none supplied)
//   GET    /v1/recon/runs
//   GET    /v1/recon/runs/:run_id
//   GET    /v1/recon/dashboard
//   POST   /v1/recon/runs/:run_id/accept            (NEW — Module 1.6)
//   POST   /v1/recon/definitions/:recon_id/inject-drop  (NEW — Module 1.6 acceptance)
//
// Spec acceptance: a deliberate row-drop in staging produces a non-zero
// gap in the next recon run with the missing key listed in the
// mismatches modal. Verified end-to-end here.
//
// Plus:
//   - audit-log write fan-out on run/accept/inject-drop (cross-cutting #6)
//   - RBAC + tenant-header guards (cross-cutting #12)
//   - 404 / 409 / 400 envelope shapes

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryReconStore, _resetReconDropRegistry } from '../src/recon/recon_engine';

const NOW = new Date('2026-05-24T15:00:00.000Z');
const TENANT = 'BANK_DEMO';
const HEADERS = {
  'X-Tenant-ID': TENANT,
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
};

const DEF = {
  recon_id: 'rcn_smoke_loans',
  name: 'Smoke CBS Loans → Staging',
  source_label: 'cbs.loan_book',
  target_label: 'staging.loans',
  kind: 'count_only',
  key_field: 'loan_id',
  severity: 'high',
} as const;

function makeSmokeApp(role: string = 'admin') {
  _resetReconDropRegistry();
  const reconStore = new InMemoryReconStore();
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    reconStore,
    now: () => NOW,
    getRole: () => role,
  });
}

describe('Module 1.6 — Reconciliation smoke', () => {
  it('walks the full definition CRUD → run → inject-drop → run again → accept flow', async () => {
    const { app } = makeSmokeApp('admin');

    // 1. Baseline list — empty.
    const empty = await request(app).get('/v1/recon/definitions').set(HEADERS);
    expect(empty.status).toBe(200);
    expect(empty.body.body.items).toHaveLength(0);

    // 2. Create a definition.
    const create = await request(app)
      .post('/v1/recon/definitions')
      .set(HEADERS)
      .send(DEF);
    expect(create.status).toBe(201);
    expect(create.body.body.recon_id).toBe(DEF.recon_id);
    expect(create.body.body.kind).toBe('count_only');
    expect(create.body.body.severity).toBe('high');
    expect(create.body.body.active).toBe(true);
    expect(create.body.body.created_by).toBe('alice.admin');

    // Duplicate id → 409
    const dup = await request(app).post('/v1/recon/definitions').set(HEADERS).send(DEF);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toMatch(/^EWS_409_/);

    // 3. Read it back.
    const get = await request(app)
      .get(`/v1/recon/definitions/${DEF.recon_id}`)
      .set(HEADERS);
    expect(get.status).toBe(200);
    expect(get.body.body.name).toBe(DEF.name);

    // 4. Patch it — severity downgrade.
    const patch = await request(app)
      .patch(`/v1/recon/definitions/${DEF.recon_id}`)
      .set(HEADERS)
      .send({ severity: 'medium' });
    expect(patch.status).toBe(200);
    expect(patch.body.body.severity).toBe('medium');

    // 5. First run — no records supplied → synthesised baseline (1000
    // rows on each side, balanced).
    const firstRun = await request(app)
      .post(`/v1/recon/definitions/${DEF.recon_id}/run`)
      .set(HEADERS)
      .send({});
    expect(firstRun.status).toBe(200);
    expect(firstRun.body.body.status).toBe('balanced');
    expect(firstRun.body.body.source_count).toBe(1000);
    expect(firstRun.body.body.target_count).toBe(1000);
    expect(firstRun.body.body.source_only_count).toBe(0);
    expect(firstRun.body.body.target_only_count).toBe(0);
    expect(firstRun.body.body.sample_breaks).toEqual([]);

    // 6. Inject a deliberate staging drop — spec acceptance path.
    const inject = await request(app)
      .post(`/v1/recon/definitions/${DEF.recon_id}/inject-drop`)
      .set(HEADERS)
      .send({ row_key: 'rcn_smoke_loans-row-00050' });
    expect(inject.status).toBe(201);
    expect(inject.body.body.staging_dropped).toContain('rcn_smoke_loans-row-00050');
    expect(inject.body.body.row_key).toBe('rcn_smoke_loans-row-00050');
    expect(inject.body.body.leg).toBe('staging');

    // 7. Run again — the drop produces a non-zero gap, and the dropped
    // key surfaces in sample_breaks. SPEC ACCEPTANCE ↓
    const secondRun = await request(app)
      .post(`/v1/recon/definitions/${DEF.recon_id}/run`)
      .set(HEADERS)
      .send({});
    expect(secondRun.status).toBe(200);
    expect(secondRun.body.body.status).toBe('breaks_found');
    expect(secondRun.body.body.source_count).toBe(1000);
    expect(secondRun.body.body.target_count).toBe(999);
    expect(secondRun.body.body.source_only_count).toBe(1);
    expect(secondRun.body.body.sample_breaks).toHaveLength(1);
    expect(secondRun.body.body.sample_breaks[0].key).toBe('rcn_smoke_loans-row-00050');
    expect(secondRun.body.body.sample_breaks[0].kind).toBe('source_only');

    const runId = secondRun.body.body.run_id;

    // 8. List runs — both visible, newest-first.
    const runs = await request(app).get('/v1/recon/runs').set(HEADERS);
    expect(runs.status).toBe(200);
    expect(runs.body.body.total).toBe(2);
    expect(runs.body.body.items[0].run_id).toBe(runId);

    // 9. Get single run.
    const oneRun = await request(app).get(`/v1/recon/runs/${runId}`).set(HEADERS);
    expect(oneRun.status).toBe(200);
    expect(oneRun.body.body.run_id).toBe(runId);
    expect(oneRun.body.body.sample_breaks[0].key).toBe('rcn_smoke_loans-row-00050');

    // 10. Mark as accepted — spec calls this out explicitly.
    const accept = await request(app)
      .post(`/v1/recon/runs/${runId}/accept`)
      .set(HEADERS)
      .send({ reason: 'Known late EOM batch — ops signed off' });
    expect(accept.status).toBe(200);
    expect(accept.body.body.accepted_by).toBe('alice.admin');
    expect(accept.body.body.accepted_at).toBe(NOW.toISOString());
    expect(accept.body.body.accepted_reason).toMatch(/Known late EOM batch/);
    // status itself unchanged (still breaks_found) — accept is an overlay
    expect(accept.body.body.status).toBe('breaks_found');

    // Double-accept → 409
    const dupAccept = await request(app)
      .post(`/v1/recon/runs/${runId}/accept`)
      .set(HEADERS)
      .send({ reason: 'duplicate attempt' });
    expect(dupAccept.status).toBe(409);
    expect(dupAccept.body.error.code).toBe('EWS_409_already_accepted');

    // Accept without reason → 400 invalid_reason
    const noReason = await request(app)
      .post(`/v1/recon/runs/${runId}/accept`)
      .set(HEADERS)
      .send({});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('EWS_400_invalid_reason');

    // 11. Audit fan-out — recon.run + recon.inject_drop + recon.accept.
    const audit = await request(app)
      .get('/v1/audit/events?resource_type=integration&page_size=20')
      .set(HEADERS);
    expect(audit.status).toBe(200);
    const events = audit.body.body.items as Array<{ action: string; resource_id: string; actor_username: string }>;
    const reconEvents = events.filter((e) =>
      e.action === 'recon.run' || e.action === 'recon.accept' || e.action === 'recon.inject_drop',
    );
    const actions = new Set(reconEvents.map((e) => e.action));
    expect(actions.has('recon.run')).toBe(true);
    expect(actions.has('recon.accept')).toBe(true);
    expect(actions.has('recon.inject_drop')).toBe(true);
    expect(reconEvents.every((e) => e.actor_username === 'alice.admin')).toBe(true);

    // 12. Dashboard rollup reflects the run.
    const dash = await request(app).get('/v1/recon/dashboard').set(HEADERS);
    expect(dash.status).toBe(200);
    expect(dash.body.body.total_definitions).toBe(1);
    expect(dash.body.body.total_runs).toBe(2);
    expect(dash.body.body.total_balanced).toBe(1);
    expect(dash.body.body.total_breaks_found).toBe(1);
    const ds = dash.body.body.definitions_status[0];
    expect(ds.recon_id).toBe(DEF.recon_id);
    expect(ds.latest_status).toBe('breaks_found');
    expect(ds.latest_breaks).toBe(1);

    // 13. Soft-delete the definition (returns 204 No Content).
    const del = await request(app)
      .delete(`/v1/recon/definitions/${DEF.recon_id}`)
      .set(HEADERS);
    expect([200, 204]).toContain(del.status);
    const listAfter = await request(app).get('/v1/recon/definitions').set(HEADERS);
    expect(listAfter.body.body.items).toHaveLength(0);
  });

  it('Unknown recon: get/run/inject all return EWS_404_unknown_recon', async () => {
    const { app } = makeSmokeApp('admin');
    const g = await request(app).get('/v1/recon/definitions/no_such').set(HEADERS);
    expect(g.status).toBe(404);
    expect(g.body.error.code).toBe('EWS_404_unknown_recon');

    const r = await request(app).post('/v1/recon/definitions/no_such/run').set(HEADERS).send({});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_recon');

    const i = await request(app).post('/v1/recon/definitions/no_such/inject-drop').set(HEADERS).send({ row_key: 'k' });
    expect(i.status).toBe(404);
    expect(i.body.error.code).toBe('EWS_404_unknown_recon');
  });

  it('Unknown run: get + accept return EWS_404_unknown_run', async () => {
    const { app } = makeSmokeApp('admin');
    const g = await request(app).get('/v1/recon/runs/no_such').set(HEADERS);
    expect(g.status).toBe(404);
    expect(g.body.error.code).toBe('EWS_404_unknown_run');

    const a = await request(app)
      .post('/v1/recon/runs/no_such/accept')
      .set(HEADERS)
      .send({ reason: 'x' });
    expect(a.status).toBe(404);
    expect(a.body.error.code).toBe('EWS_404_unknown_run');
  });

  it('Inject-drop validation: missing row_key → 400; invalid leg → 400', async () => {
    const { app } = makeSmokeApp('admin');
    await request(app).post('/v1/recon/definitions').set(HEADERS).send(DEF);

    const noKey = await request(app)
      .post(`/v1/recon/definitions/${DEF.recon_id}/inject-drop`)
      .set(HEADERS)
      .send({});
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toMatch(/^EWS_400_/);

    const badLeg = await request(app)
      .post(`/v1/recon/definitions/${DEF.recon_id}/inject-drop`)
      .set(HEADERS)
      .send({ row_key: 'k', leg: 'bogus' });
    expect(badLeg.status).toBe(400);
    expect(badLeg.body.error.code).toBe('EWS_400_invalid_leg');
  });

  it('RBAC: field_officer blocked on audit:read recon routes', async () => {
    const { app } = makeSmokeApp('field_officer');
    const block = (s: number) => expect([401, 403]).toContain(s);
    block((await request(app).get('/v1/recon/definitions').set(HEADERS)).status);
    block(
      (await request(app).post('/v1/recon/definitions').set(HEADERS).send(DEF)).status,
    );
    block(
      (await request(app).post('/v1/recon/definitions/x/run').set(HEADERS).send({})).status,
    );
    block(
      (await request(app)
        .post('/v1/recon/definitions/x/inject-drop')
        .set(HEADERS)
        .send({ row_key: 'k' })).status,
    );
    block((await request(app).get('/v1/recon/runs').set(HEADERS)).status);
    block((await request(app).get('/v1/recon/dashboard').set(HEADERS)).status);
  });

  it('Tenant gate: every route refuses without X-Tenant-ID + X-Channel', async () => {
    const { app } = makeSmokeApp('admin');
    const block = (s: number) => expect([400, 401, 403]).toContain(s);
    block((await request(app).get('/v1/recon/definitions')).status);
    block((await request(app).post('/v1/recon/definitions').send(DEF)).status);
    block((await request(app).get('/v1/recon/runs')).status);
    block((await request(app).get('/v1/recon/dashboard')).status);
  });
});
