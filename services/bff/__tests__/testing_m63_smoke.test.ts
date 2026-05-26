// services/bff/__tests__/testing_m63_smoke.test.ts
//
// M6.3 — Testing Hub smoke
//
// Spec acceptance:
//   "A scheduled auto-run produces a results report and writes per-case
//    events to Audit Trail."
//
// Routes verified (spec aliases + existing surface):
//   GET    /v1/testing/cases               (M6.3 spec alias of /tests)
//   POST   /v1/testing/cases               (create — w/ audit fan-out)
//   GET    /v1/testing/cases/:id           (single)
//   PUT    /v1/testing/cases/:id           (update — w/ audit fan-out)
//   DELETE /v1/testing/cases/:id           (delete — w/ audit fan-out)
//   POST   /v1/testing/cases/:id/run       (single-case run — w/ audit fan-out)
//   POST   /v1/testing/run-all             (NEW spec route — w/ per-case + rollup audit)
//   POST   /v1/testing/bulk-upload         (csv import — w/ audit fan-out)
//   GET    /v1/testing/runs                (run history)
//   GET    /v1/testing/schedules           (spec plural alias)
//   POST   /v1/testing/schedules           (schedule update — w/ audit)
//
// Cross-cutting:
//   - audit fan-out on every mutation (cross-cutting #6)
//   - cross-tenant isolation invariant
//   - 403 on non-admin role

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { defaultAuditTrailStore, InMemoryAuditTrailStore } from '../src/audit_trail';
import { _resetTestingHubStore } from '../src/testing_hub';

const NOW = new Date('2026-05-26T12:00:00.000Z');

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

const VALID_CASE = {
  name: 'M6.3 RULE-001 fires on high DPD',
  target_type: 'rule',
  target_id: 'RULE-001',
  description: 'Verifies the high-DPD rule fires the expected severity',
  inputs: { dpd: 95, exposure_kes: 1_000_000 },
  expected: { severity: 'CRITICAL', fired: true },
};

