// services/bff/__tests__/ai_model_retirement_candidates.test.ts
//
// T6 M7.9 — AI model retirement candidates.

import request from 'supertest';
import {
  findRetirementCandidates,
  RetirementCandidatesError,
} from '../src/ai_model_retirement_candidates';
import { defaultAiModelRegistry, SEED_MODELS, type ModelVersion } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkModel(o: Partial<ModelVersion> & { model_id: string; trained_at: string }): ModelVersion {
  return {
    model_id: o.model_id,
    name: o.name ?? `Model ${o.model_id}`,
    type: o.type ?? 'pd',
    version: o.version ?? '1.0',
    status: o.status ?? 'production',
    framework: o.framework ?? 'xgboost',
    description: o.description ?? 'desc',
    trained_at: o.trained_at,
    deployed_at: o.deployed_at ?? null,
    retired_at: o.retired_at ?? null,
    training_data_window_days: o.training_data_window_days ?? 365,
    key_features: o.key_features ?? [],
    metrics: o.metrics ?? {
      auc: 0.8,
      precision: 0.7,
      recall: 0.7,
      f1: 0.7,
      mae: null,
      training_rows: 100000,
      evaluated_at: '2026-04-01T00:00:00.000Z',
    },
  };
}

// ─── findRetirementCandidates — pure ─────────────────────────────────

describe('M7.9 — empty registry', () => {
  test('zero models → zero candidates', () => {
    const r = findRetirementCandidates([], NOW);
    expect(r.total_models_considered).toBe(0);
    expect(r.total_candidates).toBe(0);
  });
});

describe('M7.9 — classification', () => {
  test('deployed 500d ago → stale (default 365 threshold)', () => {
    const m = mkModel({
      model_id: 'old',
      trained_at: '2024-12-30T00:00:00.000Z',
      deployed_at: new Date(NOW.getTime() - 500 * 86_400_000).toISOString(),
      status: 'production',
    });
    const r = findRetirementCandidates([m], NOW);
    expect(r.total_candidates).toBe(1);
    expect(r.candidates[0]!.candidacy).toBe('stale');
    expect(r.candidates[0]!.days_since_deployed).toBe(500);
  });

  test('deployed 200d ago → aging (between aging=180 and stale=365)', () => {
    const m = mkModel({
      model_id: 'mid',
      trained_at: '2025-10-26T00:00:00.000Z',
      deployed_at: new Date(NOW.getTime() - 200 * 86_400_000).toISOString(),
      status: 'production',
    });
    const r = findRetirementCandidates([m], NOW);
    expect(r.candidates[0]!.candidacy).toBe('aging');
  });

  test('deployed 30d ago → fresh (below aging threshold)', () => {
    const m = mkModel({
      model_id: 'new',
      trained_at: '2026-04-14T00:00:00.000Z',
      deployed_at: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
      status: 'production',
    });
    const r = findRetirementCandidates([m], NOW);
    expect(r.total_candidates).toBe(0);
  });

  test('never_deployed: trained > stale_days but never went live', () => {
    const m = mkModel({
      model_id: 'orphan',
      trained_at: new Date(NOW.getTime() - 500 * 86_400_000).toISOString(),
      deployed_at: null,
      status: 'experimental',
    });
    const r = findRetirementCandidates([m], NOW);
    expect(r.total_candidates).toBe(1);
    expect(r.candidates[0]!.candidacy).toBe('never_deployed');
    expect(r.candidates[0]!.days_since_deployed).toBeNull();
  });
});

describe('M7.9 — retired models excluded', () => {
  test('models in `retired` status are excluded from consideration', () => {
    const retired = mkModel({
      model_id: 'r',
      trained_at: '2024-01-01T00:00:00.000Z',
      deployed_at: '2024-02-01T00:00:00.000Z',
      status: 'retired',
      retired_at: '2025-08-01T00:00:00.000Z',
    });
    const stale = mkModel({
      model_id: 's',
      trained_at: '2024-12-30T00:00:00.000Z',
      deployed_at: new Date(NOW.getTime() - 500 * 86_400_000).toISOString(),
      status: 'production',
    });
    const r = findRetirementCandidates([retired, stale], NOW);
    expect(r.total_models_considered).toBe(1);
    expect(r.candidates[0]!.model_id).toBe('s');
  });
});

describe('M7.9 — sort', () => {
  test('candidates sorted oldest-deployment first', () => {
    const a = mkModel({
      model_id: 'a',
      trained_at: '2024-01-01T00:00:00.000Z',
      deployed_at: new Date(NOW.getTime() - 200 * 86_400_000).toISOString(),
      status: 'production',
    });
    const b = mkModel({
      model_id: 'b',
      trained_at: '2024-01-01T00:00:00.000Z',
      deployed_at: new Date(NOW.getTime() - 500 * 86_400_000).toISOString(),
      status: 'production',
    });
    const r = findRetirementCandidates([a, b], NOW);
    expect(r.candidates.map((c) => c.model_id)).toEqual(['b', 'a']);
  });
});

describe('M7.9 — validation', () => {
  test('stale_days < aging_days → throws', () => {
    expect(() => findRetirementCandidates([], NOW, 30, 365)).toThrow(/stale_days/);
  });
  test('negative stale_days → throws', () => {
    expect(() => findRetirementCandidates([], NOW, -1, 0)).toThrow(RetirementCandidatesError);
  });
});

describe('M7.9 — default registry integration', () => {
  test('called with no args + default thresholds → returns shape over real seed models', () => {
    const r = findRetirementCandidates(SEED_MODELS, NOW);
    expect(r.total_models_considered).toBeGreaterThan(0);
    expect(Array.isArray(r.candidates)).toBe(true);
    // total_candidates ≤ total_models_considered
    expect(r.total_candidates).toBeLessThanOrEqual(r.total_models_considered);
  });
});

// ─── GET /v1/ai/models/retirement-candidates ─────────────────────────

function makeRetirementApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    aiModelRegistry: defaultAiModelRegistry,
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M7.9 — GET /v1/ai/models/retirement-candidates', () => {
  test('admin → 200 with full report', async () => {
    const { app } = makeRetirementApp('admin');
    const r = await request(app).get('/v1/ai/models/retirement-candidates').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_models_considered).toBeGreaterThan(0);
    expect(Array.isArray(r.body.body.candidates)).toBe(true);
  });

  test('?stale_days=180 widens the net', async () => {
    const { app } = makeRetirementApp('admin');
    const wide = await request(app)
      .get('/v1/ai/models/retirement-candidates?stale_days=180&aging_days=90')
      .set(TH_BIL);
    const narrow = await request(app)
      .get('/v1/ai/models/retirement-candidates?stale_days=730&aging_days=365')
      .set(TH_BIL);
    expect(wide.status).toBe(200);
    expect(narrow.status).toBe(200);
    expect(wide.body.body.total_candidates).toBeGreaterThanOrEqual(narrow.body.body.total_candidates);
  });

  test('invalid bound → 400', async () => {
    const { app } = makeRetirementApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/retirement-candidates?stale_days=10&aging_days=20')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRetirementApp('case_owner');
    const r = await request(app).get('/v1/ai/models/retirement-candidates').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same response across tenants', async () => {
    const { app } = makeRetirementApp('admin');
    const bil = await request(app).get('/v1/ai/models/retirement-candidates').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/ai/models/retirement-candidates')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });
});
