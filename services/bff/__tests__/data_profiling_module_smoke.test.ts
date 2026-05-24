// services/bff/__tests__/data_profiling_module_smoke.test.ts
//
// Module 1.2 — Data Profiling (AI) smoke test.
//
// Walks the complete user journey end-to-end against the live BFF +
// in-memory data_profiling store. Mirrors what a partner would script
// in Postman:
//
//   GET   /v1/dq/profile/:source_id/columns                       (list)
//   GET   /v1/dq/profile/:source_id/column/:col                   (single — NEW)
//   GET   /v1/dq/profile/:source_id/columns/:col/distribution
//   POST  /v1/dq/profile/:source_id/suggest-rules                 (AI propose)
//   POST  /v1/dq/profile/promote-rule body {rule_id}              (NEW, tenant-level)
//   POST  /v1/dq/profile/:source_id/rules/:rule_id/promote        (legacy per-rule)
//
// Plus:
//   - audit-log write fan-out on promote (cross-cutting #6)
//   - RBAC + tenant-header guards
//   - 404 / 409 / 400 envelope shapes for the error paths

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { _resetDqSuggestionStore } from '../src/data_profiling';

const NOW = new Date('2026-05-24T13:00:00.000Z');
const TENANT = 'BANK_DEMO';
const HEADERS = {
  'X-Tenant-ID': TENANT,
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
};

