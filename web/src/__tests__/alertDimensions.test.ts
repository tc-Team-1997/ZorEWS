// Pure-function tests for lib/alertDimensions.
//
// No DOM, no React Query, no recharts — just classifier behaviour.
// These are the load-bearing assertions for every chart on the
// dashboard's Alert Analytics section.

import { describe, it, expect } from 'vitest';
import type { Alert } from '@/lib/api';
import {
  aggregate,
  aggregateTimeline,
  ALERT_RISK_BANDS,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  categoryOf,
  filterByDimension,
  moduleOf,
  riskBandOf,
  sourceOf,
  statusOf,
  topCustomers,
  valueFor,
} from '@/lib/alertDimensions';

function mkAlert(over: Partial<Alert> = {}): Alert {
  return {
    id: over.id ?? 'a-1',
    severity: over.severity ?? 'medium',
    customer: over.customer ?? { id: 'c-1', name: 'Alice' },
    rule: over.rule ?? { id: 'r-aml-01', name: 'AML watchlist hit' },
    indicators: over.indicators ?? [],
    age_min: over.age_min ?? 60,
    assignee: 'assignee' in over ? over.assignee : null,
    created_at: over.created_at ?? '2026-05-17T10:00:00Z',
    confidence: over.confidence ?? 0.8,
    customer_exposure_kes: over.customer_exposure_kes ?? 100000,
    criticality_score: over.criticality_score ?? 4,
    linked_alert_ids: over.linked_alert_ids ?? [],
  };
}

describe('statusOf', () => {
  it('returns open when assignee is null', () => {
    expect(statusOf(mkAlert({ assignee: null }))).toBe('open');
  });
  it('returns in_progress when assignee set and age < 240min', () => {
    expect(statusOf(mkAlert({ assignee: 'ravi', age_min: 30 }))).toBe('in_progress');
  });
  it('returns acked when assignee set and age >= 240min', () => {
    expect(statusOf(mkAlert({ assignee: 'ravi', age_min: 480 }))).toBe('acked');
  });
});

describe('riskBandOf', () => {
  it('matches the criticality.bandFor cutoffs', () => {
    expect(riskBandOf(mkAlert({ criticality_score: 9 }))).toBe('critical');
    expect(riskBandOf(mkAlert({ criticality_score: 5 }))).toBe('high');
    expect(riskBandOf(mkAlert({ criticality_score: 3 }))).toBe('medium');
    expect(riskBandOf(mkAlert({ criticality_score: 1 }))).toBe('low');
  });
});

describe('categoryOf (heuristic from rule.name)', () => {
  it('returns the first significant token, lowercased', () => {
    expect(categoryOf(mkAlert({ rule: { id: 'r-1', name: 'DPD 30+ days' } }))).toBe('dpd');
    expect(categoryOf(mkAlert({ rule: { id: 'r-2', name: 'AML watchlist hit' } }))).toBe('aml');
  });
  it('returns unclassified for empty rule name', () => {
    expect(categoryOf(mkAlert({ rule: { id: 'r-x', name: '' } }))).toBe('unclassified');
  });
});

describe('moduleOf (heuristic from rule.id)', () => {
  it('classifies fraud rules', () => {
    expect(moduleOf(mkAlert({ rule: { id: 'r-fraud-01', name: '' } }))).toBe('fraud_detection');
  });
  it('classifies financial / risk rules', () => {
    expect(moduleOf(mkAlert({ rule: { id: 'r-fin-22', name: '' } }))).toBe('risk_indicators');
  });
  it('classifies AML rules as compliance', () => {
    expect(moduleOf(mkAlert({ rule: { id: 'r-aml-99', name: '' } }))).toBe('compliance');
  });
  it('returns unclassified for unknown prefixes', () => {
    expect(moduleOf(mkAlert({ rule: { id: 'r-mystery-1', name: '' } }))).toBe('unclassified');
  });
});

describe('sourceOf (today: always rule_engine)', () => {
  it('returns rule_engine for every alert until BFF emits alert.source', () => {
    expect(sourceOf(mkAlert())).toBe('rule_engine');
  });
});

describe('valueFor dispatcher', () => {
  it('routes each dimension to the right classifier', () => {
    const a = mkAlert({
      severity: 'high',
      criticality_score: 9,
      assignee: null,
      rule: { id: 'r-aml-01', name: 'AML watchlist' },
    });
    expect(valueFor(a, 'severity')).toBe('high');
    expect(valueFor(a, 'risk_band')).toBe('critical');
    expect(valueFor(a, 'status')).toBe('open');
    expect(valueFor(a, 'category')).toBe('aml');
    expect(valueFor(a, 'module')).toBe('compliance');
    expect(valueFor(a, 'source')).toBe('rule_engine');
  });
});

