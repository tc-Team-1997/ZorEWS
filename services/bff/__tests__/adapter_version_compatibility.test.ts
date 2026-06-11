// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildAdapterVersionCompatibility } from '../src/adapter_version_compatibility';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildAdapterVersionCompatibility', () => {
  it('returns 8 adapters', () => {
    const out = buildAdapterVersionCompatibility('BIL', NOW);
    expect(out.adapters.length).toBe(8);
  });

  it('has required envelope fields', () => {
    const out = buildAdapterVersionCompatibility('BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
    expect(typeof out.current_count).toBe('number');
    expect(typeof out.legacy_count).toBe('number');
    expect(typeof out.avg_compatibility_score).toBe('number');
    expect(Array.isArray(out.adapters_needing_upgrade)).toBe(true);
  });

  it('compatibility_score is in [0, 100] for each adapter', () => {
    const out = buildAdapterVersionCompatibility('BIL', NOW);
    for (const a of out.adapters) {
      expect(a.compatibility_score).toBeGreaterThanOrEqual(0);
      expect(a.compatibility_score).toBeLessThanOrEqual(100);
    }
  });

  it('compatibility_tier is one of the valid values', () => {
    const out = buildAdapterVersionCompatibility('BIL', NOW);
    for (const a of out.adapters) {
      expect(['current', 'compatible', 'legacy']).toContain(a.compatibility_tier);
    }
  });

  it('api_version is v1/v2/v3', () => {
    const out = buildAdapterVersionCompatibility('BIL', NOW);
    for (const a of out.adapters) {
      expect(['v1', 'v2', 'v3']).toContain(a.api_version);
    }
  });

  it('is deterministic per tenant+day', () => {
    const out1 = buildAdapterVersionCompatibility('BIL', NOW);
    const out2 = buildAdapterVersionCompatibility('BIL', NOW);
    expect(out1.adapters.map(a => a.compatibility_score)).toEqual(out2.adapters.map(a => a.compatibility_score));
  });

  it('sorted by compatibility_score asc', () => {
    const out = buildAdapterVersionCompatibility('BIL', NOW);
    for (let i = 1; i < out.adapters.length; i++) {
      expect(out.adapters[i].compatibility_score).toBeGreaterThanOrEqual(out.adapters[i-1].compatibility_score);
    }
  });

  it('avg_compatibility_score is in [0, 100]', () => {
    const out = buildAdapterVersionCompatibility('BIL', NOW);
    expect(out.avg_compatibility_score).toBeGreaterThanOrEqual(0);
    expect(out.avg_compatibility_score).toBeLessThanOrEqual(100);
  });
});

describe('GET /v1/integrations/adapters/version-compatibility', () => {
  it('returns 200 for admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/integrations/adapters/version-compatibility')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.adapters.length).toBe(8);
  });

  it('returns 403 for field_officer', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/integrations/adapters/version-compatibility')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
