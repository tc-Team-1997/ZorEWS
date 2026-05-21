// services/bff/__tests__/aml_correlation.test.ts
//
// Phase T3.3 — AML Bidirectional Alert Correlation tests.

import request from 'supertest';
import {
  ALL_AML_ENTITY_KINDS,
  ALL_AML_LINK_RELATIONS,
  ALL_AML_TIMELINE_SEVERITIES,
  isAmlEntityKind,
  isAmlLinkRelation,
  composeCustomerTimeline,
  InMemoryAmlCorrelationStore,
  AmlCorrelationError,
  AML_CORRELATION_CAP_PER_TENANT,
  AML_CORRELATION_MAX_TRAVERSAL_DEPTH,
  type AmlCorrelationLinkInput,
  type AmlTimelineEvent,
} from '../src/aml/correlation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T18:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeAmlApp(
  role: string = 'admin',
  overrides: { amlCorrelationStore?: InMemoryAmlCorrelationStore } = {},
) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    amlCorrelationStore: overrides.amlCorrelationStore ?? new InMemoryAmlCorrelationStore(),
  });
  return app;
}

const validLinkInput = (over: Partial<AmlCorrelationLinkInput> = {}): AmlCorrelationLinkInput => ({
  source_kind: 'aml_match',
  source_id: 'AML-2026-001',
  target_kind: 'ews_alert',
  target_id: 'ALERT-2026-001',
  relation: 'triggered_alert',
  customer_id: 'CUST-100001',
  notes: 'AML hit triggered the high-priority EWS alert',
  ...over,
});

const tlEvent = (over: Partial<AmlTimelineEvent> = {}): AmlTimelineEvent => ({
  event_id: 'evt-1',
  tenant_id: 'BIL',
  customer_id: 'CUST-100001',
  entity_kind: 'aml_match',
  entity_id: 'AML-2026-001',
  occurred_at: '2026-05-15T09:00:00.000Z',
  severity: 'high',
  title: 'AML watchlist match',
  description: 'Match against UN sanctions list',
  ...over,
});

// ── 1. Constants + type guards ────────────────────────────────────────

describe('aml_correlation constants', () => {
  test('ALL_AML_ENTITY_KINDS covers 5 entity surfaces', () => {
    expect(ALL_AML_ENTITY_KINDS).toEqual([
      'aml_match', 'ews_alert', 'case', 'investigation', 'str_report',
    ]);
  });

  test('ALL_AML_LINK_RELATIONS has 6 closed-enum entries', () => {
    expect(ALL_AML_LINK_RELATIONS.length).toBe(6);
  });

  test('ALL_AML_TIMELINE_SEVERITIES has 5 entries', () => {
    expect(ALL_AML_TIMELINE_SEVERITIES.length).toBe(5);
  });

  test('type guards accept + reject', () => {
    expect(isAmlEntityKind('aml_match')).toBe(true);
    expect(isAmlEntityKind('bogus')).toBe(false);
    expect(isAmlLinkRelation('triggered_alert')).toBe(true);
    expect(isAmlLinkRelation('nope')).toBe(false);
  });
});

// ── 2. Store link creation ──────────────────────────────────────────

