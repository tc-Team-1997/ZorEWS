// services/bff/__tests__/ai_drift.test.ts
//
// T7 Module 7 — Drift Detection. Pure band logic + snapshot determinism +
// fleet rollup + history + route smoke (via makeApp).

import request from 'supertest';
import {
  InMemoryAiDriftStore,
  AiDriftError,
  psiBand,
  PSI_OK,
  PSI_WARN,
  ALL_DRIFT_BANDS,
  MONITORED_MODELS,
  listMonitoredModels,
} from '../src/ai_drift';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-29T09:00:00.000Z');
const MODEL = 'pd_xgb_v3';

function makeDriftApp(role = 'risk_analyst', store = new InMemoryAiDriftStore()) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    aiDriftStore: store,
  });
}

describe('PSI bands (mirror of ml/monitoring/drift.py)', () => {
  it('thresholds: stable < 0.10 ≤ warn < 0.25 ≤ drift', () => {
    expect(PSI_OK).toBe(0.10);
    expect(PSI_WARN).toBe(0.25);
    expect(psiBand(0.0)).toBe('stable');
    expect(psiBand(0.09)).toBe('stable');
    expect(psiBand(0.10)).toBe('warn');
    expect(psiBand(0.24)).toBe('warn');
    expect(psiBand(0.25)).toBe('drift');
    expect(psiBand(0.9)).toBe('drift');
    expect(ALL_DRIFT_BANDS).toEqual(['stable', 'warn', 'drift']);
  });
});

describe('monitored model catalog', () => {
  it('exposes ≥ 5 models spanning banking + insurance + anomaly', () => {
    expect(MONITORED_MODELS.length).toBeGreaterThanOrEqual(5);
    const ids = listMonitoredModels().map((m) => m.model_id);
    expect(ids).toContain('pd_xgb_v3');
    expect(ids).toContain('lapse_xgb_v1');
    expect(MONITORED_MODELS.find((m) => m.model_type === 'anomaly')!.baseline_auc).toBeNull();
  });
});

describe('snapshot builder', () => {
  it('latest() produces a coherent snapshot with all 4 signal blocks', () => {
    const s = new InMemoryAiDriftStore();
    const snap = s.latest('BANK_DEMO', MODEL, NOW);
    expect(snap.model_id).toBe(MODEL);
    expect(snap.snapshot_id).toMatch(/^drift-BANK_DEMO-pd_xgb_v3-/);
    expect(ALL_DRIFT_BANDS).toContain(snap.overall_status);
    // data drift: every feature has a band consistent with its psi
    for (const f of snap.data_drift.features) expect(f.band).toBe(psiBand(f.psi));
    expect(snap.data_drift.max_psi).toBeGreaterThanOrEqual(0);
    // model drift KS in a sane range
    expect(snap.model_drift.ks_stat).toBeGreaterThanOrEqual(0);
    expect(snap.model_drift.p_value).toBeGreaterThanOrEqual(0);
    // performance present for a binary model
    expect(snap.performance_drift.baseline_auc).toBeCloseTo(0.847, 3);
    expect(snap.anomaly_spike.ratio).toBeGreaterThan(0);
  });

  it('is deterministic per (tenant, model, day)', () => {
    const a = new InMemoryAiDriftStore().latest('BANK_DEMO', MODEL, NOW);
    const b = new InMemoryAiDriftStore().latest('BANK_DEMO', MODEL, NOW);
    expect(b.overall_status).toBe(a.overall_status);
    expect(b.data_drift.max_psi).toBe(a.data_drift.max_psi);
    expect(b.model_drift.ks_stat).toBe(a.model_drift.ks_stat);
  });

  it('different tenant → different snapshot', () => {
    const a = new InMemoryAiDriftStore().latest('BANK_DEMO', MODEL, NOW);
    const b = new InMemoryAiDriftStore().latest('BIL', MODEL, NOW);
    expect(b.tenant_id).toBe('BIL');
    // at least one signal differs (overwhelmingly likely given independent seeds)
    const differs = b.data_drift.max_psi !== a.data_drift.max_psi || b.model_drift.ks_stat !== a.model_drift.ks_stat;
    expect(differs).toBe(true);
  });

  it('anomaly model carries null AUC + drifted=false on the perf block', () => {
    const snap = new InMemoryAiDriftStore().latest('BANK_DEMO', 'anomaly_if_v2', NOW);
    expect(snap.performance_drift.current_auc).toBeNull();
    expect(snap.performance_drift.baseline_auc).toBeNull();
    expect(snap.performance_drift.drifted).toBe(false);
  });

  it('overall_status is the worst of the signal bands', () => {
    const snap = new InMemoryAiDriftStore().latest('BANK_DEMO', MODEL, NOW);
    const featWorst = snap.data_drift.features.reduce(
      (acc, f) => (['stable', 'warn', 'drift'].indexOf(f.band) > ['stable', 'warn', 'drift'].indexOf(acc) ? f.band : acc),
      'stable' as string,
    );
    const rank = (b: string) => ['stable', 'warn', 'drift'].indexOf(b);
    expect(rank(snap.overall_status)).toBeGreaterThanOrEqual(rank(featWorst));
  });

  it('unknown model throws + empty tenant throws', () => {
    const s = new InMemoryAiDriftStore();
    expect(() => s.latest('BANK_DEMO', 'nope', NOW)).toThrow(AiDriftError);
    expect(() => s.latest('', MODEL, NOW)).toThrow(AiDriftError);
  });
});

