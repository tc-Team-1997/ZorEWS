import request from 'supertest';
import { makeApp } from '../src/server';
import { InMemoryMartReader } from '../src/mart/reader';

function makeRealApp() {
  // Default getRole — header-based.
  return makeApp({ reader: new InMemoryMartReader(), emitter: () => undefined });
}

const COMPUTE_BODY = { customer_id: 'CUST0001', snapshot_date: '2026-04-27' };

describe('indicators — RBAC enforcement', () => {
  test('GET /healthz is unauthenticated', async () => {
    const app = makeRealApp();
    expect((await request(app).get('/healthz')).status).toBe(200);
  });

  test('GET /indicators (catalog) is unauthenticated — SPA rule editor needs it', async () => {
    const app = makeRealApp();
    const r = await request(app).get('/indicators');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.indicators)).toBe(true);
  });

  test('POST /indicators/compute without role → 401', async () => {
    const app = makeRealApp();
    const r = await request(app).post('/indicators/compute').send(COMPUTE_BODY);
    expect(r.status).toBe(401);
  });

  test('POST /indicators/compute with non-admin role → 403', async () => {
    const app = makeRealApp();
    for (const role of ['risk_analyst', 'supervisor', 'collection_officer', 'field_officer']) {
      const r = await request(app)
        .post('/indicators/compute')
        .set('x-apex-role', role)
        .send(COMPUTE_BODY);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/admin only/);
    }
  });

  test('POST /indicators/compute/batch without role → 401', async () => {
    const app = makeRealApp();
    const r = await request(app)
      .post('/indicators/compute/batch')
      .send({ items: [COMPUTE_BODY] });
    expect(r.status).toBe(401);
  });

  test('POST /indicators/compute/batch with non-admin role → 403', async () => {
    const app = makeRealApp();
    const r = await request(app)
      .post('/indicators/compute/batch')
      .set('x-apex-role', 'risk_analyst')
      .send({ items: [COMPUTE_BODY] });
    expect(r.status).toBe(403);
  });

  test('POST /indicators/compute with admin role passes RBAC', async () => {
    const app = makeRealApp();
    const r = await request(app)
      .post('/indicators/compute')
      .set('x-apex-role', 'admin')
      .send(COMPUTE_BODY);
    // RBAC pass — engine returns 404 because the in-memory reader has no data
    // for CUST0001 at 2026-04-27. The point is the response is NOT 401/403.
    expect([200, 404]).toContain(r.status);
  });
});
