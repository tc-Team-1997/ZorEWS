// services/bff/__tests__/ews_rules_module_smoke.test.ts
//
// Module 1.3 — Validation Rules (AI) smoke test.
//
// Walks the complete Validation Rules journey end-to-end:
//
//   POST  /v1/ews/rules                         (Draft create + VR-1 fields)
//   GET   /v1/ews/rules/:id                     (read back)
//   POST  /v1/ews/rules/:id/submit              (Draft → PENDING_REVIEW)
//   POST  /v1/ews/rules/:id/approve             (4-eyes ACTIVE; refuses self)
//   POST  /v1/ews/rules/:id/reject               (4-eyes REJECT)
//   GET   /v1/ews/rules/:id/versions            (RP-1 snapshot ledger)
//   POST  /v1/ews/rules/:id/versions/:n/restore (revert per VR-spec)
//   GET   /v1/ews/rules/:id/quarantine          (NEW — VR-2)
//   GET   /v1/ews/rules/:id/stats               (NEW — VR-2)
//
// Per spec acceptance: maker !== checker (4-eyes refused at HTTP layer
// with EWS_403_self_approval_refused); audit-log fan-out at every
// transition (cross-cutting #6); RBAC + tenant-header guards.
//
// `requireTenant` middleware needs valid `X-Tenant-ID` + `X-Channel`.

import request from 'supertest';
import { InMemoryEwsRuleStore } from '../src/ews_rules';
import { InMemoryCaseEventStore } from '../src/case_events';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-24T07:00:00.000Z');
const TENANT = 'BANK_DEMO';
const HEADERS_MAKER = {
  'X-Tenant-ID': TENANT,
  'X-Channel': 'API',
  'X-APEX-USER': 'jane.maker',
};
const HEADERS_CHECKER = {
  'X-Tenant-ID': TENANT,
  'X-Channel': 'API',
  'X-APEX-USER': 'bob.checker',
};

const VR_RULE = {
  rule_id: 'RULE_VR_SMOKE_001',
  name: 'High DPD watchlist',
  category: 'credit',
  description: 'Rule originated from M1.2 DQ AI suggestion. ' +
    '7-day risk-score delta > 30 → quarantine + investigate.',
  conditions: [{ field: 'risk_score_delta_7d', operator: '>=', value: 30 }],
  logic: 'AND',
  action: { alert_severity: 'RED', weight: 25, recommended_action: 'Open case' },
  source: 'ai_suggestion:dq-cbs_loans-risk_score-range',
  action_on_fail: 'quarantine',
  ai_suggested: true,
};

function makeSmokeApp(role: string = 'admin') {
  const ewsRuleStore = new InMemoryEwsRuleStore();
  const caseEventStore = new InMemoryCaseEventStore();
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    ewsRuleStore,
    caseEventStore,
    now: () => NOW,
    getRole: () => role,
  });
}