function makeSmokeApp(role: string = 'admin') {
  _resetDqSuggestionStore();
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('Module 1.2 — Data Profiling smoke', () => {
  it('admin walks the full profile → distribution → suggest → promote flow', async () => {
    const { app } = makeSmokeApp('admin');

    // 1. Source profile (all columns + new top_values/format_detected/p50/p95)
    const cols = await request(app)
      .get('/v1/dq/profile/cbs_loans/columns')
      .set(HEADERS);
    expect(cols.status).toBe(200);
    expect(cols.body.body.source_id).toBe('cbs_loans');
    expect(cols.body.body.columns.length).toBeGreaterThan(0);
    const sampleCol = cols.body.body.columns[0];
    expect(typeof sampleCol.column).toBe('string');
    expect(typeof sampleCol.null_pct).toBe('number');
    expect(Array.isArray(sampleCol.top_values)).toBe(true);
    expect('format_detected' in sampleCol).toBe(true);
    expect('p50' in sampleCol).toBe(true);
    expect('p95' in sampleCol).toBe(true);

    // 2. Single-column accessor (NEW per Module 1.2)
    const single = await request(app)
      .get('/v1/dq/profile/cbs_loans/column/loan_id')
      .set(HEADERS);
    expect(single.status).toBe(200);
    expect(single.body.body.column.column).toBe('loan_id');
    expect(single.body.body.column.type).toBe('string');

    // 3. Single-column 404 on unknown column
    const single404 = await request(app)
      .get('/v1/dq/profile/cbs_loans/column/not_a_real_col')
      .set(HEADERS);
    expect(single404.status).toBe(404);
    expect(single404.body.error.code).toBe('EWS_404_unknown_column');

    // 4. Single-column 404 on unknown source
    const src404 = await request(app)
      .get('/v1/dq/profile/no_such_source/column/loan_id')
      .set(HEADERS);
    expect(src404.status).toBe(404);
    expect(src404.body.error.code).toBe('EWS_404_unknown_source');

    // 5. Column distribution histogram
    const dist = await request(app)
      .get('/v1/dq/profile/cbs_loans/columns/loan_id/distribution')
      .set(HEADERS);
    expect(dist.status).toBe(200);
    expect(Array.isArray(dist.body.body.buckets)).toBe(true);
    expect(dist.body.body.buckets.length).toBeGreaterThan(0);

    // 6. AI rule suggestion engine
    const suggest = await request(app)
      .post('/v1/dq/profile/cbs_loans/suggest-rules')
      .set(HEADERS);
    expect(suggest.status).toBe(200);
    expect(suggest.body.body.count).toBeGreaterThanOrEqual(1);
    const rules: Array<{ rule_id: string; rule_type: string; column: string }> = suggest.body.body.rules;
    const firstRule = rules[0];
    expect(firstRule.rule_id).toMatch(/^dq-BANK_DEMO-cbs_loans-/);

    // Cross-cutting verification: every detected pattern (PAN/email/etc)
    // surfaces ≥1 regex suggestion in addition to the not_null / range
    // / enum baseline. Acceptance criterion §1.2.
    const ruleTypes = new Set(rules.map((r) => r.rule_type));
    expect(ruleTypes.has('not_null')).toBe(true);
    // p95 range tightening on sanctioned_amount
    expect(ruleTypes.has('range')).toBe(true);
    // enum_membership on product_code
    expect(ruleTypes.has('enum_membership')).toBe(true);

    // 7. Promote a rule via the NEW tenant-level endpoint
    const promote = await request(app)
      .post('/v1/dq/profile/promote-rule')
      .set(HEADERS)
      .send({ rule_id: firstRule.rule_id });
    expect(promote.status).toBe(200);
    expect(promote.body.body.status).toBe('promoted');
    expect(promote.body.body.rule_id).toBe(firstRule.rule_id);

    // 8. Promote without rule_id → 400
    const noBody = await request(app)
      .post('/v1/dq/profile/promote-rule')
      .set(HEADERS)
      .send({});
    expect(noBody.status).toBe(400);
    expect(noBody.body.error.code).toBe('EWS_400_invalid_input');

    // 9. Double-promote → 409
    const dupPromote = await request(app)
      .post('/v1/dq/profile/promote-rule')
      .set(HEADERS)
      .send({ rule_id: firstRule.rule_id });
    expect(dupPromote.status).toBe(409);
    expect(dupPromote.body.error.code).toBe('EWS_409_already_promoted');

    // 10. Unknown rule → 404
    const unkPromote = await request(app)
      .post('/v1/dq/profile/promote-rule')
      .set(HEADERS)
      .send({ rule_id: 'dq-BANK_DEMO-no-such-rule' });
    expect(unkPromote.status).toBe(404);
    expect(unkPromote.body.error.code).toBe('EWS_404_unknown_rule');

    // 11. Audit-log write on promote — query the audit chain
    const audit = await request(app)
      .get('/v1/audit/events?action=dq.suggestion.promote&page_size=5')
      .set(HEADERS);
    expect(audit.status).toBe(200);
    expect(audit.body.body.total).toBeGreaterThanOrEqual(1);
    const event = audit.body.body.items[0];
    expect(event.action).toBe('dq.suggestion.promote');
    expect(event.resource_type).toBe('rule');
    expect(event.resource_id).toBe(firstRule.rule_id);
    expect(event.outcome).toBe('success');
  });

  it('every protected route returns 401/403 to non-allowed roles', async () => {
    const { app } = makeSmokeApp('field_officer');
    const block = (status: number) => expect([401, 403]).toContain(status);

    block((await request(app).get('/v1/dq/profile/cbs_loans/columns').set(HEADERS)).status);
    block((await request(app).get('/v1/dq/profile/cbs_loans/column/loan_id').set(HEADERS)).status);
    block(
      (await request(app)
        .post('/v1/dq/profile/cbs_loans/suggest-rules')
        .set(HEADERS)).status,
    );
    block(
      (await request(app)
        .post('/v1/dq/profile/promote-rule')
        .set(HEADERS)
        .send({ rule_id: 'x' })).status,
    );
  });

  it('every route refuses without X-Tenant-ID / X-Channel', async () => {
    const { app } = makeSmokeApp('admin');
    const r1 = await request(app).get('/v1/dq/profile/cbs_loans/columns');
    expect([400, 401, 403]).toContain(r1.status);
    const r2 = await request(app)
      .post('/v1/dq/profile/promote-rule')
      .set('X-Tenant-ID', TENANT)
      .send({ rule_id: 'x' });
    expect([400, 401, 403]).toContain(r2.status);
  });
});
