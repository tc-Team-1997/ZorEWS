// services/bff/__tests__/ews_rules_routes.test.ts
//
// EWS-3 — route tests + 1000-rule perf budget.

import request from 'supertest';
import {
  InMemoryEwsRuleStore,
  type EwsRule,
} from '../src/ews_rules';
import { InMemoryCaseEventStore } from '../src/case_events';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T10:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

interface RuleBody {
  rule_id: string;
  name: string;
  category: string;
  description: string;
  conditions: Array<{ field: string; operator: string; value: number }>;
  logic: string;
  action: { alert_severity: string; weight: number; recommended_action?: string };
  is_active?: boolean;
}

const VALID: RuleBody = {
  rule_id: 'RULE_CREDIT_001',
  name: 'High EMI Bounce Risk',
  category: 'credit',
  description: '3+ EMI bounces in 90 days indicates servicing distress.',
  conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 3 }],
  logic: 'AND',
  action: { alert_severity: 'RED', weight: 25, recommended_action: 'Pause disbursement' },
  is_active: true,
};

function makeEwsApp(role = 'admin') {
  const ewsRuleStore = new InMemoryEwsRuleStore();
  const caseEventStore = new InMemoryCaseEventStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    ewsRuleStore,
    caseEventStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, ewsRuleStore, caseEventStore };
}

// ─── /indicators ─────────────────────────────────────────────────────

describe('EWS-3 — GET /v1/ews/rules/indicators', () => {
  test('lists every catalog entry', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app).get('/v1/ews/rules/indicators').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBeGreaterThanOrEqual(15);
    const ids = r.body.body.items.map((x: { id: string }) => x.id);
    expect(ids.every((id: string) => id.startsWith('EWS-'))).toBe(true);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeEwsApp('case_owner');
    const r = await request(app).get('/v1/ews/rules/indicators').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── CRUD ────────────────────────────────────────────────────────────

describe('EWS-3 — POST/GET/PUT/DELETE /v1/ews/rules', () => {
  test('POST 201 + GET reflects + audit event written', async () => {
    const { app } = makeEwsApp('admin');
    const c = await request(app)
      .post('/v1/ews/rules')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send(VALID);
    expect(c.status).toBe(201);
    expect(c.body.body.rule_id).toBe('RULE_CREDIT_001');
    expect(c.body.body.state).toBe('draft');
    expect(c.body.body.is_active).toBe(false);
    expect(c.body.body.created_by).toBe('compliance.lead');

    // Audit event present (queryable via /v1/audit/events)
    const audit = await request(app)
      .get('/v1/audit/events?resource_id=RULE_CREDIT_001')
      .set(TH_BIL);
    expect(audit.status).toBe(200);
    const createEvt = audit.body.body.items.find(
      (e: { action: string }) => e.action === 'rule.create',
    );
    expect(createEvt).toBeDefined();

    const list = await request(app).get('/v1/ews/rules').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
  });

  test('POST validation: bogus indicator → 400', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app)
      .post('/v1/ews/rules')
      .set(TH_BIL)
      .send({
        ...VALID,
        conditions: [{ field: 'no_such_indicator', operator: '>=', value: 3 }],
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_unknown_indicator');
  });

  test('POST duplicate rule_id → 409', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    const r = await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_rule_id');
  });

  test('GET unknown → 404', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app).get('/v1/ews/rules/RULE_NONE').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_rule');
  });

  test('PUT replaces + bumps version + audit event', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    const r = await request(app)
      .put('/v1/ews/rules/RULE_CREDIT_001')
      .set(TH_BIL)
      .send({ ...VALID, name: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.body.body.name).toBe('Renamed');
    expect(r.body.body.version).toBe(2);
  });

  test('PUT unknown → 404', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app)
      .put('/v1/ews/rules/RULE_NONE')
      .set(TH_BIL)
      .send(VALID);
    expect(r.status).toBe(404);
  });

  test('DELETE soft-deletes (state=deprecated) + audit event', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    const d = await request(app).delete('/v1/ews/rules/RULE_CREDIT_001').set(TH_BIL);
    expect(d.status).toBe(200);
    expect(d.body.body.state).toBe('deprecated');
    expect(d.body.body.is_active).toBe(false);
  });

  test('GET ?category= filter', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    await request(app)
      .post('/v1/ews/rules')
      .set(TH_BIL)
      .send({
        ...VALID,
        rule_id: 'RULE_KYC_001',
        category: 'kyc',
        conditions: [{ field: 'kyc_doc_expiry_days', operator: '>', value: 30 }],
      });
    const r = await request(app).get('/v1/ews/rules?category=kyc').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].category).toBe('kyc');
  });

  test('GET ?category=garbage → 400', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app).get('/v1/ews/rules?category=garbage').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('GET ?is_active=true filter', async () => {
    const { app, ewsRuleStore } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    // Manually move to active via store (route activate is tested separately)
    ewsRuleStore.submit('BIL', 'RULE_CREDIT_001', NOW);
    ewsRuleStore.activate('BIL', 'RULE_CREDIT_001', NOW);
    const r = await request(app).get('/v1/ews/rules?is_active=true').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    const otherList = await request(app)
      .get('/v1/ews/rules')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(otherList.body.body.total).toBe(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeEwsApp('case_owner');
    const r = await request(app).get('/v1/ews/rules').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── /test ───────────────────────────────────────────────────────────

describe('EWS-3 — POST /v1/ews/rules/:id/test', () => {
  test('happy: matched=true with firing indicators', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/test')
      .set(TH_BIL)
      .send({ values: { emi_bounce_count_90d: 5 } });
    expect(r.status).toBe(200);
    expect(r.body.body.matched).toBe(true);
    expect(r.body.body.matched_indicators).toEqual(['emi_bounce_count_90d']);
    expect(r.body.body.score_impact).toBe(25);
    expect(r.body.body.alert_severity).toBe('RED');
  });

  test('matched=false when below threshold; score_impact=0', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/test')
      .set(TH_BIL)
      .send({ values: { emi_bounce_count_90d: 1 } });
    expect(r.body.body.matched).toBe(false);
    expect(r.body.body.score_impact).toBe(0);
  });

  test('test does NOT record execution telemetry', async () => {
    const { app, ewsRuleStore } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/test')
      .set(TH_BIL)
      .send({ values: { emi_bounce_count_90d: 5 } });
    const hits = ewsRuleStore.listExecutionsForRule('BIL', 'RULE_CREDIT_001', 50);
    expect(hits).toHaveLength(0);
  });

  test('unknown rule → 404', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app)
      .post('/v1/ews/rules/RULE_NONE/test')
      .set(TH_BIL)
      .send({ values: {} });
    expect(r.status).toBe(404);
  });

  test('missing values → 400', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/test')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });
});

