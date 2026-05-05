// services/bff/__tests__/ai_model_ab_test.test.ts
//
// T6 M7.3 — Model A/B test harness.

import request from 'supertest';
import { AbTestError, runAbTest, runAbTestBatch } from '../src/ai_model_ab_test';
import { defaultAiModelRegistry } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T23:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeAbApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('runAbTest', () => {
  test('happy: scores both + returns delta', () => {
    const r = runAbTest(
      defaultAiModelRegistry,
      {
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_id: 'CUST-100001',
      },
      'BIL',
      NOW,
    );
    expect(r.champion.model.model_id).toBe('churn_xgb_v1');
    expect(r.candidate.model.model_id).toBe('churn_torch_v1');
    expect(typeof r.score_delta).toBe('number');
    expect(r.type_match).toBe(true);
  });

  test('cross-type comparison: type_match=false', () => {
    const r = runAbTest(
      defaultAiModelRegistry,
      {
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'fraud_lgb_v1',
        customer_id: 'CUST-100001',
      },
      'BIL',
      NOW,
    );
    expect(r.type_match).toBe(false);
  });

  test('rejects same model_id for champion + candidate', () => {
    expect(() =>
      runAbTest(
        defaultAiModelRegistry,
        {
          champion_model_id: 'churn_xgb_v1',
          candidate_model_id: 'churn_xgb_v1',
          customer_id: 'CUST-100001',
        },
        'BIL',
        NOW,
      ),
    ).toThrow(/must differ/);
  });

  test('missing champion_model_id → invalid_input', () => {
    try {
      runAbTest(
        defaultAiModelRegistry,
        { candidate_model_id: 'churn_torch_v1', customer_id: 'CUST-1' } as never,
        'BIL',
        NOW,
      );
      fail('expected throw');
    } catch (e) {
      expect((e as AbTestError).code).toBe('invalid_input');
    }
  });

  test('unknown champion → unknown_model', () => {
    try {
      runAbTest(
        defaultAiModelRegistry,
        {
          champion_model_id: 'NO-SUCH',
          candidate_model_id: 'churn_torch_v1',
          customer_id: 'CUST-1',
        },
        'BIL',
        NOW,
      );
      fail('expected throw');
    } catch (e) {
      expect((e as AbTestError).code).toBe('unknown_model');
    }
  });

  test('unknown candidate → unknown_model', () => {
    try {
      runAbTest(
        defaultAiModelRegistry,
        {
          champion_model_id: 'churn_xgb_v1',
          candidate_model_id: 'NO-SUCH',
          customer_id: 'CUST-1',
        },
        'BIL',
        NOW,
      );
      fail('expected throw');
    } catch (e) {
      expect((e as AbTestError).code).toBe('unknown_model');
    }
  });

  test('determinism: same call → same delta', () => {
    const a = runAbTest(
      defaultAiModelRegistry,
      {
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_id: 'CUST-100001',
      },
      'BIL',
      NOW,
    );
    const b = runAbTest(
      defaultAiModelRegistry,
      {
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_id: 'CUST-100001',
      },
      'BIL',
      NOW,
    );
    expect(a.score_delta).toBe(b.score_delta);
  });

  test('band_match flag accuracy', () => {
    const r = runAbTest(
      defaultAiModelRegistry,
      {
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_id: 'CUST-100001',
      },
      'BIL',
      NOW,
    );
    if (r.champion.result.band !== null && r.candidate.result.band !== null) {
      expect(r.band_match).toBe(r.champion.result.band === r.candidate.result.band);
    }
  });
});

describe('POST /v1/ai/models/ab-test', () => {
  test('analyst+: 200 with delta', async () => {
    const { app } = makeAbApp('risk_analyst');
    const r = await request(app)
      .post('/v1/ai/models/ab-test')
      .set(TH_BIL)
      .send({
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_id: 'CUST-100001',
      });
    expect(r.status).toBe(200);
    expect(r.body.body.champion.model.model_id).toBe('churn_xgb_v1');
    expect(r.body.body.candidate.model.model_id).toBe('churn_torch_v1');
  });

  test('accepts enveloped body', async () => {
    const { app } = makeAbApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/ab-test')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: {
          champion_model_id: 'churn_xgb_v1',
          candidate_model_id: 'churn_torch_v1',
          customer_id: 'CUST-100001',
        },
      });
    expect(r.status).toBe(200);
  });

  test('unknown model → 404', async () => {
    const { app } = makeAbApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/ab-test')
      .set(TH_BIL)
      .send({
        champion_model_id: 'NO-SUCH',
        candidate_model_id: 'churn_torch_v1',
        customer_id: 'CUST-1',
      });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_model');
  });

  test('same id for both → 400', async () => {
    const { app } = makeAbApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/ab-test')
      .set(TH_BIL)
      .send({
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_xgb_v1',
        customer_id: 'CUST-1',
      });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAbApp('case_owner');
    const r = await request(app)
      .post('/v1/ai/models/ab-test')
      .set(TH_BIL)
      .send({
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_id: 'CUST-1',
      });
    expect(r.status).toBe(403);
  });
});