describe('InMemoryAmlCorrelationStore — link', () => {
  test('happy path with default confidence by relation', () => {
    const s = new InMemoryAmlCorrelationStore();
    const l = s.link('BIL', validLinkInput(), 'admin', NOW);
    expect(l.relation).toBe('triggered_alert');
    expect(l.confidence).toBe(1.0); // system-generated relations default to 1.0
    expect(l.customer_id).toBe('CUST-100001');
  });

  test('manual_link defaults to 0.5 confidence', () => {
    const s = new InMemoryAmlCorrelationStore();
    const l = s.link(
      'BIL',
      validLinkInput({ relation: 'manual_link' }),
      'admin',
      NOW,
    );
    expect(l.confidence).toBe(0.5);
  });

  test('explicit confidence wins', () => {
    const s = new InMemoryAmlCorrelationStore();
    const l = s.link('BIL', validLinkInput({ confidence: 0.85 }), 'admin', NOW);
    expect(l.confidence).toBe(0.85);
  });

  test('duplicate (source, target, relation) → 409', () => {
    const s = new InMemoryAmlCorrelationStore();
    s.link('BIL', validLinkInput(), 'admin', NOW);
    expect(() => s.link('BIL', validLinkInput(), 'admin', NOW)).toThrow(/duplicate_link/);
  });

  test('self_link rejected', () => {
    const s = new InMemoryAmlCorrelationStore();
    expect(() =>
      s.link(
        'BIL',
        validLinkInput({
          target_kind: 'aml_match',
          target_id: 'AML-2026-001',
        }),
        'admin',
        NOW,
      ),
    ).toThrow(/self_link/);
  });

  test('invalid entity kind → 400', () => {
    const s = new InMemoryAmlCorrelationStore();
    expect(() =>
      s.link('BIL', validLinkInput({ source_kind: 'wallet' as never }), 'admin', NOW),
    ).toThrow(/invalid_entity_kind/);
  });

  test('invalid relation → 400', () => {
    const s = new InMemoryAmlCorrelationStore();
    expect(() =>
      s.link('BIL', validLinkInput({ relation: 'magical' as never }), 'admin', NOW),
    ).toThrow(/invalid_relation/);
  });

  test('confidence out of range → 400', () => {
    const s = new InMemoryAmlCorrelationStore();
    expect(() =>
      s.link('BIL', validLinkInput({ confidence: 1.5 }), 'admin', NOW),
    ).toThrow(/invalid_confidence/);
  });

  test('invalid entity_id format → 400', () => {
    const s = new InMemoryAmlCorrelationStore();
    expect(() =>
      s.link('BIL', validLinkInput({ source_id: 'has space' }), 'admin', NOW),
    ).toThrow(/invalid_entity_id/);
  });

  test('invalid customer_id format → 400', () => {
    const s = new InMemoryAmlCorrelationStore();
    expect(() =>
      s.link('BIL', validLinkInput({ customer_id: 'bad customer' }), 'admin', NOW),
    ).toThrow(/invalid_customer_id/);
  });

  test('cap_reached', () => {
    const s = new InMemoryAmlCorrelationStore();
    for (let i = 0; i < AML_CORRELATION_CAP_PER_TENANT; i++) {
      s.link(
        'BIL',
        validLinkInput({
          source_id: `AML-${i}`,
          target_id: `ALERT-${i}`,
        }),
        'admin',
        NOW,
      );
    }
    expect(() =>
      s.link(
        'BIL',
        validLinkInput({ source_id: 'AML-over', target_id: 'ALERT-over' }),
        'admin',
        NOW,
      ),
    ).toThrow(/cap_reached/);
  });
});

// ── 3. Store list / get / listForEntity ─────────────────────────────

describe('InMemoryAmlCorrelationStore — list/get/listForEntity', () => {
  test('list newest-first by created_at', () => {
    const s = new InMemoryAmlCorrelationStore();
    s.link(
      'BIL',
      validLinkInput({ link_id: 'acl_a', source_id: 'AML-1', target_id: 'ALERT-1' }),
      'admin',
      NOW,
    );
    s.link(
      'BIL',
      validLinkInput({ link_id: 'acl_b', source_id: 'AML-2', target_id: 'ALERT-2' }),
      'admin',
      new Date(NOW.getTime() + 10_000),
    );
    expect(s.list('BIL')[0].link_id).toBe('acl_b');
  });

  test('list filter combinations', () => {
    const s = new InMemoryAmlCorrelationStore();
    s.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_a',
        source_id: 'AML-A',
        target_id: 'ALERT-A',
        customer_id: 'CUST-A',
      }),
      'admin',
      NOW,
    );
    s.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_b',
        source_kind: 'ews_alert',
        source_id: 'ALERT-B',
        target_kind: 'case',
        target_id: 'CASE-B',
        relation: 'escalated_to_case',
        customer_id: 'CUST-B',
      }),
      'admin',
      NOW,
    );
    expect(s.list('BIL', { customer_id: 'CUST-A' })).toHaveLength(1);
    expect(s.list('BIL', { relation: 'escalated_to_case' })).toHaveLength(1);
    expect(s.list('BIL', { source_kind: 'aml_match' })).toHaveLength(1);
  });

  test('listForEntity returns links where entity is source OR target', () => {
    const s = new InMemoryAmlCorrelationStore();
    s.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_a',
        source_kind: 'aml_match',
        source_id: 'AML-1',
        target_kind: 'ews_alert',
        target_id: 'ALERT-1',
      }),
      'admin',
      NOW,
    );
    s.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_b',
        source_kind: 'ews_alert',
        source_id: 'ALERT-1',
        target_kind: 'case',
        target_id: 'CASE-1',
        relation: 'escalated_to_case',
      }),
      'admin',
      NOW,
    );
    // ALERT-1 is target in acl_a + source in acl_b — both returned.
    const links = s.listForEntity('BIL', 'ews_alert', 'ALERT-1');
    expect(links).toHaveLength(2);
  });

  test('get returns null for unknown id', () => {
    const s = new InMemoryAmlCorrelationStore();
    expect(s.get('BIL', 'acl_nope')).toBeNull();
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryAmlCorrelationStore();
    s.link('BIL', validLinkInput(), 'admin', NOW);
    expect(s.list('BANK_DEMO')).toHaveLength(0);
  });
});

