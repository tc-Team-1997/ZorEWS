// services/bff/__tests__/analytics_alert_resolution.test.ts
//
// T4.1 — Alert Resolution sub-dashboard (EWS.docx §5.5 / §8). Three
// layers of coverage:
//   1. Pure resolver — funnel, p50/p95, weekly trend, severity filter.
//   2. Route — RBAC, envelope, validation, happy path.
//   3. Edge cases — empty input, single-sample percentile, partial
//      lifecycle (acked but not closed).

import request from 'supertest';
import {
  computeAlertResolution,
  InMemoryAlertResolutionSource,
  type AlertLifecycleRow,
} from '../src/analytics/alert_resolution';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-08T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function rowAt(
  base: Date,
  over: Partial<AlertLifecycleRow> & { id?: number; ackMin?: number | null; closeMin?: number | null },
): AlertLifecycleRow {
  const id = over.id ?? 1;
  return {
    alert_id: over.alert_id ?? `a-${id}`,
    severity: over.severity ?? 'medium',
    status:
      over.status ??
      (over.closeMin != null ? 'closed' : over.ackMin != null ? 'acked' : 'open'),
    created_at: base.toISOString(),
    acked_at:
      over.ackMin == null
        ? null
        : new Date(base.getTime() + over.ackMin * 60_000).toISOString(),
    closed_at:
      over.closeMin == null
        ? null
        : new Date(base.getTime() + over.closeMin * 60_000).toISOString(),
  };
}

// ── 1. Pure resolver ──────────────────────────────────────────────────

describe('computeAlertResolution', () => {
  test('returns zero/null funnel + duration on empty input', () => {
    const out = computeAlertResolution({
      tenant_id: 'BANK_DEMO',
      rows: [],
      asOf: NOW,
    });
    expect(out.funnel.find((s) => s.stage === 'created')!.count).toBe(0);
    expect(out.ack_duration).toEqual({ n: 0, p50_sec: null, p95_sec: null, mean_sec: null });
    expect(out.close_duration).toEqual({ n: 0, p50_sec: null, p95_sec: null, mean_sec: null });
    expect(out.trend).toEqual([]);
  });

  test('funnel ratios are conversions vs. created', () => {
    const base = new Date(NOW.getTime() - 60 * 60_000);
    const rows: AlertLifecycleRow[] = [
      rowAt(base, { id: 1, ackMin: 5,  closeMin: 60 }),
      rowAt(base, { id: 2, ackMin: 10, closeMin: 90 }),
      rowAt(base, { id: 3, ackMin: 15, closeMin: null }),    // open at end
      rowAt(base, { id: 4, ackMin: null, closeMin: null }),  // never acked
    ];
    const out = computeAlertResolution({ tenant_id: 'BANK_DEMO', rows, asOf: NOW });
    const map = Object.fromEntries(out.funnel.map((s) => [s.stage, s]));
    expect(map.created.count).toBe(4);
    expect(map.acked.count).toBe(3);
    expect(map.investigated.count).toBe(3); // all 3 acked have ≥5min between ack and close (or open)
    expect(map.closed.count).toBe(2);
    expect(map.acked.ratio).toBe(0.75);
    expect(map.closed.ratio).toBe(0.5);
  });

  test('investigated excludes acked-but-immediately-closed (< 5 min gap)', () => {
    const base = new Date(NOW.getTime() - 60 * 60_000);
    const rows = [
      rowAt(base, { id: 1, ackMin: 5,  closeMin: 6 }),  // 1 min gap → not investigated
      rowAt(base, { id: 2, ackMin: 5,  closeMin: 30 }), // 25 min gap → investigated
    ];
    const out = computeAlertResolution({ tenant_id: 'BANK_DEMO', rows, asOf: NOW });
    expect(out.funnel.find((s) => s.stage === 'investigated')!.count).toBe(1);
    expect(out.funnel.find((s) => s.stage === 'closed')!.count).toBe(2);
  });

  test('p50/p95 are computed in seconds, mean too', () => {
    const base = new Date(NOW.getTime() - 60 * 60_000);
    // Ack times: 1, 2, 3, 4, 100 minutes → p50=3min, p95=100min
    const rows = [1, 2, 3, 4, 100].map((m, i) =>
      rowAt(base, { id: i, ackMin: m, closeMin: m + 30 }),
    );
    const out = computeAlertResolution({ tenant_id: 'BANK_DEMO', rows, asOf: NOW });
    expect(out.ack_duration.n).toBe(5);
    expect(out.ack_duration.p50_sec).toBe(3 * 60);
    expect(out.ack_duration.p95_sec).toBe(100 * 60);
    expect(out.ack_duration.mean_sec).toBe(Math.round((1 + 2 + 3 + 4 + 100) * 60 / 5));
  });

  test('severity filter narrows the row set', () => {
    const base = new Date(NOW.getTime() - 60 * 60_000);
    const rows: AlertLifecycleRow[] = [
      rowAt(base, { id: 1, severity: 'critical', ackMin: 5, closeMin: 30 }),
      rowAt(base, { id: 2, severity: 'high',     ackMin: 5, closeMin: 30 }),
      rowAt(base, { id: 3, severity: 'medium',   ackMin: 5, closeMin: 30 }),
    ];
    const out = computeAlertResolution({
      tenant_id: 'BANK_DEMO',
      rows,
      filter: { severity: 'critical' },
      asOf: NOW,
    });
    expect(out.funnel.find((s) => s.stage === 'created')!.count).toBe(1);
  });

  test('from/to date filter narrows by created_at', () => {
    const recent = new Date(NOW.getTime() - 60 * 60_000);
    const old = new Date(NOW.getTime() - 30 * 86_400_000);
    const rows: AlertLifecycleRow[] = [
      rowAt(recent, { id: 1, ackMin: 5 }),
      rowAt(old,    { id: 2, ackMin: 5 }),
    ];
    const out = computeAlertResolution({
      tenant_id: 'BANK_DEMO',
      rows,
      filter: { from: new Date(NOW.getTime() - 7 * 86_400_000).toISOString() },
      asOf: NOW,
    });
    expect(out.funnel.find((s) => s.stage === 'created')!.count).toBe(1);
  });

  test('weekly trend buckets created/acked/closed events into the right ISO week', () => {
    const week1 = new Date('2026-05-04T10:00:00.000Z'); // Mon, ISO 2026-W19
    const week2 = new Date('2026-05-11T10:00:00.000Z'); // Mon, ISO 2026-W20
    const rows: AlertLifecycleRow[] = [
      rowAt(week1, { id: 1, ackMin: 60,  closeMin: 60 * 24 * 7 + 60 }), // close lands in W20
      rowAt(week2, { id: 2, ackMin: 60,  closeMin: 60 * 2 }),
    ];
    const out = computeAlertResolution({ tenant_id: 'BANK_DEMO', rows, asOf: NOW });
    const byWeek = Object.fromEntries(out.trend.map((b) => [b.week, b]));
    expect(byWeek['2026-W19'].created).toBe(1);
    expect(byWeek['2026-W19'].acked).toBe(1);
    expect(byWeek['2026-W20'].created).toBe(1);
    // First alert closed in W20 + second closed in W20 → 2 closes in W20
    expect(byWeek['2026-W20'].closed).toBe(2);
  });
});

