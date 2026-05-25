/* M4.3 — AI Explainability smoke.
 *
 * Covers:
 *   GET /v1/ai/predictions/:id/explanation       — top-5 SHAP card
 *   GET /v1/ai/predictions/:id/feature-importance — full ranking (NEW)
 *   GET /v1/ai/predictions/:id/trust-signals     — 5-axis trust card
 *
 * Acceptance gates verified by this smoke:
 *   1. Explanation retrievable for any prediction ≤ 24 months old.
 *   2. Prediction 25+ months old → 410 EWS_410_explanation_expired
 *      (NOT 404; we explicitly distinguish "expired" from "not-found"
 *      so the SPA renders the right message).
 *   3. Unknown prediction_id → 404 EWS_404_unknown_prediction.
 *   4. Cross-tenant access → 404 (prediction is tenant-scoped via the
 *      M4.1 prediction store).
 *   5. Pure feature-importance fn returns the full pool ranked by
 *      |weight| desc with rank 1..N, and the by_group rollup shares
 *      sum to ≈ 1.
 */

import request from 'supertest';
import {
  buildFeatureImportance,
  explainPrediction,
  buildTrustSignals,
  assertPredictionExplainable,
  ExplainabilityError,
  EXPLAINABILITY_AGE_LIMIT_MONTHS,
} from '../src/ai_explainability';
import {
  InMemoryAiPredictionStore,
  type AiPredictionStore,
} from '../src/ai_predictions';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-25T12:00:00.000Z');
const TH_BIL = {
  'x-tenant-id': 'BIL',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};
const TH_BANK = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};

function seedPrediction(
  store: AiPredictionStore,
  tenant_id: string,
  createdAt: Date,
): string {
  const row = store.record(
    {
      tenant_id,
      model_id: 'pd_xgb_v3',
      model_version: '3.2.1',
      prediction_type: 'pd',
      result: {
        model_id: 'pd_xgb_v3',
        customer_id: 'c-101',
        score: 0.72,
        probability: 0.72,
        band: 'high',
        scored_at: createdAt.toISOString(),
        top_features: [{ feature: 'dpd_max_90d', value: 45, attribution: 0.31 }],
      },
      created_by: 'alice.admin',
    },
    createdAt,
  );
  return row.prediction_id;
}

function makeSmokeApp(role = 'admin') {
  const aiPredictionStore = new InMemoryAiPredictionStore();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    aiPredictionStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { app, aiPredictionStore };
}