// ── 4. Store traverse ────────────────────────────────────────────────

describe('InMemoryAmlCorrelationStore — traverse', () => {
  test('BFS reaches depth 2 across 4 modules', () => {
    const s = new InMemoryAmlCorrelationStore();
    // aml_match → ews_alert
    s.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_a',
        source_kind: 'aml_match',
        source_id: 'AML-1',
        target_kind: 'ews_alert',
        target_id: 'ALERT-1',
        relation: 'triggered_alert',
      }),
      'admin',
      NOW,
    );
    // ews_alert → case
    s.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_b',
        source_kind: 'ews_alert',
        source_id: 'ALERT-1',
        target_kind: 'case',
        target_id: 'CASE-1',
        relation: 'escalated_to_case',
      }),
      'admin',
      NOW,
    );
    // case → investigation
    s.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_c',
        source_kind: 'case',
        source_id: 'CASE-1',
        target_kind: 'investigation',
        target_id: 'INV-1',
        relation: 'opened_investigation',
      }),
      'admin',
      NOW,
    );
    const out = s.traverse('BIL', { kind: 'aml_match', id: 'AML-1' }, 3);
    // Should reach AML-1 (origin), ALERT-1, CASE-1, INV-1 = 4 nodes.
    expect(out.nodes.length).toBe(4);
    expect(out.edges.length).toBe(3);
    const inv = out.nodes.find((n) => n.kind === 'investigation' && n.id === 'INV-1');
    expect(inv?.reached_at_depth).toBe(3);
  });

  test('depth=0 returns origin only', () => {
    const s = new InMemoryAmlCorrelationStore();
    s.link('BIL', validLinkInput(), 'admin', NOW);
    const out = s.traverse('BIL', { kind: 'aml_match', id: 'AML-2026-001' }, 0);
    expect(out.nodes).toHaveLength(1);
    expect(out.edges).toHaveLength(0);
  });

  test('depth > MAX → 400', () => {
    const s = new InMemoryAmlCorrelationStore();
    expect(() =>
      s.traverse(
        'BIL',
        { kind: 'aml_match', id: 'AML-1' },
        AML_CORRELATION_MAX_TRAVERSAL_DEPTH + 1,
      ),
    ).toThrow(/invalid_traversal/);
  });

  test('isolated entity returns only itself', () => {
    const s = new InMemoryAmlCorrelationStore();
    const out = s.traverse('BIL', { kind: 'aml_match', id: 'AML-ISOLATED' }, 3);
    expect(out.nodes).toHaveLength(1);
    expect(out.edges).toHaveLength(0);
  });
});

// ── 5. Store soft-delete + restore + summary ─────────────────────────

describe('InMemoryAmlCorrelationStore — soft-delete + restore + summary', () => {
  test('soft-delete + restore round-trip', () => {
    const s = new InMemoryAmlCorrelationStore();
    const l = s.link('BIL', validLinkInput(), 'admin', NOW);
    s.softDelete('BIL', l.link_id, 'admin', NOW);
    expect(s.list('BIL')).toHaveLength(0);
    // Tuple is freed, so the same edge can be re-asserted.
    s.link('BIL', validLinkInput(), 'admin', new Date(NOW.getTime() + 1000));
    // Restoring the original now conflicts with the new live one.
    expect(
      s.restore({ ...l, deleted_at: NOW.toISOString(), deleted_by: 'admin' }),
    ).toBe(false);
  });

  test('summary rollup', () => {
    const s = new InMemoryAmlCorrelationStore();
    s.link('BIL', validLinkInput({ link_id: 'acl_a' }), 'admin', NOW);
    s.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_b',
        source_kind: 'ews_alert',
        source_id: 'ALERT-1',
        target_kind: 'case',
        target_id: 'CASE-1',
        relation: 'escalated_to_case',
      }),
      'admin',
      NOW,
    );
    s.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_c',
        source_kind: 'aml_match',
        source_id: 'AML-X',
        target_kind: 'ews_alert',
        target_id: 'ALERT-X',
        customer_id: 'CUST-OTHER',
      }),
      'admin',
      NOW,
    );
    const sum = s.summary('BIL');
    expect(sum.total_links).toBe(3);
    expect(sum.by_relation.triggered_alert).toBe(2);
    expect(sum.by_relation.escalated_to_case).toBe(1);
    expect(sum.by_kind_pair['aml_match->ews_alert']).toBe(2);
    expect(sum.total_customers_with_links).toBe(2);
  });
});

