import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { _resetCaseTypeConfigStore, defaultCaseTypeConfigStore } from '../src/case_type_config';

// Case Management Setup (#13) → CMS case-creation runtime wiring.
// When a case is opened with a configured case_type, the route seeds the
// case's priority + SLA + category from the master. Explicit priority wins;
// the SLA + category come from the type. Unknown/disabled type → 400.

const NOW = new Date('2026-05-29T12:00:00.000Z');
const TENANT = 'BANK_DEMO';
const H = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API', 'x-apex-user': 'alice.admin' };

function app(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

function hoursBetween(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / 3_600_000);
}

describe('CMS create — case_type config seeding', () => {
  beforeEach(() => _resetCaseTypeConfigStore());

  it('seeds priority + SLA + category from the configured case type', async () => {
    // FRAUD_INVESTIGATION seed: P1, 4h SLA, Fraud Desk.
    const res = await request(app('admin'))
      .post('/v1/cms/cases')
      .set(H)
      .send({ title: 'Suspicious wire burst', case_type: 'FRAUD_INVESTIGATION' });
    expect(res.status).toBe(201);
    expect(res.body.body.priority).toBe('P1');
    expect(res.body.body.case_category).toBe('FRAUD_INVESTIGATION');
    // SLA window = 4h from created_at (not the priority-derived P1 window, which
    // also happens to be 4h — so use a type whose SLA differs from the window
    // to prove the override; see the COLLECTIONS test below).
    expect(hoursBetween(res.body.body.created_at, res.body.body.sla_due_at)).toBe(4);
  });

  it("uses the type's SLA hours, not the priority-derived window", async () => {
    // COLLECTIONS_FOLLOWUP seed: P4, 168h SLA. The P4 priority window is also
    // 7d=168h, so to prove the override is the TYPE's sla_hours we patch the
    // type's SLA to a value that does NOT match any priority window.
    const collections = defaultCaseTypeConfigStore
      .list(TENANT, 'all', true)
      .find((t) => t.code === 'COLLECTIONS_FOLLOWUP')!;
    defaultCaseTypeConfigStore.update(TENANT, collections.case_type_id, { sla_hours: 50 }, NOW.getTime());

    const res = await request(app('admin'))
      .post('/v1/cms/cases')
      .set(H)
      .send({ title: 'Recovery chase', case_type: 'COLLECTIONS_FOLLOWUP' });
    expect(res.status).toBe(201);
    expect(res.body.body.priority).toBe('P4');
    expect(hoursBetween(res.body.body.created_at, res.body.body.sla_due_at)).toBe(50);
  });

  it('explicit priority overrides the type priority but SLA still comes from the type', async () => {
    // CREDIT_RISK_REVIEW seed: P2, 24h. Caller forces P1.
    const res = await request(app('admin'))
      .post('/v1/cms/cases')
      .set(H)
      .send({ title: 'Forced critical', case_type: 'CREDIT_RISK_REVIEW', priority: 'P1' });
    expect(res.status).toBe(201);
    expect(res.body.body.priority).toBe('P1'); // explicit wins
    expect(res.body.body.case_category).toBe('CREDIT_RISK_REVIEW');
    expect(hoursBetween(res.body.body.created_at, res.body.body.sla_due_at)).toBe(24); // type SLA
  });

  it('lower-cases / trims the case_type code before lookup', async () => {
    const res = await request(app('admin'))
      .post('/v1/cms/cases')
      .set(H)
      .send({ title: 'Case', case_type: '  kyc_remediation  ' });
    expect(res.status).toBe(201);
    expect(res.body.body.priority).toBe('P3');
    expect(res.body.body.case_category).toBe('KYC_REMEDIATION');
  });

  it('400s an unknown case_type', async () => {
    const res = await request(app('admin'))
      .post('/v1/cms/cases')
      .set(H)
      .send({ title: 'Case', case_type: 'NOPE_NOT_A_TYPE' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EWS_400_unknown_case_type');
  });

  it('400s a disabled case_type (treated as unknown)', async () => {
    const credit = defaultCaseTypeConfigStore
      .list(TENANT, 'all', true)
      .find((t) => t.code === 'CREDIT_RISK_REVIEW')!;
    defaultCaseTypeConfigStore.update(TENANT, credit.case_type_id, { enabled: false }, NOW.getTime());
    const res = await request(app('admin'))
      .post('/v1/cms/cases')
      .set(H)
      .send({ title: 'Case', case_type: 'CREDIT_RISK_REVIEW' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EWS_400_unknown_case_type');
  });

  it('without case_type, behaviour is unchanged — priority required, window-derived SLA', async () => {
    const ok = await request(app('admin'))
      .post('/v1/cms/cases')
      .set(H)
      .send({ title: 'Plain case', priority: 'P2' });
    expect(ok.status).toBe(201);
    expect(ok.body.body.priority).toBe('P2');
    expect(ok.body.body.case_category).toBeNull();
    expect(hoursBetween(ok.body.body.created_at, ok.body.body.sla_due_at)).toBe(24); // P2 window

    // missing priority + no case_type → 400 (existing validator contract)
    const bad = await request(app('admin')).post('/v1/cms/cases').set(H).send({ title: 'No priority' });
    expect(bad.status).toBe(400);
  });
});
