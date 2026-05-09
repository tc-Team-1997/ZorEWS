// Route smoke tests for /v1/admin/notification-templates (T6 M14.16).
// Wires the in-memory store into the real makeApp() pipeline and
// exercises the happy path + RBAC + tenant isolation. Bulk of validation
// behaviour is already covered by notification_templates_store.test.ts.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryNotificationTemplateStore } from '../src/admin/notification_templates_store';

const NOW = new Date('2026-05-09T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTplApp(role = 'admin', store?: InMemoryNotificationTemplateStore) {
  const s = store ?? new InMemoryNotificationTemplateStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    notificationTemplateStore: s,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store: s };
}

const EMAIL_BODY = {
  name: 'RM weekly digest',
  channel: 'EMAIL',
  subject: 'Your weekly EWS update',
  body: 'Hi {{rm_name}}, {{count}} new alerts.',
};

describe('POST + GET /v1/admin/notification-templates (M14.16)', () => {
  test('POST 201 creates a DRAFT template, then GET list returns it', async () => {
    const { app } = makeTplApp();
    const c = await request(app)
      .post('/v1/admin/notification-templates')
      .set({ ...TH_BIL, 'x-apex-user': 'alice.admin' })
      .send(EMAIL_BODY);
    expect(c.status).toBe(201);
    expect(c.body.body.status).toBe('DRAFT');
    expect(c.body.body.created_by).toBe('alice.admin');

    const l = await request(app)
      .get('/v1/admin/notification-templates')
      .set(TH_BIL);
    expect(l.status).toBe(200);
    expect(l.body.body.total).toBe(1);
  });

  test('POST 400 on EMAIL without subject', async () => {
    const { app } = makeTplApp();
    const r = await request(app)
      .post('/v1/admin/notification-templates')
      .set(TH_BIL)
      .send({ name: 'X', channel: 'EMAIL', body: 'b' });
    expect(r.status).toBe(400);
  });

  test('POST 400 on SMS WITH subject', async () => {
    const { app } = makeTplApp();
    const r = await request(app)
      .post('/v1/admin/notification-templates')
      .set(TH_BIL)
      .send({ name: 'X', channel: 'SMS', subject: 'oops', body: 'b' });
    expect(r.status).toBe(400);
  });

  test('POST 409 on duplicate (tenant, name, locale)', async () => {
    const { app } = makeTplApp();
    await request(app).post('/v1/admin/notification-templates').set(TH_BIL).send(EMAIL_BODY);
    const dup = await request(app)
      .post('/v1/admin/notification-templates')
      .set(TH_BIL)
      .send(EMAIL_BODY);
    expect(dup.status).toBe(409);
  });

  test('GET list filters by channel', async () => {
    const { app } = makeTplApp();
    await request(app).post('/v1/admin/notification-templates').set(TH_BIL).send(EMAIL_BODY);
    await request(app)
      .post('/v1/admin/notification-templates')
      .set(TH_BIL)
      .send({ name: 'Lapse SMS', channel: 'SMS', body: 'EWS: lapse' });
    const sms = await request(app).get('/v1/admin/notification-templates?channel=SMS').set(TH_BIL);
    expect(sms.body.body.total).toBe(1);
    expect(sms.body.body.items[0].channel).toBe('SMS');
  });

  test('GET list 400 on unknown channel filter', async () => {
    const { app } = makeTplApp();
    const r = await request(app)
      .get('/v1/admin/notification-templates?channel=PIGEON')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403 on POST', async () => {
    const { app } = makeTplApp('case_owner');
    const r = await request(app)
      .post('/v1/admin/notification-templates')
      .set(TH_BIL)
      .send(EMAIL_BODY);
    expect(r.status).toBe(403);
  });

  test('supervisor can list but not create', async () => {
    const { app } = makeTplApp('supervisor');
    const l = await request(app).get('/v1/admin/notification-templates').set(TH_BIL);
    expect(l.status).toBe(200);
    const c = await request(app)
      .post('/v1/admin/notification-templates')
      .set(TH_BIL)
      .send(EMAIL_BODY);
    expect(c.status).toBe(403);
  });

  test('PATCH 200 updates body + activate moves DRAFT → ACTIVE', async () => {
    const { app } = makeTplApp();
    const c = await request(app)
      .post('/v1/admin/notification-templates')
      .set({ ...TH_BIL, 'x-apex-user': 'alice.admin' })
      .send(EMAIL_BODY);
    const id = c.body.body.template_id;

    const p = await request(app)
      .patch(`/v1/admin/notification-templates/${id}`)
      .set({ ...TH_BIL, 'x-apex-user': 'bob.admin' })
      .send({ body: 'updated body' });
    expect(p.status).toBe(200);
    expect(p.body.body.body).toBe('updated body');
    expect(p.body.body.updated_by).toBe('bob.admin');

    const a = await request(app)
      .post(`/v1/admin/notification-templates/${id}/activate`)
      .set(TH_BIL);
    expect(a.status).toBe(200);
    expect(a.body.body.status).toBe('ACTIVE');
  });

  test('DELETE 200 archives + soft-deletes; GET list excludes by default', async () => {
    const { app } = makeTplApp();
    const c = await request(app)
      .post('/v1/admin/notification-templates')
      .set(TH_BIL)
      .send(EMAIL_BODY);
    const id = c.body.body.template_id;

    const d = await request(app)
      .delete(`/v1/admin/notification-templates/${id}`)
      .set(TH_BIL);
    expect(d.status).toBe(200);
    expect(d.body.body.status).toBe('ARCHIVED');
    expect(d.body.body.deleted_at).not.toBeNull();

    const l = await request(app).get('/v1/admin/notification-templates').set(TH_BIL);
    expect(l.body.body.total).toBe(0);

    const lDel = await request(app)
      .get('/v1/admin/notification-templates?include_deleted=true')
      .set(TH_BIL);
    expect(lDel.body.body.total).toBe(1);
  });

  test('GET 404 across tenants', async () => {
    const { app } = makeTplApp();
    const c = await request(app)
      .post('/v1/admin/notification-templates')
      .set(TH_BIL)
      .send(EMAIL_BODY);
    const id = c.body.body.template_id;
    const cross = await request(app)
      .get(`/v1/admin/notification-templates/${id}`)
      .set({ ...TH_BIL, 'X-Tenant-ID': 'BANK_DEMO' });
    expect(cross.status).toBe(404);
  });
});
