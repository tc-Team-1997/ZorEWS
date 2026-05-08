// services/bff/__tests__/cms_routes.test.ts
//
// CMS-3 — 18 route tests covering CRUD + lifecycle + notes + attachments
// + history + stats + SLA breaches + bulk-assign + RBAC + cross-tenant.

import request from 'supertest';
import { InMemoryCmsCaseStore } from '../src/cms_store';
import { InMemoryCaseEventStore } from '../src/case_events';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T10:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

interface CaseBody {
  title: string;
  description?: string;
  priority: string;
  alert_id?: string;
  tags?: string[];
  assigned_to?: string;
}

const VALID: CaseBody = {
  title: 'Customer cust-001 RED breach',
  description: '3+ EMI bounces in 90d',
  priority: 'P2',
  alert_id: 'alrt-001',
  tags: ['credit'],
};

function makeCmsApp(role = 'admin') {
  const cmsCaseStore = new InMemoryCmsCaseStore();
  const caseEventStore = new InMemoryCaseEventStore();
  let nowVal = NOW;
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    cmsCaseStore,
    caseEventStore,
    now: () => nowVal,
    getRole: () => role,
  });
  return {
    ...built,
    cmsCaseStore,
    caseEventStore,
    setNow: (d: Date) => { nowVal = d; },
  };
}

async function createCase(app: Parameters<typeof request>[0], body: CaseBody = VALID) {
  const r = await request(app).post('/v1/cms/cases').set(TH_BIL).send(body);
  expect(r.status).toBe(201);
  return r.body.body as { case_id: string; case_number: string };
}

// ─── Stats / SLA breaches / bulk-assign (literal routes — declared first) ─

describe('CMS-3 — GET /v1/cms/cases/stats', () => {
  test('empty store: zero everything', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app).get('/v1/cms/cases/stats').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
    expect(r.body.body.by_status.OPEN).toBe(0);
    expect(r.body.body.by_priority.P1).toBe(0);
    expect(r.body.body.sla_breached_count).toBe(0);
    expect(r.body.body.avg_resolution_hours).toBeNull();
  });

  test('counts by_status + by_priority', async () => {
    const { app } = makeCmsApp('admin');
    await createCase(app, { ...VALID, priority: 'P1' });
    await createCase(app, { ...VALID, priority: 'P3' });
    const r = await request(app).get('/v1/cms/cases/stats').set(TH_BIL);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.by_priority.P1).toBe(1);
    expect(r.body.body.by_priority.P3).toBe(1);
    expect(r.body.body.by_status.OPEN).toBe(2);
  });

  test('sla_breached_count counts cases past sla_due_at + not closed', async () => {
    const { app, setNow } = makeCmsApp('admin');
    await createCase(app, { ...VALID, priority: 'P1' }); // 4h SLA
    setNow(new Date(NOW.getTime() + 5 * 3600_000));
    const r = await request(app).get('/v1/cms/cases/stats').set(TH_BIL);
    expect(r.body.body.sla_breached_count).toBe(1);
  });

  test('avg_resolution_hours computed across closed cases', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app, { ...VALID, assigned_to: 'jane' });
    await request(app)
      .post(`/v1/cms/cases/${c.case_id}/transition`)
      .set(TH_BIL)
      .send({ target: 'INVESTIGATING' });
    await request(app)
      .post(`/v1/cms/cases/${c.case_id}/close`)
      .set(TH_BIL)
      .send({ resolution_category: 'mitigated', resolution_notes: 'paid' });
    const r = await request(app).get('/v1/cms/cases/stats').set(TH_BIL);
    expect(r.body.body.avg_resolution_hours).toBe(0); // closed at NOW
  });
});

