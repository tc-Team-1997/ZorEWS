// services/bff/__tests__/indicator_thresholds.test.ts
//
// T6 M4.3 — KRI threshold breach detection.

import request from 'supertest';
import {
  InMemoryThresholdOverrideStore,
  ThresholdError,
  assertThresholdCoverage,
  checkBreach,
  checkBreachById,
  getEffectiveThreshold,
  getThreshold,
  listThresholds,
} from '../src/indicator_thresholds';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T10:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeThrApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('Threshold catalog invariants', () => {
  test('every M6.2 catalog indicator has a default threshold', () => {
    expect(() => assertThresholdCoverage()).not.toThrow();
  });

  test('thresholds are monotonic: yellow_at ≤ orange_at ≤ red_at', () => {
    for (const t of listThresholds()) {
      expect(t.yellow_at).toBeLessThanOrEqual(t.orange_at);
      expect(t.orange_at).toBeLessThanOrEqual(t.red_at);
    }
  });

  test('all thresholds in [0, 1]', () => {
    for (const t of listThresholds()) {
      expect(t.yellow_at).toBeGreaterThanOrEqual(0);
      expect(t.red_at).toBeLessThanOrEqual(1);
    }
  });

  test('listThresholds with vertical filter', () => {
    const banking = listThresholds({ vertical: 'banking' });
    const insurance = listThresholds({ vertical: 'insurance' });
    expect(banking.length).toBe(8);
    expect(insurance.length).toBe(9);
    expect(banking.every((t) => t.vertical === 'banking')).toBe(true);
  });

  test('getThreshold returns null on unknown', () => {
    expect(getThreshold('NO-SUCH')).toBeNull();
  });
});

describe('checkBreach pure', () => {
  const dpdThreshold = getThreshold('FIN-001')!; // 0.30 / 0.55 / 0.80

  test('value below yellow → green; headroom = yellow_at - value', () => {
    const r = checkBreach(dpdThreshold, 0.10);
    expect(r.breach_class).toBe('green');
    expect(r.threshold_crossed).toBeNull();
    expect(r.headroom_to_next).toBeCloseTo(0.20);
  });

  test('value at yellow_at exactly → yellow', () => {
    const r = checkBreach(dpdThreshold, 0.30);
    expect(r.breach_class).toBe('yellow');
    expect(r.threshold_crossed).toBe(0.30);
  });

  test('value between yellow and orange → yellow', () => {
    const r = checkBreach(dpdThreshold, 0.45);
    expect(r.breach_class).toBe('yellow');
    expect(r.headroom_to_next).toBeCloseTo(0.55 - 0.45);
  });

  test('value at orange_at → orange', () => {
    const r = checkBreach(dpdThreshold, 0.55);
    expect(r.breach_class).toBe('orange');
    expect(r.threshold_crossed).toBe(0.55);
    expect(r.headroom_to_next).toBeCloseTo(0.80 - 0.55);
  });

  test('value at red_at → red', () => {
    const r = checkBreach(dpdThreshold, 0.80);
    expect(r.breach_class).toBe('red');
    expect(r.threshold_crossed).toBe(0.80);
    expect(r.headroom_to_next).toBeNull();
  });

  test('value above red → red, headroom_to_next null', () => {
    const r = checkBreach(dpdThreshold, 0.95);
    expect(r.breach_class).toBe('red');
    expect(r.headroom_to_next).toBeNull();
  });

  test('rejects non-finite value', () => {
    expect(() => checkBreach(dpdThreshold, NaN)).toThrow(/finite/);
    expect(() => checkBreach(dpdThreshold, Infinity)).toThrow(/finite/);
  });

  test('rejects out-of-range value', () => {
    expect(() => checkBreach(dpdThreshold, -0.1)).toThrow(/\[0, 1\]/);
    expect(() => checkBreach(dpdThreshold, 1.1)).toThrow(/\[0, 1\]/);
  });

  test('repeat-claim tighter thresholds: 0.50 already = orange', () => {
    const repeatClaim = getThreshold('CLM-001')!; // 0.25 / 0.50 / 0.75
    expect(checkBreach(repeatClaim, 0.50).breach_class).toBe('orange');
    expect(checkBreach(repeatClaim, 0.55).breach_class).toBe('orange');
    expect(checkBreach(repeatClaim, 0.75).breach_class).toBe('red');
  });
});