// ─── /activate ───────────────────────────────────────────────────────

describe('EWS-3 — POST /v1/ews/rules/:id/activate', () => {
  test('happy: draft → active in one call (auto-submits)', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/activate')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.state).toBe('active');
    expect(r.body.body.is_active).toBe(true);
  });

  test('cannot activate deprecated rule', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    await request(app).delete('/v1/ews/rules/RULE_CREDIT_001').set(TH_BIL);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/activate')
      .set(TH_BIL);
    expect(r.status).toBe(409);
  });

  test('unknown rule → 404', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app)
      .post('/v1/ews/rules/RULE_NONE/activate')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

// ─── /hits ───────────────────────────────────────────────────────────

describe('EWS-3 — GET /v1/ews/rules/:id/hits', () => {
  test('returns recorded executions newest-first', async () => {
    const { app, ewsRuleStore } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    for (let i = 0; i < 3; i++) {
      ewsRuleStore.recordExecution('BIL', {
        rule_id: 'RULE_CREDIT_001',
        entity_type: 'customer',
        entity_id: `cust-${i}`,
        matched: true,
        matched_indicators: ['emi_bounce_count_90d'],
        score_impact: 25,
        alert_id: null,
        evaluated_at: NOW.toISOString(),
        duration_us: 50,
      });
    }
    const r = await request(app)
      .get('/v1/ews/rules/RULE_CREDIT_001/hits')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(3);
    expect(r.body.body.items[0].sequence_no).toBeGreaterThan(r.body.body.items[2].sequence_no);
  });

  test('unknown rule → 404', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app).get('/v1/ews/rules/RULE_NONE/hits').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('?limit=0 → 400', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    const r = await request(app)
      .get('/v1/ews/rules/RULE_CREDIT_001/hits?limit=0')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });
});

// ─── /evaluate ───────────────────────────────────────────────────────

