// services/bff/__tests__/case_maker_checker_reviewer_rollup.test.ts
//
// T6 M9.16 — Maker-checker by-reviewer activity rollup.

import request from 'supertest';
import {
  summarizeMakerCheckerReviewerActivity,
  MC_RUBBER_STAMP_MIN_DECISIONS,
} from '../src/case_maker_checker_reviewer_rollup';
import {
  InMemoryMakerCheckerEngine,
  type SensitiveActionType,
} from '../src/case_maker_checker';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeMcrApp(role: string = 'admin', makerCheckerEngine?: InMemoryMakerCheckerEngine) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    makerCheckerEngine: makerCheckerEngine ?? new InMemoryMakerCheckerEngine(),
  });
}

function decideAction(
  engine: InMemoryMakerCheckerEngine,
  tenant: string,
  case_id: string,
  action_type: SensitiveActionType,
  maker: string,
  checker: string,
  outcome: 'approved' | 'rejected',
  at: Date = NOW,
) {
  const action = engine.submit(
    tenant,
    {
      case_id,
      action_type,
      payload: {},
      rationale: 'test submission for unit tests',
    },
    maker,
    new Date(at.getTime() - 1000),
  );
  if (outcome === 'approved') {
    engine.approve(tenant, action.action_id, checker, 'lgtm', at);
  } else {
    engine.reject(tenant, action.action_id, checker, 'nope', at);
  }
  return action;
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M9.16 — empty engine', () => {
  test('zero decisions → zero rows', () => {
    const e = new InMemoryMakerCheckerEngine();
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.total_decisions).toBe(0);
    expect(s.reviewers).toEqual([]);
    expect(s.most_active_reviewer).toBeNull();
    expect(s.rubber_stamp_reviewers).toEqual([]);
  });
});

describe('M9.16 — pending excluded', () => {
  test('only decided actions counted', () => {
    const e = new InMemoryMakerCheckerEngine();
    // submit pending action
    e.submit('BIL', {
      case_id: 'c1',
      action_type: 'case.close',
      payload: {},
      rationale: 'pending',
    }, 'alice', NOW);
    decideAction(e, 'BIL', 'c2', 'case.close', 'maker', 'bob', 'approved');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.total_decisions).toBe(1);
    expect(s.total_reviewers).toBe(1);
    expect(s.reviewers[0].checker_username).toBe('bob');
  });
});

describe('M9.16 — single checker single decision', () => {
  test('alice approves 1 → 1 row with approved_count=1', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].checker_username).toBe('alice');
    expect(s.reviewers[0].total_decisions).toBe(1);
    expect(s.reviewers[0].approved_count).toBe(1);
    expect(s.reviewers[0].rejected_count).toBe(0);
    expect(s.reviewers[0].approval_rate).toBe(1);
    expect(s.reviewers[0].distinct_cases).toBe(1);
    expect(s.reviewers[0].case_ids).toEqual(['c1']);
    expect(s.reviewers[0].by_action_type['case.close']).toBe(1);
  });
});

describe('M9.16 — multi-checker cohort sorted desc', () => {
  test('alice 3 + bob 1 → sorted', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c2', 'case.escalate', 'maker', 'alice', 'rejected');
    decideAction(e, 'BIL', 'c3', 'case.override_decision', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c4', 'case.close', 'maker', 'bob', 'approved');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].checker_username).toBe('alice');
    expect(s.reviewers[0].total_decisions).toBe(3);
    expect(s.most_active_reviewer).toBe('alice');
  });

  test('canonical username asc tie-break', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c2', 'case.close', 'maker', 'bob', 'approved');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].checker_username).toBe('alice');
    expect(s.reviewers[1].checker_username).toBe('bob');
  });
});

describe('M9.16 — distinct_cases + case_ids', () => {
  test('case_ids sorted asc + cap 50', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'zebra', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'alpha', 'case.close', 'maker', 'alice', 'approved');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].distinct_cases).toBe(2);
    expect(s.reviewers[0].case_ids).toEqual(['alpha', 'zebra']);
  });
});

describe('M9.16 — by_action_type every key present', () => {
  test('all 3 action_type keys present', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(Object.keys(s.reviewers[0].by_action_type).sort()).toEqual([
      'case.close',
      'case.escalate',
      'case.override_decision',
    ]);
    expect(s.reviewers[0].by_action_type['case.close']).toBe(1);
    expect(s.reviewers[0].by_action_type['case.escalate']).toBe(0);
  });
});

describe('M9.16 — approval_rate formula', () => {
  test('half approved/half rejected = 0.5', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c2', 'case.close', 'maker', 'alice', 'rejected');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].approval_rate).toBe(0.5);
  });

  test('all approved = 1.0', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c2', 'case.escalate', 'maker', 'alice', 'approved');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].approval_rate).toBe(1);
  });
});

