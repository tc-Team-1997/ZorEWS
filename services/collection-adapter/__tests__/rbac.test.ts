import request from 'supertest';
import { makeApp } from '../src/server';
import { UnavailableCasesClient } from '../src/cases_client';
import { InMemoryCollectionSink } from '../src/sink';
import { StaticCaseEventSource } from '../src/source';

/** App factory using the *real* default getRole (header-based). */
function makeRealApp() {
  return makeApp({
    source: new StaticCaseEventSource([]),
    sink: new InMemoryCollectionSink(),
    casesClient: new UnavailableCasesClient(),
  });
}

describe('collection-adapter — RBAC enforcement', () => {
  test('GET /healthz is unauthenticated', async () => {
    const { app } = makeRealApp();
    expect((await request(app).get('/healthz')).status).toBe(200);
  });

  test('POST /collection/callback without role → 401', async () => {
    const { app } = makeRealApp();
    const r = await request(app)
      .post('/collection/callback')
      .send({ case_id: 'case-1', status: 'cured' });
    expect(r.status).toBe(401);
  });

  test('field_officer cannot hit /collection/callback (403)', async () => {
    const { app } = makeRealApp();
    const r = await request(app)
      .post('/collection/callback')
      .set('x-apex-role', 'field_officer')
      .send({ case_id: 'case-1', status: 'cured' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/collection:callback/);
  });

  test('collection_officer can hit /collection/callback (RBAC pass; upstream 503 because unconfigured)', async () => {
    const { app } = makeRealApp();
    const r = await request(app)
      .post('/collection/callback')
      .set('x-apex-role', 'collection_officer')
      .send({ case_id: 'case-1', status: 'cured' });
    // RBAC passed → 503 from UnavailableCasesClient (not 403)
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/APEX_CASES_URL/);
  });

  test('supervisor can hit /collection/callback', async () => {
    const { app } = makeRealApp();
    const r = await request(app)
      .post('/collection/callback')
      .set('x-apex-role', 'supervisor')
      .send({ case_id: 'case-1', status: 'cured' });
    expect(r.status).toBe(503);  // RBAC pass, upstream unconfigured
  });

  test('/process is admin-only — denies non-admin roles', async () => {
    const { app } = makeRealApp();
    for (const role of ['risk_analyst', 'supervisor', 'collection_officer', 'field_officer']) {
      const r = await request(app).post('/process').set('x-apex-role', role).send({});
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/admin only/);
    }
  });

  test('/process without role → 401', async () => {
    const { app } = makeRealApp();
    const r = await request(app).post('/process').send({});
    expect(r.status).toBe(401);
  });

  test('admin can run /process', async () => {
    const { app } = makeRealApp();
    const r = await request(app).post('/process').set('x-apex-role', 'admin').send({});
    expect(r.status).toBe(200);
    expect(r.body.scanned).toBe(0);
  });
});