describe('checkBreachById', () => {
  test('happy path', () => {
    const r = checkBreachById('FIN-001', 0.85);
    expect(r.breach_class).toBe('red');
    expect(r.indicator_id).toBe('FIN-001');
    expect(r.name).toBe('DPD ≥ 30 days');
  });

  test('missing indicator_id → invalid_input', () => {
    expect(() => checkBreachById('', 0.5)).toThrow(/indicator_id/);
    expect(() => checkBreachById(undefined, 0.5)).toThrow(/indicator_id/);
  });

  test('non-number value → invalid_input', () => {
    expect(() => checkBreachById('FIN-001', '0.5')).toThrow(/value must be a number/);
  });

  test('unknown indicator → unknown_indicator', () => {
    try {
      checkBreachById('NO-SUCH', 0.5);
      fail('expected throw');
    } catch (e) {
      expect((e as ThresholdError).code).toBe('unknown_indicator');
    }
  });
});

describe('GET /v1/indicators/thresholds', () => {
  test('analyst+: 200 with all 17', async () => {
    const { app } = makeThrApp('risk_analyst');
    const r = await request(app).get('/v1/indicators/thresholds').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(17);
  });

  test('vertical filter narrows', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app)
      .get('/v1/indicators/thresholds?vertical=banking')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(8);
  });

  test('invalid vertical → 400', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app)
      .get('/v1/indicators/thresholds?vertical=crypto')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_vertical');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeThrApp('case_owner');
    const r = await request(app).get('/v1/indicators/thresholds').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/indicators/thresholds/:indicator_id', () => {
  test('200 on hit', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app).get('/v1/indicators/thresholds/CLM-001').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.indicator_id).toBe('CLM-001');
    expect(r.body.body.red_at).toBe(0.75);
  });

  test('404 on miss', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app).get('/v1/indicators/thresholds/NO-SUCH').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_indicator');
  });
});

describe('POST /v1/indicators/thresholds/check', () => {
  test('analyst+: 200 with breach result', async () => {
    const { app } = makeThrApp('risk_analyst');
    const r = await request(app)
      .post('/v1/indicators/thresholds/check')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', value: 0.85 });
    expect(r.status).toBe(200);
    expect(r.body.body.breach_class).toBe('red');
  });

  test('green value', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app)
      .post('/v1/indicators/thresholds/check')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', value: 0.10 });
    expect(r.body.body.breach_class).toBe('green');
    expect(r.body.body.threshold_crossed).toBeNull();
  });

  test('accepts enveloped body', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app)
      .post('/v1/indicators/thresholds/check')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { indicator_id: 'CLM-001', value: 0.75 },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.breach_class).toBe('red');
  });

  test('missing indicator_id → 400', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app)
      .post('/v1/indicators/thresholds/check')
      .set(TH_BIL)
      .send({ value: 0.5 });
    expect(r.status).toBe(400);
  });

  test('value out of range → 400', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app)
      .post('/v1/indicators/thresholds/check')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', value: 1.5 });
    expect(r.status).toBe(400);
  });

  test('unknown indicator → 404', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app)
      .post('/v1/indicators/thresholds/check')
      .set(TH_BIL)
      .send({ indicator_id: 'NO-SUCH', value: 0.5 });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_indicator');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeThrApp('case_owner');
    const r = await request(app)
      .post('/v1/indicators/thresholds/check')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', value: 0.5 });
    expect(r.status).toBe(403);
  });
});

// ─── M4.4 — Per-tenant override store ────────────────────────────────

