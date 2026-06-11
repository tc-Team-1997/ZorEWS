// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildDashboardAdoptionFunnel } from '../src/dashboard_adoption_funnel';
import { InMemoryCustomDashboardStore } from '../src/custom_dashboards';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildDashboardAdoptionFunnel', () => {
  it('returns inactive for empty store', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardAdoptionFunnel(store, 'BIL', NOW);
    expect(out.total_dashboards).toBe(0);
    expect(out.adoption_tier).toBe('inactive');
    expect(out.funnel_score).toBe(0);
  });

  it('has 4 funnel stages', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardAdoptionFunnel(store, 'BIL', NOW);
    expect(out.funnel_stages.length).toBe(4);
  });

  it('funnel_score is in [0, 100]', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardAdoptionFunnel(store, 'BIL', NOW);
    expect(out.funnel_score).toBeGreaterThanOrEqual(0);
    expect(out.funnel_score).toBeLessThanOrEqual(100);
  });

  it('adoption_tier is one of the valid values', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardAdoptionFunnel(store, 'BIL', NOW);
    expect(['power_user', 'engaged', 'onboarding', 'inactive']).toContain(out.adoption_tier);
  });

  it('has required envelope fields', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardAdoptionFunnel(store, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
    expect(Array.isArray(out.recommendations)).toBe(true);
  });

  it('returns recommendations when empty', () => {
    const store = new InMemoryCustomDashboardStore();
    const out = buildDashboardAdoptionFunnel(store, 'BIL', NOW);
    expect(out.recommendations.length).toBeGreaterThan(0);
  });

  it('is tenant-isolated', () => {
    const store = new InMemoryCustomDashboardStore();
    store.create('BIL', { name: 'dash1', description: 'd', widgets: [{ widget_type: 'tenant_kpi', config: {}, position: { row: 0, col: 0 }, span: { rows: 4, cols: 6 } }] }, 'alice', NOW);
    const outBil = buildDashboardAdoptionFunnel(store, 'BIL', NOW);
    const outBank = buildDashboardAdoptionFunnel(store, 'BANK_DEMO', NOW);
    expect(outBil.total_dashboards).toBe(1);
    expect(outBank.total_dashboards).toBe(0);
  });
});

describe('GET /v1/dashboards/custom/adoption-funnel', () => {
  it('returns 200 for admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/dashboards/custom/adoption-funnel')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.funnel_stages.length).toBe(4);
  });

  it('returns 403 for case_owner', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/dashboards/custom/adoption-funnel')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'case_owner');
    expect(res.status).toBe(403);
  });
});