describe('M9.16 — most_recent_at = max checker_at', () => {
  test('newest checker_at wins', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved',
      new Date('2026-05-10T00:00:00.000Z'));
    decideAction(e, 'BIL', 'c2', 'case.close', 'maker', 'alice', 'approved',
      new Date('2026-05-15T00:00:00.000Z'));
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].most_recent_at).toBe('2026-05-15T00:00:00.000Z');
  });
});

describe('M9.16 — rubber_stamp_reviewers', () => {
  test('approval_rate=1.0 AND >=3 decisions flagged', () => {
    expect(MC_RUBBER_STAMP_MIN_DECISIONS).toBe(3);
    const e = new InMemoryMakerCheckerEngine();
    // alice approves 3 (rubber-stamp)
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c2', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c3', 'case.close', 'maker', 'alice', 'approved');
    // bob approves 1 (below threshold)
    decideAction(e, 'BIL', 'c4', 'case.close', 'maker', 'bob', 'approved');
    // carol mixed decisions
    decideAction(e, 'BIL', 'c5', 'case.close', 'maker', 'carol', 'approved');
    decideAction(e, 'BIL', 'c6', 'case.close', 'maker', 'carol', 'rejected');
    decideAction(e, 'BIL', 'c7', 'case.close', 'maker', 'carol', 'approved');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.rubber_stamp_reviewers).toEqual(['alice']);
  });
});

describe('M9.16 — partition invariants', () => {
  test('Σ reviewers.total_decisions = envelope.total_decisions', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c2', 'case.close', 'maker', 'bob', 'rejected');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    const sum = s.reviewers.reduce((acc, r) => acc + r.total_decisions, 0);
    expect(sum).toBe(s.total_decisions);
  });

  test('approved + rejected = total per row', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c2', 'case.close', 'maker', 'alice', 'rejected');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.reviewers[0].approved_count + s.reviewers[0].rejected_count)
      .toBe(s.reviewers[0].total_decisions);
  });

  test('Σ by_action_type per row = row.total_decisions', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c2', 'case.escalate', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c3', 'case.override_decision', 'maker', 'alice', 'rejected');
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    const row = s.reviewers[0];
    const sum = Object.values(row.by_action_type).reduce((a, b) => a + b, 0);
    expect(sum).toBe(row.total_decisions);
  });
});

describe('M9.16 — tenant scoping', () => {
  test('BIL decisions invisible to BANK_DEMO', () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    const bil = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    const bank = summarizeMakerCheckerReviewerActivity(e, 'BANK_DEMO', NOW);
    expect(bil.total_decisions).toBe(1);
    expect(bank.total_decisions).toBe(0);
  });
});

describe('M9.16 — tenant_id + generated_at echo', () => {
  test('envelope echoes inputs', () => {
    const e = new InMemoryMakerCheckerEngine();
    const s = summarizeMakerCheckerReviewerActivity(e, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M9.16 — GET /v1/cases/maker-checker/reviewer-rollup', () => {
  test('admin → 200 with empty engine', async () => {
    const { app } = makeMcrApp('admin');
    const r = await request(app)
      .get('/v1/cases/maker-checker/reviewer-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_decisions).toBe(0);
    expect(r.body.body.most_active_reviewer).toBeNull();
  });

  test('populated → reflects decisions', async () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c2', 'case.close', 'maker', 'alice', 'approved');
    decideAction(e, 'BIL', 'c3', 'case.close', 'maker', 'alice', 'approved');
    const { app } = makeMcrApp('admin', e);
    const r = await request(app)
      .get('/v1/cases/maker-checker/reviewer-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_decisions).toBe(3);
    expect(r.body.body.most_active_reviewer).toBe('alice');
    expect(r.body.body.rubber_stamp_reviewers).toEqual(['alice']);
  });

  test('analyst+ (cases:list) accepted', async () => {
    const { app } = makeMcrApp('risk_analyst');
    const r = await request(app)
      .get('/v1/cases/maker-checker/reviewer-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const e = new InMemoryMakerCheckerEngine();
    decideAction(e, 'BIL', 'c1', 'case.close', 'maker', 'alice', 'approved');
    const { app } = makeMcrApp('admin', e);
    const bankR = await request(app)
      .get('/v1/cases/maker-checker/reviewer-rollup')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_decisions).toBe(0);
  });

  test('M9.3 /v1/cases/maker-checker sibling regression still 200', async () => {
    const { app } = makeMcrApp('admin');
    const r = await request(app)
      .get('/v1/cases/maker-checker')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/reviewer-rollup` not captured by `:action_id` wildcard', async () => {
    const { app } = makeMcrApp('admin');
    const r = await request(app)
      .get('/v1/cases/maker-checker/reviewer-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.reviewers).toBeDefined();
  });
});
