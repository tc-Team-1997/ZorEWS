import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  InMemoryRiskScoreConfigStore,
  RiskScoreConfigError,
  summarizeWeights,
  isScoreFactorDomain,
  ALL_SCORE_FACTOR_DOMAINS,
  _resetRiskScoreConfigStore,
  FACTORS_PER_TENANT_MAX,
  type ScoreFactor,
} from '../src/risk_score_config';

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

// ─── Enums + pure summary ────────────────────────────────────────────

describe('risk_score_config — enums + summary', () => {
  it('ALL_SCORE_FACTOR_DOMAINS is the closed 3-value set + guard agrees', () => {
    expect(ALL_SCORE_FACTOR_DOMAINS).toEqual(['banking', 'insurance', 'both']);
    expect(isScoreFactorDomain('banking')).toBe(true);
    expect(isScoreFactorDomain('nope')).toBe(false);
    expect(isScoreFactorDomain(42)).toBe(false);
  });

  it('summarizeWeights sums ENABLED weights, flags balanced at 100', () => {
    const mk = (w: number, enabled = true): ScoreFactor => ({
      factor_id: 'x',
      tenant_id: TENANT,
      code: 'X',
      name: 'X',
      description: null,
      domain: 'banking',
      weight_pct: w,
      enabled,
      sort_order: 0,
      created_by: 's',
      created_at: '',
      updated_at: '',
    });
    const balanced = summarizeWeights([mk(30), mk(25), mk(25), mk(20)], 'banking');
    expect(balanced.total_weight_pct).toBe(100);
    expect(balanced.balanced).toBe(true);
    expect(balanced.remainder_pct).toBe(0);
    expect(balanced.enabled_count).toBe(4);

    // Disabled factor excluded from the sum.
    const imbalanced = summarizeWeights([mk(30), mk(25), mk(25), mk(20, false)], 'banking');
    expect(imbalanced.total_weight_pct).toBe(80);
    expect(imbalanced.balanced).toBe(false);
    expect(imbalanced.remainder_pct).toBe(20);
    expect(imbalanced.factor_count).toBe(4);
    expect(imbalanced.enabled_count).toBe(3);
  });
});

// ─── Store ───────────────────────────────────────────────────────────

