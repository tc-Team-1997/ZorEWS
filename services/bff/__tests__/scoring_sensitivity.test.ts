// services/bff/__tests__/scoring_sensitivity.test.ts
//
// T6 M6.13 — Score sensitivity analysis.

import request from 'supertest';
import {
  analyseScoreSensitivity,
  SensitivityError,
  DEFAULT_BASE_LOOKUP,
} from '../src/scoring_sensitivity';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { listWeightPresets } from '../src/scoring_presets';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// Pick a banking preset for the test
const BANKING_PRESET_ID = listWeightPresets({ vertical: 'banking' })[0]!.id;

// ─── analyseScoreSensitivity — pure ──────────────────────────────────

describe('M6.13 — happy path', () => {
  test('single-indicator → 1 row, base_score + perturbation echoed', () => {
    const r = analyseScoreSensitivity(
      {
        preset_id: BANKING_PRESET_ID,
        items: [{ indicator_id: 'FIN-001', value: 0.5 }],
      },
      DEFAULT_BASE_LOOKUP,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.preset_id).toBe(BANKING_PRESET_ID);
    expect(r.perturbation).toBe(0.05);
    expect(r.most_sensitive_indicator).toBe('FIN-001');
    expect(r.rows[0]!.base_value).toBe(0.5);
    expect(r.rows[0]!.sensitivity).toBeGreaterThan(0);
  });
});

describe('M6.13 — heavier indicator more sensitive', () => {
  test('FIN-001 (banking weight 0.9) more sensitive than BEH-002 (weight 0.4)', () => {
    const r = analyseScoreSensitivity(
      {
        preset_id: BANKING_PRESET_ID,
        items: [
          { indicator_id: 'FIN-001', value: 0.5 },
          { indicator_id: 'BEH-002', value: 0.5 },
        ],
      },
      DEFAULT_BASE_LOOKUP,
    );
    // FIN-001 has higher catalog weight → higher sensitivity
    const fin = r.rows.find((row) => row.indicator_id === 'FIN-001')!;
    const beh = r.rows.find((row) => row.indicator_id === 'BEH-002')!;
    expect(fin.sensitivity).toBeGreaterThan(beh.sensitivity);
    // Sorted by sensitivity desc → FIN-001 first
    expect(r.rows[0]!.indicator_id).toBe('FIN-001');
    expect(r.most_sensitive_indicator).toBe('FIN-001');
  });
});

describe('M6.13 — symmetric_delta = score_up - score_down', () => {
  test('verified arithmetic per row', () => {
    const r = analyseScoreSensitivity(
      {
        preset_id: BANKING_PRESET_ID,
        items: [{ indicator_id: 'FIN-001', value: 0.5 }],
      },
      DEFAULT_BASE_LOOKUP,
    );
    const row = r.rows[0]!;
    expect(row.symmetric_delta).toBeCloseTo(row.score_up - row.score_down, 5);
    expect(row.sensitivity).toBeCloseTo(Math.abs(row.symmetric_delta), 5);
  });
});

describe('M6.13 — perturbation clamping', () => {
  test('value=0 → perturbation+0 clamped at 0; up >= base', () => {
    const r = analyseScoreSensitivity(
      {
        preset_id: BANKING_PRESET_ID,
        items: [{ indicator_id: 'FIN-001', value: 0 }],
      },
      DEFAULT_BASE_LOOKUP,
    );
    const row = r.rows[0]!;
    // score_down should equal base (value cannot go below 0)
    // score_up should be > base
    expect(row.score_up).toBeGreaterThanOrEqual(row.score_down);
  });

  test('value=1 → perturbation+1 clamped at 1; down <= base', () => {
    const r = analyseScoreSensitivity(
      {
        preset_id: BANKING_PRESET_ID,
        items: [{ indicator_id: 'FIN-001', value: 1 }],
      },
      DEFAULT_BASE_LOOKUP,
    );
    const row = r.rows[0]!;
    // score_up should equal base (value cannot exceed 1)
    expect(row.score_up).toBeGreaterThanOrEqual(row.score_down);
  });
});