// ── 6. composeCustomerTimeline ──────────────────────────────────────

describe('composeCustomerTimeline', () => {
  test('filters + sorts newest-first', () => {
    const events: AmlTimelineEvent[] = [
      tlEvent({ event_id: 'a', occurred_at: '2026-05-10T09:00:00.000Z' }),
      tlEvent({ event_id: 'b', occurred_at: '2026-05-15T09:00:00.000Z' }),
      tlEvent({ event_id: 'c', customer_id: 'CUST-OTHER' }),
    ];
    const out = composeCustomerTimeline(events, 'CUST-100001');
    expect(out.map((e) => e.event_id)).toEqual(['b', 'a']);
  });

  test('limit cap applied', () => {
    const events: AmlTimelineEvent[] = Array.from({ length: 100 }, (_, i) => tlEvent({ event_id: `e${i}` }));
    const out = composeCustomerTimeline(events, 'CUST-100001', 10);
    expect(out).toHaveLength(10);
  });

  test('invalid customer_id throws', () => {
    expect(() => composeCustomerTimeline([], 'bad customer')).toThrow(/invalid_customer_id/);
  });

  test('limit out of range throws', () => {
    expect(() => composeCustomerTimeline([], 'CUST-A', 0)).toThrow(/invalid_input/);
    expect(() => composeCustomerTimeline([], 'CUST-A', 1000)).toThrow(/invalid_input/);
  });
});

// ── 7. Routes ────────────────────────────────────────────────────────

