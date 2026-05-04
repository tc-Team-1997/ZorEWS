import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { makeApp } from '../src/server';
import { CaseService } from '../src/service';
import { OutboxCaseProducer } from '../src/producer';
import { CaseStore } from '../src/store';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-cases-rbac-'));
}

/**
 * App factory using the *real* default getRole (header-based). Tests assert
 * the matrix is enforced end-to-end via the `x-apex-role` header.
 */
function makeRealApp() {
  const dir = tmp();
  const store = new CaseStore(path.join(dir, 'cases.ndjson'));
  const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
  const service = new CaseService({ store, producer });
  return makeApp({ store, producer, service });
}

const A = {
  alert_id: 'alert-rbac-1',
  customer_id: 'cust-1',
  loan_id: 'loan-1',
  severity: 'high',
  rule_id: 'CRD-006',
  raised_at: '2026-04-27T10:00:00.000Z',
};

describe('cases server — RBAC enforcement', () => {
  test('GET /healthz is unauthenticated (no role required)', async () => {
    const { app } = makeRealApp();
    const r = await request(app).get('/healthz');
    expect(r.status).toBe(200);
  });

  test('mutating routes 401 without a role header', async () => {
    const { app } = makeRealApp();
    const r = await request(app).post('/cases').send(A);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/authentication required/);
  });

  test('field_officer cannot create a case (403)', async () => {
    const { app } = makeRealApp();
    const r = await request(app).post('/cases').set('x-apex-role', 'field_officer').send(A);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/field_officer cannot cases:create/);
  });

  test('risk_analyst can create a case but cannot close it (403)', async () => {
    const { app } = makeRealApp();
    const create = await request(app)
      .post('/cases')
      .set('x-apex-role', 'risk_analyst')
      .send({ ...A, alert_id: 'alert-rbac-ra' });
    expect(create.status).toBe(201);
    const id = create.body.case.case_id;
    // matrix says cases:close is admin / supervisor / collection_officer only.
    const closed = await request(app)
      .post(`/cases/${id}/close`)
      .set('x-apex-role', 'risk_analyst')
      .send({ outcome: 'cured' });
    expect(closed.status).toBe(403);
    expect(closed.body.error).toMatch(/cases:close/);
  });

  test('supervisor can assign + close; field_officer cannot assign', async () => {
    const { app } = makeRealApp();
    const create = await request(app)
      .post('/cases')
      .set('x-apex-role', 'supervisor')
      .send({ ...A, alert_id: 'alert-rbac-sup' });
    const id = create.body.case.case_id;
    const sup = await request(app)
      .post(`/cases/${id}/assign`)
      .set('x-apex-role', 'supervisor')
      .send({ user_id: 'fiona.field' });
    expect(sup.status).toBe(200);
    const fo = await request(app)
      .post(`/cases/${id}/assign`)
      .set('x-apex-role', 'field_officer')
      .send({ user_id: 'fiona.field' });
    expect(fo.status).toBe(403);
    expect(fo.body.error).toMatch(/cases:assign/);
  });

  test('field_officer can log_action but cannot monitor', async () => {
    const { app } = makeRealApp();
    const create = await request(app)
      .post('/cases')
      .set('x-apex-role', 'admin')
      .send({ ...A, alert_id: 'alert-rbac-fo' });
    const id = create.body.case.case_id;
    await request(app)
      .post(`/cases/${id}/assign`)
      .set('x-apex-role', 'admin')
      .send({ user_id: 'fiona.field' });
    const action = await request(app)
      .post(`/cases/${id}/actions`)
      .set('x-apex-role', 'field_officer')
      .send({ kind: 'visit', officer_id: 'fiona.field' });
    expect(action.status).toBe(201);
    const monitor = await request(app)
      .post(`/cases/${id}/monitor`)
      .set('x-apex-role', 'field_officer')
      .send({});
    expect(monitor.status).toBe(403);
    expect(monitor.body.error).toMatch(/cases:monitor/);
  });

  test('GET /cases requires cases:list — denies unknown role', async () => {
    const { app } = makeRealApp();
    const r = await request(app).get('/cases').set('x-apex-role', 'ghost');
    expect(r.status).toBe(403);
  });

  test('admin role wildcards — every endpoint passes', async () => {
    const { app } = makeRealApp();
    const create = await request(app)
      .post('/cases')
      .set('x-apex-role', 'admin')
      .send({ ...A, alert_id: 'alert-rbac-admin' });
    const id = create.body.case.case_id;
    expect((await request(app).get('/cases').set('x-apex-role', 'admin')).status).toBe(200);
    expect(
      (await request(app).post(`/cases/${id}/assign`).set('x-apex-role', 'admin').send({ user_id: 'u' })).status,
    ).toBe(200);
    expect(
      (await request(app).post(`/cases/${id}/actions`).set('x-apex-role', 'admin').send({ kind: 'note', officer_id: 'fo' })).status,
    ).toBe(201);
    expect((await request(app).post(`/cases/${id}/monitor`).set('x-apex-role', 'admin').send({})).status).toBe(200);
    expect(
      (await request(app).post(`/cases/${id}/close`).set('x-apex-role', 'admin').send({ outcome: 'cured' })).status,
    ).toBe(200);
  });
});
