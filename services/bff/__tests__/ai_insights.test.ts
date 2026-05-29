// services/bff/__tests__/ai_insights.test.ts
//
// T7 Module 9 — AI Insight Panels. Catalog + deterministic synthesis +
// feed rollup/filter + route smoke (via makeApp).

import request from 'supertest';
import {
  InMemoryAiInsightStore,
  AiInsightError,
  listInsightCatalog,
  isInsightCategory,
  isInsightSeverity,
  ALL_INSIGHT_CATEGORIES,
  ALL_INSIGHT_SEVERITIES,
} from '../src/ai_insights';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-29T09:00:00.000Z');

function makeInsightApp(role = 'risk_analyst', store = new InMemoryAiInsightStore()) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    aiInsightStore: store,
  });
}

describe('catalog', () => {
  it('exposes the 6 reusable insight panels spanning the spec examples', () => {
    const cat = listInsightCatalog();
    const ids = cat.map((c) => c.insight_id);
    expect(ids).toContain('top_risky_borrowers');
    expect(ids).toContain('fraud_anomaly_highlights');
    expect(ids).toContain('lapse_prediction_insights');
    expect(ids).toContain('unusual_trends');
    expect(cat.length).toBeGreaterThanOrEqual(6);
    // every entry carries a model_ref (insights are "powered by" a model/signal)
    for (const c of cat) expect(c.model_ref.length).toBeGreaterThan(0);
  });

  it('type guards', () => {
    expect(isInsightCategory('risk')).toBe(true);
    expect(isInsightCategory('bogus')).toBe(false);
    expect(isInsightSeverity('critical')).toBe(true);
    expect(isInsightSeverity('nope')).toBe(false);
  });
});