describe('GET /v1/aml/correlation/enums', () => {
  test('admin → 200', async () => {
    const app = makeAmlApp('admin');
    const r = await request(app).get('/v1/aml/correlation/enums').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.entity_kinds).toEqual([...ALL_AML_ENTITY_KINDS]);
    expect(r.body.body.relations).toEqual([...ALL_AML_LINK_RELATIONS]);
    expect(r.body.body.max_traversal_depth).toBe(AML_CORRELATION_MAX_TRAVERSAL_DEPTH);
  });

  test('case_owner → 403', async () => {
    const app = makeAmlApp('case_owner');
    const r = await request(app).get('/v1/aml/correlation/enums').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/aml/correlation/links', () => {
  test('happy → 201', async () => {
    const app = makeAmlApp('admin');
    const r = await request(app)
      .post('/v1/aml/correlation/links')
      .set(TH_BIL)
      .send(validLinkInput());
    expect(r.status).toBe(201);
    expect(r.body.body.relation).toBe('triggered_alert');
  });

  test('duplicate link → 409', async () => {
    const app = makeAmlApp('admin');
    await request(app).post('/v1/aml/correlation/links').set(TH_BIL).send(validLinkInput());
    const r2 = await request(app).post('/v1/aml/correlation/links').set(TH_BIL).send(validLinkInput());
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('EWS_409_duplicate_link');
  });

  test('self-link → 400', async () => {
    const app = makeAmlApp('admin');
    const r = await request(app)
      .post('/v1/aml/correlation/links')
      .set(TH_BIL)
      .send(
        validLinkInput({
          target_kind: 'aml_match',
          target_id: 'AML-2026-001',
        }),
      );
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_self_link');
  });

  test('case_owner → 403', async () => {
    const app = makeAmlApp('case_owner');
    const r = await request(app)
      .post('/v1/aml/correlation/links')
      .set(TH_BIL)
      .send(validLinkInput());
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/aml/correlation/links', () => {
  test('list happy + filter', async () => {
    const store = new InMemoryAmlCorrelationStore();
    const app = makeAmlApp('admin', { amlCorrelationStore: store });
    store.link('BIL', validLinkInput({ link_id: 'acl_a' }), 'admin', NOW);
    store.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_b',
        source_kind: 'ews_alert',
        source_id: 'ALERT-2',
        target_kind: 'case',
        target_id: 'CASE-2',
        relation: 'escalated_to_case',
      }),
      'admin',
      NOW,
    );
    const r = await request(app)
      .get('/v1/aml/correlation/links?relation=escalated_to_case')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('invalid filter → 400', async () => {
    const app = makeAmlApp('admin');
    const r = await request(app)
      .get('/v1/aml/correlation/links?source_kind=bogus')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_entity_kind');
  });

  test('cross-tenant invisibility', async () => {
    const store = new InMemoryAmlCorrelationStore();
    const app = makeAmlApp('admin', { amlCorrelationStore: store });
    store.link('BIL', validLinkInput(), 'admin', NOW);
    const r = await request(app).get('/v1/aml/correlation/links').set(TH_BANK);
    expect(r.body.body.total).toBe(0);
  });
});

describe('GET /v1/aml/correlation/entity/:kind/:id', () => {
  test('symmetric lookup', async () => {
    const store = new InMemoryAmlCorrelationStore();
    const app = makeAmlApp('admin', { amlCorrelationStore: store });
    store.link('BIL', validLinkInput({ link_id: 'acl_a' }), 'admin', NOW);
    // Looking up the TARGET entity still returns the link.
    const r = await request(app)
      .get('/v1/aml/correlation/entity/ews_alert/ALERT-2026-001')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('invalid kind → 400', async () => {
    const app = makeAmlApp('admin');
    const r = await request(app)
      .get('/v1/aml/correlation/entity/bogus/123')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });
});

describe('POST /v1/aml/correlation/traverse', () => {
  test('BFS reaches connected nodes', async () => {
    const store = new InMemoryAmlCorrelationStore();
    const app = makeAmlApp('admin', { amlCorrelationStore: store });
    store.link('BIL', validLinkInput({ link_id: 'acl_a' }), 'admin', NOW);
    store.link(
      'BIL',
      validLinkInput({
        link_id: 'acl_b',
        source_kind: 'ews_alert',
        source_id: 'ALERT-2026-001',
        target_kind: 'case',
        target_id: 'CASE-1',
        relation: 'escalated_to_case',
      }),
      'admin',
      NOW,
    );
    const r = await request(app)
      .post('/v1/aml/correlation/traverse')
      .set(TH_BIL)
      .send({ kind: 'aml_match', id: 'AML-2026-001', depth: 3 });
    expect(r.status).toBe(200);
    expect(r.body.body.nodes.length).toBeGreaterThanOrEqual(3);
  });

  test('invalid traversal → 400', async () => {
    const app = makeAmlApp('admin');
    const r = await request(app)
      .post('/v1/aml/correlation/traverse')
      .set(TH_BIL)
      .send({ kind: 'aml_match', id: 'AML-2026-001', depth: 99 });
    expect(r.status).toBe(400);
  });
});

describe('POST /v1/aml/correlation/timeline', () => {
  test('composes per-customer timeline', async () => {
    const app = makeAmlApp('admin');
    const r = await request(app)
      .post('/v1/aml/correlation/timeline')
      .set(TH_BIL)
      .send({
        customer_id: 'CUST-100001',
        events: [
          tlEvent({ event_id: 'a', occurred_at: '2026-05-10T09:00:00.000Z' }),
          tlEvent({ event_id: 'b', occurred_at: '2026-05-15T09:00:00.000Z' }),
        ],
        limit: 10,
      });
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.items[0].event_id).toBe('b');
  });

  test('invalid customer_id → 400', async () => {
    const app = makeAmlApp('admin');
    const r = await request(app)
      .post('/v1/aml/correlation/timeline')
      .set(TH_BIL)
      .send({ customer_id: 'bad customer', events: [] });
    expect(r.status).toBe(400);
  });
});

describe('GET /v1/aml/correlation/summary', () => {
  test('admin → rollup', async () => {
    const store = new InMemoryAmlCorrelationStore();
    const app = makeAmlApp('admin', { amlCorrelationStore: store });
    store.link('BIL', validLinkInput(), 'admin', NOW);
    const r = await request(app).get('/v1/aml/correlation/summary').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_links).toBe(1);
  });
});

describe('GET / DELETE link by id', () => {
  test('GET single 200 + 404', async () => {
    const store = new InMemoryAmlCorrelationStore();
    const app = makeAmlApp('admin', { amlCorrelationStore: store });
    const l = store.link('BIL', validLinkInput(), 'admin', NOW);
    const ok = await request(app).get(`/v1/aml/correlation/links/${l.link_id}`).set(TH_BIL);
    expect(ok.status).toBe(200);
    const miss = await request(app).get('/v1/aml/correlation/links/acl_nope').set(TH_BIL);
    expect(miss.status).toBe(404);
  });

  test('DELETE 204 + 404', async () => {
    const store = new InMemoryAmlCorrelationStore();
    const app = makeAmlApp('admin', { amlCorrelationStore: store });
    const l = store.link('BIL', validLinkInput(), 'admin', NOW);
    const r = await request(app).delete(`/v1/aml/correlation/links/${l.link_id}`).set(TH_BIL);
    expect(r.status).toBe(204);
    expect(store.get('BIL', l.link_id)).toBeNull();
    const r2 = await request(app).delete('/v1/aml/correlation/links/acl_nope').set(TH_BIL);
    expect(r2.status).toBe(404);
  });
});
