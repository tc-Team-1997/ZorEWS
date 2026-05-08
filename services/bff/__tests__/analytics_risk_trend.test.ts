// services/bff/__tests__/analytics_risk_trend.test.ts
//
// T4.1 4b — Risk Trend sub-dashboard. Three-layer coverage:
//   1. Pure resolver — weekly bucketing, severity counts, avg
//      criticality, high-critical share, segment lookup.
//   2. ISO-week edge cases — alerts on year-boundary land in the right
//      week-label.
//   3. Route — RBAC, envelope, validation, segment-filter pass-through.

import request from 'supertest';
import {
  computeRiskTrend,
  InMemoryRiskTrendSource,
  type AlertSeverity,
  type RiskTrendRow,
} from '../src/analytics/risk_trend';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-08T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function row(over: Partial<RiskTrendRow> & { id?: number; createdAt: string }): RiskTrendRow {
  const id = over.id ?? 1;
  return {
    alert_id: over.alert_id ?? `a-${id}`,
    customer_id: over.customer_id ?? `cust-${id}`,
    severity: (over.severity ?? 'medium') as AlertSeverity,
    criticality_score: over.criticality_score ?? 50,
    created_at: over.createdAt,
  };
}

// ── 1. Pure resolver ──────────────────────────────────────────────────

describe('computeRiskTrend', () => {
  test('empty input → no buckets, null totals', () => {
    const out = computeRiskTrend({ tenant_id: 'BANK_DEMO', rows: [], asOf: NOW });
    expect(out.buckets).toEqual([]);
    expect(out.totals.alert_count).toBe(0);
    expect(out.totals.avg_criticality).toBeNull();
    expect(out.totals.high_critical_share).toBe(0);
  });

  test('buckets rows into ISO weeks; counts by severity', () => {
    // 2026-W19 = Mon May 4 - Sun May 10
    // 2026-W20 = Mon May 11 - Sun May 17
    const rows = [
      row({ id: 1, createdAt: '2026-05-04T08:00:00Z', severity: 'critical', criticality_score: 90 }),
      row({ id: 2, createdAt: '2026-05-06T15:00:00Z', severity: 'high', criticality_score: 70 }),
      row({ id: 3, createdAt: '2026-05-10T23:59:00Z', severity: 'medium', criticality_score: 30 }),
      row({ id: 4, createdAt: '2026-05-11T00:01:00Z', severity: 'low', criticality_score: 10 }),
      row({ id: 5, createdAt: '2026-05-13T12:00:00Z', severity: 'high', criticality_score: 75 }),
    ];
    const out = computeRiskTrend({ tenant_id: 'BANK_DEMO', rows, asOf: NOW });
    expect(out.buckets.map((b) => b.week)).toEqual(['2026-W19', '2026-W20']);
    const w19 = out.buckets[0];
    expect(w19.total).toBe(3);
    expect(w19.by_severity).toEqual({ critical: 1, high: 1, medium: 1, low: 0 });
    expect(w19.high_critical_share).toBeCloseTo(2 / 3, 3);
    // (90+70+30)/3 = 63.33
    expect(w19.avg_criticality).toBeCloseTo(63.33, 1);
  });

  test('totals aggregate across all buckets', () => {
    const rows = [
      row({ id: 1, createdAt: '2026-05-01T00:00:00Z', severity: 'critical', criticality_score: 80 }),
      row({ id: 2, createdAt: '2026-05-08T00:00:00Z', severity: 'low', criticality_score: 20 }),
    ];
    const out = computeRiskTrend({ tenant_id: 'BANK_DEMO', rows, asOf: NOW });
    expect(out.totals.alert_count).toBe(2);
    expect(out.totals.avg_criticality).toBe(50);
    expect(out.totals.high_critical_share).toBe(0.5);
  });

  test('from/to filter narrows by created_at', () => {
    const rows = [
      row({ id: 1, createdAt: '2026-04-01T00:00:00Z' }),
      row({ id: 2, createdAt: '2026-05-01T00:00:00Z' }),
      row({ id: 3, createdAt: '2026-06-01T00:00:00Z' }),
    ];
    const out = computeRiskTrend({
      tenant_id: 'BANK_DEMO',
      rows,
      filter: { from: '2026-04-15T00:00:00Z', to: '2026-05-31T23:59:59Z' },
      asOf: NOW,
    });
    expect(out.totals.alert_count).toBe(1);
  });

  test('segment filter — only rows whose customer maps to the segment count', () => {
    const segmentMap: Record<string, string> = { 'cust-1': 'retail', 'cust-2': 'sme', 'cust-3': 'retail' };
    const rows = [
      row({ id: 1, createdAt: '2026-05-04T00:00:00Z' }),
      row({ id: 2, createdAt: '2026-05-04T00:00:00Z' }),
      row({ id: 3, createdAt: '2026-05-04T00:00:00Z' }),
    ];
    const out = computeRiskTrend({
      tenant_id: 'BANK_DEMO',
      rows,
      filter: { segment: 'retail' },
      segmentOf: (id) => segmentMap[id] ?? null,
      asOf: NOW,
    });
    expect(out.totals.alert_count).toBe(2); // cust-1 + cust-3
  });

  test('ISO-week year-boundary case (Dec 31 / Jan 1)', () => {
    // 2025-12-29 (Mon) → ISO 2026-W01 (because Thursday 2026-01-01)
    // 2026-01-04 (Sun) → ISO 2026-W01
    // 2026-01-05 (Mon) → ISO 2026-W02
    const rows = [
      row({ id: 1, createdAt: '2025-12-29T08:00:00Z' }),
      row({ id: 2, createdAt: '2026-01-04T08:00:00Z' }),
      row({ id: 3, createdAt: '2026-01-05T08:00:00Z' }),
    ];
    const out = computeRiskTrend({ tenant_id: 'BANK_DEMO', rows, asOf: NOW });
    const labels = out.buckets.map((b) => b.week);
    expect(labels).toEqual(['2026-W01', '2026-W02']);
    expect(out.buckets[0].total).toBe(2);
  });
});

// ── 2. Route ──────────────────────────────────────────────────────────

function makeAppFor(role = 'admin', rows: RiskTrendRow[] = []) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    riskTrendSource: new InMemoryRiskTrendSource(rows),
  }).app;
}

describe('GET /v1/analytics/risk-trend', () => {
  test('happy path returns buckets in EWS envelope', async () => {
    const rows = [
      row({ id: 1, createdAt: '2026-05-04T00:00:00Z', severity: 'critical', criticality_score: 80 }),
      row({ id: 2, createdAt: '2026-05-06T00:00:00Z', severity: 'high', criticality_score: 60 }),
    ];
    const r = await request(makeAppFor('admin', rows))
      .get('/v1/analytics/risk-trend')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.buckets).toHaveLength(1);
    expect(r.body.body.totals.alert_count).toBe(2);
  });

  test('400 on invalid from date', async () => {
    const r = await request(makeAppFor('admin', []))
      .get('/v1/analytics/risk-trend?from=not-a-date')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(400);
  });

  test('403 for collection_officer', async () => {
    const r = await request(makeAppFor('collection_officer', []))
      .get('/v1/analytics/risk-trend')
      .set(TH)
      .set('x-apex-role', 'collection_officer');
    expect(r.status).toBe(403);
  });
});