describe('CMS-3 — GET /v1/cms/cases/sla-breaches', () => {
  test('empty when nothing breached', async () => {
    const { app } = makeCmsApp('admin');
    await createCase(app);
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(TH_BIL);
    expect(r.body.body.total).toBe(0);
  });

  test('returns breached cases sorted by overshoot (most overdue first)', async () => {
    const { app, setNow } = makeCmsApp('admin');
    await createCase(app, { ...VALID, priority: 'P1', title: 'A' });
    await createCase(app, { ...VALID, priority: 'P2', title: 'B' });
    setNow(new Date(NOW.getTime() + 30 * 3600_000)); // both breached (P1 4h, P2 24h)
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(TH_BIL);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.items[0].overshoot_hours).toBeGreaterThan(
      r.body.body.items[1].overshoot_hours,
    );
  });

  test('closed cases excluded', async () => {
    const { app, setNow } = makeCmsApp('admin');
    const c = await createCase(app, { ...VALID, priority: 'P1', assigned_to: 'jane' });
    await request(app)
      .post(`/v1/cms/cases/${c.case_id}/transition`)
      .set(TH_BIL)
      .send({ target: 'INVESTIGATING' });
    await request(app)
      .post(`/v1/cms/cases/${c.case_id}/close`)
      .set(TH_BIL)
      .send({ resolution_category: 'false_positive', resolution_notes: 'noop' });
    setNow(new Date(NOW.getTime() + 10 * 3600_000));
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(TH_BIL);
    expect(r.body.body.total).toBe(0);
  });
});

describe('CMS-3 — POST /v1/cms/cases/bulk-assign', () => {
  test('mixed outcomes + ok_count', async () => {
    const { app } = makeCmsApp('admin');
    const c1 = await createCase(app);
    const r = await request(app)
      .post('/v1/cms/cases/bulk-assign')
      .set(TH_BIL)
      .send({ case_ids: [c1.case_id, 'no-such-id'], assigned_to: 'jane' });
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.ok_count).toBe(1);
    expect(r.body.body.rows[0].status).toBe('ok');
    expect(r.body.body.rows[1].status).toBe('unknown_case');
  });

  test('empty case_ids → 400', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app)
      .post('/v1/cms/cases/bulk-assign')
      .set(TH_BIL)
      .send({ case_ids: [], assigned_to: 'jane' });
    expect(r.status).toBe(400);
  });

  test('missing assigned_to → 400', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app)
      .post('/v1/cms/cases/bulk-assign')
      .set(TH_BIL)
      .send({ case_ids: ['x'] });
    expect(r.status).toBe(400);
  });
});

// ─── CRUD ────────────────────────────────────────────────────────────

describe('CMS-3 — POST /v1/cms/cases (create)', () => {
  test('happy: 201 + audit + case event', async () => {
    const { app, caseEventStore } = makeCmsApp('admin');
    const r = await request(app).post('/v1/cms/cases').set(TH_BIL).send(VALID);
    expect(r.status).toBe(201);
    expect(r.body.body.case_number).toMatch(/^EWS-2026-\d{5}$/);
    expect(r.body.body.status).toBe('OPEN');

    const id = r.body.body.case_id;
    // Case-event journal entry
    const events = caseEventStore.fetchSince('BIL', 0, 50);
    const opened = events.items.find(
      (e) => e.case_id === id && e.action === 'opened',
    );
    expect(opened).toBeDefined();

    // Audit-trail entry
    const audit = await request(app)
      .get(`/v1/audit/events?resource_id=${id}`)
      .set(TH_BIL);
    expect(audit.body.body.items.find((x: { action: string }) => x.action === 'case.create')).toBeDefined();
  });

  test('bad priority → 400', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app).post('/v1/cms/cases').set(TH_BIL).send({ ...VALID, priority: 'P5' });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCmsApp('case_owner_unknown_role');
    const r = await request(app).post('/v1/cms/cases').set(TH_BIL).send(VALID);
    expect(r.status).toBe(403);
  });
});

