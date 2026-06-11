// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildConfigBestPractices } from '../src/config_best_practices';
import { InMemoryConfigStore } from '../src/admin_config';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildConfigBestPractices', () => {
  it('returns 5 practices', () => {
    const store = new InMemoryConfigStore();
    const out = buildConfigBestPractices(store, 'BIL', NOW);
    expect(out.practices.length).toBe(5);
  });

  it('compliance_score is in [0, 100]', () => {
    const store = new InMemoryConfigStore();
    const out = buildConfigBestPractices(store, 'BIL', NOW);
    expect(out.compliance_score).toBeGreaterThanOrEqual(0);
    expect(out.compliance_score).toBeLessThanOrEqual(100);
  });

  it('has required envelope fields', () => {
    const store = new InMemoryConfigStore();
    const out = buildConfigBestPractices(store, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
    expect(typeof out.passed_count).toBe('number');
    expect(typeof out.failed_count).toBe('number');
    expect(Array.isArray(out.high_impact_failures)).toBe(true);
  });

  it('passed_count + failed_count = 5', () => {
    const store = new InMemoryConfigStore();
    const out = buildConfigBestPractices(store, 'BIL', NOW);
    expect(out.passed_count + out.failed_count).toBe(5);
  });

  it('passes red_sla_aggressive when red_sla_hours = 4 (default)', () => {
    const store = new InMemoryConfigStore();
    const out = buildConfigBestPractices(store, 'BIL', NOW);
    const practice = out.practices.find(p => p.practice_id === 'red_sla_aggressive');
    expect(practice).toBeDefined();
    // Default is 4, so should pass
    expect(practice.passed).toBe(true);
  });

  it('fails red_sla_aggressive when red_sla_hours > 4', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 8, 'admin', NOW);
    const out = buildConfigBestPractices(store, 'BIL', NOW);
    const practice = out.practices.find(p => p.practice_id === 'red_sla_aggressive');
    expect(practice.passed).toBe(false);
  });

  it('high_impact_failures contains practice_ids with impact=high that failed', () => {
    const store = new InMemoryConfigStore();
    const out = buildConfigBestPractices(store, 'BIL', NOW);
    const failedHighImpact = out.practices.filter(p => !p.passed && p.impact === 'high').map(p => p.practice_id);
    expect(out.high_impact_failures.sort()).toEqual(failedHighImpact.sort());
  });

  it('is tenant-isolated', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'features.maker_checker_enabled', true, 'admin', NOW);
    const outBil = buildConfigBestPractices(store, 'BIL', NOW);
    const outBank = buildConfigBestPractices(store, 'BANK_DEMO', NOW);
    const bilMakerChecker = outBil.practices.find(p => p.practice_id === 'maker_checker_enabled');
    const bankMakerChecker = outBank.practices.find(p => p.practice_id === 'maker_checker_enabled');
    expect(bilMakerChecker.passed).toBe(true);
    // BANK_DEMO default for maker_checker_enabled is false
    expect(bankMakerChecker.passed).toBe(false);
  });
});

describe('GET /v1/admin/config/best-practices', () => {
  it('returns 200 for admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/admin/config/best-practices')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.practices.length).toBe(5);
  });

  it('returns 403 for field_officer', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/admin/config/best-practices')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