describe('insight synthesis', () => {
  it('get() returns a coherent ranked insight', () => {
    const s = new InMemoryAiInsightStore();
    const ins = s.get('BANK_DEMO', 'top_risky_borrowers', NOW);
    expect(ins.insight_id).toBe('top_risky_borrowers');
    expect(ins.category).toBe('risk');
    expect(ins.domain).toBe('banking');
    expect(ins.model_ref).toBe('pd_xgb_v3');
    expect(ins.items.length).toBe(ins.item_count);
    expect(ins.items.length).toBeGreaterThanOrEqual(4);
    // ranked worst-first
    for (let i = 1; i < ins.items.length; i++) expect(ins.items[i - 1].score).toBeGreaterThanOrEqual(ins.items[i].score);
    // severity tracks the top score band
    expect(ALL_INSIGHT_SEVERITIES).toContain(ins.severity);
    expect(ins.confidence).toBeGreaterThan(0);
    expect(ins.headline.length).toBeGreaterThan(0);
    // every item shaped
    for (const it of ins.items) {
      expect(it.score).toBeGreaterThanOrEqual(0);
      expect(it.score).toBeLessThanOrEqual(1);
      expect(['up', 'down', 'flat']).toContain(it.trend);
      expect(it.reason.length).toBeGreaterThan(0);
      expect(it.score_label.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic per (tenant, insight, day)', () => {
    const a = new InMemoryAiInsightStore().get('BANK_DEMO', 'fraud_anomaly_highlights', NOW);
    const b = new InMemoryAiInsightStore().get('BANK_DEMO', 'fraud_anomaly_highlights', NOW);
    expect(b.items.map((i) => i.score)).toEqual(a.items.map((i) => i.score));
    expect(b.severity).toBe(a.severity);
  });

  it('different tenant → different items', () => {
    const a = new InMemoryAiInsightStore().get('BANK_DEMO', 'lapse_prediction_insights', NOW);
    const b = new InMemoryAiInsightStore().get('BIL', 'lapse_prediction_insights', NOW);
    expect(b.items[0].entity_id).not.toBe(a.items[0].entity_id);
  });

  it('lapse insight renders a percentage score label', () => {
    const ins = new InMemoryAiInsightStore().get('BANK_DEMO', 'lapse_prediction_insights', NOW);
    expect(ins.items[0].score_label).toMatch(/lapse \d+%/);
  });

  it('unknown insight + empty tenant throw', () => {
    const s = new InMemoryAiInsightStore();
    expect(() => s.get('BANK_DEMO', 'nope', NOW)).toThrow(AiInsightError);
    expect(() => s.get('', 'top_risky_borrowers', NOW)).toThrow(AiInsightError);
  });
});

describe('feed rollup + filter', () => {
  it('feed covers the catalog with by_category/by_severity partitions + top_insight', () => {
    const feed = new InMemoryAiInsightStore().feed('BANK_DEMO', {}, NOW);
    expect(feed.total).toBe(listInsightCatalog().length);
    const catSum = ALL_INSIGHT_CATEGORIES.reduce((acc, c) => acc + feed.by_category[c], 0);
    expect(catSum).toBe(feed.total);
    const sevSum = ALL_INSIGHT_SEVERITIES.reduce((acc, s) => acc + feed.by_severity[s], 0);
    expect(sevSum).toBe(feed.total);
    expect(feed.top_insight).not.toBeNull();
    // feed is ordered highest-severity first
    const rank = (s: string) => ['info', 'medium', 'high', 'critical'].indexOf(s);
    for (let i = 1; i < feed.insights.length; i++) {
      expect(rank(feed.insights[i - 1].severity)).toBeGreaterThanOrEqual(rank(feed.insights[i].severity));
    }
  });

  it('domain filter narrows to insurance insights', () => {
    const feed = new InMemoryAiInsightStore().feed('BANK_DEMO', { domain: 'insurance' }, NOW);
    expect(feed.total).toBeGreaterThan(0);
    for (const i of feed.insights) expect(i.domain).toBe('insurance');
  });

  it('category filter narrows to fraud insights', () => {
    const feed = new InMemoryAiInsightStore().feed('BANK_DEMO', { category: 'fraud' }, NOW);
    for (const i of feed.insights) expect(i.category).toBe('fraud');
  });

  it('empty tenant throws', () => {
    expect(() => new InMemoryAiInsightStore().feed('', {}, NOW)).toThrow(AiInsightError);
  });
});

describe('routes', () => {
  const HDRS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  it('GET catalog + feed + single happy path', async () => {
    const { app } = makeInsightApp('risk_analyst');
    const cat = await request(app).get('/v1/ai/insights/catalog').set(HDRS);
    expect(cat.status).toBe(200);
    expect(cat.body.body.total).toBeGreaterThanOrEqual(6);

    const feed = await request(app).get('/v1/ai/insights').set(HDRS);
    expect(feed.status).toBe(200);
    expect(feed.body.body.total).toBe(cat.body.body.total);
    expect(feed.body.body.top_insight).not.toBeNull();

    const single = await request(app).get('/v1/ai/insights/top_risky_borrowers').set(HDRS);
    expect(single.status).toBe(200);
    expect(single.body.body.items.length).toBeGreaterThanOrEqual(4);
  });

  it('the literal /catalog is not captured by :insight_id', async () => {
    const { app } = makeInsightApp('risk_analyst');
    const cat = await request(app).get('/v1/ai/insights/catalog').set(HDRS);
    expect(cat.body.body).toHaveProperty('insights');
    expect(cat.body.body).not.toHaveProperty('items');
  });

  it('feed filters + invalid filter 400', async () => {
    const { app } = makeInsightApp('risk_analyst');
    const ins = await request(app).get('/v1/ai/insights?domain=insurance').set(HDRS);
    expect(ins.status).toBe(200);
    for (const i of ins.body.body.insights) expect(i.domain).toBe('insurance');
    const bad = await request(app).get('/v1/ai/insights?severity=bogus').set(HDRS);
    expect(bad.status).toBe(400);
  });

  it('404 on unknown insight', async () => {
    const { app } = makeInsightApp('risk_analyst');
    const r = await request(app).get('/v1/ai/insights/nope').set(HDRS);
    expect(r.status).toBe(404);
  });

  it('403 for a role lacking customers:read_risk_profile', async () => {
    const { app } = makeInsightApp('auditor');
    const r = await request(app).get('/v1/ai/insights').set(HDRS);
    expect(r.status).toBe(403);
  });
});