// ─── M7.4 — Batch A/B test ────────────────────────────────────────────

describe('runAbTestBatch', () => {
  test('happy: results array + aggregate', () => {
    const r = runAbTestBatch(
      defaultAiModelRegistry,
      {
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_ids: ['CUST-100001', 'CUST-100002', 'CUST-100003'],
      },
      'BIL',
      NOW,
    );
    expect(r.results.length).toBe(3);
    expect(r.aggregate.count).toBe(3);
    expect(typeof r.aggregate.mean_score_delta).toBe('number');
    expect(r.aggregate.type_match).toBe(true);
  });

  test('mean_score_delta = average of per-customer deltas', () => {
    const r = runAbTestBatch(
      defaultAiModelRegistry,
      {
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_ids: ['CUST-100001', 'CUST-100002'],
      },
      'BIL',
      NOW,
    );
    const expected =
      (r.results[0]!.score_delta + r.results[1]!.score_delta) / 2;
    expect(r.aggregate.mean_score_delta).toBeCloseTo(expected);
  });

  test('band_match_rate is fraction in [0, 1]', () => {
    const r = runAbTestBatch(
      defaultAiModelRegistry,
      {
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_ids: ['CUST-100001', 'CUST-100002', 'CUST-100003'],
      },
      'BIL',
      NOW,
    );
    if (r.aggregate.band_match_rate !== null) {
      expect(r.aggregate.band_match_rate).toBeGreaterThanOrEqual(0);
      expect(r.aggregate.band_match_rate).toBeLessThanOrEqual(1);
    }
  });

  test('empty customer_ids[] → invalid_input', () => {
    expect(() =>
      runAbTestBatch(
        defaultAiModelRegistry,
        {
          champion_model_id: 'churn_xgb_v1',
          candidate_model_id: 'churn_torch_v1',
          customer_ids: [],
        },
        'BIL',
        NOW,
      ),
    ).toThrow(/non-empty/);
  });

  test('> 50 customers → invalid_input', () => {
    const cids = new Array(51).fill(0).map((_, i) => `CUST-${i}`);
    expect(() =>
      runAbTestBatch(
        defaultAiModelRegistry,
        {
          champion_model_id: 'churn_xgb_v1',
          candidate_model_id: 'churn_torch_v1',
          customer_ids: cids,
        },
        'BIL',
        NOW,
      ),
    ).toThrow(/batch cap/);
  });

  test('duplicate customer_id → invalid_input', () => {
    expect(() =>
      runAbTestBatch(
        defaultAiModelRegistry,
        {
          champion_model_id: 'churn_xgb_v1',
          candidate_model_id: 'churn_torch_v1',
          customer_ids: ['CUST-1', 'CUST-1'],
        },
        'BIL',
        NOW,
      ),
    ).toThrow(/duplicate/);
  });

  test('unknown model → unknown_model bubbles per-row', () => {
    try {
      runAbTestBatch(
        defaultAiModelRegistry,
        {
          champion_model_id: 'NO-SUCH',
          candidate_model_id: 'churn_torch_v1',
          customer_ids: ['CUST-1'],
        },
        'BIL',
        NOW,
      );
      fail('expected throw');
    } catch (e) {
      expect((e as AbTestError).code).toBe('unknown_model');
    }
  });
});

describe('POST /v1/ai/models/ab-test/batch', () => {
  test('analyst+: 200 with batch body', async () => {
    const { app } = makeAbApp('risk_analyst');
    const r = await request(app)
      .post('/v1/ai/models/ab-test/batch')
      .set(TH_BIL)
      .send({
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_ids: ['CUST-100001', 'CUST-100002'],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.results.length).toBe(2);
    expect(r.body.body.aggregate.count).toBe(2);
  });

  test('empty customer_ids → 400', async () => {
    const { app } = makeAbApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/ab-test/batch')
      .set(TH_BIL)
      .send({
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_ids: [],
      });
    expect(r.status).toBe(400);
  });

  test('unknown model → 404', async () => {
    const { app } = makeAbApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/ab-test/batch')
      .set(TH_BIL)
      .send({
        champion_model_id: 'NO-SUCH',
        candidate_model_id: 'churn_torch_v1',
        customer_ids: ['CUST-1'],
      });
    expect(r.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAbApp('case_owner');
    const r = await request(app)
      .post('/v1/ai/models/ab-test/batch')
      .set(TH_BIL)
      .send({
        champion_model_id: 'churn_xgb_v1',
        candidate_model_id: 'churn_torch_v1',
        customer_ids: ['CUST-1'],
      });
    expect(r.status).toBe(403);
  });
});
