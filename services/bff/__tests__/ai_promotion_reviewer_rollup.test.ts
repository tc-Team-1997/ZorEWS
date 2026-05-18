// services/bff/__tests__/ai_promotion_reviewer_rollup.test.ts
//
// T6 M7.16 — AI promotion by-reviewer rollup.

import request from 'supertest';
import {
  summarizePromotionReviewerActivity,
  RUBBER_STAMP_MIN_DECISIONS,
} from '../src/ai_promotion_reviewer_rollup';
import { InMemoryPromotionEngine } from '../src/ai_model_promotion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeRrApp(role: string = 'admin', promotionEngine?: InMemoryPromotionEngine) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    promotionEngine: promotionEngine ?? new InMemoryPromotionEngine(),
  });
}

function decide(
  engine: InMemoryPromotionEngine,
  tenant: string,
  model_id: string,
  reviewer: string,
  outcome: 'approved' | 'rejected',
  reviewedAt: Date = NOW,
) {
  const req = engine.requestPromotion(
    tenant,
    {
      model_id,
      from_status: 'staging',
      to_status: 'production',
      request_notes: 'test request',
    },
    'maker',
    new Date(reviewedAt.getTime() - 1000),
  );
  if (outcome === 'approved') {
    engine.approve(tenant, req.request_id, reviewer, 'lgtm', reviewedAt);
  } else {
    engine.reject(tenant, req.request_id, reviewer, 'nope', reviewedAt);
  }
  return req;
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M7.16 — empty engine', () => {
  test('zero decisions → zero rows + null leaderboard', () => {
    const e = new InMemoryPromotionEngine();
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.total_decisions).toBe(0);
    expect(s.total_reviewers).toBe(0);
    expect(s.reviewers).toEqual([]);
    expect(s.most_active_reviewer).toBeNull();
    expect(s.rubber_stamp_reviewers).toEqual([]);
  });
});

describe('M7.16 — pending + cancelled excluded', () => {
  test('only decided (approved/rejected) requests counted', () => {
    const e = new InMemoryPromotionEngine();
    // Pending request (not decided)
    e.requestPromotion(
      'BIL',
      {
        model_id: 'pd_xgb',
        from_status: 'staging',
        to_status: 'production',
        request_notes: 'still pending',
      },
      'maker',
      NOW,
    );
    decide(e, 'BIL', 'fraud_lgb', 'alice', 'approved');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.total_decisions).toBe(1);
    expect(s.total_reviewers).toBe(1);
  });
});

describe('M7.16 — single reviewer single decision', () => {
  test('alice approves 1 → 1 row with approved_count=1, approval_rate=1', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'pd_xgb', 'alice', 'approved');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.total_decisions).toBe(1);
    expect(s.reviewers[0].reviewed_by).toBe('alice');
    expect(s.reviewers[0].total_decisions).toBe(1);
    expect(s.reviewers[0].approved_count).toBe(1);
    expect(s.reviewers[0].rejected_count).toBe(0);
    expect(s.reviewers[0].approval_rate).toBe(1);
  });
});

describe('M7.16 — multi-reviewer cohort', () => {
  test('alice 3 + bob 1 → sorted desc', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    decide(e, 'BIL', 'm2', 'alice', 'approved');
    decide(e, 'BIL', 'm3', 'alice', 'rejected');
    decide(e, 'BIL', 'm4', 'bob', 'approved');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.total_reviewers).toBe(2);
    expect(s.reviewers[0].reviewed_by).toBe('alice');
    expect(s.reviewers[0].total_decisions).toBe(3);
    expect(s.reviewers[0].approved_count).toBe(2);
    expect(s.reviewers[0].rejected_count).toBe(1);
    expect(s.reviewers[0].approval_rate).toBeCloseTo(2 / 3);
    expect(s.most_active_reviewer).toBe('alice');
  });

  test('canonical username asc tie-break', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    decide(e, 'BIL', 'm2', 'bob', 'approved');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].reviewed_by).toBe('alice');
    expect(s.reviewers[1].reviewed_by).toBe('bob');
  });
});

describe('M7.16 — distinct_models sorted asc + deduped', () => {
  test('distinct models per reviewer', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'zebra', 'alice', 'approved');
    decide(e, 'BIL', 'alpha', 'alice', 'rejected');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].distinct_models).toEqual(['alpha', 'zebra']);
  });
});

describe('M7.16 — approval_rate formula', () => {
  test('half-approved = 0.5', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    decide(e, 'BIL', 'm2', 'alice', 'rejected');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].approval_rate).toBe(0.5);
  });

  test('all-rejected = 0', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'rejected');
    decide(e, 'BIL', 'm2', 'alice', 'rejected');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].approval_rate).toBe(0);
  });

  test('all-approved = 1.0', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    decide(e, 'BIL', 'm2', 'alice', 'approved');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].approval_rate).toBe(1);
  });
});

