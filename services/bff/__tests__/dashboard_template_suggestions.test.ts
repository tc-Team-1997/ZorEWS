// @ts-nocheck
// T6 M11.26 — Dashboard cross-tenant template suggestions.

import request from 'supertest';
import { buildDashboardTemplateSuggestions } from '../src/dashboard_template_suggestions';
import { InMemoryCustomDashboardStore } from '../src/custom_dashboards';
import { listStarterPacks } from '../src/dashboard_starter_packs';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeSuggestApp(role = 'admin', store = new InMemoryCustomDashboardStore()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, customDashboardStore: store });
  return app;
}

describe('M11.26 — empty dashboards', () => {
  test('all packs are new_opportunity for empty tenant', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardTemplateSuggestions('BIL', store, NOW);
    expect(out.total_dashboards).toBe(0);
    expect(out.already_covered_packs).toEqual([]);
    for (const s of out.suggestions) {
      expect(s.suggestion_strength).toBe('new_opportunity');
    }
  });

  test('returns all starter packs', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardTemplateSuggestions('BIL', store, NOW);
    const catalog = listStarterPacks();
    expect(out.suggestions.length).toBe(catalog.packs.length);
  });
});

describe('M11.26 — with matching dashboards', () => {
  test('match_score in [0,1]', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardTemplateSuggestions('BIL', store, NOW);
    for (const s of out.suggestions) {
      expect(s.match_score).toBeGreaterThanOrEqual(0);
      expect(s.match_score).toBeLessThanOrEqual(1);
    }
  });

  test('suggestions sorted new_opportunity first', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardTemplateSuggestions('BIL', store, NOW);
    const strengthOrder = ['new_opportunity', 'partial_match', 'already_covered'];
    for (let i = 0; i < out.suggestions.length - 1; i++) {
      const r1 = strengthOrder.indexOf(out.suggestions[i].suggestion_strength);
      const r2 = strengthOrder.indexOf(out.suggestions[i + 1].suggestion_strength);
      expect(r1).toBeLessThanOrEqual(r2);
    }
  });

  test('missing_widget_types are valid widget type strings', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardTemplateSuggestions('BIL', store, NOW);
    for (const s of out.suggestions) {
      expect(Array.isArray(s.missing_widget_types)).toBe(true);
    }
  });
});

describe('M11.26 — route', () => {
  test('admin GET /v1/dashboards/custom/template-suggestions returns 200', async () => {
    const app = makeSuggestApp();
    const res = await request(app).get('/v1/dashboards/custom/template-suggestions').set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.suggestions)).toBe(true);
  });

  test('non-admin gets 403', async () => {
    const app = makeSuggestApp('field_officer');
    const res = await request(app).get('/v1/dashboards/custom/template-suggestions').set(TH);
    expect(res.status).toBe(403);
  });
});