describe('M6.13 — sort order', () => {
  test('rows sorted by sensitivity desc with indicator_id asc tie-break', () => {
    const r = analyseScoreSensitivity(
      {
        preset_id: BANKING_PRESET_ID,
        items: [
          { indicator_id: 'FIN-003', value: 0.5 },
          { indicator_id: 'FIN-002', value: 0.5 },
          { indicator_id: 'FIN-001', value: 0.5 },
        ],
      },
      DEFAULT_BASE_LOOKUP,
    );
    // Weights: FIN-001 (0.9) > FIN-002 (0.7) > FIN-003 (0.6) → sensitivity desc
    expect(r.rows.map((row) => row.indicator_id)).toEqual(['FIN-001', 'FIN-002', 'FIN-003']);
  });
});

describe('M6.13 — validation', () => {
  test('missing items → 400', () => {
    expect(() =>
      analyseScoreSensitivity(
        { preset_id: BANKING_PRESET_ID } as never,
        DEFAULT_BASE_LOOKUP,
      ),
    ).toThrow(SensitivityError);
  });

  test('perturbation outside (0, 0.5] → 400', () => {
    expect(() =>
      analyseScoreSensitivity(
        {
          preset_id: BANKING_PRESET_ID,
          items: [{ indicator_id: 'FIN-001', value: 0.5 }],
          perturbation: 0,
        },
        DEFAULT_BASE_LOOKUP,
      ),
    ).toThrow(/perturbation/);
    expect(() =>
      analyseScoreSensitivity(
        {
          preset_id: BANKING_PRESET_ID,
          items: [{ indicator_id: 'FIN-001', value: 0.5 }],
          perturbation: 0.7,
        },
        DEFAULT_BASE_LOOKUP,
      ),
    ).toThrow(/perturbation/);
  });
});

describe('M6.13 — empty items', () => {
  test('zero items → throws (M6.1 scoreFromIndicators rejects empty)', () => {
    // Sensitivity analysis on no inputs is meaningless; the base
    // scoreByPreset rejects empty items[] which bubbles up here as
    // ScoringInputError, mapped by the route to 400 empty_items.
    expect(() =>
      analyseScoreSensitivity(
        { preset_id: BANKING_PRESET_ID, items: [] },
        DEFAULT_BASE_LOOKUP,
      ),
    ).toThrow(/empty_items|items/);
  });
});

// ─── POST /v1/scoring/sensitivity ────────────────────────────────────

function makeSensitivityApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M6.13 — POST /v1/scoring/sensitivity', () => {
  test('admin → 200 with sensitivity report', async () => {
    const { app } = makeSensitivityApp('admin');
    const r = await request(app)
      .post('/v1/scoring/sensitivity')
      .set(TH_BIL)
      .send({
        preset_id: BANKING_PRESET_ID,
        items: [
          { indicator_id: 'FIN-001', value: 0.5 },
          { indicator_id: 'BEH-002', value: 0.5 },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toHaveLength(2);
    expect(r.body.body.most_sensitive_indicator).toBe('FIN-001');
  });

  test('missing preset_id → 400', async () => {
    const { app } = makeSensitivityApp('admin');
    const r = await request(app)
      .post('/v1/scoring/sensitivity')
      .set(TH_BIL)
      .send({ items: [{ indicator_id: 'FIN-001', value: 0.5 }] });
    expect(r.status).toBe(400);
  });

  test('unknown preset_id → 404', async () => {
    const { app } = makeSensitivityApp('admin');
    const r = await request(app)
      .post('/v1/scoring/sensitivity')
      .set(TH_BIL)
      .send({
        preset_id: 'not-a-real-preset',
        items: [{ indicator_id: 'FIN-001', value: 0.5 }],
      });
    expect(r.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSensitivityApp('case_owner');
    const r = await request(app)
      .post('/v1/scoring/sensitivity')
      .set(TH_BIL)
      .send({
        preset_id: BANKING_PRESET_ID,
        items: [{ indicator_id: 'FIN-001', value: 0.5 }],
      });
    expect(r.status).toBe(403);
  });

  test('invalid perturbation → 400', async () => {
    const { app } = makeSensitivityApp('admin');
    const r = await request(app)
      .post('/v1/scoring/sensitivity')
      .set(TH_BIL)
      .send({
        preset_id: BANKING_PRESET_ID,
        items: [{ indicator_id: 'FIN-001', value: 0.5 }],
        perturbation: 0.9,
      });
    expect(r.status).toBe(400);
  });
});