describe('CMS-3 — GET /v1/cms/cases (list)', () => {
  test('lists newest-first', async () => {
    const { app } = makeCmsApp('admin');
    await createCase(app);
    await createCase(app);
    const r = await request(app).get('/v1/cms/cases').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
  });

  test('filter ?priority=P1', async () => {
    const { app } = makeCmsApp('admin');
    await createCase(app, { ...VALID, priority: 'P1' });
    await createCase(app, { ...VALID, priority: 'P3' });
    const r = await request(app).get('/v1/cms/cases?priority=P1').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('?priority=garbage → 400', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app).get('/v1/cms/cases?priority=P5').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('?status=OPEN', async () => {
    const { app } = makeCmsApp('admin');
    await createCase(app);
    const r = await request(app).get('/v1/cms/cases?status=OPEN').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('?tags=credit', async () => {
    const { app } = makeCmsApp('admin');
    await createCase(app, { ...VALID, tags: ['credit'] });
    await createCase(app, { ...VALID, tags: ['ops'] });
    const r = await request(app).get('/v1/cms/cases?tags=credit').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('?q=', async () => {
    const { app } = makeCmsApp('admin');
    await createCase(app, { ...VALID, title: 'Mumbai escalation' });
    await createCase(app, { ...VALID, title: 'Delhi claim' });
    const r = await request(app).get('/v1/cms/cases?q=mumbai').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('?breached=true filters using sla_config (BAC §3.1.9.1.4)', async () => {
    // Hand-built sla matrix source: P2 default_fallback target = 5d.
    // We then create cases with controlled created_at via a custom now()
    // shift. Two cases: one within target (3d old = on-track), one past
    // (8d old = breached).
    const cmsCaseStore = new InMemoryCmsCaseStore();
    const caseEventStore = new InMemoryCaseEventStore();
    let nowVal = NOW;
    const slaMatrixSource = {
      loadConfigs: async () => [
        {
          sla_config_id: 'cfg-fb-p2',
          tenant_id: 'BIL',
          case_category: 'default_fallback',
          priority: 'P2' as const,
          business_unit: null,
          sla_target_days: 5,
          status: 'ACTIVE' as const,
        },
      ],
      // unused for this test — the route only calls loadConfigs
      loadOpenCases: async () => [],
    };
    const built = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      cmsCaseStore,
      caseEventStore,
      slaMatrixSource,
      now: () => nowVal,
      getRole: () => 'admin',
    });

    // 8 days ago → past target (breached)
    nowVal = new Date(NOW.getTime() - 8 * 86_400_000);
    await createCase(built.app, { ...VALID, title: 'old breached' });
    // 3 days ago → on track
    nowVal = new Date(NOW.getTime() - 3 * 86_400_000);
    await createCase(built.app, { ...VALID, title: 'still on track' });
    // Move the clock back to NOW so the route sees ages 8d / 3d
    nowVal = NOW;

    const r = await request(built.app).get('/v1/cms/cases?breached=true').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].title).toBe('old breached');

    // Without the flag both rows surface
    const all = await request(built.app).get('/v1/cms/cases').set(TH_BIL);
    expect(all.body.body.total).toBe(2);
  });

  test('?breached=true with no sla_config row returns empty (not all rows)', async () => {
    const cmsCaseStore = new InMemoryCmsCaseStore();
    const caseEventStore = new InMemoryCaseEventStore();
    const built = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      cmsCaseStore,
      caseEventStore,
      slaMatrixSource: {
        loadConfigs: async () => [],
        loadOpenCases: async () => [],
      },
      now: () => NOW,
      getRole: () => 'admin',
    });
    await createCase(built.app);
    const r = await request(built.app).get('/v1/cms/cases?breached=true').set(TH_BIL);
    expect(r.status).toBe(200);
    // No config → unresolved → excluded from the breached set
    expect(r.body.body.total).toBe(0);
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeCmsApp('admin');
    await createCase(app);
    const other = await request(app)
      .get('/v1/cms/cases')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(other.body.body.total).toBe(0);
  });
});

describe('CMS-3 — GET /v1/cms/cases/:id (detail)', () => {
  test('happy: returns case + assignments + counts + sla', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app, { ...VALID, assigned_to: 'jane' });
    const r = await request(app).get(`/v1/cms/cases/${c.case_id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.case_id).toBe(c.case_id);
    expect(r.body.body.assignments).toHaveLength(1);
    expect(r.body.body.notes_count).toBe(0);
    expect(r.body.body.attachments_count).toBe(0);
    expect(r.body.body.sla.progress_pct).toBe(0);
    expect(r.body.body.sla.breached).toBe(false);
    expect(r.body.body.sla.warning).toBe(false);
  });

  test('breached after SLA elapse', async () => {
    const { app, setNow } = makeCmsApp('admin');
    const c = await createCase(app, { ...VALID, priority: 'P1' });
    setNow(new Date(NOW.getTime() + 5 * 3600_000));
    const r = await request(app).get(`/v1/cms/cases/${c.case_id}`).set(TH_BIL);
    expect(r.body.body.sla.breached).toBe(true);
  });

  test('warning after 80% elapsed', async () => {
    const { app, setNow } = makeCmsApp('admin');
    const c = await createCase(app, { ...VALID, priority: 'P1' }); // 4h SLA
    setNow(new Date(NOW.getTime() + 3.5 * 3600_000)); // 87.5%
    const r = await request(app).get(`/v1/cms/cases/${c.case_id}`).set(TH_BIL);
    expect(r.body.body.sla.warning).toBe(true);
    expect(r.body.body.sla.breached).toBe(false);
  });

  test('unknown → 404', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app).get('/v1/cms/cases/no-such').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

describe('CMS-3 — PATCH /v1/cms/cases/:id (update)', () => {
  test('happy: partial update', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .patch(`/v1/cms/cases/${c.case_id}`)
      .set(TH_BIL)
      .send({ title: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.body.body.title).toBe('Renamed');
  });

  test('locked case → 409', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app, { ...VALID, assigned_to: 'jane' });
    await request(app).post(`/v1/cms/cases/${c.case_id}/transition`).set(TH_BIL).send({ target: 'INVESTIGATING' });
    await request(app).post(`/v1/cms/cases/${c.case_id}/close`).set(TH_BIL).send({ resolution_category: 'mitigated', resolution_notes: 'p' });
    const r = await request(app)
      .patch(`/v1/cms/cases/${c.case_id}`)
      .set(TH_BIL)
      .send({ title: 'ignored' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_case_locked');
  });

  test('unknown → 404', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app)
      .patch('/v1/cms/cases/no-such')
      .set(TH_BIL)
      .send({ title: 'x' });
    expect(r.status).toBe(404);
  });
});

describe('CMS-3 — POST /v1/cms/cases/:id/transition', () => {
  test('legal transition', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app, { ...VALID, assigned_to: 'jane' });
    const r = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/transition`)
      .set(TH_BIL)
      .send({ target: 'INVESTIGATING' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('INVESTIGATING');
  });

  test('illegal transition → 409', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/transition`)
      .set(TH_BIL)
      .send({ target: 'INVESTIGATING' }); // OPEN→INVESTIGATING illegal
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_illegal_transition');
  });

  test('reopen path: CLOSED → OPEN', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app, { ...VALID, assigned_to: 'jane' });
    await request(app).post(`/v1/cms/cases/${c.case_id}/transition`).set(TH_BIL).send({ target: 'INVESTIGATING' });
    await request(app).post(`/v1/cms/cases/${c.case_id}/close`).set(TH_BIL).send({ resolution_category: 'mitigated', resolution_notes: 'p' });
    const r = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/transition`)
      .set(TH_BIL)
      .send({ target: 'OPEN' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('OPEN');
    expect(r.body.body.is_locked).toBe(false);
  });

  test('CLOSED via transition → 400 (must use /close)', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/transition`)
      .set(TH_BIL)
      .send({ target: 'CLOSED' });
    expect(r.status).toBe(400);
  });
});

describe('CMS-3 — POST /v1/cms/cases/:id/assign', () => {
  test('happy: 200 + audit', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/assign`)
      .set(TH_BIL)
      .send({ assigned_to: 'jane' });
    expect(r.status).toBe(200);
    expect(r.body.body.assigned_to).toBe('jane');
    expect(r.body.body.status).toBe('ASSIGNED');
  });

  test('reassign closes prior + opens new', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    await request(app).post(`/v1/cms/cases/${c.case_id}/assign`).set(TH_BIL).send({ assigned_to: 'jane' });
    await request(app).post(`/v1/cms/cases/${c.case_id}/assign`).set(TH_BIL).send({ assigned_to: 'bob' });
    const detail = await request(app).get(`/v1/cms/cases/${c.case_id}`).set(TH_BIL);
    expect(detail.body.body.assignments).toHaveLength(2);
    expect(detail.body.body.assignments[0].assigned_to).toBe('bob');
  });
});