describe('fleet rollup', () => {
  it('covers every monitored model with a by_status partition', () => {
    const s = new InMemoryAiDriftStore();
    const fleet = s.fleet('BANK_DEMO', NOW);
    expect(fleet.total_models).toBe(MONITORED_MODELS.length);
    expect(fleet.models).toHaveLength(MONITORED_MODELS.length);
    const sum = fleet.by_status.stable + fleet.by_status.warn + fleet.by_status.drift;
    expect(sum).toBe(fleet.total_models);
    expect(fleet.models_needing_attention).toBe(fleet.by_status.warn + fleet.by_status.drift);
  });

  it('worst_offender is null when all stable, else points at a non-stable model', () => {
    const fleet = new InMemoryAiDriftStore().fleet('BANK_DEMO', NOW);
    if (fleet.models_needing_attention === 0) {
      expect(fleet.worst_offender).toBeNull();
    } else {
      expect(fleet.worst_offender).not.toBeNull();
      expect(fleet.worst_offender!.overall_status).not.toBe('stable');
    }
  });
});

describe('recompute + history', () => {
  it('recompute appends a fresh snapshot to history newest-first', () => {
    const s = new InMemoryAiDriftStore();
    s.latest('BANK_DEMO', MODEL, NOW); // seeds 1
    const r1 = s.recompute('BANK_DEMO', MODEL, NOW);
    const r2 = s.recompute('BANK_DEMO', MODEL, NOW);
    const hist = s.history('BANK_DEMO', MODEL, 10);
    expect(hist[0].snapshot_id).toBe(r2.snapshot_id);
    expect(hist[1].snapshot_id).toBe(r1.snapshot_id);
    expect(hist.length).toBeGreaterThanOrEqual(3);
  });

  it('history limit is clamped + unknown model throws', () => {
    const s = new InMemoryAiDriftStore();
    s.latest('BANK_DEMO', MODEL, NOW);
    expect(s.history('BANK_DEMO', MODEL, 1)).toHaveLength(1);
    expect(() => s.history('BANK_DEMO', 'nope', 5)).toThrow(AiDriftError);
  });

  it('tenant isolation — BIL history is independent', () => {
    const s = new InMemoryAiDriftStore();
    s.recompute('BANK_DEMO', MODEL, NOW);
    expect(s.history('BIL', MODEL, 10)).toHaveLength(0);
  });
});

describe('routes', () => {
  const HDRS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  it('GET fleet + GET single + GET history + POST recompute happy path', async () => {
    const { app } = makeDriftApp('risk_analyst');
    const fleet = await request(app).get('/v1/ai/drift').set(HDRS);
    expect(fleet.status).toBe(200);
    expect(fleet.body.body.total_models).toBe(MONITORED_MODELS.length);

    const single = await request(app).get(`/v1/ai/drift/${MODEL}`).set(HDRS);
    expect(single.status).toBe(200);
    expect(single.body.body.model_id).toBe(MODEL);

    const recomputed = await request(app).post(`/v1/ai/drift/${MODEL}/recompute`).set(HDRS).send({});
    expect(recomputed.status).toBe(201);

    const hist = await request(app).get(`/v1/ai/drift/${MODEL}/history`).set(HDRS);
    expect(hist.status).toBe(200);
    expect(hist.body.body.total).toBeGreaterThanOrEqual(1);
  });

  it('the literal /drift fleet route is not captured by :model_id', async () => {
    const { app } = makeDriftApp('risk_analyst');
    const fleet = await request(app).get('/v1/ai/drift').set(HDRS);
    expect(fleet.body.body).toHaveProperty('by_status');
  });

  it('404 on unknown model', async () => {
    const { app } = makeDriftApp('risk_analyst');
    const r = await request(app).get('/v1/ai/drift/nope').set(HDRS);
    expect(r.status).toBe(404);
  });

  it('403 for a role lacking customers:read_risk_profile', async () => {
    const { app } = makeDriftApp('auditor');
    const r = await request(app).get('/v1/ai/drift').set(HDRS);
    expect(r.status).toBe(403);
  });
});
