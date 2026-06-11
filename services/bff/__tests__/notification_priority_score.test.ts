// @ts-nocheck
// T6 M10.27 — Notification priority score tests.

import request from 'supertest';
import { buildNotificationPriorityScores } from '../src/notification_priority_score';
import { introspectNotificationTemplateCatalog } from '../src/notification_template_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return { app };
}

describe('M10.27 — buildNotificationPriorityScores pure', () => {
  test('returns all catalog templates', () => {
    const catalog = introspectNotificationTemplateCatalog();
    const result = buildNotificationPriorityScores(NOW);
    expect(result.total_templates).toBe(catalog.total_templates);
  });

  test('all templates have valid priority_tier', () => {
    const result = buildNotificationPriorityScores(NOW);
    for (const t of result.templates) {
      expect(['critical', 'high', 'standard']).toContain(t.priority_tier);
      expect(t.priority_score).toBeGreaterThan(0);
    }
  });

  test('sorted by priority_score descending', () => {
    const result = buildNotificationPriorityScores(NOW);
    for (let i = 1; i < result.templates.length; i++) {
      expect(result.templates[i - 1].priority_score).toBeGreaterThanOrEqual(
        result.templates[i].priority_score,
      );
    }
  });

  test('critical_templates contains high priority items', () => {
    const result = buildNotificationPriorityScores(NOW);
    for (const tid of result.critical_templates) {
      const t = result.templates.find(t => t.template_id === tid);
      expect(t.priority_tier).toBe('critical');
    }
  });

  test('platform-static across calls', () => {
    const r1 = buildNotificationPriorityScores(NOW);
    const r2 = buildNotificationPriorityScores(NOW);
    expect(r1.templates.map(t => t.template_id)).toEqual(r2.templates.map(t => t.template_id));
  });
});

describe('M10.27 — GET /v1/notifications/priority-scores route', () => {
  test('admin returns 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/notifications/priority-scores')
      .set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.templates)).toBe(true);
    expect(res.body.body.templates.length).toBeGreaterThan(0);
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/notifications/priority-scores')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('platform-static: BIL = BANK_DEMO response', async () => {
    const { app } = makeTestApp('admin');
    const r1 = await request(app).get('/v1/notifications/priority-scores').set(TH);
    const r2 = await request(app)
      .get('/v1/notifications/priority-scores')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r1.body.body.total_templates).toBe(r2.body.body.total_templates);
  });
});
