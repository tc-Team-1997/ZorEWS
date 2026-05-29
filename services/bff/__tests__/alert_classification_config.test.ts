import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  InMemoryAlertClassificationConfigStore,
  AlertClassificationConfigError,
  classifyScore,
  validateBoundaries,
  isRagBand,
  ALL_RAG_BANDS,
  SCORE_CEILING,
  _resetAlertClassificationConfigStore,
} from '../src/alert_classification_config';

const NOW = new Date('2026-05-29T12:00:00.000Z');
const NOW_MS = NOW.getTime();
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

// ─── Enums + pure ────────────────────────────────────────────────────

describe('alert_classification_config — enums + pure', () => {
  it('ALL_RAG_BANDS is green→amber→red + guard agrees', () => {
    expect(ALL_RAG_BANDS).toEqual(['green', 'amber', 'red']);
    expect(isRagBand('amber')).toBe(true);
    expect(isRagBand('orange')).toBe(false);
  });

  it('validateBoundaries enforces 0 < amber_min < red_min ≤ ceiling', () => {
    expect(validateBoundaries(60, 100)).toEqual({ amber_min: 60, red_min: 100 });
    expect(() => validateBoundaries(0, 100)).toThrow(/amber_min must be >/);
    expect(() => validateBoundaries(100, 60)).toThrow(/red_min must be > amber_min/);
    expect(() => validateBoundaries(60, SCORE_CEILING + 1)).toThrow(/red_min must be ≤/);
    expect(() => validateBoundaries('x', 100)).toThrow(AlertClassificationConfigError);
    expect(() => validateBoundaries(NaN, 100)).toThrow(/finite/);
  });

  it('classifyScore partitions the axis with no holes', () => {
    const store = new InMemoryAlertClassificationConfigStore();
    const cfg = store.get(TENANT); // default 60 / 100
    expect(classifyScore(cfg, 0).band).toBe('green');
    expect(classifyScore(cfg, 59.99).band).toBe('green');
    expect(classifyScore(cfg, 60).band).toBe('amber'); // inclusive lower
    expect(classifyScore(cfg, 99.99).band).toBe('amber');
    expect(classifyScore(cfg, 100).band).toBe('red'); // inclusive lower
    expect(classifyScore(cfg, 5000).band).toBe('red'); // open-ended top
    // below-floor clamps into green (no hole)
    expect(classifyScore(cfg, -10).band).toBe('green');
    expect(classifyScore(cfg, 100).action_required).toBe('Immediate action — escalate');
  });
});

// ─── Store ───────────────────────────────────────────────────────────

