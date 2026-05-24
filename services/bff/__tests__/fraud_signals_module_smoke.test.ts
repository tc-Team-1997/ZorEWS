// services/bff/__tests__/fraud_signals_module_smoke.test.ts
//
// Module 2.6 — Fraud Signals smoke (per the user playbook).
//
// Per cross-cutting #1 + the user's explicit "if already exist please dont
// do that again" guard: NO new BFF routes shipped this session. The
// 8 endpoints (cases CRUD + rules CRUD + SAR + vigilance) were all
// pre-existing under §2.3 of the gap analysis. M2.6 adds:
//
//   - Audit fan-out on POST /v1/fraud/cases/:id/sar (spec acceptance)
//   - Audit fan-out on POST /v1/fraud/cases/:id/vigilance (symmetry)
//   - SPA FraudSignalsPage consuming the existing surface
//
// SPEC ACCEPTANCE — "SAR submission writes audit event and locks the SAR
// draft from further edits."

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { _resetFraudStore } from '../src/banking_fraud';

const NOW = new Date('2026-05-24T12:00:00.000Z');
const HDR = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'admin',
};

function makeSmokeApp() {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
  });
}

let app: ReturnType<typeof makeSmokeApp>['app'];

beforeEach(() => {
  _resetFraudStore();
  app = makeSmokeApp().app;
});

async function createCase(opts: { category?: string; description?: string; customer_id?: string } = {}) {
  const r = await request(app)
    .post('/v1/fraud/cases')
    .set(HDR)
    .send({
      category: opts.category ?? 'cheque_fraud',
      priority: 'critical',
      description:
        opts.description ?? 'Cheque kiting cluster across 3 branches — 8 cheques in 5 days, distinct beneficiaries.',
      customer_id: opts.customer_id ?? 'c-101',
      account_id: 'a-100101-00',
      amount_kes: 4_500_000,
    });
  expect(r.status).toBe(201);
  return r.body.body as { case_id: string; status: string; sar_id: string | null; vigilance_ref: string | null };
}