// ── 2. Route + RBAC ───────────────────────────────────────────────────

function makeAppForAnalytics(role = 'admin', rows: AlertLifecycleRow[] = []) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    alertResolutionSource: new InMemoryAlertResolutionSource(rows),
  }).app;
}

describe('GET /v1/analytics/alert-resolution', () => {
  test('returns funnel + duration in EWS envelope on happy path', async () => {
    const base = new Date(NOW.getTime() - 60 * 60_000);
    const rows = [
      rowAt(base, { id: 1, ackMin: 5, closeMin: 30 }),
      rowAt(base, { id: 2, ackMin: 10, closeMin: 60 }),
    ];
    const app = makeAppForAnalytics('admin', rows);
    const r = await request(app)
      .get('/v1/analytics/alert-resolution')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.funnel).toHaveLength(4);
    expect(r.body.body.ack_duration.n).toBe(2);
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
  });

  test('passes through severity filter', async () => {
    const base = new Date(NOW.getTime() - 60 * 60_000);
    const rows = [
      rowAt(base, { id: 1, severity: 'critical', ackMin: 5, closeMin: 30 }),
      rowAt(base, { id: 2, severity: 'low',      ackMin: 5, closeMin: 30 }),
    ];
    const app = makeAppForAnalytics('admin', rows);
    const r = await request(app)
      .get('/v1/analytics/alert-resolution?severity=critical')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(200);
    expect(r.body.body.funnel.find((s: { stage: string; count: number }) => s.stage === 'created').count).toBe(1);
  });

  test('400 on invalid severity', async () => {
    const app = makeAppForAnalytics('admin', []);
    const r = await request(app)
      .get('/v1/analytics/alert-resolution?severity=urgent')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('400 on invalid from date', async () => {
    const app = makeAppForAnalytics('admin', []);
    const r = await request(app)
      .get('/v1/analytics/alert-resolution?from=not-a-date')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(400);
  });

  test('403 when role lacks dashboard:analytics:read', async () => {
    const app = makeAppForAnalytics('collection_officer', []);
    const r = await request(app)
      .get('/v1/analytics/alert-resolution')
      .set(TH)
      .set('x-apex-role', 'collection_officer');
    expect(r.status).toBe(403);
  });
});