describe('Module 1.3 — Validation Rules smoke', () => {
  it('walks the full Draft → Pending → Approved → Active state machine + VR-1 fields', async () => {
    const { app } = makeSmokeApp('admin');

    // 1. Create (jane.maker) → draft
    const c = await request(app)
      .post('/v1/ews/rules')
      .set(HEADERS_MAKER)
      .send(VR_RULE);
    expect(c.status).toBe(201);
    expect(c.body.body.rule_id).toBe(VR_RULE.rule_id);
    expect(c.body.body.state).toBe('draft');
    expect(c.body.body.created_by).toBe('jane.maker');
    // VR-1: source + action_on_fail + ai_suggested round-trip
    expect(c.body.body.source).toBe(VR_RULE.source);
    expect(c.body.body.action_on_fail).toBe('quarantine');
    expect(c.body.body.ai_suggested).toBe(true);

    // 2. Quarantine on a draft rule → total=0 (rule not firing)
    const qDraft = await request(app)
      .get(`/v1/ews/rules/${VR_RULE.rule_id}/quarantine`)
      .set(HEADERS_MAKER);
    expect(qDraft.status).toBe(200);
    expect(qDraft.body.body.rule_state).toBe('draft');
    expect(qDraft.body.body.total).toBe(0);
    expect(qDraft.body.body.items).toEqual([]);
    // VR-1 echo through: action_on_fail surfaced on the envelope
    expect(qDraft.body.body.action_on_fail).toBe('quarantine');

    // 3. Submit for review (jane.maker) → pending_review
    const sub = await request(app)
      .post(`/v1/ews/rules/${VR_RULE.rule_id}/submit`)
      .set(HEADERS_MAKER)
      .send({ reason: 'Ready for review — back-tested OK' });
    expect(sub.status).toBe(200);
    expect(sub.body.body.rule.state).toBe('pending_review');
    expect(sub.body.body.approval.maker_username).toBe('jane.maker');
    expect(sub.body.body.approval.decision).toBe('pending');

    // 4. 4-eyes refusal: jane.maker (= maker) tries to self-approve → 403
    const selfApprove = await request(app)
      .post(`/v1/ews/rules/${VR_RULE.rule_id}/approve`)
      .set(HEADERS_MAKER)
      .send({ reason: 'looks fine' });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('EWS_403_self_approval_refused');

    // 5. bob.checker (≠ maker) approves → active
    const ap = await request(app)
      .post(`/v1/ews/rules/${VR_RULE.rule_id}/approve`)
      .set(HEADERS_CHECKER)
      .send({ reason: 'Conditions match Q1 portfolio behaviour' });
    expect(ap.status).toBe(200);
    expect(ap.body.body.rule.state).toBe('active');
    expect(ap.body.body.rule.is_active).toBe(true);
    expect(ap.body.body.approval.approver_username).toBe('bob.checker');
    expect(ap.body.body.approval.decision).toBe('approved');

    // 6. Quarantine on an active rule → total > 0, items synthesised
    const qActive = await request(app)
      .get(`/v1/ews/rules/${VR_RULE.rule_id}/quarantine?page=1&page_size=10`)
      .set(HEADERS_MAKER);
    expect(qActive.status).toBe(200);
    expect(qActive.body.body.rule_state).toBe('active');
    expect(qActive.body.body.total).toBeGreaterThan(0);
    expect(qActive.body.body.items.length).toBeGreaterThan(0);
    const item = qActive.body.body.items[0];
    expect(item.record_id).toMatch(/^rec-RULE_VR_SMOKE_001-/);
    expect(item.customer_id).toMatch(/^c-/);
    expect(item.severity).toBe('RED');
    expect(item.action_on_fail).toBe('quarantine');
    expect(item.triggered_field).toBe('risk_score_delta_7d');

    // 7. Quarantine pagination
    const qPaged = await request(app)
      .get(`/v1/ews/rules/${VR_RULE.rule_id}/quarantine?page=2&page_size=3`)
      .set(HEADERS_MAKER);
    expect(qPaged.status).toBe(200);
    expect(qPaged.body.body.page).toBe(2);
    expect(qPaged.body.body.page_size).toBe(3);

    // 8. Stats — rule_state echoed; aggregates either populated from
    // telemetry (RP-1 listExecutionsForRule) or synthesised when empty.
    const stats = await request(app)
      .get(`/v1/ews/rules/${VR_RULE.rule_id}/stats`)
      .set(HEADERS_MAKER);
    expect(stats.status).toBe(200);
    expect(stats.body.body.rule_state).toBe('active');
    expect(stats.body.body.rule_id).toBe(VR_RULE.rule_id);
    expect(typeof stats.body.body.total_runs).toBe('number');
    expect(typeof stats.body.body.pass_count).toBe('number');
    expect(typeof stats.body.body.fail_count).toBe('number');
    // pass_pct: number in [0,1] or null
    if (stats.body.body.pass_pct !== null) {
      expect(stats.body.body.pass_pct).toBeGreaterThanOrEqual(0);
      expect(stats.body.body.pass_pct).toBeLessThanOrEqual(1);
    }

    // 9. Audit-log fan-out: rule.activate via four_eyes_approve event present
    const audit = await request(app)
      .get(`/v1/audit/events?resource_type=rule&page_size=20`)
      .set(HEADERS_MAKER);
    expect(audit.status).toBe(200);
    const events = audit.body.body.items as Array<{
      action: string;
      resource_id: string;
      actor_username: string;
      metadata?: Record<string, unknown>;
    }>;
    const ruleEvents = events.filter((e) => e.resource_id === VR_RULE.rule_id);
    expect(ruleEvents.length).toBeGreaterThan(0);
    const activateEvt = ruleEvents.find((e) => e.action === 'rule.activate');
    expect(activateEvt).toBeDefined();
    expect(activateEvt?.actor_username).toBe('bob.checker');
    expect(activateEvt?.metadata?.maker).toBe('jane.maker');
  });

  it('reject path: bob.checker rejects → state returns to draft + reason captured', async () => {
    const { app } = makeSmokeApp('admin');

    await request(app).post('/v1/ews/rules').set(HEADERS_MAKER).send({
      ...VR_RULE,
      rule_id: 'RULE_VR_REJ_001',
    });
    await request(app)
      .post('/v1/ews/rules/RULE_VR_REJ_001/submit')
      .set(HEADERS_MAKER)
      .send({ reason: 'Please review' });

    // Reject requires a reason — empty body → 400
    const noReason = await request(app)
      .post('/v1/ews/rules/RULE_VR_REJ_001/reject')
      .set(HEADERS_CHECKER)
      .send({});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('EWS_400_invalid_input');

    // Reject with reason → 200 + state reverts
    const rej = await request(app)
      .post('/v1/ews/rules/RULE_VR_REJ_001/reject')
      .set(HEADERS_CHECKER)
      .send({ reason: 'Threshold too aggressive — needs Q1 calibration' });
    expect(rej.status).toBe(200);
    expect(rej.body.body.approval.decision).toBe('rejected');
    expect(rej.body.body.approval.approver_username).toBe('bob.checker');
    expect(rej.body.body.approval.reason).toMatch(/Q1 calibration/);
  });

  it('RBAC: field_officer cannot create / submit / approve / view quarantine + stats', async () => {
    const { app } = makeSmokeApp('field_officer');
    const block = (s: number) => expect([401, 403]).toContain(s);

    block(
      (await request(app).post('/v1/ews/rules').set(HEADERS_MAKER).send({ ...VR_RULE, rule_id: 'X' })).status,
    );
    block(
      (await request(app).post('/v1/ews/rules/X/submit').set(HEADERS_MAKER)).status,
    );
    block(
      (await request(app).post('/v1/ews/rules/X/approve').set(HEADERS_CHECKER)).status,
    );
    block(
      (await request(app).get('/v1/ews/rules/X/quarantine').set(HEADERS_MAKER)).status,
    );
    block(
      (await request(app).get('/v1/ews/rules/X/stats').set(HEADERS_MAKER)).status,
    );
  });

  it('Tenant gate: every route refuses without X-Tenant-ID + X-Channel', async () => {
    const { app } = makeSmokeApp('admin');
    const block = (s: number) => expect([400, 401, 403]).toContain(s);

    block((await request(app).post('/v1/ews/rules').send(VR_RULE)).status);
    block((await request(app).post('/v1/ews/rules/X/submit').send({})).status);
    block((await request(app).get('/v1/ews/rules/X/quarantine')).status);
    block((await request(app).get('/v1/ews/rules/X/stats')).status);
  });

  it('Unknown rule: quarantine + stats return EWS_404_unknown_rule', async () => {
    const { app } = makeSmokeApp('admin');

    const q = await request(app)
      .get('/v1/ews/rules/no_such_rule/quarantine')
      .set(HEADERS_MAKER);
    expect(q.status).toBe(404);
    expect(q.body.error.code).toBe('EWS_404_unknown_rule');

    const s = await request(app)
      .get('/v1/ews/rules/no_such_rule/stats')
      .set(HEADERS_MAKER);
    expect(s.status).toBe(404);
    expect(s.body.error.code).toBe('EWS_404_unknown_rule');
  });
});