describe('risk_score_config — store', () => {
  function freshStore() {
    return new InMemoryRiskScoreConfigStore();
  }

  it('seeds the MASTER SETUP example factors (banking sums to 100)', () => {
    const s = freshStore();
    const banking = s.list(TENANT, 'banking');
    expect(banking.length).toBe(4);
    expect(banking.map((f) => f.code)).toContain('OVERDUE');
    expect(summarizeWeights(banking, 'banking').total_weight_pct).toBe(100);
    const insurance = s.list(TENANT, 'insurance');
    expect(summarizeWeights(insurance, 'insurance').total_weight_pct).toBe(100);
    // 'all' returns both domains.
    expect(s.list(TENANT, 'all').length).toBe(8);
  });

  it('list is sorted by sort_order and returns defensive copies', () => {
    const s = freshStore();
    const a = s.list(TENANT, 'banking');
    for (let i = 1; i < a.length; i++) expect(a[i].sort_order).toBeGreaterThanOrEqual(a[i - 1].sort_order);
    a[0].weight_pct = 999;
    expect(s.list(TENANT, 'banking')[0].weight_pct).not.toBe(999);
  });

  it('create mints id, lands at end, rejects duplicate code + bad weight + bad domain', () => {
    const s = freshStore();
    const created = s.create(TENANT, { code: 'collateral', name: 'Collateral Cover', domain: 'banking', weight_pct: 10 }, 'alice', NOW_MS);
    expect(created.factor_id).toMatch(/^rsf-BANK_DEMO-\d{4}$/);
    expect(created.code).toBe('COLLATERAL'); // uppercased
    expect(s.list(TENANT, 'banking').length).toBe(5);
    expect(() => s.create(TENANT, { code: 'OVERDUE', name: 'dup', domain: 'banking', weight_pct: 5 }, 'a', NOW_MS)).toThrow(RiskScoreConfigError);
    expect(() => s.create(TENANT, { code: 'BADW', name: 'x', domain: 'banking', weight_pct: 150 }, 'a', NOW_MS)).toThrow(/weight_pct/);
    expect(() => s.create(TENANT, { code: 'BADD', name: 'x', domain: 'xx' as never, weight_pct: 5 }, 'a', NOW_MS)).toThrow(/domain/);
  });

  it('update edits fields + throws unknown_factor', () => {
    const s = freshStore();
    const f = s.list(TENANT, 'banking')[0];
    const up = s.update(TENANT, f.factor_id, { weight_pct: 42, enabled: false }, NOW_MS);
    expect(up.weight_pct).toBe(42);
    expect(up.enabled).toBe(false);
    expect(() => s.update(TENANT, 'rsf-NOPE-9999', { weight_pct: 1 }, NOW_MS)).toThrow(/unknown factor/);
  });

  it('remove drops the factor + throws unknown_factor on miss', () => {
    const s = freshStore();
    const f = s.list(TENANT, 'banking')[0];
    s.remove(TENANT, f.factor_id);
    expect(s.list(TENANT, 'banking').length).toBe(3);
    expect(() => s.remove(TENANT, f.factor_id)).toThrow(/unknown factor/);
  });

  it('reorder rewrites sort_order for the exact id set; rejects mismatched sets', () => {
    const s = freshStore();
    const ids = s.list(TENANT, 'banking').map((f) => f.factor_id);
    const reversed = [...ids].reverse();
    const out = s.reorder(TENANT, 'banking', reversed, NOW_MS);
    expect(out.map((f) => f.factor_id)).toEqual(reversed);
    expect(() => s.reorder(TENANT, 'banking', ids.slice(1), NOW_MS)).toThrow(/exact set/);
    expect(() => s.reorder(TENANT, 'banking', [...ids.slice(1), 'rsf-X-0001'], NOW_MS)).toThrow(/exact set/);
  });

  it('normalize rescales enabled weights to exactly 100 (last absorbs drift)', () => {
    const s = freshStore();
    // Skew the banking factors so they no longer sum to 100.
    const banking = s.list(TENANT, 'banking');
    s.update(TENANT, banking[0].factor_id, { weight_pct: 10 }, NOW_MS);
    s.update(TENANT, banking[1].factor_id, { weight_pct: 10 }, NOW_MS);
    // now 10 + 10 + 25 + 20 = 65 → normalize → 100
    const out = s.normalize(TENANT, 'banking', NOW_MS);
    expect(summarizeWeights(out, 'banking').total_weight_pct).toBe(100);
    expect(summarizeWeights(out, 'banking').balanced).toBe(true);
  });

  it('normalize ignores disabled factors + throws when nothing enabled or sum is 0', () => {
    const s = freshStore();
    const banking = s.list(TENANT, 'banking');
    // Disable one — normalize should rescale the remaining 3 to 100 and leave the disabled one untouched.
    s.update(TENANT, banking[3].factor_id, { enabled: false }, NOW_MS);
    const out = s.normalize(TENANT, 'banking', NOW_MS);
    const enabled = out.filter((f) => f.enabled);
    expect(summarizeWeights(enabled, 'banking').total_weight_pct).toBe(100);
    expect(out.find((f) => f.factor_id === banking[3].factor_id)!.enabled).toBe(false);

    // Disable ALL → throws.
    out.forEach((f) => s.update(TENANT, f.factor_id, { enabled: false }, NOW_MS));
    expect(() => s.normalize(TENANT, 'banking', NOW_MS)).toThrow(/no enabled/);
  });

  it('enforces the per-tenant factor cap', () => {
    const s = freshStore();
    const existing = s.list(TENANT, 'all').length;
    for (let i = existing; i < FACTORS_PER_TENANT_MAX; i++) {
      s.create(TENANT, { code: `F${i}`, name: `F${i}`, domain: 'both', weight_pct: 1 }, 'a', NOW_MS);
    }
    expect(() => s.create(TENANT, { code: 'OVERFLOW', name: 'x', domain: 'both', weight_pct: 1 }, 'a', NOW_MS)).toThrow(/cap/);
  });

  it('is tenant-scoped — BIL never sees BANK_DEMO factors', () => {
    const s = freshStore();
    const created = s.create(TENANT, { code: 'ONLYBANK', name: 'x', domain: 'banking', weight_pct: 5 }, 'a', NOW_MS);
    expect(s.get('BIL', created.factor_id)).toBeNull();
    expect(s.list('BIL', 'all').every((f) => f.code !== 'ONLYBANK')).toBe(true);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

describe('risk_score_config — routes', () => {
  beforeEach(() => _resetRiskScoreConfigStore());

  it('GET /factors returns seeded factors; ?domain filters', async () => {
    const all = await request(app()).get('/v1/config/risk-score/factors').set(H);
    expect(all.status).toBe(200);
    expect(all.body.body.total).toBe(8);
    const banking = await request(app()).get('/v1/config/risk-score/factors?domain=banking').set(H);
    expect(banking.body.body.factors.every((f: ScoreFactor) => f.domain === 'banking')).toBe(true);
    expect(banking.body.body.factors.length).toBe(4);
  });

  it('GET /summary reports balanced=true for the seeded banking set', async () => {
    const r = await request(app()).get('/v1/config/risk-score/summary?domain=banking').set(H);
    expect(r.status).toBe(200);
    expect(r.body.body.total_weight_pct).toBe(100);
    expect(r.body.body.balanced).toBe(true);
  });

  it('POST /factors creates (201) + 409 on duplicate code + 400 on bad weight', async () => {
    const ok = await request(app())
      .post('/v1/config/risk-score/factors')
      .set(H)
      .send({ code: 'COLLATERAL', name: 'Collateral Cover', domain: 'banking', weight_pct: 10 });
    expect(ok.status).toBe(201);
    expect(ok.body.body.code).toBe('COLLATERAL');

    const dup = await request(app())
      .post('/v1/config/risk-score/factors')
      .set(H)
      .send({ code: 'OVERDUE', name: 'dup', domain: 'banking', weight_pct: 5 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EWS_409_duplicate_code');

    const bad = await request(app())
      .post('/v1/config/risk-score/factors')
      .set(H)
      .send({ code: 'BADW', name: 'x', domain: 'banking', weight_pct: 150 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('EWS_400_invalid_weight');
  });

  it('PATCH /factors/:id updates; 404 on unknown', async () => {
    const list = await request(app()).get('/v1/config/risk-score/factors?domain=banking').set(H);
    const id = list.body.body.factors[0].factor_id;
    const up = await request(app()).patch(`/v1/config/risk-score/factors/${id}`).set(H).send({ weight_pct: 33 });
    expect(up.status).toBe(200);
    expect(up.body.body.weight_pct).toBe(33);
    const miss = await request(app()).patch('/v1/config/risk-score/factors/rsf-NOPE-9999').set(H).send({ weight_pct: 1 });
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('EWS_404_unknown_factor');
  });

  it('DELETE /factors/:id → 204 then 404', async () => {
    const list = await request(app()).get('/v1/config/risk-score/factors?domain=banking').set(H);
    const id = list.body.body.factors[0].factor_id;
    expect((await request(app()).delete(`/v1/config/risk-score/factors/${id}`).set(H)).status).toBe(204);
    expect((await request(app()).delete(`/v1/config/risk-score/factors/${id}`).set(H)).status).toBe(404);
  });

  it('POST /normalize rebalances enabled weights to exactly 100', async () => {
    const list = await request(app()).get('/v1/config/risk-score/factors?domain=banking').set(H);
    const factors = list.body.body.factors;
    await request(app()).patch(`/v1/config/risk-score/factors/${factors[0].factor_id}`).set(H).send({ weight_pct: 5 });
    const norm = await request(app()).post('/v1/config/risk-score/normalize').set(H).send({ domain: 'banking' });
    expect(norm.status).toBe(200);
    expect(norm.body.body.summary.total_weight_pct).toBe(100);
    expect(norm.body.body.summary.balanced).toBe(true);
  });

  it('POST /reorder reverses the banking order', async () => {
    const before = await request(app()).get('/v1/config/risk-score/factors?domain=banking').set(H);
    const ids = before.body.body.factors.map((f: ScoreFactor) => f.factor_id);
    const reversed = [...ids].reverse();
    const r = await request(app()).post('/v1/config/risk-score/reorder').set(H).send({ domain: 'banking', ordered_ids: reversed });
    expect(r.status).toBe(200);
    expect(r.body.body.factors.map((f: ScoreFactor) => f.factor_id)).toEqual(reversed);
    // bad set → 400
    const bad = await request(app()).post('/v1/config/risk-score/reorder').set(H).send({ domain: 'banking', ordered_ids: ids.slice(1) });
    expect(bad.status).toBe(400);
  });

  it('non-admin role → 403 on every route', async () => {
    const a = app('field_officer');
    expect((await request(a).get('/v1/config/risk-score/factors').set(H)).status).toBe(403);
    expect((await request(a).post('/v1/config/risk-score/factors').set(H).send({ code: 'X', name: 'x', domain: 'banking', weight_pct: 1 })).status).toBe(403);
  });

  it('missing tenant header → 400', async () => {
    const r = await request(app()).get('/v1/config/risk-score/factors').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
  });

  it('cross-tenant isolation via HTTP — BIL factor invisible to BANK_DEMO', async () => {
    const bilH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-user': 'bil.admin' };
    const created = await request(app()).post('/v1/config/risk-score/factors').set(bilH).send({ code: 'BILONLY', name: 'x', domain: 'banking', weight_pct: 3 });
    expect(created.status).toBe(201);
    const bankList = await request(app()).get('/v1/config/risk-score/factors').set(H);
    expect(bankList.body.body.factors.every((f: ScoreFactor) => f.code !== 'BILONLY')).toBe(true);
  });
});