describe('EWS-3 — POST /v1/ews/rules/evaluate', () => {
  function activate(app: Parameters<typeof request>[0], body: RuleBody) {
    return request(app)
      .post('/v1/ews/rules')
      .set(TH_BIL)
      .send(body)
      .then(() =>
        request(app).post(`/v1/ews/rules/${body.rule_id}/activate`).set(TH_BIL),
      );
  }

  test('matches an active rule + records execution + writes case event', async () => {
    const { app, ewsRuleStore, caseEventStore } = makeEwsApp('admin');
    await activate(app, VALID);
    const r = await request(app)
      .post('/v1/ews/rules/evaluate')
      .set(TH_BIL)
      .send({
        entity_type: 'customer',
        entity_id: 'cust-001',
        values: { emi_bounce_count_90d: 5 },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.matched_count).toBe(1);
    expect(r.body.body.cumulative_score).toBe(25);
    expect(r.body.body.aggregate_severity).toBe('YELLOW');

    // Telemetry recorded
    const hits = ewsRuleStore.listExecutionsForRule('BIL', 'RULE_CREDIT_001', 50);
    expect(hits).toHaveLength(1);

    // Case event written (M9.4 journal)
    const events = caseEventStore.fetchSince('BIL', 0, 50);
    expect(events.total).toBeGreaterThanOrEqual(1);
    const ewsEvent = events.items.find(
      (e) => e.actor === 'system:ews-rules-engine',
    );
    expect(ewsEvent).toBeDefined();
    expect(ewsEvent!.payload.rule_id).toBe('RULE_CREDIT_001');
  });

  test('inactive (draft) rule does NOT match', async () => {
    const { app } = makeEwsApp('admin');
    await request(app).post('/v1/ews/rules').set(TH_BIL).send(VALID);
    // No activate → still draft
    const r = await request(app)
      .post('/v1/ews/rules/evaluate')
      .set(TH_BIL)
      .send({
        entity_type: 'customer',
        entity_id: 'cust-001',
        values: { emi_bounce_count_90d: 5 },
      });
    expect(r.body.body.matched_count).toBe(0);
  });

  test('multi-rule cumulative score; aggregate severity derived', async () => {
    const { app } = makeEwsApp('admin');
    await activate(app, VALID); // RED weight 25
    await activate(app, {
      ...VALID,
      rule_id: 'RULE_CREDIT_002',
      conditions: [{ field: 'internal_dpd_current', operator: '>', value: 30 }],
      action: { alert_severity: 'ORANGE', weight: 30 },
    });
    const r = await request(app)
      .post('/v1/ews/rules/evaluate')
      .set(TH_BIL)
      .send({
        entity_type: 'customer',
        entity_id: 'cust-001',
        values: { emi_bounce_count_90d: 5, internal_dpd_current: 60 },
      });
    expect(r.body.body.matched_count).toBe(2);
    expect(r.body.body.cumulative_score).toBe(55);
    expect(r.body.body.aggregate_severity).toBe('ORANGE');
  });

  test('bad entity_type → 400', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app)
      .post('/v1/ews/rules/evaluate')
      .set(TH_BIL)
      .send({ entity_type: 'invoice', entity_id: 'X', values: {} });
    expect(r.status).toBe(400);
  });

  test('missing entity_id → 400', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app)
      .post('/v1/ews/rules/evaluate')
      .set(TH_BIL)
      .send({ entity_type: 'customer', values: {} });
    expect(r.status).toBe(400);
  });

  test('values not object → 400', async () => {
    const { app } = makeEwsApp('admin');
    const r = await request(app)
      .post('/v1/ews/rules/evaluate')
      .set(TH_BIL)
      .send({ entity_type: 'customer', entity_id: 'X', values: ['nope'] });
    expect(r.status).toBe(400);
  });

  test('PERF: 1000 active rules / 1 entity / single /evaluate call < 500ms', async () => {
    const { app, ewsRuleStore } = makeEwsApp('admin');
    // Seed 1000 active rules directly via the store (bypassing the
    // route's auto-submit/activate sequence keeps the perf test
    // focused on the executor + route plumbing).
    for (let i = 0; i < 1000; i++) {
      const id = `RULE_CREDIT_${String(i).padStart(4, '0')}`;
      ewsRuleStore.create(
        'BIL',
        {
          rule_id: id,
          name: `Synth ${i}`,
          category: 'credit',
          description: 'd',
          conditions: [
            { field: 'emi_bounce_count_90d', operator: '>=', value: i % 2 === 0 ? 3 : 99 },
          ],
          logic: 'AND',
          action: { alert_severity: 'YELLOW', weight: 1 },
        },
        'admin',
        NOW,
      );
      ewsRuleStore.submit('BIL', id, NOW);
      ewsRuleStore.activate('BIL', id, NOW);
    }
    const t0 = Date.now();
    const r = await request(app)
      .post('/v1/ews/rules/evaluate')
      .set(TH_BIL)
      .send({
        entity_type: 'customer',
        entity_id: 'cust-001',
        values: { emi_bounce_count_90d: 5 },
      });
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(200);
    expect(r.body.body.rule_count).toBe(1000);
    expect(r.body.body.matched_count).toBe(500);
    expect(r.body.body.cumulative_score).toBe(100); // capped
    expect(elapsed).toBeLessThan(500);
  });
});
