// services/bff/__tests__/account_behaviour_module_smoke.test.ts
//
// Module 2.2 — Account Behaviour smoke (per the user playbook).
//
// 4 spec routes covered end-to-end:
//   GET  /v1/banking/accounts/signals?customer_id=&watchlist_only=&status=
//   GET  /v1/banking/accounts/:id/patterns
//   GET  /v1/banking/accounts/:id/transactions               (M2.2 net-new — alias to M14.7 finance ledger)
//   POST /v1/banking/accounts/:id/block                      (4-eyes maker-checker)
// + 2 net-new mutators with audit fan-out:
//   POST /v1/banking/accounts/signals/:signal_id/dismiss
//   POST /v1/banking/accounts/signals/:signal_id/review
//
// SPEC ACCEPTANCE CRITERIA — both proven in pure form here so the contract
// is verifiable independently of the random-synth signal generator:
//   #1 — Salary-credit-stopped detection fires WITHIN 7 days of last credit
//   #2 — Cash-flow-drop detector triggers when MoM net-flow drops >30%

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  detectSalaryStopped,
  detectCashFlowDropMoM,
  _resetSignalStatusOverrides,
  _resetBlockStore,
} from '../src/banking_account_behaviour';

const NOW = new Date('2026-05-24T12:00:00.000Z');
const HDR = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'admin',
};

function makeSmokeApp() {
  // No getRole override — defaultGetRole reads `x-apex-role` per request,
  // so the self-approval test can switch actors mid-flight.
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
  _resetSignalStatusOverrides();
  _resetBlockStore();
  app = makeSmokeApp().app;
});

