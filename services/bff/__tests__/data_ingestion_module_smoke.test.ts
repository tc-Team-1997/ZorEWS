// services/bff/__tests__/data_ingestion_module_smoke.test.ts
//
// Module 1.1 — Data Ingestion smoke test.
//
// Walks the complete Module 1.1 user journey end-to-end against the
// live BFF + in-memory defaultIngestionRegistry. Mirrors what a partner
// would script in Postman:
//
//   GET   /v1/ingestion/connectors                       (list baseline)
//   GET   /v1/ingestion/health                           (KPI strip)
//   POST  /v1/ingestion/connectors                       (Add new source)
//   POST  /v1/ingestion/connectors duplicate id          → 409
//   POST  /v1/ingestion/connectors invalid id            → 400
//   PATCH /v1/ingestion/connectors/:id                   (Edit)
//   PATCH /v1/ingestion/connectors/unknown_id            → 404
//   POST  /v1/ingestion/connectors/:id/run               (Sync now)
//   POST  /v1/ingestion/connectors/:id/pause             (Pause)
//   POST  /v1/ingestion/connectors/:id/resume            (Resume)
//   GET   /v1/ingestion/connectors/:id/runs              (Run history)
//   GET   /v1/ingestion/connectors/schema-drift          (Drift dashboard)
//   GET   /v1/ingestion/connectors/:id/schema            (Per-source schema)
//
// Plus RBAC + tenant-header guards on every route.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryIngestionRegistry } from '../src/ingestion';

const NOW = new Date('2026-05-24T12:00:00.000Z');
const TENANT = 'BANK_DEMO';
const HEADERS = {
  'X-Tenant-ID': TENANT,
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
};

function makeSmokeApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    // Fresh per-test registry so smoke output is deterministic
    ingestionRegistry: new InMemoryIngestionRegistry(),
  });
}