describe('CMS-3 — POST /v1/cms/cases/:id/escalate', () => {
  test('happy: ESCALATED', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app, { ...VALID, assigned_to: 'jane' });
    const r = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/escalate`)
      .set(TH_BIL)
      .send({ reason: 'urgent' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('ESCALATED');
  });
});

describe('CMS-3 — POST /v1/cms/cases/:id/close', () => {
  test('happy: CLOSED + locked + resolution', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app, { ...VALID, assigned_to: 'jane' });
    await request(app).post(`/v1/cms/cases/${c.case_id}/transition`).set(TH_BIL).send({ target: 'INVESTIGATING' });
    const r = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/close`)
      .set(TH_BIL)
      .send({ resolution_category: 'mitigated', resolution_notes: 'paid in full' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('CLOSED');
    expect(r.body.body.is_locked).toBe(true);
    expect(r.body.body.resolution_category).toBe('mitigated');
  });

  test('missing resolution → 400', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/close`)
      .set(TH_BIL)
      .send({ resolution_category: 'mitigated' });
    expect(r.status).toBe(400);
  });
});

// ─── Notes ───────────────────────────────────────────────────────────

describe('CMS-3 — notes', () => {
  test('POST + GET round-trip', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const post = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/notes`)
      .set(TH_BIL)
      .send({ note_text: 'Met customer at branch' });
    expect(post.status).toBe(201);
    const list = await request(app).get(`/v1/cms/cases/${c.case_id}/notes`).set(TH_BIL);
    expect(list.body.body.total).toBe(1);
    expect(list.body.body.items[0].note_text).toBe('Met customer at branch');
  });

  test('GET notes on unknown case → 404', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app).get('/v1/cms/cases/no-such/notes').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