describe('M2.2 — Account Behaviour smoke', () => {
  it('walks the full list → patterns → transactions → dismiss → 4-eyes block flow', async () => {
    // 1. List signals
    const list = await request(app).get('/v1/banking/accounts/signals').set(HDR);
    expect(list.status).toBe(200);
    expect(list.body.body.total).toBeGreaterThan(0);
    expect(list.body.body.signals.length).toBeGreaterThan(0);
    const sig = list.body.body.signals[0];
    expect(sig).toMatchObject({
      signal_id: expect.any(String),
      account_id: expect.any(String),
      customer_id: expect.any(String),
      status: 'new',
      severity: expect.stringMatching(/^(low|medium|high|critical)$/),
    });

    // 2. Patterns for one of the signal's accounts (4 sparkline series)
    const patterns = await request(app)
      .get(`/v1/banking/accounts/${sig.account_id}/patterns`)
      .set(HDR);
    expect(patterns.status).toBe(200);
    expect(patterns.body.body.patterns).toHaveLength(4);
    expect(patterns.body.body.patterns[0].series).toHaveLength(12);

    // 3. Transactions — thin alias re-uses M14.7 finance ledger (returns 200
    //    when the account exists in the M14.7 deterministic synth, otherwise
    //    404 unknown_account — either way the contract is verified).
    const txns = await request(app)
      .get(`/v1/banking/accounts/${sig.account_id}/transactions`)
      .set(HDR);
    expect([200, 404]).toContain(txns.status);
    if (txns.status === 200) {
      // M14.7 finance ledger shape — items[], not entries
      expect(txns.body.body.items).toBeDefined();
      expect(Array.isArray(txns.body.body.items)).toBe(true);
    } else {
      expect(txns.body.error.code).toBe('EWS_404_unknown_account');
    }

    // 4. Dismiss the signal — mark false positive (cases:log_action gate)
    const dismiss = await request(app)
      .post(`/v1/banking/accounts/signals/${sig.signal_id}/dismiss`)
      .set(HDR)
      .send({});
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.body.status).toBe('dismissed');
    expect(dismiss.body.body.reviewed_by).toBe('admin');

    // 5. Re-list with ?status=dismissed — the dismissed signal surfaces
    const dlist = await request(app)
      .get('/v1/banking/accounts/signals?status=dismissed')
      .set(HDR);
    expect(dlist.status).toBe(200);
    const dismissedIds = dlist.body.body.signals.map((s: { signal_id: string }) => s.signal_id);
    expect(dismissedIds).toContain(sig.signal_id);

    // 6. 4-eyes block — propose then approve (different actor)
    const propose = await request(app)
      .post(`/v1/banking/accounts/${sig.account_id}/block`)
      .set(HDR)
      .send({ reason: 'EWS anomaly cluster — block pending compliance review' });
    expect(propose.status).toBe(201);
    expect(propose.body.body.status).toBe('pending');
    expect(propose.body.body.requested_by).toBe('admin');
    const reqId = propose.body.body.request_id;

    // 7. Self-approval refused (segregation of duties)
    const selfApprove = await request(app)
      .post(`/v1/banking/accounts/${sig.account_id}/block`)
      .set(HDR)
      .send({ request_id: reqId, decision: 'approve' });
    expect(selfApprove.status).toBe(409);
    expect(selfApprove.body.error.code).toBe('EWS_409_self_approval_forbidden');

    // 8. Checker (different user) approves
    const approve = await request(app)
      .post(`/v1/banking/accounts/${sig.account_id}/block`)
      .set({ ...HDR, 'x-apex-user': 'bob.supervisor', 'x-apex-role': 'supervisor' })
      .send({ request_id: reqId, decision: 'approve' });
    expect(approve.status).toBe(200);
    expect(approve.body.body.status).toBe('approved');
    expect(approve.body.body.reviewed_by).toBe('bob.supervisor');
  });

  // ── SPEC ACCEPTANCE #1: salary-stopped within 7 days ────────────────
  it('SPEC ACCEPTANCE: salary-credit-stopped detection fires within 7 days of last credit', () => {
    // Credit 8 days ago → DETECTED (> 7d threshold)
    const eightDaysAgo = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    const stopped = detectSalaryStopped(
      [{ credited_at: eightDaysAgo, amount_inr: 75_000 }],
      NOW,
    );
    expect(stopped.detected).toBe(true);
    expect(stopped.days_since_last_salary).toBe(8);
    expect(stopped.last_salary_at).toBe(eightDaysAgo);
    expect(stopped.threshold_days).toBe(7);

    // Credit 3 days ago → NOT detected (within 7d threshold)
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const ok = detectSalaryStopped(
      [{ credited_at: threeDaysAgo, amount_inr: 75_000 }],
      NOW,
    );
    expect(ok.detected).toBe(false);
    expect(ok.days_since_last_salary).toBe(3);

    // Exactly 7 days ago → NOT detected (strict `>` boundary; "within 7 days")
    const sevenDaysAgo = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
    const boundary = detectSalaryStopped(
      [{ credited_at: sevenDaysAgo, amount_inr: 75_000 }],
      NOW,
    );
    expect(boundary.detected).toBe(false);
    expect(boundary.days_since_last_salary).toBe(7);

    // Empty credit history → detected (never paid)
    const never = detectSalaryStopped([], NOW);
    expect(never.detected).toBe(true);
    expect(never.last_salary_at).toBeNull();

    // Newest among many is what matters — old credits don't shadow recent ones
    const mixed = detectSalaryStopped(
      [
        { credited_at: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(), amount_inr: 50_000 },
        { credited_at: new Date(NOW.getTime() - 60 * 86_400_000).toISOString(), amount_inr: 55_000 },
        { credited_at: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(), amount_inr: 75_000 },
      ],
      NOW,
    );
    expect(mixed.detected).toBe(false);
    expect(mixed.days_since_last_salary).toBe(3);
  });

  // ── SPEC ACCEPTANCE #2: MoM cash-flow drop > 30% ────────────────────
  it('SPEC ACCEPTANCE: cash-flow-drop detector triggers when MoM net-flow drops >30%', () => {
    // 40% drop (100k → 60k) → DETECTED
    const drop40 = detectCashFlowDropMoM(100_000, 60_000);
    expect(drop40.detected).toBe(true);
    expect(drop40.mom_drop_pct).toBeCloseTo(0.4, 4);
    expect(drop40.threshold_pct).toBe(0.3);

    // 30% drop (100k → 70k) → NOT detected (strict `>` boundary)
    const drop30 = detectCashFlowDropMoM(100_000, 70_000);
    expect(drop30.detected).toBe(false);
    expect(drop30.mom_drop_pct).toBeCloseTo(0.3, 4);

    // 20% drop → NOT detected
    const drop20 = detectCashFlowDropMoM(100_000, 80_000);
    expect(drop20.detected).toBe(false);

    // No drop (growth) → NOT detected
    const grew = detectCashFlowDropMoM(100_000, 130_000);
    expect(grew.detected).toBe(false);
    expect(grew.mom_drop_pct).toBeCloseTo(-0.3, 4);

    // Prev=0 baseline → not detected (no meaningful base to compare)
    const noBase = detectCashFlowDropMoM(0, 60_000);
    expect(noBase.detected).toBe(false);
    expect(noBase.mom_drop_pct).toBeNull();

    // Custom threshold — 25% bar
    const drop28 = detectCashFlowDropMoM(100_000, 72_000, 0.25);
    expect(drop28.detected).toBe(true);
  });

  it('Filters: customer_id / watchlist_only / status narrow the signal list', async () => {
    // customer_id filter
    const byCust = await request(app)
      .get('/v1/banking/accounts/signals?customer_id=c-100002')
      .set(HDR);
    expect(byCust.status).toBe(200);
    expect(byCust.body.body.customer_id).toBe('c-100002');
    for (const s of byCust.body.body.signals) {
      expect(s.customer_id).toBe('c-100002');
    }

    // watchlist_only=true
    const wl = await request(app)
      .get('/v1/banking/accounts/signals?watchlist_only=true')
      .set(HDR);
    expect(wl.status).toBe(200);
    expect(wl.body.body.watchlist_only).toBe(true);
    for (const s of wl.body.body.signals) {
      expect(s.is_watchlisted).toBe(true);
    }

    // status=new (default before any mutator runs — all signals are new)
    const newOnly = await request(app)
      .get('/v1/banking/accounts/signals?status=new')
      .set(HDR);
    expect(newOnly.status).toBe(200);
    for (const s of newOnly.body.body.signals) {
      expect(s.status).toBe('new');
    }

    // status=dismissed BEFORE any dismiss → empty
    const noDismissed = await request(app)
      .get('/v1/banking/accounts/signals?status=dismissed')
      .set(HDR);
    expect(noDismissed.status).toBe(200);
    expect(noDismissed.body.body.total).toBe(0);
  });

  it('400 paths: invalid status filter / malformed signal_id / short reason', async () => {
    // Unknown status enum
    const badStatus = await request(app)
      .get('/v1/banking/accounts/signals?status=unknown_state')
      .set(HDR);
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error.code).toBe('EWS_400_invalid_status');

    // Malformed signal_id on dismiss
    const badSig = await request(app)
      .post('/v1/banking/accounts/signals/NOT_A_SIGNAL_ID/dismiss')
      .set(HDR)
      .send({});
    expect(badSig.status).toBe(400);
    expect(badSig.body.error.code).toBe('EWS_400_invalid_input');

    // Block reason too short
    const shortReason = await request(app)
      .post('/v1/banking/accounts/a-100002-00/block')
      .set(HDR)
      .send({ reason: 'no' });
    expect(shortReason.status).toBe(400);
    expect(shortReason.body.error.code).toBe('EWS_400_invalid_input');
  });

  it('RBAC: unknown role fails closed on all M2.2 routes', async () => {
    // Note: customers:read_risk_profile is intentionally broad — every known
    // operator role holds it because every role interacts with borrowers.
    // Use a truly unknown role to verify the gate fails closed.
    const viewer = { ...HDR, 'x-apex-role': 'viewer' };
    const list = await request(app).get('/v1/banking/accounts/signals').set(viewer);
    expect(list.status).toBe(403);
    const txns = await request(app)
      .get('/v1/banking/accounts/a-100002-00/transactions')
      .set(viewer);
    expect(txns.status).toBe(403);
    const dismiss = await request(app)
      .post('/v1/banking/accounts/signals/sig-X-c-100002-0-2026-05-24/dismiss')
      .set(viewer)
      .send({});
    expect(dismiss.status).toBe(403);
  });

  it('Tenant gate: refuses without X-Tenant-ID + X-Channel', async () => {
    const noTen = await request(app).get('/v1/banking/accounts/signals');
    expect([400, 401, 403]).toContain(noTen.status);
    const noCh = await request(app)
      .get('/v1/banking/accounts/signals')
      .set({ 'x-tenant-id': 'BANK_DEMO', 'x-apex-role': 'admin', 'x-apex-user': 'admin' });
    expect([400, 401, 403]).toContain(noCh.status);
  });
});
