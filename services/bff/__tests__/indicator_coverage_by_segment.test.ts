// @ts-nocheck
// T6 M4.23 — Indicator catalog coverage by customer segment tests.

import request from 'supertest';
import {
  buildIndicatorCoverageBySegment,
  ALL_CUSTOMER_SEGMENTS,
} from '../src/indicator_coverage_by_segment';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

describe('buildIndicatorCoverageBySegment — shape', () => {
  test('returns all 6 segments', () => {
    const r = buildIndicatorCoverageBySegment(NOW);
    expect(r.by_segment.length).toBe(6);
    const segNames = r.by_segment.map(s => s.segment);
    for (const seg of ALL_CUSTOMER_SEGMENTS) {
      expect(segNames).toContain(seg);
    }
  });

  test('total_indicators > 0', () => {
    const r = buildIndicatorCoverageBySegment(NOW);
    expect(r.total_indicators).toBeGreaterThan(0);
  });

  test('generated_at is correct', () => {
    const r = buildIndicatorCoverageBySegment(NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
  });

  test('each segment has required fields', () => {
    const r = buildIndicatorCoverageBySegment(NOW);
    for (const seg of r.by_segment) {
      expect(typeof seg.segment).toBe('string');
      expect(typeof seg.applicable_indicator_count).toBe('number');
      expect(Array.isArray(seg.indicator_ids)).toBe(true);
      expect(typeof seg.pct_of_catalog).toBe('number');
      expect(seg.pct_of_catalog).toBeGreaterThanOrEqual(0);
      expect(seg.pct_of_catalog).toBeLessThanOrEqual(100);
    }
  });

  test('indicator_ids are sorted asc', () => {
    const r = buildIndicatorCoverageBySegment(NOW);
    for (const seg of r.by_segment) {
      const sorted = [...seg.indicator_ids].sort();
      expect(seg.indicator_ids).toEqual(sorted);
    }
  });

  test('sorted by applicable_indicator_count desc', () => {
    const r = buildIndicatorCoverageBySegment(NOW);
    for (let i = 1; i < r.by_segment.length; i++) {
      expect(r.by_segment[i - 1].applicable_indicator_count).toBeGreaterThanOrEqual(
        r.by_segment[i].applicable_indicator_count,
      );
    }
  });

  test('best_covered_segment is not null', () => {
    const r = buildIndicatorCoverageBySegment(NOW);
    expect(r.best_covered_segment).not.toBeNull();
  });

  test('least_covered_segment is not null', () => {
    const r = buildIndicatorCoverageBySegment(NOW);
    expect(r.least_covered_segment).not.toBeNull();
  });

  test('banking segments (retail/sme/corporate) have indicators', () => {
    const r = buildIndicatorCoverageBySegment(NOW);
    const retail = r.by_segment.find(s => s.segment === 'retail');
    expect(retail.applicable_indicator_count).toBeGreaterThan(0);
  });

  test('insurance segments (individual/group) have indicators', () => {
    const r = buildIndicatorCoverageBySegment(NOW);
    const individual = r.by_segment.find(s => s.segment === 'individual');
    expect(individual.applicable_indicator_count).toBeGreaterThan(0);
  });
});

describe('route — /v1/indicators/coverage-by-segment', () => {
  test('GET returns 200 with correct shape', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/indicators/coverage-by-segment').set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.by_segment.length).toBe(6);
    expect(res.body.body.total_indicators).toBeGreaterThan(0);
  });

  test('403 for wrong role', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'field_officer',
    });
    const res = await request(app).get('/v1/indicators/coverage-by-segment').set(H);
    expect(res.status).toBe(403);
  });
});
