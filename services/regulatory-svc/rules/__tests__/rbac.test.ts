import request from 'supertest';
import { makeApp } from '../src/server';
import { RuleStore } from '../src/lifecycle';

function makeRealApp() {
  return makeApp({ store: new RuleStore() });
}

describe('rules — RBAC enforcement', () => {
  test('GET /healthz is unauthenticated', async () => {
    const app = makeRealApp();
    expect((await request(app).get('/healthz')).status).toBe(200);
  });

  test('GET /rules without role → 401', async () => {
    const app = makeRealApp();
    const r = await request(app).get('/rules');
    expect(r.status).toBe(401);
  });

  test('GET /rules with field_officer is allowed (rules:list)', async () => {
    const app = makeRealApp();
    const r = await request(app).get('/rules').set('x-apex-role', 'field_officer');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.rules)).toBe(true);
  });

  test('POST /rules with field_officer is denied (rules:create — admin/risk_analyst only)', async () => {
    const app = makeRealApp();
    const r = await request(app).post('/rules').set('x-apex-role', 'field_officer').send({});
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/rules:create/);
  });

  test('POST /rules/:id/retire with risk_analyst is denied (admin/supervisor only)', async () => {
    const app = makeRealApp();
    const r = await request(app)
      .post('/rules/r-1/retire')
      .set('x-apex-role', 'risk_analyst')
      .send({});
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/rules:retire/);
  });

  test('POST /rules/:id/promote uses rules:retire op (lifecycle role set)', async () => {
    const app = makeRealApp();
    const ra = await request(app)
      .post('/rules/r-1/promote')
      .set('x-apex-role', 'risk_analyst')
      .send({});
    expect(ra.status).toBe(403);
    expect(ra.body.error).toMatch(/rules:retire/);
    // supervisor permitted (gets a real rules-engine error since r-1 doesn't
    // exist; the point is that RBAC didn't 403)
    const sup = await request(app)
      .post('/rules/r-1/promote')
      .set('x-apex-role', 'supervisor')
      .send({});
    expect(sup.status).not.toBe(403);
  });

  test('GET /rules/:id/audit is admin/supervisor only', async () => {
    const app = makeRealApp();
    const fo = await request(app)
      .get('/rules/r-1/audit')
      .set('x-apex-role', 'field_officer');
    expect(fo.status).toBe(403);
    expect(fo.body.error).toMatch(/audit:read/);
    const sup = await request(app)
      .get('/rules/r-1/audit')
      .set('x-apex-role', 'supervisor');
    expect(sup.status).toBe(200);
  });

  test('POST /rules/:id/simulate is admin/risk_analyst/supervisor only', async () => {
    const app = makeRealApp();
    const fo = await request(app)
      .post('/rules/r-1/simulate')
      .set('x-apex-role', 'field_officer')
      .send({});
    expect(fo.status).toBe(403);
    const co = await request(app)
      .post('/rules/r-1/simulate')
      .set('x-apex-role', 'collection_officer')
      .send({});
    expect(co.status).toBe(403);
  });
});
