import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { makeApp } from '../src/server';
import { CaseService, CASE_TOPIC } from '../src/service';
import { OutboxCaseProducer } from '../src/producer';
import { CaseStore } from '../src/store';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-cases-srv-'));
}

function makeApiApp() {
  const dir = tmp();
  const store = new CaseStore(path.join(dir, 'cases.ndjson'));
  const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
  const service = new CaseService({ store, producer });
  // These tests focus on the HTTP semantics; RBAC is covered separately in
  // rbac.test.ts. Inject an admin getRole so every route is permitted here.
  return { ...makeApp({ store, producer, service, getRole: () => 'admin' }), dir };
}

const A = {
  alert_id: 'alert-srv-1',
  customer_id: 'cust-1',
  loan_id: 'loan-1',
  severity: 'high',
  rule_id: 'CRD-006',
  raised_at: '2026-04-27T10:00:00.000Z',
  reason_summary: 'High DPD',
};

describe('cases HTTP server', () => {
  test('GET /healthz', async () => {
    const { app } = makeApiApp();
    const r = await request(app).get('/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  test('POST /cases creates (201), repeated POST returns existing (200)', async () => {
    const { app } = makeApiApp();
    const r1 = await request(app).post('/cases').send(A);
    expect(r1.status).toBe(201);
    expect(r1.body.created).toBe(true);
    const caseId = r1.body.case.case_id;

    const r2 = await request(app).post('/cases').send(A);
    expect(r2.status).toBe(200);
    expect(r2.body.created).toBe(false);
    expect(r2.body.case.case_id).toBe(caseId);
  });

  test('POST /cases rejects invalid severity (400)', async () => {
    const { app } = makeApiApp();
    const r = await request(app).post('/cases').send({ ...A, severity: 'urgent' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/severity/);
  });

  test('full lifecycle via HTTP', async () => {
    const { app, producer } = makeApiApp();
    const create = await request(app).post('/cases').send({ ...A, alert_id: 'alert-srv-lc' });
    expect(create.status).toBe(201);
    const id = create.body.case.case_id;

    const assign = await request(app).post(`/cases/${id}/assign`).send({ user_id: 'analyst.bob' });
    expect(assign.status).toBe(200);
    expect(assign.body.state).toBe('assigned');

    const action = await request(app)
      .post(`/cases/${id}/actions`)
      .send({ kind: 'visit', officer_id: 'fo.alice', gps: { lat: -1.29, lng: 36.82 } });
    expect(action.status).toBe(201);
    expect(action.body.state).toBe('in_action');
    expect(action.body.actions).toHaveLength(1);

    const monitor = await request(app).post(`/cases/${id}/monitor`).send({});
    expect(monitor.status).toBe(200);
    expect(monitor.body.state).toBe('monitored');

    const close = await request(app)
      .post(`/cases/${id}/close`)
      .send({ outcome: 'cured', note: 'paid' });
    expect(close.status).toBe(200);
    expect(close.body.state).toBe('closed');
    expect(close.body.outcome).toBe('cured');

    const events = (producer as OutboxCaseProducer).readAll(CASE_TOPIC).map((e) => e.event_type);
    expect(events).toEqual([
      'case.created',
      'case.assigned',
      'case.action_logged',
      'case.monitored',
      'case.closed',
    ]);
  });

  test('illegal transition returns 409 with current_state', async () => {
    const { app } = makeApiApp();
    const r = await request(app).post('/cases').send({ ...A, alert_id: 'alert-srv-409' });
    const id = r.body.case.case_id;
    // log action without assignment
    const bad = await request(app)
      .post(`/cases/${id}/actions`)
      .send({ kind: 'call', officer_id: 'x' });
    expect(bad.status).toBe(409);
    expect(bad.body.current_state).toBe('open');
    expect(bad.body.attempted).toBe('logAction');
  });

  test('GET /cases lists with filters', async () => {
    const { app } = makeApiApp();
    await request(app).post('/cases').send({ ...A, alert_id: 'a1', customer_id: 'cA' });
    await request(app).post('/cases').send({ ...A, alert_id: 'a2', customer_id: 'cB' });
    const all = await request(app).get('/cases');
    expect(all.body.total).toBe(2);
    const filtered = await request(app).get('/cases?customer_id=cA');
    expect(filtered.body.total).toBe(1);
  });

  test('action with bad gps returns 400', async () => {
    const { app } = makeApiApp();
    const r = await request(app).post('/cases').send({ ...A, alert_id: 'alert-bad-gps' });
    const id = r.body.case.case_id;
    await request(app).post(`/cases/${id}/assign`).send({ user_id: 'u' });
    const bad = await request(app)
      .post(`/cases/${id}/actions`)
      .send({ kind: 'visit', officer_id: 'fo', gps: { lat: 'nope' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/gps/);
  });

  test('close with bad outcome returns 400', async () => {
    const { app } = makeApiApp();
    const r = await request(app).post('/cases').send({ ...A, alert_id: 'alert-bad-out' });
    const id = r.body.case.case_id;
    const bad = await request(app).post(`/cases/${id}/close`).send({ outcome: 'recovered' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/outcome/);
  });

  test('GET /cases/:id 404 on unknown id', async () => {
    const { app } = makeApiApp();
    const r = await request(app).get('/cases/no-such-case');
    expect(r.status).toBe(404);
  });

  // T4.24 Phase 5 — cross-tenant isolation. Cases created by a BANK_DEMO
  // request must not be visible to BIL requests, and vice-versa.
  describe('cross-tenant isolation (T4.24 Phase 5)', () => {
    test('BIL admin never sees BANK_DEMO cases', async () => {
      const { app } = makeApiApp();
      // BANK_DEMO admin creates a case (X-Tenant-ID = BANK_DEMO).
      const created = await request(app)
        .post('/cases')
        .set('X-Tenant-ID', 'BANK_DEMO')
        .send({ ...A, alert_id: 'alert-bank-isolation' });
      expect(created.status).toBe(201);
      const caseId = created.body.case.case_id;
      expect(created.body.case.tenant_id).toBe('BANK_DEMO');

      // BIL admin lists cases — sees nothing.
      const bilList = await request(app)
        .get('/cases')
        .set('X-Tenant-ID', 'BIL');
      expect(bilList.status).toBe(200);
      expect(bilList.body.total).toBe(0);

      // BIL admin tries to fetch the case directly — 404 (no enumeration).
      const bilGet = await request(app)
        .get(`/cases/${caseId}`)
        .set('X-Tenant-ID', 'BIL');
      expect(bilGet.status).toBe(404);

      // BIL admin tries to assign — 404, the case stays un-mutated.
      const bilAssign = await request(app)
        .post(`/cases/${caseId}/assign`)
        .set('X-Tenant-ID', 'BIL')
        .send({ user_id: 'bil.admin' });
      expect(bilAssign.status).toBe(404);

      // BANK_DEMO admin still sees the case unchanged.
      const bankGet = await request(app)
        .get(`/cases/${caseId}`)
        .set('X-Tenant-ID', 'BANK_DEMO');
      expect(bankGet.status).toBe(200);
      expect(bankGet.body.assignee).toBeNull();
    });

    test('cases from different tenants live side-by-side without leaking', async () => {
      const { app } = makeApiApp();
      const bank = await request(app)
        .post('/cases')
        .set('X-Tenant-ID', 'BANK_DEMO')
        .send({ ...A, alert_id: 'alert-coexist-bank' });
      expect(bank.body.case.tenant_id).toBe('BANK_DEMO');
      const bil = await request(app)
        .post('/cases')
        .set('X-Tenant-ID', 'BIL')
        .send({ ...A, alert_id: 'alert-coexist-bil' });
      expect(bil.body.case.tenant_id).toBe('BIL');

      const bankList = await request(app).get('/cases').set('X-Tenant-ID', 'BANK_DEMO');
      expect(bankList.body.total).toBe(1);
      expect(bankList.body.items[0].alert_id).toBe('alert-coexist-bank');

      const bilList = await request(app).get('/cases').set('X-Tenant-ID', 'BIL');
      expect(bilList.body.total).toBe(1);
      expect(bilList.body.items[0].alert_id).toBe('alert-coexist-bil');
    });
  });
});