describe('M7.16 — most_recent_at = max reviewed_at', () => {
  test('newest reviewed_at wins', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved', new Date('2026-05-10T00:00:00.000Z'));
    decide(e, 'BIL', 'm2', 'alice', 'approved', new Date('2026-05-15T00:00:00.000Z'));
    decide(e, 'BIL', 'm3', 'alice', 'approved', new Date('2026-05-12T00:00:00.000Z'));
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].most_recent_at).toBe('2026-05-15T00:00:00.000Z');
  });
});

describe('M7.16 — rubber_stamp_reviewers security signal', () => {
  test('approval_rate=1.0 AND total_decisions >= 3 → flagged', () => {
    expect(RUBBER_STAMP_MIN_DECISIONS).toBe(3);
    const e = new InMemoryPromotionEngine();
    // alice approved 3 (rubber-stamper)
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    decide(e, 'BIL', 'm2', 'alice', 'approved');
    decide(e, 'BIL', 'm3', 'alice', 'approved');
    // bob approved 1 (below threshold)
    decide(e, 'BIL', 'm4', 'bob', 'approved');
    // carol approved 2 + rejected 1 (not rubber-stamp)
    decide(e, 'BIL', 'm5', 'carol', 'approved');
    decide(e, 'BIL', 'm6', 'carol', 'approved');
    decide(e, 'BIL', 'm7', 'carol', 'rejected');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.rubber_stamp_reviewers).toEqual(['alice']);
  });

  test('empty when no rubber-stampers', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    decide(e, 'BIL', 'm2', 'alice', 'rejected');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.rubber_stamp_reviewers).toEqual([]);
  });
});

describe('M7.16 — partition invariant', () => {
  test('Σ reviewers.total_decisions = envelope.total_decisions', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    decide(e, 'BIL', 'm2', 'bob', 'approved');
    decide(e, 'BIL', 'm3', 'carol', 'rejected');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    const sum = s.reviewers.reduce((acc, r) => acc + r.total_decisions, 0);
    expect(sum).toBe(s.total_decisions);
    expect(s.total_decisions).toBe(3);
  });

  test('approved + rejected = total per reviewer', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    decide(e, 'BIL', 'm2', 'alice', 'rejected');
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    const r = s.reviewers[0];
    expect(r.approved_count + r.rejected_count).toBe(r.total_decisions);
  });
});

describe('M7.16 — tenant scoping', () => {
  test('BIL decisions invisible to BANK_DEMO', () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    const bil = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    const bank = summarizePromotionReviewerActivity(e, 'BANK_DEMO', NOW);
    expect(bil.total_decisions).toBe(1);
    expect(bank.total_decisions).toBe(0);
  });
});

describe('M7.16 — tenant_id + generated_at echo', () => {
  test('envelope echoes inputs', () => {
    const e = new InMemoryPromotionEngine();
    const s = summarizePromotionReviewerActivity(e, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M7.16 — GET /v1/ai/promotions/reviewer-rollup', () => {
  test('admin → 200 with empty engine', async () => {
    const { app } = makeRrApp('admin');
    const r = await request(app)
      .get('/v1/ai/promotions/reviewer-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_decisions).toBe(0);
    expect(r.body.body.most_active_reviewer).toBeNull();
  });

  test('populated → reflects decisions', async () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    decide(e, 'BIL', 'm2', 'alice', 'approved');
    decide(e, 'BIL', 'm3', 'alice', 'approved');
    decide(e, 'BIL', 'm4', 'bob', 'approved');
    const { app } = makeRrApp('admin', e);
    const r = await request(app)
      .get('/v1/ai/promotions/reviewer-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_decisions).toBe(4);
    expect(r.body.body.most_active_reviewer).toBe('alice');
    expect(r.body.body.rubber_stamp_reviewers).toEqual(['alice']);
  });

  test('analyst+ accepted', async () => {
    const { app } = makeRrApp('risk_analyst');
    const r = await request(app)
      .get('/v1/ai/promotions/reviewer-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRrApp('case_owner');
    const r = await request(app)
      .get('/v1/ai/promotions/reviewer-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const e = new InMemoryPromotionEngine();
    decide(e, 'BIL', 'm1', 'alice', 'approved');
    const { app } = makeRrApp('admin', e);
    const bankR = await request(app)
      .get('/v1/ai/promotions/reviewer-rollup')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_decisions).toBe(0);
  });

  test('M7.15 /v1/ai/promotions/latency-histogram sibling regression still 200', async () => {
    const { app } = makeRrApp('admin');
    const r = await request(app)
      .get('/v1/ai/promotions/latency-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/reviewer-rollup` not captured by `:request_id` wildcard', async () => {
    const { app } = makeRrApp('admin');
    const r = await request(app)
      .get('/v1/ai/promotions/reviewer-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.reviewers).toBeDefined();
  });
});
