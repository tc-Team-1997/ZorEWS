// services/bff/__tests__/scoring_what_if.test.ts
//
// T6 M6.14 — Score what-if across all library presets.

import request from 'supertest';
import { buildScoreWhatIf } from '../src/scoring_what_if';
import { defaultIndicatorWeightLookup } from '../src/bil_scoring_v2';
import { WEIGHT_PRESETS, WeightPresetError } from '../src/scoring_presets';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const bankingItems = [
  { indicator_id: 'FIN-001', value: 0.8 },
  { indicator_id: 'BEH-001', value: 0.5 },
];
const insuranceItems = [
  { indicator_id: 'POL-001', value: 0.6 },
];

// ─── buildScoreWhatIf — pure ─────────────────────────────────────────

describe('M6.14 — banking what-if', () => {
  test('every banking preset scored once', () => {
    const r = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    const bankingPresetCount = WEIGHT_PRESETS.filter((p) => p.vertical === 'banking').length;
    expect(r.total_presets_considered).toBe(bankingPresetCount);
    expect(r.presets.length).toBe(bankingPresetCount);
    expect(r.vertical).toBe('banking');
    expect(r.items_count).toBe(bankingItems.length);
  });
});

describe('M6.14 — insurance what-if', () => {
  test('every insurance preset scored once', () => {
    const r = buildScoreWhatIf(
      { vertical: 'insurance', items: insuranceItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    const insurancePresetCount = WEIGHT_PRESETS.filter((p) => p.vertical === 'insurance').length;
    expect(r.total_presets_considered).toBe(insurancePresetCount);
    expect(r.vertical).toBe('insurance');
  });
});

describe('M6.14 — sort order', () => {
  test('presets sorted by score desc with preset_id asc tie-break', () => {
    const r = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    for (let i = 1; i < r.presets.length; i++) {
      const prev = r.presets[i - 1]!;
      const curr = r.presets[i]!;
      if (prev.score === curr.score) {
        expect(prev.preset_id < curr.preset_id).toBe(true);
      } else {
        expect(prev.score).toBeGreaterThan(curr.score);
      }
    }
  });
});

describe('M6.14 — peak_preset + lowest_preset', () => {
  test('peak = first row, lowest = last row', () => {
    const r = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    expect(r.peak_preset!.preset_id).toBe(r.presets[0]!.preset_id);
    expect(r.peak_preset!.score).toBe(r.presets[0]!.score);
    expect(r.lowest_preset!.preset_id).toBe(r.presets[r.presets.length - 1]!.preset_id);
    expect(r.lowest_preset!.score).toBe(r.presets[r.presets.length - 1]!.score);
  });
});

describe('M6.14 — spread', () => {
  test('spread = peak.score - lowest.score', () => {
    const r = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    expect(r.spread).toBeCloseTo(r.peak_preset!.score - r.lowest_preset!.score);
  });

  test('spread >= 0', () => {
    const r = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    expect(r.spread).toBeGreaterThanOrEqual(0);
  });
});

describe('M6.14 — delta_vs_balanced', () => {
  test('balanced preset has delta=0', () => {
    const r = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    const balanced = r.presets.find((p) => p.preset_mode === 'balanced')!;
    expect(balanced.delta_vs_balanced).toBe(0);
  });

  test('delta_vs_balanced equals score - balanced.score', () => {
    const r = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    const balanced = r.presets.find((p) => p.preset_mode === 'balanced')!;
    for (const p of r.presets) {
      expect(p.delta_vs_balanced).toBeCloseTo(p.score - balanced.score);
    }
  });

  test('all non-balanced presets have non-null delta_vs_balanced', () => {
    const r = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    for (const p of r.presets) {
      expect(p.delta_vs_balanced).not.toBeNull();
    }
  });
});

describe('M6.14 — vertical filter is strict', () => {
  test('insurance preset never appears in banking result + vice versa', () => {
    const banking = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    const insurance = buildScoreWhatIf(
      { vertical: 'insurance', items: insuranceItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    for (const p of banking.presets) {
      expect(p.vertical).toBe('banking');
    }
    for (const p of insurance.presets) {
      expect(p.vertical).toBe('insurance');
    }
  });
});

describe('M6.14 — generated_at echoed', () => {
  test('generated_at = now.toISOString()', () => {
    const r = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    expect(r.generated_at).toBe(NOW.toISOString());
  });
});

describe('M6.14 — input validation', () => {
  test('non-object input throws invalid_input', () => {
    expect(() =>
      buildScoreWhatIf(null as unknown as never, defaultIndicatorWeightLookup, NOW),
    ).toThrow(WeightPresetError);
  });

  test('bad vertical throws invalid_input', () => {
    expect(() =>
      buildScoreWhatIf(
        { vertical: 'bogus' as never, items: [] },
        defaultIndicatorWeightLookup,
        NOW,
      ),
    ).toThrow(/vertical/);
  });

  test('non-array items throws invalid_input', () => {
    expect(() =>
      buildScoreWhatIf(
        { vertical: 'banking', items: 'not an array' as unknown as never },
        defaultIndicatorWeightLookup,
        NOW,
      ),
    ).toThrow(/items/);
  });
});

describe('M6.14 — items_count echoed', () => {
  test('items_count reflects input length', () => {
    const r = buildScoreWhatIf(
      { vertical: 'banking', items: bankingItems },
      defaultIndicatorWeightLookup,
      NOW,
    );
    expect(r.items_count).toBe(bankingItems.length);
  });
});

// ─── POST /v1/scoring/what-if ────────────────────────────────────────

function makeWhatIfApp(role = 'risk_analyst') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M6.14 — POST /v1/scoring/what-if', () => {
  test('analyst+ → 200 with full library scored', async () => {
    const { app } = makeWhatIfApp('risk_analyst');
    const r = await request(app)
      .post('/v1/scoring/what-if')
      .set(TH_BIL)
      .send({ vertical: 'banking', items: bankingItems });
    expect(r.status).toBe(200);
    expect(r.body.body.vertical).toBe('banking');
    expect(r.body.body.presets.length).toBeGreaterThan(0);
  });

  test('envelope request body honoured', async () => {
    const { app } = makeWhatIfApp('admin');
    const r = await request(app)
      .post('/v1/scoring/what-if')
      .set(TH_BIL)
      .send({ header: { requestId: 'rq-1' }, body: { vertical: 'banking', items: bankingItems } });
    expect(r.status).toBe(200);
    expect(r.body.body.vertical).toBe('banking');
  });

  test('missing vertical → 400', async () => {
    const { app } = makeWhatIfApp('admin');
    const r = await request(app)
      .post('/v1/scoring/what-if')
      .set(TH_BIL)
      .send({ items: bankingItems });
    expect(r.status).toBe(400);
  });

  test('bad vertical → 400', async () => {
    const { app } = makeWhatIfApp('admin');
    const r = await request(app)
      .post('/v1/scoring/what-if')
      .set(TH_BIL)
      .send({ vertical: 'bogus', items: bankingItems });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeWhatIfApp('case_owner');
    const r = await request(app)
      .post('/v1/scoring/what-if')
      .set(TH_BIL)
      .send({ vertical: 'banking', items: bankingItems });
    expect(r.status).toBe(403);
  });

  test('M6.3 sibling route /v1/scoring/presets still works', async () => {
    const { app } = makeWhatIfApp('admin');
    const r = await request(app).get('/v1/scoring/presets').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
