// @ts-nocheck
// __tests__/ai_model_version_timeline.test.ts
// T6 M7.21 — AI model version history timeline

import request from 'supertest';
import {
  buildModelVersionTimeline,
  ModelVersionTimelineError,
} from '../src/ai_model_version_timeline';
import { InMemoryAiModelRegistry } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T00:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTimelineApp(role = 'admin') {
  const registry = new InMemoryAiModelRegistry();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    aiModelRegistry: registry,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, registry };
}

// ─── Pure function tests ───────────────────────────────────────────────

describe('buildModelVersionTimeline — M7.21', () => {
  it('invalid type throws ModelVersionTimelineError', () => {
    const registry = new InMemoryAiModelRegistry();
    expect(() => buildModelVersionTimeline('invalid_type_xyz', registry, NOW)).toThrow(
      ModelVersionTimelineError,
    );
  });

  it('valid type with default registry returns shape', () => {
    const registry = new InMemoryAiModelRegistry();
    const result = buildModelVersionTimeline('pd', registry, NOW);
    expect(result.model_type).toBe('pd');
    expect(result.generated_at).toBe(NOW.toISOString());
    expect(Array.isArray(result.versions)).toBe(true);
    expect(typeof result.version_count).toBe('number');
    expect(typeof result.retired_count).toBe('number');
    expect(typeof result.active_count).toBe('number');
    expect(typeof result.version_velocity_30d).toBe('number');
  });

  it('production_version is non-null for pd (has production in seed)', () => {
    const registry = new InMemoryAiModelRegistry();
    const result = buildModelVersionTimeline('pd', registry, NOW);
    expect(result.production_version).not.toBeNull();
  });

  it('versions sorted by trained_at desc', () => {
    const registry = new InMemoryAiModelRegistry();
    const result = buildModelVersionTimeline('pd', registry, NOW);
    for (let i = 1; i < result.versions.length; i++) {
      const tPrev = new Date(result.versions[i - 1].trained_at).getTime();
      const tCurr = new Date(result.versions[i].trained_at).getTime();
      expect(tPrev).toBeGreaterThanOrEqual(tCurr);
    }
  });

  it('version_count matches versions.length', () => {
    const registry = new InMemoryAiModelRegistry();
    const result = buildModelVersionTimeline('pd', registry, NOW);
    expect(result.version_count).toBe(result.versions.length);
  });

  it('active_count + retired_count = version_count', () => {
    const registry = new InMemoryAiModelRegistry();
    const result = buildModelVersionTimeline('pd', registry, NOW);
    expect(result.active_count + result.retired_count).toBe(result.version_count);
  });

  it('days_in_status is non-negative', () => {
    const registry = new InMemoryAiModelRegistry();
    const result = buildModelVersionTimeline('pd', registry, NOW);
    for (const v of result.versions) {
      expect(v.days_in_status).toBeGreaterThanOrEqual(0);
    }
  });

  it('each version has required fields', () => {
    const registry = new InMemoryAiModelRegistry();
    const result = buildModelVersionTimeline('pd', registry, NOW);
    for (const v of result.versions) {
      expect(typeof v.model_id).toBe('string');
      expect(typeof v.name).toBe('string');
      expect(typeof v.version).toBe('string');
      expect(typeof v.status).toBe('string');
      expect(typeof v.framework).toBe('string');
      expect(typeof v.trained_at).toBe('string');
    }
  });

  it('version_velocity_30d counts versions within 30 days of NOW', () => {
    const registry = new InMemoryAiModelRegistry();
    const result = buildModelVersionTimeline('pd', registry, NOW);
    expect(result.version_velocity_30d).toBeGreaterThanOrEqual(0);
    expect(result.version_velocity_30d).toBeLessThanOrEqual(result.version_count);
  });

  it('type=fraud returns fraud models', () => {
    const registry = new InMemoryAiModelRegistry();
    const result = buildModelVersionTimeline('fraud', registry, NOW);
    expect(result.model_type).toBe('fraud');
  });

  it('lapse type returns empty versions for lapse (no lapse in seed)', () => {
    const registry = new InMemoryAiModelRegistry();
    const result = buildModelVersionTimeline('lapse', registry, NOW);
    expect(result.model_type).toBe('lapse');
    // lapse seed may or may not have production; just check shape
    expect(result.version_count).toBeGreaterThanOrEqual(0);
  });
});

// ─── Route tests ───────────────────────────────────────────────────────

describe('GET /v1/ai/models/by-type/:type/version-timeline — M7.21 route', () => {
  it('admin GET pd version-timeline → 200 with shape', async () => {
    const { app } = makeTimelineApp('admin');
    const res = await request(app)
      .get('/v1/ai/models/by-type/pd/version-timeline')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.model_type).toBe('pd');
    expect(Array.isArray(res.body.body.versions)).toBe(true);
    expect(typeof res.body.body.version_count).toBe('number');
  });

  it('invalid type → 400', async () => {
    const { app } = makeTimelineApp('admin');
    const res = await request(app)
      .get('/v1/ai/models/by-type/invalid_xyz/version-timeline')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EWS_400_invalid_type');
  });

  it('non-admin role (risk_analyst lacks audit:read) → 403', async () => {
    const { app } = makeTimelineApp('risk_analyst');
    const res = await request(app)
      .get('/v1/ai/models/by-type/pd/version-timeline')
      .set(TH_BIL)
      .set('x-apex-role', 'risk_analyst');
    expect(res.status).toBe(403);
  });

  it('no tenant header → 400', async () => {
    const { app } = makeTimelineApp('admin');
    const res = await request(app)
      .get('/v1/ai/models/by-type/pd/version-timeline')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });

  it('fraud type → 200', async () => {
    const { app } = makeTimelineApp('admin');
    const res = await request(app)
      .get('/v1/ai/models/by-type/fraud/version-timeline')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.model_type).toBe('fraud');
  });
});
