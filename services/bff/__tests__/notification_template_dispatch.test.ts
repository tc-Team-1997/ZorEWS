// Route tests for the M14.24 notification render + dispatch surface:
//   POST /v1/admin/notification-templates/:id/preview
//   POST /v1/admin/notification-templates/:id/test-fire
//   GET  /v1/admin/notification-templates/dispatches
// Also covers the in-memory dispatch store contract (append + filtered list).

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  InMemoryNotificationTemplateStore,
  validateCreate,
} from '../src/admin/notification_templates_store';
import {
  DISPATCH_LOG_CAP,
  InMemoryNotificationDispatchStore,
} from '../src/admin/notification_dispatch_store';

const NOW = new Date('2026-05-09T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

async function makeAppWithSeed(opts: {
  role?: string;
  withDispatch?: boolean;
  templates?: ReturnType<typeof validateCreate>[];
} = {}) {
  const role = opts.role ?? 'admin';
  const withDispatch = opts.withDispatch !== false;
  const tplStore = new InMemoryNotificationTemplateStore();
  const dispatchStore = withDispatch ? new InMemoryNotificationDispatchStore() : undefined;
  // Seed default email template under BIL
  const seeds =
    opts.templates ??
    [
      validateCreate({
        name: 'M14_24 demo email',
        channel: 'EMAIL',
        subject: 'New case {{case_number}} for {{customer_name}}',
        body: 'Hi {{rm_name}}, a {{priority | default: "P3"}} case for {{customer_name}}.',
      }),
    ];
  const created: { id: string; name: string }[] = [];
  for (const s of seeds) {
    const r = await tplStore.create('BIL', s, { actor_id: 'system:seed' }, NOW);
    created.push({ id: r.template_id, name: r.name });
  }
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    notificationTemplateStore: tplStore,
    notificationDispatchStore: dispatchStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, tplStore, dispatchStore, seeds: created };
}