describe('aggregate', () => {
  const alerts = [
    mkAlert({ id: 'a-1', severity: 'critical' }),
    mkAlert({ id: 'a-2', severity: 'critical' }),
    mkAlert({ id: 'a-3', severity: 'high' }),
    mkAlert({ id: 'a-4', severity: 'low' }),
  ];

  it('counts correctly without order', () => {
    const result = aggregate(alerts, 'severity');
    const map = Object.fromEntries(result.map((r) => [r.value, r.count]));
    expect(map.critical).toBe(2);
    expect(map.high).toBe(1);
    expect(map.low).toBe(1);
    expect(map.medium).toBeUndefined();
  });

  it('zero-fills missing keys when order is supplied', () => {
    const result = aggregate(alerts, 'severity', { order: ALERT_SEVERITIES });
    expect(result.map((r) => r.value)).toEqual(['critical', 'high', 'medium', 'low']);
    expect(result.find((r) => r.value === 'medium')?.count).toBe(0);
  });

  it('emits buckets sorted by count desc when no order', () => {
    const result = aggregate(alerts, 'severity');
    expect(result[0].count).toBeGreaterThanOrEqual(result[result.length - 1].count);
  });
});

describe('aggregateTimeline', () => {
  it('buckets by YYYY-MM-DD and sorts oldest-first', () => {
    const alerts = [
      mkAlert({ id: 'a-1', created_at: '2026-05-17T08:00:00Z' }),
      mkAlert({ id: 'a-2', created_at: '2026-05-17T18:00:00Z' }),
      mkAlert({ id: 'a-3', created_at: '2026-05-15T12:00:00Z' }),
    ];
    const result = aggregateTimeline(alerts);
    expect(result).toEqual([
      { date: '2026-05-15', count: 1 },
      { date: '2026-05-17', count: 2 },
    ]);
  });

  it('skips alerts with empty created_at', () => {
    const alerts = [mkAlert({ id: 'a-x', created_at: '' })];
    expect(aggregateTimeline(alerts)).toEqual([]);
  });
});

describe('filterByDimension', () => {
  it('returns only matching alerts', () => {
    const alerts = [
      mkAlert({ id: 'a-1', severity: 'critical' }),
      mkAlert({ id: 'a-2', severity: 'high' }),
      mkAlert({ id: 'a-3', severity: 'critical' }),
    ];
    const out = filterByDimension(alerts, 'severity', 'critical');
    expect(out.map((a) => a.id)).toEqual(['a-1', 'a-3']);
  });
});

describe('topCustomers', () => {
  it('groups by customer + sums exposure + sorts by count desc', () => {
    const alerts = [
      mkAlert({ id: 'a-1', customer: { id: 'c-1', name: 'Alice' }, customer_exposure_kes: 100 }),
      mkAlert({ id: 'a-2', customer: { id: 'c-1', name: 'Alice' }, customer_exposure_kes: 50 }),
      mkAlert({ id: 'a-3', customer: { id: 'c-2', name: 'Bob' }, customer_exposure_kes: 200 }),
    ];
    const out = topCustomers(alerts, 5);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      customer_id: 'c-1',
      customer_name: 'Alice',
      count: 2,
      total_exposure_kes: 150,
    });
    expect(out[1]).toEqual({
      customer_id: 'c-2',
      customer_name: 'Bob',
      count: 1,
      total_exposure_kes: 200,
    });
  });

  it('respects the n cap', () => {
    const alerts = Array.from({ length: 10 }, (_, i) =>
      mkAlert({ id: `a-${i}`, customer: { id: `c-${i}`, name: `Customer ${i}` } }),
    );
    expect(topCustomers(alerts, 3)).toHaveLength(3);
  });
});

describe('enum invariants (canonical orders)', () => {
  it('ALERT_SEVERITIES is 4 in canonical order', () => {
    expect(ALERT_SEVERITIES).toEqual(['critical', 'high', 'medium', 'low']);
  });
  it('ALERT_RISK_BANDS mirrors severities', () => {
    expect(ALERT_RISK_BANDS).toEqual(['critical', 'high', 'medium', 'low']);
  });
  it('ALERT_STATUSES is open → in_progress → acked', () => {
    expect(ALERT_STATUSES).toEqual(['open', 'in_progress', 'acked']);
  });
});
