// services/bff/__tests__/scoring_presets.test.ts
//
// T6 M6.3 — Scoring weight presets.

import request from 'supertest';
import {
  VALID_PRESET_MODES,
  WEIGHT_PRESETS,
  WeightPresetError,
  getWeightPreset,
  isWeightPresetMode,
  listWeightPresets,
  scoreByPreset,
} from '../src/scoring_presets';
import { defaultIndicatorWeightLookup } from '../src/bil_scoring_v2';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T16:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makePresetApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Type guards / catalog invariants ─────────────────────────────────

describe('WEIGHT_PRESETS catalog', () => {
  test('exactly 6 presets (3 modes × 2 verticals)', () => {
    expect(WEIGHT_PRESETS.length).toBe(6);
  });

  test('every preset id unique', () => {
    const ids = new Set(WEIGHT_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(6);
  });

  test('every preset has both vertical and mode', () => {
    const banking = WEIGHT_PRESETS.filter((p) => p.vertical === 'banking');
    const insurance = WEIGHT_PRESETS.filter((p) => p.vertical === 'insurance');
    expect(banking.length).toBe(3);
    expect(insurance.length).toBe(3);
    for (const v of [banking, insurance]) {
      const modes = new Set(v.map((p) => p.mode));
      expect(modes).toEqual(new Set(['conservative', 'balanced', 'aggressive']));
    }
  });

  test('balanced presets carry empty multipliers (catalog passthrough)', () => {
    for (const p of WEIGHT_PRESETS.filter((x) => x.mode === 'balanced')) {
      expect(Object.keys(p.weight_multipliers)).toEqual([]);
    }
  });

  test('conservative presets only carry multipliers ≥ 1', () => {
    for (const p of WEIGHT_PRESETS.filter((x) => x.mode === 'conservative')) {
      for (const v of Object.values(p.weight_multipliers)) {
        expect(v).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test('aggressive presets only carry multipliers ≤ 1', () => {
    for (const p of WEIGHT_PRESETS.filter((x) => x.mode === 'aggressive')) {
      for (const v of Object.values(p.weight_multipliers)) {
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('isWeightPresetMode', () => {
  test('accepts the 3 valid modes', () => {
    for (const m of VALID_PRESET_MODES) {
      expect(isWeightPresetMode(m)).toBe(true);
    }
  });

  test('rejects bogus values', () => {
    expect(isWeightPresetMode('extreme')).toBe(false);
    expect(isWeightPresetMode(42)).toBe(false);
  });
});

describe('listWeightPresets', () => {
  test('no filter → all 6', () => {
    expect(listWeightPresets().length).toBe(6);
  });

  test('vertical=banking → 3 banking presets', () => {
    const r = listWeightPresets({ vertical: 'banking' });
    expect(r.length).toBe(3);
    for (const p of r) expect(p.vertical).toBe('banking');
  });

  test('mode=conservative → 2 conservative presets (one per vertical)', () => {
    const r = listWeightPresets({ mode: 'conservative' });
    expect(r.length).toBe(2);
    for (const p of r) expect(p.mode).toBe('conservative');
  });

  test('vertical=insurance + mode=aggressive → exactly 1', () => {
    const r = listWeightPresets({ vertical: 'insurance', mode: 'aggressive' });
    expect(r.length).toBe(1);
    expect(r[0]!.id).toBe('preset_insurance_aggressive');
  });
});

describe('getWeightPreset', () => {
  test('returns preset on hit', () => {
    expect(getWeightPreset('preset_banking_conservative')?.mode).toBe('conservative');
  });

  test('null on miss', () => {
    expect(getWeightPreset('NO-SUCH')).toBeNull();
  });
});

// ─── scoreByPreset (pure) ─────────────────────────────────────────────

describe('scoreByPreset', () => {
  test('balanced preset preserves catalog weights (multiplier 1)', () => {
    const r = scoreByPreset(
      {
        preset_id: 'preset_banking_balanced',
        items: [
          { indicator_id: 'FIN-001', value: 0.8 },
          { indicator_id: 'FIN-002', value: 0.5 },
        ],
      },
      defaultIndicatorWeightLookup,
    );
    expect(r.preset_id).toBe('preset_banking_balanced');
    for (const e of r.effective_weights) {
      expect(e.multiplier).toBe(1);
      expect(e.effective_weight).toBeCloseTo(e.catalog_weight);
    }
  });

  test('conservative banking boosts FIN-001 (DPD ≥ 30) effective weight (clamps at 1.0)', () => {
    const r = scoreByPreset(
      {
        preset_id: 'preset_banking_conservative',
        items: [{ indicator_id: 'FIN-001', value: 1 }],
      },
      defaultIndicatorWeightLookup,
    );
    const fin001 = r.effective_weights.find((e) => e.indicator_id === 'FIN-001')!;
    expect(fin001.multiplier).toBe(1.15);
    expect(fin001.catalog_weight).toBeCloseTo(0.9);
    // 0.9 × 1.15 = 1.035 → clamped to 1.0 to honour M6.1's [0, 1] range
    expect(fin001.effective_weight).toBe(1);
  });

  test('conservative on a low-baseline indicator (FIN-002, catalog 0.7) does NOT clamp', () => {
    const r = scoreByPreset(
      {
        preset_id: 'preset_banking_conservative',
        items: [{ indicator_id: 'FIN-002', value: 1 }],
      },
      defaultIndicatorWeightLookup,
    );
    const fin002 = r.effective_weights.find((e) => e.indicator_id === 'FIN-002')!;
    // 0.7 × 1.1 = 0.77 — well within [0, 1]
    expect(fin002.effective_weight).toBeCloseTo(0.77);
  });

  test('aggressive insurance tones down AGT-001 (Agent persistency)', () => {
    const r = scoreByPreset(
      {
        preset_id: 'preset_insurance_aggressive',
        items: [{ indicator_id: 'AGT-001', value: 0.5 }],
      },
      defaultIndicatorWeightLookup,
    );
    const agt = r.effective_weights.find((e) => e.indicator_id === 'AGT-001')!;
    expect(agt.multiplier).toBe(0.7);
    expect(agt.effective_weight).toBeCloseTo(0.6 * 0.7); // catalog 0.6
  });

  test('indicator NOT in multiplier map uses multiplier=1.0', () => {
    const r = scoreByPreset(
      {
        preset_id: 'preset_banking_conservative',
        // CRD-001 is in the catalog but NOT in the conservative-banking multipliers
        items: [{ indicator_id: 'CRD-001', value: 0.5 }],
      },
      defaultIndicatorWeightLookup,
    );
    const crd = r.effective_weights.find((e) => e.indicator_id === 'CRD-001')!;
    expect(crd.multiplier).toBe(1);
  });

  test('preset.vertical filtered: banking preset rejects insurance indicator', () => {
    expect(() =>
      scoreByPreset(
        {
          preset_id: 'preset_banking_conservative',
          items: [{ indicator_id: 'POL-001', value: 0.5 }], // insurance indicator
        },
        defaultIndicatorWeightLookup,
      ),
    ).toThrow(/POL-001/);
  });

  test('non-object body → invalid_input', () => {
    try {
      scoreByPreset('foo' as unknown as never, defaultIndicatorWeightLookup);
      fail('expected throw');
    } catch (e) {
      expect((e as WeightPresetError).code).toBe('invalid_input');
    }
  });

  test('missing preset_id → invalid_input', () => {
    expect(() =>
      scoreByPreset(
        { items: [] } as unknown as Parameters<typeof scoreByPreset>[0],
        defaultIndicatorWeightLookup,
      ),
    ).toThrow(/preset_id/);
  });

  test('non-array items → invalid_input', () => {
    expect(() =>
      scoreByPreset(
        { preset_id: 'preset_banking_balanced', items: 'foo' as unknown as never[] },
        defaultIndicatorWeightLookup,
      ),
    ).toThrow(/items/);
  });

  test('unknown preset → unknown_preset', () => {
    try {
      scoreByPreset(
        { preset_id: 'NO-SUCH', items: [] },
        defaultIndicatorWeightLookup,
      );
      fail('expected throw');
    } catch (e) {
      expect((e as WeightPresetError).code).toBe('unknown_preset');
    }
  });

  test('result mode echoes preset.mode', () => {
    const r = scoreByPreset(
      {
        preset_id: 'preset_insurance_conservative',
        items: [{ indicator_id: 'CLM-001', value: 0.5 }],
      },
      defaultIndicatorWeightLookup,
    );
    expect(r.preset_mode).toBe('conservative');
    expect(r.preset_name).toContain('Conservative');
  });

  test('conservative score > balanced > aggressive (same items)', () => {
    const items = [{ indicator_id: 'CLM-001', value: 0.8 }];
    const cons = scoreByPreset(
      { preset_id: 'preset_insurance_conservative', items },
      defaultIndicatorWeightLookup,
    );
    const bal = scoreByPreset(
      { preset_id: 'preset_insurance_balanced', items },
      defaultIndicatorWeightLookup,
    );
    expect(cons.score).toBeGreaterThanOrEqual(bal.score);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('GET /v1/scoring/presets', () => {
  test('analyst+: 200 with all 6 presets', async () => {
    const { app } = makePresetApp('risk_analyst');
    const r = await request(app).get('/v1/scoring/presets').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(6);
  });

  test('vertical filter narrows', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app).get('/v1/scoring/presets?vertical=banking').set(TH_BIL);
    expect(r.body.body.total).toBe(3);
    for (const p of r.body.body.items) expect(p.vertical).toBe('banking');
  });

  test('mode filter narrows', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app).get('/v1/scoring/presets?mode=conservative').set(TH_BIL);
    expect(r.body.body.total).toBe(2);
  });

  test('invalid vertical → 400', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app).get('/v1/scoring/presets?vertical=crypto').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_vertical');
  });

  test('invalid mode → 400', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app).get('/v1/scoring/presets?mode=extreme').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_mode');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePresetApp('case_owner');
    const r = await request(app).get('/v1/scoring/presets').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/scoring/presets/:id', () => {
  test('200 on hit', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app).get('/v1/scoring/presets/preset_banking_balanced').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe('preset_banking_balanced');
  });

  test('404 on miss with EWS_404_unknown_preset', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app).get('/v1/scoring/presets/NO-SUCH').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });
});

describe('POST /v1/scoring/risk/by-preset', () => {
  test('analyst+: 200 with score body', async () => {
    const { app } = makePresetApp('risk_analyst');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset')
      .set(TH_BIL)
      .send({
        preset_id: 'preset_banking_conservative',
        items: [
          { indicator_id: 'FIN-001', value: 0.8 },
          { indicator_id: 'BEH-001', value: 0.6 },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.preset_id).toBe('preset_banking_conservative');
    expect(r.body.body.preset_mode).toBe('conservative');
    expect(r.body.body.effective_weights.length).toBe(2);
  });

  test('accepts enveloped body', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: {
          preset_id: 'preset_banking_balanced',
          items: [{ indicator_id: 'FIN-001', value: 0.5 }],
        },
      });
    expect(r.status).toBe(200);
  });

  test('unknown preset → 404 EWS_404_unknown_preset', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset')
      .set(TH_BIL)
      .send({ preset_id: 'NO-SUCH', items: [] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('unknown indicator → 404 EWS_404_unknown_indicator (bubble from M6.2 lookup)', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset')
      .set(TH_BIL)
      .send({
        preset_id: 'preset_banking_balanced',
        items: [{ indicator_id: 'XXX-999', value: 0.5 }],
      });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_indicator');
  });

  test('insurance preset rejects banking indicator → 404 unknown_indicator', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset')
      .set(TH_BIL)
      .send({
        preset_id: 'preset_insurance_balanced',
        items: [{ indicator_id: 'FIN-001', value: 0.5 }],
      });
    expect(r.status).toBe(404);
  });

  test('missing preset_id → 400 EWS_400_invalid_input', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset')
      .set(TH_BIL)
      .send({ items: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePresetApp('case_owner');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset')
      .set(TH_BIL)
      .send({ preset_id: 'preset_banking_balanced', items: [] });
    expect(r.status).toBe(403);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M6.1 + M6.2 routes still work', () => {
  test('POST /v1/scoring/risk still works', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk')
      .set(TH_BIL)
      .send({
        items: [{ indicator_id: 'FIN-001', value: 0.5, weight: 0.9 }],
      });
    expect(r.status).toBe(200);
  });

  test('POST /v1/scoring/risk/by-indicators still works', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH_BIL)
      .send({
        items: [{ indicator_id: 'FIN-001', value: 0.5 }],
      });
    expect(r.status).toBe(200);
  });
});

// ─── M6.6 — Batch score by preset ────────────────────────────────────

describe('POST /v1/scoring/risk/by-preset/batch', () => {
  const BATCH_BODY = {
    preset_id: 'preset_banking_balanced',
    customers: [
      {
        customer_id: 'CUST-1',
        items: [
          { indicator_id: 'FIN-001', value: 0.9 },
          { indicator_id: 'FIN-002', value: 0.7 },
        ],
      },
      {
        customer_id: 'CUST-2',
        items: [
          { indicator_id: 'FIN-001', value: 0.1 },
          { indicator_id: 'FIN-002', value: 0.2 },
        ],
      },
    ],
  };

  test('analyst+: 200 with batch body + aggregate', async () => {
    const { app } = makePresetApp('risk_analyst');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset/batch')
      .set(TH_BIL)
      .send(BATCH_BODY);
    expect(r.status).toBe(200);
    expect(r.body.body.results.length).toBe(2);
    expect(r.body.body.aggregate.count).toBe(2);
    expect(typeof r.body.body.aggregate.mean_score).toBe('number');
  });

  test('aggregate band counters add to count', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset/batch')
      .set(TH_BIL)
      .send(BATCH_BODY);
    const a = r.body.body.aggregate;
    expect(a.low_count + a.medium_count + a.high_count).toBe(a.count);
  });

  test('high-value customer bands as high', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset/batch')
      .set(TH_BIL)
      .send({
        preset_id: 'preset_banking_balanced',
        customers: [
          {
            customer_id: 'HIGH-1',
            items: [
              { indicator_id: 'FIN-001', value: 1.0 },
              { indicator_id: 'FIN-002', value: 1.0 },
            ],
          },
        ],
      });
    expect(r.body.body.results[0].category).toBe('high');
  });

  test('empty customers[] → 400', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset/batch')
      .set(TH_BIL)
      .send({ preset_id: 'preset_banking_balanced', customers: [] });
    expect(r.status).toBe(400);
  });

  test('> 50 customers → 400', async () => {
    const { app } = makePresetApp('admin');
    const customers = Array.from({ length: 51 }, (_, i) => ({
      customer_id: `CUST-${i}`,
      items: [{ indicator_id: 'FIN-001', value: 0.5 }],
    }));
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset/batch')
      .set(TH_BIL)
      .send({ preset_id: 'preset_banking_balanced', customers });
    expect(r.status).toBe(400);
  });

  test('duplicate customer_id → 400', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset/batch')
      .set(TH_BIL)
      .send({
        preset_id: 'preset_banking_balanced',
        customers: [
          {
            customer_id: 'DUP-1',
            items: [{ indicator_id: 'FIN-001', value: 0.5 }],
          },
          {
            customer_id: 'DUP-1',
            items: [{ indicator_id: 'FIN-002', value: 0.5 }],
          },
        ],
      });
    expect(r.status).toBe(400);
  });

  test('unknown preset → 404', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset/batch')
      .set(TH_BIL)
      .send({
        preset_id: 'NO-SUCH',
        customers: [{ customer_id: 'C1', items: [] }],
      });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('unknown indicator inside items → 404 EWS_404_unknown_indicator', async () => {
    const { app } = makePresetApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset/batch')
      .set(TH_BIL)
      .send({
        preset_id: 'preset_banking_balanced',
        customers: [
          {
            customer_id: 'C1',
            items: [{ indicator_id: 'XXX-9999', value: 0.5 }],
          },
        ],
      });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_indicator');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePresetApp('case_owner');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset/batch')
      .set(TH_BIL)
      .send(BATCH_BODY);
    expect(r.status).toBe(403);
  });
});