// ─── Attachments ─────────────────────────────────────────────────────

describe('CMS-3 — attachments', () => {
  test('POST + GET + GET-single + DELETE', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const post = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/attachments`)
      .set(TH_BIL)
      .send({ file_name: 'evidence.pdf', file_size: 1024, mime_type: 'application/pdf' });
    expect(post.status).toBe(201);
    const aid = post.body.body.attachment_id;

    const list = await request(app).get(`/v1/cms/cases/${c.case_id}/attachments`).set(TH_BIL);
    expect(list.body.body.total).toBe(1);

    const single = await request(app)
      .get(`/v1/cms/cases/${c.case_id}/attachments/${aid}`)
      .set(TH_BIL);
    expect(single.status).toBe(200);
    expect(single.body.body.virus_scan_status).toBe('clean');

    const del = await request(app)
      .delete(`/v1/cms/cases/${c.case_id}/attachments/${aid}`)
      .set(TH_BIL);
    expect(del.status).toBe(204);

    const after = await request(app).get(`/v1/cms/cases/${c.case_id}/attachments`).set(TH_BIL);
    expect(after.body.body.total).toBe(0);
  });

  test('non-whitelisted mime → 415', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/attachments`)
      .set(TH_BIL)
      .send({ file_name: 'evil.exe', file_size: 100, mime_type: 'application/x-msdownload' });
    expect(r.status).toBe(415);
    expect(r.body.error.code).toBe('EWS_415_invalid_mime_type');
  });

  test('file > 20 MB → 400', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .post(`/v1/cms/cases/${c.case_id}/attachments`)
      .set(TH_BIL)
      .send({
        file_name: 'big.pdf',
        file_size: 21 * 1024 * 1024,
        mime_type: 'application/pdf',
      });
    expect(r.status).toBe(400);
  });

  test('unknown attachment → 404', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .get(`/v1/cms/cases/${c.case_id}/attachments/no-such`)
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

// ─── History ─────────────────────────────────────────────────────────

describe('CMS-3 — GET /v1/cms/cases/:id/history', () => {
  test('returns audit slice newest-first', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    await request(app).patch(`/v1/cms/cases/${c.case_id}`).set(TH_BIL).send({ title: 'Renamed' });
    const r = await request(app).get(`/v1/cms/cases/${c.case_id}/history`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBeGreaterThan(0);
    expect(r.body.body.items[0].action_type).toBe('update');
  });

  test('?limit=1', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    await request(app).patch(`/v1/cms/cases/${c.case_id}`).set(TH_BIL).send({ title: 'X' });
    const r = await request(app)
      .get(`/v1/cms/cases/${c.case_id}/history?limit=1`)
      .set(TH_BIL);
    expect(r.body.body.items).toHaveLength(1);
  });

  test('?limit=0 → 400', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .get(`/v1/cms/cases/${c.case_id}/history?limit=0`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('unknown case → 404', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app).get('/v1/cms/cases/no-such/history').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

// ─── Cross-tenant + RBAC + no-shadow ─────────────────────────────────

describe('CMS-3 — cross-tenant + RBAC + no shadow', () => {
  test('cross-tenant: BANK_DEMO cannot see BIL case', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .get(`/v1/cms/cases/${c.case_id}`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(404);
  });

  test('M9.x /v1/cases/sla-summary still works (literal /cms/cases not shadowed)', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app).get('/v1/cases/sla-summary').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M9.x /v1/investigations still works', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app).get('/v1/investigations').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});

describe('CMS-3 — PATCH /v1/cms/cases/:id/category', () => {
  test('happy path: sets case_category from null → "fraud"', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .patch(`/v1/cms/cases/${c.case_id}/category`)
      .set(TH_BIL)
      .send({ case_category: 'fraud', reason: 'Confirmed via manual review' });
    expect(r.status).toBe(200);
    expect(r.body.body.case_category).toBe('fraud');
  });

  test('null clears the category back to default_fallback territory', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    await request(app)
      .patch(`/v1/cms/cases/${c.case_id}/category`)
      .set(TH_BIL)
      .send({ case_category: 'fraud' });
    const r = await request(app)
      .patch(`/v1/cms/cases/${c.case_id}/category`)
      .set(TH_BIL)
      .send({ case_category: null, reason: 'misclassified earlier' });
    expect(r.status).toBe(200);
    expect(r.body.body.case_category).toBeNull();
  });

  test('empty string is treated as null', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .patch(`/v1/cms/cases/${c.case_id}/category`)
      .set(TH_BIL)
      .send({ case_category: '   ' });
    expect(r.status).toBe(200);
    expect(r.body.body.case_category).toBeNull();
  });

  test('non-string + non-null body → 400', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .patch(`/v1/cms/cases/${c.case_id}/category`)
      .set(TH_BIL)
      .send({ case_category: 42 });
    expect(r.status).toBe(400);
  });

  test('non-admin / non-supervisor role denied (403)', async () => {
    const { app } = makeCmsApp('risk_analyst');
    const c = await createCase(app);
    const r = await request(app)
      .patch(`/v1/cms/cases/${c.case_id}/category`)
      .set(TH_BIL)
      .send({ case_category: 'fraud' });
    expect(r.status).toBe(403);
  });

  test('unknown case → 404', async () => {
    const { app } = makeCmsApp('admin');
    const r = await request(app)
      .patch('/v1/cms/cases/no-such-id/category')
      .set(TH_BIL)
      .send({ case_category: 'fraud' });
    expect(r.status).toBe(404);
  });

  test('idempotent re-categorise (same value, no-op) still returns 200', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    await request(app)
      .patch(`/v1/cms/cases/${c.case_id}/category`)
      .set(TH_BIL)
      .send({ case_category: 'fraud' });
    const r = await request(app)
      .patch(`/v1/cms/cases/${c.case_id}/category`)
      .set(TH_BIL)
      .send({ case_category: 'fraud' });
    expect(r.status).toBe(200);
    expect(r.body.body.case_category).toBe('fraud');
  });

  test('rejects category > 64 chars', async () => {
    const { app } = makeCmsApp('admin');
    const c = await createCase(app);
    const r = await request(app)
      .patch(`/v1/cms/cases/${c.case_id}/category`)
      .set(TH_BIL)
      .send({ case_category: 'x'.repeat(65) });
    expect(r.status).toBe(400);
  });
});