describe('POST /v1/admin/notification-templates/:id/preview (M14.24)', () => {
  test('renders subject + body with provided vars', async () => {
    const { app, seeds } = await makeAppWithSeed();
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/preview`)
      .set(TH_BIL)
      .send({ vars: { case_number: 'C-001', customer_name: 'Alice', rm_name: 'Bob', priority: 'P1' } });
    expect(r.status).toBe(200);
    expect(r.body.body.subject).toBe('New case C-001 for Alice');
    expect(r.body.body.body).toBe('Hi Bob, a P1 case for Alice.');
    expect(r.body.body.missing_vars).toEqual([]);
  });

  test('flags missing vars in the response (no exception)', async () => {
    const { app, seeds } = await makeAppWithSeed();
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/preview`)
      .set(TH_BIL)
      .send({ vars: { case_number: 'C-001' } });
    expect(r.status).toBe(200);
    expect(r.body.body.missing_vars.sort()).toEqual(['customer_name', 'rm_name']);
    // Default supplied → priority is NOT missing
    expect(r.body.body.body).toContain('a P3 case');
  });

  test('preview does NOT write to the dispatch log', async () => {
    const { app, seeds, dispatchStore } = await makeAppWithSeed();
    await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/preview`)
      .set(TH_BIL)
      .send({ vars: {} });
    const log = await dispatchStore!.list('BIL', {});
    expect(log.total).toBe(0);
  });

  test('404 on unknown template', async () => {
    const { app } = await makeAppWithSeed();
    const r = await request(app)
      .post('/v1/admin/notification-templates/no-such/preview')
      .set(TH_BIL)
      .send({ vars: {} });
    expect(r.status).toBe(404);
  });

  test('400 on non-object vars', async () => {
    const { app, seeds } = await makeAppWithSeed();
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/preview`)
      .set(TH_BIL)
      .send({ vars: 'not an object' });
    expect(r.status).toBe(400);
  });

  test('case_owner role → 403 (not in admin:notification_templates:preview allowlist)', async () => {
    const { app, seeds } = await makeAppWithSeed({ role: 'case_owner' });
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/preview`)
      .set(TH_BIL)
      .send({ vars: {} });
    expect(r.status).toBe(403);
  });

  test('supervisor can preview (admin:notification_templates:preview includes supervisor)', async () => {
    const { app, seeds } = await makeAppWithSeed({ role: 'supervisor' });
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/preview`)
      .set(TH_BIL)
      .send({ vars: {} });
    expect(r.status).toBe(200);
  });

  test('cross-tenant 404 (BIL template invisible to BANK_DEMO)', async () => {
    const { app, seeds } = await makeAppWithSeed();
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/preview`)
      .set(TH_BANK)
      .send({ vars: {} });
    expect(r.status).toBe(404);
  });
});

describe('POST /v1/admin/notification-templates/:id/test-fire (M14.24)', () => {
  test('200 — renders + appends a dispatch row with status=sent', async () => {
    const { app, seeds, dispatchStore } = await makeAppWithSeed();
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
      .set({ ...TH_BIL, 'x-apex-user': 'alice.admin' })
      .send({
        vars: { case_number: 'C-001', customer_name: 'Alice', rm_name: 'Bob' },
        recipient: 'bob@example.com',
        reference: 'case:c-001',
      });
    expect(r.status).toBe(200);
    expect(r.body.body.dispatch.status).toBe('sent');
    expect(r.body.body.dispatch.recipient).toBe('bob@example.com');
    expect(r.body.body.dispatch.reference).toBe('case:c-001');
    expect(r.body.body.dispatch.performed_by).toBe('alice.admin');
    expect(r.body.body.dispatch.trigger).toBe('admin_test_fire');
    expect(r.body.body.rendered.subject).toContain('C-001');
    const log = await dispatchStore!.list('BIL', {});
    expect(log.total).toBe(1);
  });

  test('200 — dispatched even with missing vars; status_reason flags it', async () => {
    const { app, seeds } = await makeAppWithSeed();
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
      .set(TH_BIL)
      .send({ vars: {}, recipient: 'x@x' });
    expect(r.status).toBe(200);
    expect(r.body.body.dispatch.status).toBe('sent');
    expect(r.body.body.dispatch.status_reason).toMatch(/missing var/);
    expect(r.body.body.dispatch.missing_vars.length).toBeGreaterThan(0);
  });

  test('422 — refuse_when_missing=true with missing vars', async () => {
    const { app, seeds, dispatchStore } = await makeAppWithSeed();
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
      .set(TH_BIL)
      .send({ vars: {}, recipient: 'x@x', refuse_when_missing: true });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('EWS_422_missing_template_vars');
    // Refused dispatches must not log
    const log = await dispatchStore!.list('BIL', {});
    expect(log.total).toBe(0);
  });

  test('400 — recipient missing or empty', async () => {
    const { app, seeds } = await makeAppWithSeed();
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
      .set(TH_BIL)
      .send({ vars: {} });
    expect(r.status).toBe(400);
  });

  test('400 — non-object vars', async () => {
    const { app, seeds } = await makeAppWithSeed();
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
      .set(TH_BIL)
      .send({ vars: ['arr', 'not', 'ok'], recipient: 'x@x' });
    expect(r.status).toBe(400);
  });

  test('409 — cannot test-fire an archived template', async () => {
    const { app, tplStore, seeds } = await makeAppWithSeed();
    await tplStore.archive('BIL', seeds[0].id, { actor_id: 'admin' }, NOW);
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
      .set(TH_BIL)
      .send({ vars: {}, recipient: 'x@x' });
    expect(r.status).toBe(409);
  });

  test('503 — when notification_dispatch_store not wired', async () => {
    const { app, seeds } = await makeAppWithSeed({ withDispatch: false });
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
      .set(TH_BIL)
      .send({ vars: {}, recipient: 'x@x' });
    expect(r.status).toBe(503);
  });

  test('supervisor → 403 (test_fire is admin-only)', async () => {
    const { app, seeds } = await makeAppWithSeed({ role: 'supervisor' });
    const r = await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
      .set(TH_BIL)
      .send({ vars: {}, recipient: 'x@x' });
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/admin/notification-templates/dispatches (M14.24)', () => {
  test('200 — empty when nothing has been dispatched', async () => {
    const { app } = await makeAppWithSeed();
    const r = await request(app)
      .get('/v1/admin/notification-templates/dispatches')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('200 — empty (gracefully) when no dispatch store wired', async () => {
    const { app } = await makeAppWithSeed({ withDispatch: false });
    const r = await request(app)
      .get('/v1/admin/notification-templates/dispatches')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('newest-first after multiple test-fires', async () => {
    const { app, seeds } = await makeAppWithSeed();
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
        .set(TH_BIL)
        .send({ vars: {}, recipient: `t${i}@x`, reference: `case:c-${i}` });
    }
    const r = await request(app)
      .get('/v1/admin/notification-templates/dispatches')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(3);
    // newest-first → reference c-2 first
    expect(r.body.body.items[0].reference).toBe('case:c-2');
    expect(r.body.body.items[2].reference).toBe('case:c-0');
  });

  test('?reference filter pivots to a specific case', async () => {
    const { app, seeds } = await makeAppWithSeed();
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
        .set(TH_BIL)
        .send({ vars: {}, recipient: 'x@x', reference: `case:c-${i}` });
    }
    const r = await request(app)
      .get('/v1/admin/notification-templates/dispatches?reference=case:c-1')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].reference).toBe('case:c-1');
  });

  test('?template_id filter restricts to one template', async () => {
    const { app, seeds } = await makeAppWithSeed({
      templates: [
        validateCreate({ name: 'A', channel: 'SMS', body: 'a' }),
        validateCreate({ name: 'B', channel: 'SMS', body: 'b' }),
      ],
    });
    await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
      .set(TH_BIL)
      .send({ vars: {}, recipient: 'x@x' });
    await request(app)
      .post(`/v1/admin/notification-templates/${seeds[1].id}/test-fire`)
      .set(TH_BIL)
      .send({ vars: {}, recipient: 'x@x' });
    const onlyA = await request(app)
      .get(`/v1/admin/notification-templates/dispatches?template_id=${seeds[0].id}`)
      .set(TH_BIL);
    expect(onlyA.body.body.total).toBe(1);
    expect(onlyA.body.body.items[0].template_id).toBe(seeds[0].id);
  });

  test('400 on invalid status filter', async () => {
    const { app } = await makeAppWithSeed();
    const r = await request(app)
      .get('/v1/admin/notification-templates/dispatches?status=zombie')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('400 on invalid since', async () => {
    const { app } = await makeAppWithSeed();
    const r = await request(app)
      .get('/v1/admin/notification-templates/dispatches?since=bad-date')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('cross-tenant isolation', async () => {
    const { app, seeds } = await makeAppWithSeed();
    await request(app)
      .post(`/v1/admin/notification-templates/${seeds[0].id}/test-fire`)
      .set(TH_BIL)
      .send({ vars: {}, recipient: 'x@x' });
    const cross = await request(app)
      .get('/v1/admin/notification-templates/dispatches')
      .set(TH_BANK);
    expect(cross.body.body.total).toBe(0);
  });
});

describe('InMemoryNotificationDispatchStore — direct contract', () => {
  test('FIFO-caps at DISPATCH_LOG_CAP', async () => {
    const s = new InMemoryNotificationDispatchStore();
    for (let i = 0; i < DISPATCH_LOG_CAP + 25; i++) {
      await s.append(
        'BIL',
        {
          template_id: 't',
          template_name: 'N',
          channel: 'SMS',
          recipient: 'r',
          trigger: 'admin_test_fire',
          reference: `case:c-${i}`,
          rendered_subject: null,
          rendered_body: 'b',
          missing_vars: [],
          status: 'sent',
          performed_by: 'a',
        },
        new Date(2026, 4, 9, 0, i),
      );
    }
    // page_size is store-capped at 200; total counts the FIFO-capped store size
    const first = await s.list('BIL', { page_size: 200 });
    expect(first.total).toBe(DISPATCH_LOG_CAP);
    expect(first.items[0]!.reference).toBe(`case:c-${DISPATCH_LOG_CAP + 24}`); // newest first
    // Walk to the last page (page 3 of 200/200/100) to check the oldest survivor
    const last = await s.list('BIL', { page: 3, page_size: 200 });
    expect(last.items[last.items.length - 1]!.reference).toBe('case:c-25');
  });
});