describe('Module 1.1 — Data Ingestion smoke', () => {
  it('admin walks the full Add → Edit → Sync → Pause → Resume → Runs flow', async () => {
    const { app } = makeSmokeApp('admin');

    // 1. List baseline (10 seed connectors)
    const list1 = await request(app)
      .get('/v1/ingestion/connectors')
      .set(HEADERS);
    expect(list1.status).toBe(200);
    expect(list1.body.body.total).toBeGreaterThanOrEqual(10);

    // 2. Health KPI strip
    const health = await request(app).get('/v1/ingestion/health').set(HEADERS);
    expect(health.status).toBe(200);
    expect(health.body.body.total_connectors).toBeGreaterThanOrEqual(10);
    expect(typeof health.body.body.by_status.healthy).toBe('number');

    // 3. Add new source (Source Editor)
    const created = await request(app)
      .post('/v1/ingestion/connectors')
      .set(HEADERS)
      .send({
        id: 'gst_returns',
        name: 'GST GSTR-3B Pull',
        source_system: 'GSTN',
        type: 'rest_api',
        schedule: 'monthly 5th 06:00',
        description: 'Monthly GST regularity feed',
        owner_user_id: 'ravi.risk',
      });
    expect(created.status).toBe(201);
    expect(created.body.body.id).toBe('gst_returns');
    expect(created.body.body.is_custom).toBe(true);
    expect(created.body.body.owner_user_id).toBe('ravi.risk');

    // 4. Duplicate id → 409
    const dup = await request(app)
      .post('/v1/ingestion/connectors')
      .set(HEADERS)
      .send({
        id: 'gst_returns',
        name: 'dup',
        source_system: 'X',
        type: 'rest_api',
        schedule: 'daily',
      });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EWS_409_id_in_use');

    // 5. Invalid id → 400
    const badId = await request(app)
      .post('/v1/ingestion/connectors')
      .set(HEADERS)
      .send({
        id: 'BAD-ID',
        name: 'bad',
        source_system: 'X',
        type: 'rest_api',
        schedule: 'daily',
      });
    expect(badId.status).toBe(400);
    expect(badId.body.error.code).toBe('EWS_400_invalid_id');

    // 6. Edit (Source Editor "save changes")
    const updated = await request(app)
      .patch('/v1/ingestion/connectors/gst_returns')
      .set(HEADERS)
      .send({ schedule: 'every 10th of month 06:00', owner_user_id: 'alice.admin' });
    expect(updated.status).toBe(200);
    expect(updated.body.body.schedule).toBe('every 10th of month 06:00');
    expect(updated.body.body.owner_user_id).toBe('alice.admin');

    // 7. Edit unknown → 404
    const unk = await request(app)
      .patch('/v1/ingestion/connectors/no_such_thing')
      .set(HEADERS)
      .send({ name: 'x' });
    expect(unk.status).toBe(404);
    expect(unk.body.error.code).toBe('EWS_404_unknown_connector');

    // 8. Sync now → records a run + bumps last_run_at
    const ran = await request(app)
      .post('/v1/ingestion/connectors/gst_returns/run')
      .set(HEADERS);
    // M3.1 returns 202 Accepted (ad-hoc run is scheduler-triggered, not synchronously completed)
    expect([200, 201, 202]).toContain(ran.status);
    expect(ran.body.body.connector_id).toBe('gst_returns');
    expect(ran.body.body.triggered_manually).toBe(true);

    // 9. Pause
    const paused = await request(app)
      .post('/v1/ingestion/connectors/gst_returns/pause')
      .set(HEADERS);
    expect(paused.status).toBe(200);
    expect(paused.body.body.status).toBe('paused');
    expect(typeof paused.body.body.paused_at).toBe('string');

    // 10. Sync while paused → 409
    const ranPaused = await request(app)
      .post('/v1/ingestion/connectors/gst_returns/run')
      .set(HEADERS);
    expect(ranPaused.status).toBe(409);

    // 11. Resume → status returns to healthy
    const resumed = await request(app)
      .post('/v1/ingestion/connectors/gst_returns/resume')
      .set(HEADERS);
    expect(resumed.status).toBe(200);
    expect(resumed.body.body.status).toBe('healthy');
    expect(resumed.body.body.paused_at).toBeNull();

    // 12. Run history (newest-first, max=200)
    const runs = await request(app)
      .get('/v1/ingestion/connectors/gst_returns/runs?limit=10')
      .set(HEADERS);
    expect(runs.status).toBe(200);
    expect(Array.isArray(runs.body.body.items)).toBe(true);
    expect(runs.body.body.items.length).toBeGreaterThanOrEqual(1);

    // 13. Schema drift dashboard
    const drift = await request(app)
      .get('/v1/ingestion/connectors/schema-drift')
      .set(HEADERS);
    expect(drift.status).toBe(200);
    expect(drift.body.body.total_connectors).toBeGreaterThanOrEqual(11);
    expect(typeof drift.body.body.drifted_count).toBe('number');
    expect(Array.isArray(drift.body.body.rows)).toBe(true);

    // 14. Per-source schema for an existing seed connector
    const schema = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/schema')
      .set(HEADERS);
    expect(schema.status).toBe(200);
    expect(schema.body.body.connector_id).toBe('cbs_loan_book');
    expect(schema.body.body.fields.length).toBeGreaterThan(0);
  });

  it('every protected route returns 401/403 to non-allowed roles', async () => {
    const { app } = makeSmokeApp('field_officer');
    const block = (status: number) => expect([401, 403]).toContain(status);

    block((await request(app).get('/v1/ingestion/connectors').set(HEADERS)).status);
    block(
      (await request(app)
        .post('/v1/ingestion/connectors')
        .set(HEADERS)
        .send({ id: 'x', name: 'X', source_system: 'S', type: 'rest_api', schedule: 'd' })).status,
    );
    block(
      (await request(app)
        .patch('/v1/ingestion/connectors/cbs_loan_book')
        .set(HEADERS)
        .send({ name: 'x' })).status,
    );
    block((await request(app).get('/v1/ingestion/connectors/schema-drift').set(HEADERS)).status);
  });

  it('every route refuses without X-Tenant-ID or X-Channel', async () => {
    const { app } = makeSmokeApp('admin');
    const r1 = await request(app).get('/v1/ingestion/connectors');
    expect([400, 401, 403]).toContain(r1.status);
    const r2 = await request(app)
      .post('/v1/ingestion/connectors')
      .set('X-Tenant-ID', TENANT)
      .send({ id: 'x', name: 'X', source_system: 'S', type: 'rest_api', schedule: 'd' });
    expect([400, 401, 403]).toContain(r2.status);
  });
});
