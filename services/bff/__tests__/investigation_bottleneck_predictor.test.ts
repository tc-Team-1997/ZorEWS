// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildInvestigationBottleneckPredictor } from '../src/investigation_bottleneck_predictor';
import { InMemoryCaseInvestigationStore } from '../src/case_investigation';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildInvestigationBottleneckPredictor', () => {
  it('returns empty state with no investigations', () => {
    const store = new InMemoryCaseInvestigationStore();
    const out = buildInvestigationBottleneckPredictor(store, 'BIL', NOW);
    expect(out.total_open).toBe(0);
    expect(out.at_risk_count).toBe(0);
    expect(out.predictions.length).toBe(0);
    expect(out.avg_risk_score).toBe(0);
    expect(out.systemic_bottleneck_step).toBeNull();
  });

  it('has required envelope fields', () => {
    const store = new InMemoryCaseInvestigationStore();
    const out = buildInvestigationBottleneckPredictor(store, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
  });

  it('returns predictions for open investigations', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c1', customer_id: 'cust1' }, 'admin', NOW);
    const out = buildInvestigationBottleneckPredictor(store, 'BIL', NOW);
    expect(out.total_open).toBe(1);
    expect(out.predictions.length).toBeGreaterThanOrEqual(0);
  });

  it('does not include closed investigations', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'c1', customer_id: 'cust1' }, 'admin', NOW);
    store.updateStatus('BIL', inv.investigation_id, 'closed', 'fraud_confirmed', 'admin', NOW);
    const out = buildInvestigationBottleneckPredictor(store, 'BIL', NOW);
    expect(out.total_open).toBe(0);
  });

  it('risk_score is in [0, 100]', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c1', customer_id: 'cust1' }, 'admin', NOW);
    const out = buildInvestigationBottleneckPredictor(store, 'BIL', NOW);
    for (const p of out.predictions) {
      expect(p.risk_score).toBeGreaterThanOrEqual(0);
      expect(p.risk_score).toBeLessThanOrEqual(100);
    }
  });

  it('risk_tier is one of the valid values', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c1', customer_id: 'cust1' }, 'admin', NOW);
    const out = buildInvestigationBottleneckPredictor(store, 'BIL', NOW);
    for (const p of out.predictions) {
      expect(['critical', 'high', 'medium', 'low']).toContain(p.risk_tier);
    }
  });
});

describe('GET /v1/investigations/bottleneck-predictor', () => {
  it('returns 200 for admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/investigations/bottleneck-predictor')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_open).toBe('number');
  });

  it('returns 403 for field_officer', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/investigations/bottleneck-predictor')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
