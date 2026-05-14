// services/bff/__tests__/scenario_narrative.test.ts
//
// T6 M16.16 — Scenario library narrative one-liners.

import request from 'supertest';
import {
  formatScenarioNarrative,
  formatShockPhrases,
  listScenarioNarratives,
} from '../src/scenario_narrative';
import { SCENARIO_PRESETS } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const MINUS = '−';

// ─── formatShockPhrases — pure ────────────────────────────────────────

describe('M16.16 — formatShockPhrases', () => {
  test('all-zero shocks → empty array', () => {
    expect(formatShockPhrases({ gdp: 0, rate: 0, fx: 0 })).toEqual([]);
  });

  test('positive shocks → +sign phrases', () => {
    const phrases = formatShockPhrases({ gdp: 2.5, rate: 100, fx: 5.0 });
    expect(phrases).toEqual(['GDP +2.5%', 'rates +100bps', 'INR +5.0%']);
  });

  test('negative shocks → Unicode minus prefix', () => {
    const phrases = formatShockPhrases({ gdp: -4.0, rate: -50, fx: -2.5 });
    expect(phrases).toEqual([
      `GDP ${MINUS}4.0%`,
      `rates ${MINUS}50bps`,
      `INR ${MINUS}2.5%`,
    ]);
  });

  test('one-axis-only → single phrase', () => {
    expect(formatShockPhrases({ gdp: 0, rate: 200, fx: 0 })).toEqual(['rates +200bps']);
  });

  test('order is stable: gdp → rate → fx', () => {
    const phrases = formatShockPhrases({ gdp: 1, rate: 1, fx: 1 });
    expect(phrases.map((p) => p.split(' ')[0])).toEqual(['GDP', 'rates', 'INR']);
  });

  test('GDP rendered with 1 decimal', () => {
    expect(formatShockPhrases({ gdp: 1.23, rate: 0, fx: 0 })).toEqual(['GDP +1.2%']);
  });

  test('rate rounded to integer bps', () => {
    expect(formatShockPhrases({ gdp: 0, rate: 100.7, fx: 0 })).toEqual(['rates +101bps']);
    expect(formatShockPhrases({ gdp: 0, rate: 100.3, fx: 0 })).toEqual(['rates +100bps']);
  });

  test('FX rendered with 1 decimal', () => {
    expect(formatShockPhrases({ gdp: 0, rate: 0, fx: 8.456 })).toEqual(['INR +8.5%']);
  });
});

// ─── formatScenarioNarrative — pure ───────────────────────────────────

describe('M16.16 — formatScenarioNarrative', () => {
  test('baseline preset → "Baseline (no shock)" string', () => {
    const baseline = SCENARIO_PRESETS.find((p) => p.shocks.gdp === 0 && p.shocks.rate === 0 && p.shocks.fx === 0)!;
    const out = formatScenarioNarrative(baseline);
    expect(out.axis_phrases).toEqual([]);
    expect(out.narrative).toBe('Baseline (no shock)');
  });

  test('multi-axis shock → comma-joined narrative', () => {
    const out = formatScenarioNarrative({
      id: 'test_preset',
      name: 'Test',
      description: 'd',
      category: 'regulatory',
      regulator: 'RBI',
      severity: 'severe',
      shocks: { gdp: -4.0, rate: 200, fx: 8.5 },
      source_doc: 's',
    });
    expect(out.narrative).toBe(`GDP ${MINUS}4.0%, rates +200bps, INR +8.5%`);
  });

  test('preserves preset_id + name + category + severity', () => {
    const out = formatScenarioNarrative({
      id: 'foo',
      name: 'Foo Scenario',
      description: 'd',
      category: 'business',
      regulator: 'INTERNAL',
      severity: 'mild',
      shocks: { gdp: 1, rate: 0, fx: 0 },
      source_doc: 's',
    });
    expect(out.preset_id).toBe('foo');
    expect(out.name).toBe('Foo Scenario');
    expect(out.category).toBe('business');
    expect(out.severity).toBe('mild');
  });
});

// ─── listScenarioNarratives — pure ────────────────────────────────────

describe('M16.16 — listScenarioNarratives', () => {
  test('covers every preset in the library', () => {
    const out = listScenarioNarratives();
    expect(out.total_presets).toBe(SCENARIO_PRESETS.length);
    expect(out.presets).toHaveLength(SCENARIO_PRESETS.length);
    const ids = new Set(out.presets.map((p) => p.preset_id));
    for (const p of SCENARIO_PRESETS) {
      expect(ids.has(p.id)).toBe(true);
    }
  });

  test('sorted by preset_id asc', () => {
    const out = listScenarioNarratives();
    const ids = out.presets.map((p) => p.preset_id);
    expect(ids).toEqual([...ids].sort());
  });

  test('every narrative is non-empty', () => {
    const out = listScenarioNarratives();
    for (const p of out.presets) {
      expect(p.narrative.length).toBeGreaterThan(0);
    }
  });

  test('exactly one preset narrates as baseline (the all-zero shock)', () => {
    const out = listScenarioNarratives();
    const baselines = out.presets.filter((p) => p.narrative === 'Baseline (no shock)');
    expect(baselines).toHaveLength(1);
  });
});

// ─── GET /v1/scenarios/library/narratives ────────────────────────────

function makeNarrativeApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M16.16 — GET /v1/scenarios/library/narratives', () => {
  test('analyst+ → 200 with full catalog', async () => {
    const { app } = makeNarrativeApp('risk_analyst');
    const r = await request(app).get('/v1/scenarios/library/narratives').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBe(SCENARIO_PRESETS.length);
  });

  test('every payload entry has non-empty narrative', async () => {
    const { app } = makeNarrativeApp('admin');
    const r = await request(app).get('/v1/scenarios/library/narratives').set(TH_BIL);
    for (const p of r.body.body.presets) {
      expect(p.narrative).toBeTruthy();
    }
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeNarrativeApp('case_owner');
    const r = await request(app).get('/v1/scenarios/library/narratives').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO see the same catalog', async () => {
    const { app } = makeNarrativeApp('admin');
    const bil = await request(app).get('/v1/scenarios/library/narratives').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/scenarios/library/narratives')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M16.1 /v1/scenarios/library still works (additive route)', async () => {
    const { app } = makeNarrativeApp('admin');
    const r = await request(app).get('/v1/scenarios/library').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