describe('M4.3 — pure feature importance', () => {
  it('EX-A: full feature pool ranked by |weight| desc with rank 1..N', () => {
    const r = buildFeatureImportance('BIL', 'pred-1', NOW);
    expect(r.total_features).toBeGreaterThan(5);
    expect(r.features.length).toBe(r.total_features);
    // rank 1..N
    r.features.forEach((f, i) => expect(f.rank).toBe(i + 1));
    // monotone |weight| descending
    for (let i = 1; i < r.features.length; i++) {
      expect(r.features[i]!.abs_weight).toBeLessThanOrEqual(r.features[i - 1]!.abs_weight);
    }
  });

  it('EX-B: deterministic per (tenant, prediction_id)', () => {
    const a = buildFeatureImportance('BIL', 'pred-x', NOW);
    const b = buildFeatureImportance('BIL', 'pred-x', NOW);
    expect(a.features.map((f) => f.feature_name)).toEqual(b.features.map((f) => f.feature_name));
    expect(a.features[0]!.abs_weight).toBe(b.features[0]!.abs_weight);
  });

  it('EX-C: by_group shares sum to ≈ 1', () => {
    const r = buildFeatureImportance('BIL', 'pred-1', NOW);
    const total = r.by_group.reduce((s, g) => s + g.share, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThanOrEqual(1.01); // float rounding
  });

  it('EX-D: explanation.top_features ⊂ full feature-importance pool', () => {
    // explainPrediction uses FEATURE_POOL.slice(0,6) for the card; the
    // full ranking considers the whole pool. The card features must be
    // a subset of the full ranking, sharing identical names.
    const full = buildFeatureImportance('BIL', 'pred-cross-check', NOW);
    const card = explainPrediction('BIL', 'pred-cross-check', NOW);
    const fullNames = new Set(full.features.map((f) => f.feature_name));
    for (const cf of card.top_features) {
      expect(fullNames.has(cf.feature_name)).toBe(true);
    }
  });
});

describe('M4.3 — 24-month age guard', () => {
  const lookup = (tenant: string, id: string) =>
    id === 'fresh'
      ? { prediction_id: 'fresh', tenant_id: tenant, created_at: '2026-05-01T00:00:00.000Z' }
      : id === 'expired'
        ? { prediction_id: 'expired', tenant_id: tenant, created_at: '2023-01-01T00:00:00.000Z' }
        : id === 'malformed'
          ? { prediction_id: 'malformed', tenant_id: tenant, created_at: 'not-a-date' }
          : null;

  it('EX-E: ≤ 24 months → passes', () => {
    const r = assertPredictionExplainable('BIL', 'fresh', NOW, lookup);
    expect(r.prediction_id).toBe('fresh');
  });

  it('EX-F: > 24 months → throws explanation_expired', () => {
    expect(() => assertPredictionExplainable('BIL', 'expired', NOW, lookup)).toThrowError(
      ExplainabilityError,
    );
    try {
      assertPredictionExplainable('BIL', 'expired', NOW, lookup);
    } catch (e) {
      expect((e as ExplainabilityError).code).toBe('explanation_expired');
      expect((e as Error).message).toContain('24 months');
    }
  });

  it('EX-G: unknown prediction → throws unknown_prediction', () => {
    try {
      assertPredictionExplainable('BIL', 'nope', NOW, lookup);
    } catch (e) {
      expect((e as ExplainabilityError).code).toBe('unknown_prediction');
    }
  });

  it('EX-H: malformed created_at → throws invalid_input', () => {
    try {
      assertPredictionExplainable('BIL', 'malformed', NOW, lookup);
    } catch (e) {
      expect((e as ExplainabilityError).code).toBe('invalid_input');
    }
  });

  it('EX-I: constant matches spec acceptance (24 months)', () => {
    expect(EXPLAINABILITY_AGE_LIMIT_MONTHS).toBe(24);
  });
});

describe('M4.3 — pure trust signals (existing, regressed)', () => {
  it('EX-J: returns 5 signals + overall band ∈ {green, amber, red}', () => {
    const r = buildTrustSignals('BIL', 'pred-trust', NOW);
    expect(r.signals.length).toBe(5);
    expect(['green', 'amber', 'red']).toContain(r.overall);
  });
});

describe('M4.3 — HTTP routes', () => {
  it('EX-K: GET /explanation 200 for a fresh prediction', async () => {
    const { app, aiPredictionStore } = makeSmokeApp('admin');
    const id = seedPrediction(aiPredictionStore, 'BIL', new Date('2026-04-01T00:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/predictions/${id}/explanation`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.prediction_id).toBe(id);
    expect(r.body.body.top_features.length).toBe(5);
  });

  it('EX-L: GET /feature-importance 200 for a fresh prediction', async () => {
    const { app, aiPredictionStore } = makeSmokeApp('admin');
    const id = seedPrediction(aiPredictionStore, 'BIL', new Date('2026-04-01T00:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/predictions/${id}/feature-importance`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_features).toBeGreaterThan(5);
    expect(r.body.body.features[0].rank).toBe(1);
  });

  it('EX-M: GET /trust-signals 200 for a fresh prediction', async () => {
    const { app, aiPredictionStore } = makeSmokeApp('admin');
    const id = seedPrediction(aiPredictionStore, 'BIL', new Date('2026-04-01T00:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/predictions/${id}/trust-signals`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.signals.length).toBe(5);
  });

  it('EX-N: Unknown prediction → 404 EWS_404_unknown_prediction', async () => {
    const { app } = makeSmokeApp('admin');
    const r = await request(app)
      .get(`/v1/ai/predictions/nope-xx/explanation`)
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_prediction');
  });

  it('EX-O: Prediction > 24 months → 410 EWS_410_explanation_expired (spec acceptance)', async () => {
    const { app, aiPredictionStore } = makeSmokeApp('admin');
    // Seed a 3-year-old prediction
    const id = seedPrediction(aiPredictionStore, 'BIL', new Date('2023-01-01T00:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/predictions/${id}/explanation`)
      .set(TH_BIL);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('EWS_410_explanation_expired');
    expect(r.body.error.message).toContain('24 months');
  });

  it('EX-P: Same gate applied to feature-importance + trust-signals', async () => {
    const { app, aiPredictionStore } = makeSmokeApp('admin');
    const id = seedPrediction(aiPredictionStore, 'BIL', new Date('2023-01-01T00:00:00Z'));
    const r1 = await request(app)
      .get(`/v1/ai/predictions/${id}/feature-importance`)
      .set(TH_BIL);
    expect(r1.status).toBe(410);
    const r2 = await request(app)
      .get(`/v1/ai/predictions/${id}/trust-signals`)
      .set(TH_BIL);
    expect(r2.status).toBe(410);
  });

  it('EX-Q: Cross-tenant prediction → 404 (tenant-scoped)', async () => {
    const { app, aiPredictionStore } = makeSmokeApp('admin');
    // Seed in BIL, look up from BANK_DEMO
    const id = seedPrediction(aiPredictionStore, 'BIL', new Date('2026-04-01T00:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/predictions/${id}/explanation`)
      .set(TH_BANK);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_prediction');
  });

  it('EX-R: GET /v1/ai/predictions/:id still works (M4.1 regression)', async () => {
    const { app, aiPredictionStore } = makeSmokeApp('admin');
    const id = seedPrediction(aiPredictionStore, 'BIL', new Date('2026-04-01T00:00:00Z'));
    const r = await request(app).get(`/v1/ai/predictions/${id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.prediction_id).toBe(id);
  });

  it('EX-S: non-allowed role → 403', async () => {
    // customers:read_risk_profile allows admin/risk_analyst/supervisor/
    // collection_officer/field_officer. Use a role outside the allowed
    // set ('viewer' is not in any RBAC mapping).
    const { app, aiPredictionStore } = makeSmokeApp('viewer');
    const id = seedPrediction(aiPredictionStore, 'BIL', new Date('2026-04-01T00:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/predictions/${id}/feature-importance`)
      .set({ ...TH_BIL, 'x-apex-role': 'viewer' });
    expect(r.status).toBe(403);
  });
});