describe('alert_classification_config — store', () => {
  function fresh() {
    return new InMemoryAlertClassificationConfigStore();
  }

  it('seeds the MASTER SETUP example (green<60 / amber60-100 / red≥100)', () => {
    const cfg = fresh().get(TENANT);
    expect(cfg.amber_min).toBe(60);
    expect(cfg.red_min).toBe(100);
    expect(cfg.bands.map((b) => b.band)).toEqual(['green', 'amber', 'red']);
    const green = cfg.bands[0];
    const amber = cfg.bands[1];
    const red = cfg.bands[2];
    expect(green.min_score).toBe(0);
    expect(green.max_score).toBe(60);
    expect(amber.min_score).toBe(60);
    expect(amber.max_score).toBe(100);
    expect(red.min_score).toBe(100);
    expect(red.max_score).toBeNull(); // open-ended
    expect(red.range_label).toBe('≥ 100');
    expect(green.range_label).toBe('< 60');
    expect(amber.range_label).toBe('60–100');
  });

  it('the derived bands always form a contiguous partition (no gaps/overlaps)', () => {
    const s = fresh();
    s.setBoundaries(TENANT, 40, 75, 'alice', NOW_MS);
    const cfg = s.get(TENANT);
    // green.max === amber.min, amber.max === red.min, red.max === null
    expect(cfg.bands[0].max_score).toBe(cfg.bands[1].min_score);
    expect(cfg.bands[1].max_score).toBe(cfg.bands[2].min_score);
    expect(cfg.bands[2].max_score).toBeNull();
    expect(cfg.bands[0].min_score).toBe(0);
  });

  it('setBoundaries validates ordering', () => {
    const s = fresh();
    expect(() => s.setBoundaries(TENANT, 80, 50, 'a', NOW_MS)).toThrow(/red_min must be > amber_min/);
    expect(() => s.setBoundaries(TENANT, 0, 50, 'a', NOW_MS)).toThrow(/amber_min/);
    const ok = s.setBoundaries(TENANT, 45, 80, 'a', NOW_MS);
    expect(ok.amber_min).toBe(45);
    expect(ok.red_min).toBe(80);
    expect(ok.updated_by).toBe('a');
  });

  it('setAction edits one band; rejects unknown band + blank/overlong text', () => {
    const s = fresh();
    const up = s.setAction(TENANT, 'red', 'Page on-call immediately', 'a', NOW_MS);
    expect(up.bands.find((b) => b.band === 'red')!.action_required).toBe('Page on-call immediately');
    expect(() => s.setAction(TENANT, 'orange', 'x', 'a', NOW_MS)).toThrow(/unknown band/);
    expect(() => s.setAction(TENANT, 'red', '', 'a', NOW_MS)).toThrow(/required/);
    expect(() => s.setAction(TENANT, 'red', 'x'.repeat(201), 'a', NOW_MS)).toThrow(/exceeds/);
  });

  it('reset restores defaults', () => {
    const s = fresh();
    s.setBoundaries(TENANT, 30, 70, 'a', NOW_MS);
    s.setAction(TENANT, 'green', 'custom', 'a', NOW_MS);
    const back = s.reset(TENANT, 'admin', NOW_MS);
    expect(back.amber_min).toBe(60);
    expect(back.red_min).toBe(100);
    expect(back.bands[0].action_required).toBe('No action — monitor');
  });

  it('is tenant-scoped', () => {
    const s = fresh();
    s.setBoundaries(TENANT, 33, 66, 'a', NOW_MS);
    expect(s.get('BIL').amber_min).toBe(60); // BIL still seeded defaults
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

describe('alert_classification_config — routes', () => {
  beforeEach(() => _resetAlertClassificationConfigStore());

  it('GET returns the seeded RAG config', async () => {
    const r = await request(app()).get('/v1/config/alert-classification').set(H);
    expect(r.status).toBe(200);
    expect(r.body.body.bands.length).toBe(3);
    expect(r.body.body.amber_min).toBe(60);
    expect(r.body.body.red_min).toBe(100);
  });

  it('PUT /boundaries updates + 400 on bad ordering', async () => {
    const ok = await request(app()).put('/v1/config/alert-classification/boundaries').set(H).send({ amber_min: 40, red_min: 75 });
    expect(ok.status).toBe(200);
    expect(ok.body.body.amber_min).toBe(40);
    expect(ok.body.body.bands[0].max_score).toBe(40);
    const bad = await request(app()).put('/v1/config/alert-classification/boundaries').set(H).send({ amber_min: 80, red_min: 50 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('EWS_400_invalid_boundaries');
  });

  it('PATCH /bands/:band edits the action; 400 on unknown band', async () => {
    const ok = await request(app()).patch('/v1/config/alert-classification/bands/red').set(H).send({ action_required: 'Escalate to head of risk' });
    expect(ok.status).toBe(200);
    expect(ok.body.body.bands.find((b: { band: string }) => b.band === 'red').action_required).toBe('Escalate to head of risk');
    const bad = await request(app()).patch('/v1/config/alert-classification/bands/orange').set(H).send({ action_required: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('EWS_400_invalid_band');
  });

  it('POST /classify maps a score to a band; 400 on non-numeric', async () => {
    const red = await request(app()).post('/v1/config/alert-classification/classify').set(H).send({ score: 150 });
    expect(red.status).toBe(200);
    expect(red.body.body.band).toBe('red');
    const green = await request(app()).post('/v1/config/alert-classification/classify').set(H).send({ score: 10 });
    expect(green.body.body.band).toBe('green');
    const bad = await request(app()).post('/v1/config/alert-classification/classify').set(H).send({ score: 'high' });
    expect(bad.status).toBe(400);
  });

  it('POST /reset restores defaults', async () => {
    await request(app()).put('/v1/config/alert-classification/boundaries').set(H).send({ amber_min: 30, red_min: 70 });
    const reset = await request(app()).post('/v1/config/alert-classification/reset').set(H);
    expect(reset.status).toBe(200);
    expect(reset.body.body.amber_min).toBe(60);
  });

  it('non-admin role → 403', async () => {
    expect((await request(app('field_officer')).get('/v1/config/alert-classification').set(H)).status).toBe(403);
  });

  it('missing tenant header → 400', async () => {
    expect((await request(app()).get('/v1/config/alert-classification').set({ 'X-Channel': 'API' })).status).toBe(400);
  });

  it('cross-tenant isolation — BIL boundary edit invisible to BANK_DEMO', async () => {
    const bilH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-user': 'bil.admin' };
    await request(app()).put('/v1/config/alert-classification/boundaries').set(bilH).send({ amber_min: 25, red_min: 55 });
    const bank = await request(app()).get('/v1/config/alert-classification').set(H);
    expect(bank.body.body.amber_min).toBe(60);
  });
});
