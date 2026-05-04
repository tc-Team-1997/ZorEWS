// Pure-function unit tests for the criticality library. Covers the
// formula, age boost, score-band classifier, customer dedup, and stable
// sort. The MSW handler at web/src/mocks/handlers.ts uses these helpers
// directly, so passing here = passing for the alert queue's wire shape.

import { describe, expect, it } from 'vitest';
import {
  ageBoost,
  bandFor,
  computeScore,
  dedupByCustomer,
  sortBy,
} from '@/lib/criticality';
import type { Alert, Severity } from '@/lib/api';

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: overrides.id ?? 'a-test',
    severity: overrides.severity ?? 'medium',
    customer: overrides.customer ?? { id: 'c-001', name: 'Test Customer' },
    rule: overrides.rule ?? { id: 'r-1', name: 'test rule' },
    indicators: overrides.indicators ?? ['IND_TXN_01'],
    age_min: overrides.age_min ?? 60,
    assignee: overrides.assignee ?? null,
    created_at: overrides.created_at ?? '2026-05-01T00:00:00Z',
    confidence: overrides.confidence ?? 0.8,
    customer_exposure_kes: overrides.customer_exposure_kes ?? 500_000,
    criticality_score: overrides.criticality_score ?? 0,
    linked_alert_ids: overrides.linked_alert_ids ?? [],
  };
}

describe('ageBoost', () => {
  it('returns 1.0 for fresh alerts (< 24h)', () => {
    expect(ageBoost(0)).toBe(1.0);
    expect(ageBoost(60)).toBe(1.0);
    expect(ageBoost(60 * 23 + 59)).toBe(1.0);
  });

  it('returns 1.2 for 1–3 day-old alerts', () => {
    expect(ageBoost(60 * 24)).toBe(1.2);
    expect(ageBoost(60 * 48)).toBe(1.2);
    expect(ageBoost(60 * 72 - 1)).toBe(1.2);
  });

  it('returns 1.5 for stale (> 3 day) alerts', () => {
    expect(ageBoost(60 * 72)).toBe(1.5);
    expect(ageBoost(60 * 24 * 30)).toBe(1.5);
  });
});

describe('computeScore', () => {
  it('zero confidence returns zero', () => {
    expect(
      computeScore({
        severity: 'critical',
        confidence: 0,
        customer_exposure_kes: 10_000_000,
        age_min: 1000,
      }),
    ).toBe(0);
  });

  it('higher severity → higher score (all else equal)', () => {
    const base = {
      confidence: 1,
      customer_exposure_kes: 1_000_000,
      age_min: 0,
    };
    const lowS = computeScore({ ...base, severity: 'low' as Severity });
    const medS = computeScore({ ...base, severity: 'medium' as Severity });
    const hiS = computeScore({ ...base, severity: 'high' as Severity });
    const critS = computeScore({ ...base, severity: 'critical' as Severity });
    expect(medS).toBeGreaterThan(lowS);
    expect(hiS).toBeGreaterThan(medS);
    expect(critS).toBeGreaterThan(hiS);
  });

  it('higher exposure → higher score (all else equal)', () => {
    const base = {
      severity: 'high' as Severity,
      confidence: 1,
      age_min: 0,
    };
    const small = computeScore({ ...base, customer_exposure_kes: 100_000 });
    const big = computeScore({ ...base, customer_exposure_kes: 10_000_000 });
    expect(big).toBeGreaterThan(small);
  });

  it('older alerts boost up via the age multiplier', () => {
    const base = {
      severity: 'medium' as Severity,
      confidence: 1,
      customer_exposure_kes: 500_000,
    };
    const fresh = computeScore({ ...base, age_min: 60 });
    const stale = computeScore({ ...base, age_min: 60 * 96 }); // 4 days
    expect(stale).toBeGreaterThan(fresh);
    // The aging boost is 1.5x at > 72h, so stale should be ~1.5x fresh.
    expect(stale / fresh).toBeCloseTo(1.5, 1);
  });

  it('clamps confidence to [0, 1]', () => {
    const a = computeScore({
      severity: 'high',
      confidence: 1,
      customer_exposure_kes: 500_000,
      age_min: 0,
    });
    const b = computeScore({
      severity: 'high',
      confidence: 5, // out of range
      customer_exposure_kes: 500_000,
      age_min: 0,
    });
    expect(a).toBe(b);
  });

  it('floors exposure below 100k so the log term never goes negative', () => {
    const tiny = computeScore({
      severity: 'medium',
      confidence: 1,
      customer_exposure_kes: 1_000, // way below 100k
      age_min: 0,
    });
    expect(tiny).toBeGreaterThan(0);
  });
});