describe('InMemoryThresholdOverrideStore', () => {
  test('effective falls through to library default when no override', () => {
    const s = new InMemoryThresholdOverrideStore();
    const t = s.effective('BIL', 'FIN-001');
    expect(t).not.toBeNull();
    expect(t!.red_at).toBe(0.80);
  });

  test('effective null on unknown indicator', () => {
    const s = new InMemoryThresholdOverrideStore();
    expect(s.effective('BIL', 'NO-SUCH')).toBeNull();
  });

  test('setOverride persists + effective returns it', () => {
    const s = new InMemoryThresholdOverrideStore();
    s.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.10,
      orange_at: 0.20,
      red_at: 0.30,
    });
    const t = s.effective('BIL', 'FIN-001');
    expect(t!.red_at).toBe(0.30);
  });

  test('setOverride rejects unknown indicator', () => {
    const s = new InMemoryThresholdOverrideStore();
    try {
      s.setOverride('BIL', 'NO-SUCH', {
        yellow_at: 0.1,
        orange_at: 0.2,
        red_at: 0.3,
      });
      fail('expected throw');
    } catch (e) {
      expect((e as ThresholdError).code).toBe('unknown_indicator');
    }
  });

  test('setOverride rejects non-monotonic values', () => {
    const s = new InMemoryThresholdOverrideStore();
    expect(() =>
      s.setOverride('BIL', 'FIN-001', {
        yellow_at: 0.7,
        orange_at: 0.5, // out of order
        red_at: 0.9,
      }),
    ).toThrow(/monotonic/);
  });

  test('setOverride rejects out-of-range', () => {
    const s = new InMemoryThresholdOverrideStore();
    expect(() =>
      s.setOverride('BIL', 'FIN-001', {
        yellow_at: 0.1,
        orange_at: 0.5,
        red_at: 1.5,
      }),
    ).toThrow(/\[0, 1\]/);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryThresholdOverrideStore();
    s.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.10,
      orange_at: 0.20,
      red_at: 0.30,
    });
    expect(s.effective('BIL', 'FIN-001')!.red_at).toBe(0.30);
    // BANK_DEMO falls through to library default 0.80
    expect(s.effective('BANK_DEMO', 'FIN-001')!.red_at).toBe(0.80);
  });

  test('listOverrides scoped to tenant', () => {
    const s = new InMemoryThresholdOverrideStore();
    s.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.1,
      orange_at: 0.2,
      red_at: 0.3,
    });
    s.setOverride('BANK_DEMO', 'FIN-002', {
      yellow_at: 0.4,
      orange_at: 0.5,
      red_at: 0.6,
    });
    expect(s.listOverrides('BIL').length).toBe(1);
    expect(s.listOverrides('BIL')[0]!.indicator_id).toBe('FIN-001');
    expect(s.listOverrides('BANK_DEMO').length).toBe(1);
  });

  test('deleteOverride: hit then miss', () => {
    const s = new InMemoryThresholdOverrideStore();
    s.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.1,
      orange_at: 0.2,
      red_at: 0.3,
    });
    expect(s.deleteOverride('BIL', 'FIN-001')).toBe(true);
    expect(s.deleteOverride('BIL', 'FIN-001')).toBe(false);
    expect(s.effective('BIL', 'FIN-001')!.red_at).toBe(0.80); // back to default
  });

  test('checkBreachById with effective lookup uses override', () => {
    const s = new InMemoryThresholdOverrideStore();
    s.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.10,
      orange_at: 0.20,
      red_at: 0.30,
    });
    // value 0.35 — green under default (0.80 red), red under override (0.30 red)
    const r = checkBreachById(
      'FIN-001',
      0.35,
      (id) => getEffectiveThreshold(s, 'BIL', id),
    );
    expect(r.breach_class).toBe('red');
  });
});