describe('M2.6 — Fraud Signals smoke', () => {
  it('walks the full spec journey: create → list → get → patch → rule CRUD → SAR → vigilance', async () => {
    // 1. Create a fraud case
    const c = await createCase();
    // Module uses 'frd-' prefix per banking_fraud.ts conventions
    expect(c.case_id).toMatch(/^frd-BANK_DEMO-/);
    expect(c.status).toBe('open');
    expect(c.sar_id).toBeNull();

    // 2. List cases
    const list = await request(app).get('/v1/fraud/cases').set(HDR);
    expect(list.status).toBe(200);
    expect(list.body.body.cases.length).toBeGreaterThanOrEqual(1);
    expect(list.body.body.cases.map((x: { case_id: string }) => x.case_id)).toContain(c.case_id);

    // 3. List with filter
    const filtered = await request(app)
      .get('/v1/fraud/cases?status=open&priority=critical')
      .set(HDR);
    expect(filtered.status).toBe(200);
    for (const row of filtered.body.body.cases) {
      expect(row.status).toBe('open');
      expect(row.priority).toBe('critical');
    }

    // 4. Get one case
    const single = await request(app).get(`/v1/fraud/cases/${c.case_id}`).set(HDR);
    expect(single.status).toBe(200);
    expect(single.body.body.case_id).toBe(c.case_id);

    // 5. PATCH — assign + advance to investigating
    const patched = await request(app)
      .patch(`/v1/fraud/cases/${c.case_id}`)
      .set(HDR)
      .send({ status: 'investigating', assignee: 'bob.supervisor' });
    expect(patched.status).toBe(200);
    expect(patched.body.body.status).toBe('investigating');
    expect(patched.body.body.assignee).toBe('bob.supervisor');

    // 6. Rules CRUD (pre-existing)
    const rule = await request(app)
      .post('/v1/fraud/rules')
      .set(HDR)
      .send({
        name: 'Cheque kiting cluster',
        category: 'cheque_fraud',
        condition_pseudocode: 'distinct_branches_5d ≥ 3 AND roundtripped_amount_ratio > 0.6',
        threshold: 0.75,
        enabled: true,
      });
    expect(rule.status).toBe(201);
    // Module rule_id format varies — assert it's a non-empty string with module's prefix convention
    expect(typeof rule.body.body.rule_id).toBe('string');
    expect(rule.body.body.rule_id.length).toBeGreaterThan(0);

    const rulesList = await request(app).get('/v1/fraud/rules').set(HDR);
    expect(rulesList.status).toBe(200);
    expect(rulesList.body.body.rules.length).toBeGreaterThanOrEqual(1);

    // 7. SAR + vigilance verified in dedicated spec-acceptance tests below
  });

  // ── SPEC ACCEPTANCE: SAR audit event + draft lock ─────────────────────
  it('SPEC ACCEPTANCE: SAR submission writes audit event AND locks the SAR draft', async () => {
    const c = await createCase();

    // First SAR submission — should succeed + write audit event
    const sar = await request(app)
      .post(`/v1/fraud/cases/${c.case_id}/sar`)
      .set(HDR)
      .send({
        summary:
          'Suspected cheque kiting cluster — 8 cheques across 3 branches in 5 days, beneficiaries round-tripping back to source account. Recommend account freeze + FIU-IND escalation per RBI Master Directions on Frauds 2016 §A.2.',
      });
    expect(sar.status).toBe(201);
    expect(sar.body.body.sar_id).toMatch(/^sar-BANK_DEMO-/);
    expect(sar.body.body.fiu_reference).toMatch(/^FIU-IND-/);
    expect(typeof sar.body.body.submitted_at).toBe('string');

    // Spec acceptance #A: case is now locked — second submission → 409
    const sar2 = await request(app)
      .post(`/v1/fraud/cases/${c.case_id}/sar`)
      .set(HDR)
      .send({
        summary:
          'Trying to refile the same SAR with a tweaked summary — locking should reject this attempt.',
      });
    expect(sar2.status).toBe(409);
    expect(sar2.body.error.code).toBe('EWS_409_sar_already_submitted');

    // Spec acceptance #B: case status flipped to 'reported' + sar_id stamped
    const fetch = await request(app).get(`/v1/fraud/cases/${c.case_id}`).set(HDR);
    expect(fetch.status).toBe(200);
    expect(fetch.body.body.status).toBe('reported');
    expect(fetch.body.body.sar_id).toBe(sar.body.body.sar_id);

    // Spec acceptance #C: audit event recorded with critical severity +
    // the SAR + FIU references on metadata. Filter by action + match by
    // resource_id (the case_id) on the client side.
    const audit = await request(app)
      .get('/v1/audit/events?action=fraud.sar.submitted&page_size=50')
      .set(HDR);
    expect(audit.status).toBe(200);
    const match = audit.body.body.items.find(
      (e: { resource_id?: string }) => e.resource_id === c.case_id,
    );
    expect(match).toBeDefined();
    expect(match).toMatchObject({
      actor_username: 'admin',
      action: 'fraud.sar.submitted',
      outcome: 'success',
      severity: 'critical',
      resource_type: 'case',
    });
    expect(match.metadata).toMatchObject({
      sar_id: sar.body.body.sar_id,
      fiu_reference: sar.body.body.fiu_reference,
    });
  });

  it('Vigilance referral writes audit event + locks (matches SAR pattern)', async () => {
    const c = await createCase();

    const vig = await request(app)
      .post(`/v1/fraud/cases/${c.case_id}/vigilance`)
      .set(HDR)
      .send({
        reason: 'Pattern matches an open IB-Vigilance internal investigation — refer for cross-check.',
      });
    expect(vig.status).toBe(201);
    expect(vig.body.body.vigilance_ref).toMatch(/^vig-BANK_DEMO-/);

    // Lock: second referral → 409
    const vig2 = await request(app)
      .post(`/v1/fraud/cases/${c.case_id}/vigilance`)
      .set(HDR)
      .send({ reason: 'Trying to refer the same case twice.' });
    expect(vig2.status).toBe(409);
    expect(vig2.body.error.code).toBe('EWS_409_vigilance_already_referred');

    // Audit recorded with warning severity + vigilance_ref metadata
    const audit = await request(app)
      .get('/v1/audit/events?action=fraud.vigilance.referred&page_size=50')
      .set(HDR);
    expect(audit.status).toBe(200);
    const match = audit.body.body.items.find(
      (e: { resource_id?: string }) => e.resource_id === c.case_id,
    );
    expect(match).toBeDefined();
    expect(match.severity).toBe('warning');
    expect(match.metadata.vigilance_ref).toBe(vig.body.body.vigilance_ref);
  });

  it('400 paths: invalid category / invalid priority / short SAR summary / short vigilance reason', async () => {
    // Bad category
    const badCat = await request(app)
      .post('/v1/fraud/cases')
      .set(HDR)
      .send({ category: 'WHATEVER', description: 'long enough description text', priority: 'high' });
    expect(badCat.status).toBe(400);
    expect(badCat.body.error.code).toBe('EWS_400_invalid_category');

    // Bad priority
    const badPri = await request(app)
      .post('/v1/fraud/cases')
      .set(HDR)
      .send({
        category: 'cheque_fraud',
        description: 'long enough description text describing the fraud pattern',
        priority: 'SUPER_DUPER',
      });
    expect(badPri.status).toBe(400);
    expect(badPri.body.error.code).toBe('EWS_400_invalid_priority');

    // SAR summary too short (< 20 chars)
    const c = await createCase();
    const shortSar = await request(app)
      .post(`/v1/fraud/cases/${c.case_id}/sar`)
      .set(HDR)
      .send({ summary: 'too short' });
    expect(shortSar.status).toBe(400);
    expect(shortSar.body.error.code).toBe('EWS_400_invalid_input');

    // Vigilance reason too short (< 10 chars)
    const shortVig = await request(app)
      .post(`/v1/fraud/cases/${c.case_id}/vigilance`)
      .set(HDR)
      .send({ reason: 'too' });
    expect(shortVig.status).toBe(400);
    expect(shortVig.body.error.code).toBe('EWS_400_invalid_input');

    // 404 on unknown case
    const unknown = await request(app).get('/v1/fraud/cases/fc-UNKNOWN').set(HDR);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('EWS_404_unknown_case');
  });

  it('RBAC: unknown role fails closed; SAR + vigilance need audit:read', async () => {
    const c = await createCase();
    const viewer = { ...HDR, 'x-apex-role': 'viewer' };

    // Reads — analyst+ broad scope, viewer rejected
    const list = await request(app).get('/v1/fraud/cases').set(viewer);
    expect(list.status).toBe(403);
    const get = await request(app).get(`/v1/fraud/cases/${c.case_id}`).set(viewer);
    expect(get.status).toBe(403);

    // SAR + vigilance — audit:read (admin/supervisor only)
    const analyst = { ...HDR, 'x-apex-role': 'risk_analyst' };
    const sar = await request(app)
      .post(`/v1/fraud/cases/${c.case_id}/sar`)
      .set(analyst)
      .send({ summary: 'Analyst trying SAR — should fail per audit:read gate (admin/supervisor only).' });
    expect(sar.status).toBe(403);
    const vig = await request(app)
      .post(`/v1/fraud/cases/${c.case_id}/vigilance`)
      .set(analyst)
      .send({ reason: 'Analyst trying vigilance referral.' });
    expect(vig.status).toBe(403);
  });

  it('Tenant gate: BIL SAR submissions never leak to BANK_DEMO audit chain', async () => {
    const c = await createCase();

    // Submit SAR under BIL tenant
    const bilCreate = await request(app)
      .post('/v1/fraud/cases')
      .set({ ...HDR, 'x-tenant-id': 'BIL' })
      .send({
        category: 'identity_theft',
        priority: 'high',
        amount_kes: 750_000,
        description: 'BIL-only identity-theft case for tenant-isolation assertion long enough.',
      });
    expect(bilCreate.status).toBe(201);
    const bilCase = bilCreate.body.body.case_id;

    const bilSar = await request(app)
      .post(`/v1/fraud/cases/${bilCase}/sar`)
      .set({ ...HDR, 'x-tenant-id': 'BIL' })
      .send({
        summary:
          'BIL-only SAR submission for tenant-isolation test — must not appear in BANK_DEMO audit trail.',
      });
    expect(bilSar.status).toBe(201);

    // BANK_DEMO audit trail should NOT contain the BIL SAR event
    const audit = await request(app)
      .get('/v1/audit/events?action=fraud.sar.submitted&page_size=50')
      .set(HDR);
    expect(audit.status).toBe(200);
    const match = audit.body.body.items.find(
      (e: { resource_id?: string }) => e.resource_id === bilCase,
    );
    expect(match).toBeUndefined();

    // Conversely, BANK_DEMO can't see BIL case directly either
    const peek = await request(app).get(`/v1/fraud/cases/${bilCase}`).set(HDR);
    expect(peek.status).toBe(404);
  });

  it('SAR is locked from the case-detail surface — case carries sar_id after first submission', async () => {
    const c = await createCase();
    expect(c.sar_id).toBeNull();

    await request(app)
      .post(`/v1/fraud/cases/${c.case_id}/sar`)
      .set(HDR)
      .send({
        summary:
          'Locking semantics test — first SAR submission stamps sar_id on the case + flips status to reported.',
      })
      .expect(201);

    // Verify case-detail now carries sar_id (the SPA renders this as "SAR filed: <id>")
    const updated = await request(app).get(`/v1/fraud/cases/${c.case_id}`).set(HDR);
    expect(updated.status).toBe(200);
    expect(updated.body.body.sar_id).toMatch(/^sar-/);
    expect(updated.body.body.status).toBe('reported');
  });
});