describe('bandFor', () => {
  it('classifies scores into the expected bands', () => {
    expect(bandFor(0)).toBe('low');
    expect(bandFor(1.5)).toBe('low');
    expect(bandFor(2)).toBe('medium');
    expect(bandFor(3.99)).toBe('medium');
    expect(bandFor(4)).toBe('high');
    expect(bandFor(7.99)).toBe('high');
    expect(bandFor(8)).toBe('critical');
    expect(bandFor(50)).toBe('critical');
  });
});

describe('dedupByCustomer', () => {
  it('passes single-customer alerts through unchanged', () => {
    const alerts = [
      makeAlert({ id: 'a-1', customer: { id: 'c-1', name: 'A' }, criticality_score: 5 }),
      makeAlert({ id: 'a-2', customer: { id: 'c-2', name: 'B' }, criticality_score: 3 }),
    ];
    const out = dedupByCustomer(alerts);
    expect(out).toHaveLength(2);
    expect(out.every((a) => a.linked_alert_ids.length === 0)).toBe(true);
  });

  it('keeps the highest-criticality alert as primary and links the rest', () => {
    const alerts = [
      makeAlert({ id: 'a-1', customer: { id: 'c-X', name: 'X' }, criticality_score: 3 }),
      makeAlert({ id: 'a-2', customer: { id: 'c-X', name: 'X' }, criticality_score: 9 }),
      makeAlert({ id: 'a-3', customer: { id: 'c-X', name: 'X' }, criticality_score: 5 }),
      makeAlert({ id: 'a-4', customer: { id: 'c-Y', name: 'Y' }, criticality_score: 4 }),
    ];
    const out = dedupByCustomer(alerts);
    expect(out).toHaveLength(2);
    const customerX = out.find((a) => a.customer.id === 'c-X')!;
    expect(customerX.id).toBe('a-2'); // highest score is primary
    expect(customerX.linked_alert_ids.sort()).toEqual(['a-1', 'a-3']);
    const customerY = out.find((a) => a.customer.id === 'c-Y')!;
    expect(customerY.linked_alert_ids).toEqual([]);
  });
});

describe('sortBy', () => {
  it('sorts by criticality desc by default key', () => {
    const alerts = [
      makeAlert({ id: 'a-1', criticality_score: 2 }),
      makeAlert({ id: 'a-2', criticality_score: 8 }),
      makeAlert({ id: 'a-3', criticality_score: 5 }),
    ];
    const out = sortBy(alerts, 'criticality');
    expect(out.map((a) => a.id)).toEqual(['a-2', 'a-3', 'a-1']);
  });

  it('sort by severity respects severity hierarchy', () => {
    const alerts = [
      makeAlert({ id: 'a-1', severity: 'low' }),
      makeAlert({ id: 'a-2', severity: 'critical' }),
      makeAlert({ id: 'a-3', severity: 'medium' }),
    ];
    const out = sortBy(alerts, 'severity');
    expect(out.map((a) => a.severity)).toEqual(['critical', 'medium', 'low']);
  });

  it('sort by age puts oldest first', () => {
    const alerts = [
      makeAlert({ id: 'a-1', age_min: 30 }),
      makeAlert({ id: 'a-2', age_min: 500 }),
      makeAlert({ id: 'a-3', age_min: 200 }),
    ];
    const out = sortBy(alerts, 'age');
    expect(out.map((a) => a.id)).toEqual(['a-2', 'a-3', 'a-1']);
  });

  it('is stable for ties (preserves input order)', () => {
    const alerts = [
      makeAlert({ id: 'a-1', criticality_score: 5 }),
      makeAlert({ id: 'a-2', criticality_score: 5 }),
      makeAlert({ id: 'a-3', criticality_score: 5 }),
    ];
    const out = sortBy(alerts, 'criticality');
    expect(out.map((a) => a.id)).toEqual(['a-1', 'a-2', 'a-3']);
  });
});