describe('M6.3 — Testing Hub', () => {
  beforeEach(() => {
    _resetTestingHubStore();
    (defaultAuditTrailStore as InMemoryAuditTrailStore).reset();
  });

  // ─────────────────────────────────────────────────────────────────────
  // TH-1: full CRUD round-trip on /v1/testing/cases (spec alias)
  // ─────────────────────────────────────────────────────────────────────
  it('TH-1 POST + GET list + GET single + PUT + DELETE round-trip', async () => {
    const { app } = makeSmokeApp();

    // POST
    const r1 = await request(app)
      .post('/v1/testing/cases')
      .set(H('BIL'))
      .send(VALID_CASE);
    expect(r1.status).toBe(201);
    const id = r1.body.body.test_id;
    expect(id).toMatch(/^tst-BIL-/);

    // GET list
    const r2 = await request(app).get('/v1/testing/cases').set(H('BIL'));
    expect(r2.status).toBe(200);
    expect(r2.body.body.cases).toHaveLength(1);
    expect(r2.body.body.cases[0].test_id).toBe(id);

    // GET single
    const r3 = await request(app).get(`/v1/testing/cases/${id}`).set(H('BIL'));
    expect(r3.status).toBe(200);
    expect(r3.body.body.name).toBe(VALID_CASE.name);

    // PUT
    const r4 = await request(app)
      .put(`/v1/testing/cases/${id}`)
      .set(H('BIL'))
      .send({ description: 'Updated description' });
    expect(r4.status).toBe(200);
    expect(r4.body.body.description).toBe('Updated description');

    // DELETE
    const r5 = await request(app).delete(`/v1/testing/cases/${id}`).set(H('BIL'));
    expect(r5.status).toBe(204);

    // GET after delete → 404
    const r6 = await request(app).get(`/v1/testing/cases/${id}`).set(H('BIL'));
    expect(r6.status).toBe(404);
    expect(r6.body.error.code).toBe('EWS_404_unknown_case');
  });

  // ─────────────────────────────────────────────────────────────────────
  // TH-2 single-case run + audit fan-out
  // ─────────────────────────────────────────────────────────────────────
  it('TH-2 POST /v1/testing/cases/:id/run writes testing.case.run audit event', async () => {
    const { app } = makeSmokeApp();

    const created = await request(app)
      .post('/v1/testing/cases')
      .set(H('BIL'))
      .send(VALID_CASE);
    const id = created.body.body.test_id;

    const run = await request(app)
      .post(`/v1/testing/cases/${id}/run`)
      .set(H('BIL'));
    expect(run.status).toBe(201);
    expect(run.body.body.run_id).toMatch(/^tstrun-BIL-/);
    expect(['pass', 'fail', 'error', 'pending', 'skipped']).toContain(run.body.body.status);

    // Audit fan-out for the run
    const audit = await request(app)
      .get('/v1/audit/events?action=testing.case.run')
      .set(H('BIL'));
    expect(audit.status).toBe(200);
    const events = audit.body.body.items as Array<{
      action: string; resource_id: string; metadata: Record<string, unknown>;
    }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events.find((e) => e.resource_id === id);
    expect(ev).toBeDefined();
    expect(ev!.metadata.triggered).toBe('manual');
    expect(typeof ev!.metadata.run_id).toBe('string');
  });

  // ─────────────────────────────────────────────────────────────────────
  // TH-3 SPEC ACCEPTANCE — run-all produces report + per-case audit
  // ─────────────────────────────────────────────────────────────────────
  it('TH-3 SPEC: POST /v1/testing/run-all returns report + writes per-case audit events', async () => {
    const { app } = makeSmokeApp();

    // Create 5 cases
    const created_ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/v1/testing/cases')
        .set(H('BIL'))
        .send({ ...VALID_CASE, name: `${VALID_CASE.name} (${i})`, target_id: `RULE-00${i}` });
      expect(r.status).toBe(201);
      created_ids.push(r.body.body.test_id);
    }

    // Trigger run-all with triggered='auto' (simulates scheduler)
    const reportRes = await request(app)
      .post('/v1/testing/run-all')
      .set(H('BIL'))
      .send({ triggered: 'auto' });
    expect(reportRes.status).toBe(201);

    const report = reportRes.body.body as {
      report_id: string;
      total_tests: number;
      total_pass: number;
      total_fail: number;
      total_error: number;
      total_skipped: number;
      runs: Array<{ test_id: string; status: string; run_id: string }>;
    };

    expect(report.report_id).toMatch(/^tstrep-BIL-/);
    expect(report.total_tests).toBe(5);
    expect(report.total_pass + report.total_fail + report.total_error + report.total_skipped).toBe(5);
    expect(report.runs).toHaveLength(5);
    // Every case in our set should be in the report
    for (const id of created_ids) {
      expect(report.runs.some((r) => r.test_id === id)).toBe(true);
    }

    // SPEC ACCEPTANCE: per-case audit events written
    const audit = await request(app)
      .get('/v1/audit/events?action=testing.case.run&page_size=50')
      .set(H('BIL'));
    expect(audit.status).toBe(200);
    const events = audit.body.body.items as Array<{
      resource_id: string; metadata: Record<string, unknown>;
    }>;
    // 5 cases × 1 run each = 5 audit events with triggered='auto'
    const autoEvents = events.filter((e) => e.metadata.triggered === 'auto');
    expect(autoEvents.length).toBe(5);
    // Each must carry the report_id back-reference
    for (const ev of autoEvents) {
      expect(ev.metadata.report_id).toBe(report.report_id);
    }

    // + 1 rollup event for the report itself
    const rollup = await request(app)
      .get(`/v1/audit/events?action=testing.run_all`)
      .set(H('BIL'));
    expect(rollup.status).toBe(200);
    const rollupEvents = rollup.body.body.items as Array<{
      resource_id: string; metadata: Record<string, unknown>;
    }>;
    expect(rollupEvents.length).toBe(1);
    expect(rollupEvents[0]!.resource_id).toBe(report.report_id);
    expect(rollupEvents[0]!.metadata.triggered).toBe('auto');
    expect(rollupEvents[0]!.metadata.total_tests).toBe(5);
  });

  // ─────────────────────────────────────────────────────────────────────
  // TH-4 bulk-upload + audit
  // ─────────────────────────────────────────────────────────────────────
  it('TH-4 POST /v1/testing/bulk-upload imports CSV + writes audit', async () => {
    const { app } = makeSmokeApp();
    const csv = [
      'name,target_type,target_id,description',
      'Bulk test 1,rule,RULE-001,One',
      'Bulk test 2,rule,RULE-002,Two',
      'Bulk test 3,indicator,FIN-001,Three',
    ].join('\n');

    const r = await request(app)
      .post('/v1/testing/bulk-upload')
      .set(H('BIL'))
      .send({ csv });
    expect(r.status).toBe(200);
    expect(r.body.body.created_count).toBe(3);

    // List should show 3
    const list = await request(app).get('/v1/testing/cases').set(H('BIL'));
    expect(list.body.body.cases).toHaveLength(3);

    // Audit
    const audit = await request(app)
      .get('/v1/audit/events?action=testing.bulk_upload')
      .set(H('BIL'));
    expect(audit.body.body.items[0]!.metadata.created).toBe(3);
  });

  // ─────────────────────────────────────────────────────────────────────
  // TH-5 schedule CRUD via spec plural alias
  // ─────────────────────────────────────────────────────────────────────
  it('TH-5 GET + POST /v1/testing/schedules (plural alias)', async () => {
    const { app } = makeSmokeApp();

    const initial = await request(app)
      .get('/v1/testing/schedules')
      .set(H('BIL'));
    expect(initial.status).toBe(200);
    expect(initial.body.body.schedules).toHaveLength(1);
    expect(initial.body.body.schedules[0].enabled).toBe(false);

    const updated = await request(app)
      .post('/v1/testing/schedules')
      .set(H('BIL'))
      .send({ enabled: true, cron_expression: '0 6 * * *' });
    expect(updated.status).toBe(201);
    expect(updated.body.body.enabled).toBe(true);
    expect(updated.body.body.cron_expression).toBe('0 6 * * *');

    const after = await request(app)
      .get('/v1/testing/schedules')
      .set(H('BIL'));
    expect(after.body.body.schedules[0].enabled).toBe(true);

    // Audit fan-out
    const audit = await request(app)
      .get('/v1/audit/events?action=testing.schedule.update')
      .set(H('BIL'));
    expect(audit.body.body.items.length).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // TH-6 GET /v1/testing/runs after run-all
  // ─────────────────────────────────────────────────────────────────────
  it('TH-6 GET /v1/testing/runs returns history newest-first', async () => {
    const { app } = makeSmokeApp();

    await request(app).post('/v1/testing/cases').set(H('BIL')).send(VALID_CASE);
    await request(app).post('/v1/testing/cases').set(H('BIL')).send({
      ...VALID_CASE,
      name: `${VALID_CASE.name} (2)`,
      target_id: 'RULE-002',
    });
    await request(app).post('/v1/testing/run-all').set(H('BIL')).send({});

    const runs = await request(app).get('/v1/testing/runs').set(H('BIL'));
    expect(runs.status).toBe(200);
    expect(runs.body.body.runs.length).toBe(2);
  });

  // ─────────────────────────────────────────────────────────────────────
  // TH-7 cross-tenant isolation
  // ─────────────────────────────────────────────────────────────────────
  it('TH-7 BIL cases invisible to BANK_DEMO + cases scoped per-tenant', async () => {
    const { app } = makeSmokeApp();

    await request(app).post('/v1/testing/cases').set(H('BIL')).send(VALID_CASE);

    const bd = await request(app).get('/v1/testing/cases').set(H('BANK_DEMO'));
    expect(bd.status).toBe(200);
    expect(bd.body.body.cases).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // TH-8 403 on non-admin role
  // ─────────────────────────────────────────────────────────────────────
  it('TH-8 unknown_role gets 403 on all M6.3 routes', async () => {
    const { app } = makeSmokeApp();
    const head = H('BIL', 'unknown_role');

    const r1 = await request(app).get('/v1/testing/cases').set(head);
    expect(r1.status).toBe(403);

    const r2 = await request(app).post('/v1/testing/cases').set(head).send(VALID_CASE);
    expect(r2.status).toBe(403);

    const r3 = await request(app).post('/v1/testing/run-all').set(head).send({});
    expect(r3.status).toBe(403);

    const r4 = await request(app).post('/v1/testing/bulk-upload').set(head).send({ csv: 'x' });
    expect(r4.status).toBe(403);

    const r5 = await request(app).get('/v1/testing/schedules').set(head);
    expect(r5.status).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────
  // TH-9 validation — POST /cases rejects malformed input
  // ─────────────────────────────────────────────────────────────────────
  it('TH-9 POST /v1/testing/cases rejects malformed input with code-routed 400s', async () => {
    const { app } = makeSmokeApp();

    // missing name
    const r1 = await request(app)
      .post('/v1/testing/cases')
      .set(H('BIL'))
      .send({ target_type: 'rule', target_id: 'RULE-001' });
    expect(r1.status).toBe(400);

    // invalid target_type
    const r2 = await request(app)
      .post('/v1/testing/cases')
      .set(H('BIL'))
      .send({ ...VALID_CASE, target_type: 'not_a_target' });
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('EWS_400_invalid_target');
  });

  // ─────────────────────────────────────────────────────────────────────
  // TH-10 run on a disabled case returns 409
  // ─────────────────────────────────────────────────────────────────────
  it('TH-10 POST /v1/testing/cases/:id/run on a disabled case returns 409 EWS_409_case_disabled', async () => {
    const { app } = makeSmokeApp();
    const created = await request(app)
      .post('/v1/testing/cases')
      .set(H('BIL'))
      .send(VALID_CASE);
    const id = created.body.body.test_id;

    // Disable it
    await request(app)
      .put(`/v1/testing/cases/${id}`)
      .set(H('BIL'))
      .send({ enabled: false });

    const run = await request(app)
      .post(`/v1/testing/cases/${id}/run`)
      .set(H('BIL'));
    expect(run.status).toBe(409);
    expect(run.body.error.code).toBe('EWS_409_case_disabled');
  });
});