describe('M4.4 routes', () => {
  test('PUT override → 200 with stored shape', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app)
      .put('/v1/indicators/thresholds/FIN-001')
      .set(TH_BIL)
      .send({ yellow_at: 0.1, orange_at: 0.2, red_at: 0.3 });
    expect(r.status).toBe(200);
    expect(r.body.body.red_at).toBe(0.3);
    expect(r.body.body.indicator_id).toBe('FIN-001');
  });

  test('GET /:id reflects override', async () => {
    const { app } = makeThrApp('admin');
    await request(app)
      .put('/v1/indicators/thresholds/FIN-001')
      .set(TH_BIL)
      .send({ yellow_at: 0.1, orange_at: 0.2, red_at: 0.3 });
    const r = await request(app).get('/v1/indicators/thresholds/FIN-001').set(TH_BIL);
    expect(r.body.body.red_at).toBe(0.3);
  });

  test('POST /check uses effective threshold', async () => {
    const { app } = makeThrApp('admin');
    await request(app)
      .put('/v1/indicators/thresholds/FIN-001')
      .set(TH_BIL)
      .send({ yellow_at: 0.1, orange_at: 0.2, red_at: 0.3 });
    const r = await request(app)
      .post('/v1/indicators/thresholds/check')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', value: 0.35 });
    // 0.35 > red_at=0.3 → red
    expect(r.body.body.breach_class).toBe('red');
  });

  test('GET /overrides lists tenant-scoped overrides', async () => {
    const { app } = makeThrApp('admin');
    await request(app)
      .put('/v1/indicators/thresholds/FIN-001')
      .set(TH_BIL)
      .send({ yellow_at: 0.1, orange_at: 0.2, red_at: 0.3 });
    const r = await request(app).get('/v1/indicators/thresholds/overrides').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
  });

  test('DELETE 204 then 404 then GET reverts to default', async () => {
    const { app } = makeThrApp('admin');
    await request(app)
      .put('/v1/indicators/thresholds/FIN-001')
      .set(TH_BIL)
      .send({ yellow_at: 0.1, orange_at: 0.2, red_at: 0.3 });
    const d1 = await request(app).delete('/v1/indicators/thresholds/FIN-001').set(TH_BIL);
    expect(d1.status).toBe(204);
    const d2 = await request(app).delete('/v1/indicators/thresholds/FIN-001').set(TH_BIL);
    expect(d2.status).toBe(404);
    expect(d2.body.error.code).toBe('EWS_404_no_override');
    const g = await request(app).get('/v1/indicators/thresholds/FIN-001').set(TH_BIL);
    expect(g.body.body.red_at).toBe(0.80); // default restored
  });

  test('PUT non-monotonic → 400', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app)
      .put('/v1/indicators/thresholds/FIN-001')
      .set(TH_BIL)
      .send({ yellow_at: 0.7, orange_at: 0.5, red_at: 0.9 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('PUT unknown indicator → 404', async () => {
    const { app } = makeThrApp('admin');
    const r = await request(app)
      .put('/v1/indicators/thresholds/NO-SUCH')
      .set(TH_BIL)
      .send({ yellow_at: 0.1, orange_at: 0.2, red_at: 0.3 });
    expect(r.status).toBe(404);
  });

  test('cross-tenant: BIL override not visible from BANK_DEMO', async () => {
    const { app } = makeThrApp('admin');
    await request(app)
      .put('/v1/indicators/thresholds/FIN-001')
      .set(TH_BIL)
      .send({ yellow_at: 0.1, orange_at: 0.2, red_at: 0.3 });
    const r = await request(app)
      .get('/v1/indicators/thresholds/FIN-001')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.body.body.red_at).toBe(0.80); // BANK_DEMO sees default
  });

  test('PUT non-allowed role → 403', async () => {
    const { app } = makeThrApp('case_owner');
    const r = await request(app)
      .put('/v1/indicators/thresholds/FIN-001')
      .set(TH_BIL)
      .send({ yellow_at: 0.1, orange_at: 0.2, red_at: 0.3 });
    expect(r.status).toBe(403);
  });
});
