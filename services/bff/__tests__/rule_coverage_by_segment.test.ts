// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildRuleCoverageBySegment } from '../src/rule_coverage_by_segment';
import { RuleStore } from '../src/rules/store';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildRuleCoverageBySegment', () => {
  it('returns empty with no live rules', () => {
    const store = new RuleStore([]);
    const out = buildRuleCoverageBySegment(store, 'BIL', NOW);
    expect(out.total_live_rules).toBe(0);
    expect(out.by_segment.every(s => s.applicable_rules === 0)).toBe(true);
    expect(out.most_covered_segment).toBeNull();
  });

  it('has required envelope fields', () => {
    const store = new RuleStore([]);
    const out = buildRuleCoverageBySegment(store, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
    expect(Array.isArray(out.by_segment)).toBe(true);
    expect(out.by_segment.length).toBe(4); // retail, sme, corporate, all
    expect(Array.isArray(out.uncovered_segments)).toBe(true);
  });

  it('all segments have coverage_pct in [0, 100]', () => {
    const store = new RuleStore([]);
    const out = buildRuleCoverageBySegment(store, 'BIL', NOW);
    for (const seg of out.by_segment) {
      expect(seg.coverage_pct).toBeGreaterThanOrEqual(0);
      expect(seg.coverage_pct).toBeLessThanOrEqual(100);
    }
  });

  it('returns segment coverage with default seed rules', () => {
    const store = new RuleStore(); // default SEED_RULES (state='active')
    const out = buildRuleCoverageBySegment(store, 'BIL', NOW);
    // With seed rules, 'all' should have all applicable
    const allSeg = out.by_segment.find(s => s.segment === 'all');
    expect(allSeg).toBeDefined();
    expect(allSeg.applicable_rules).toBe(out.total_live_rules);
    expect(out.by_segment.length).toBe(4);
  });
});

describe('GET /v1/rules/coverage-by-segment', () => {
  it('returns 200 for analyst', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/rules/coverage-by-segment')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'risk_analyst');
    expect(res.status).toBe(200);
    expect(res.body.body.by_segment.length).toBe(4);
  });

  it('returns 403 for unknown role', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/rules/coverage-by-segment')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'unknown_role');
    expect(res.status).toBe(403);
  });
});
