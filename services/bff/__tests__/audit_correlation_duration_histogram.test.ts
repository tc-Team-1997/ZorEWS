// services/bff/__tests__/audit_correlation_duration_histogram.test.ts
//
// T6 M15.16 — Audit correlation duration histogram.

import request from 'supertest';
import {
  buildAuditCorrelationDurationHistogram,
  ALL_CORRELATION_DURATION_BUCKETS,
} from '../src/audit_correlation_duration_histogram';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
  type AuditOutcome,
  type AuditTrailStore,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeCdhApp(role: string = 'admin', auditTrailStore?: AuditTrailStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditTrailStore: auditTrailStore ?? new InMemoryAuditTrailStore(),
  });
}

function record(
  store: AuditTrailStore,
  tenant: string,
  correlation_id: string | null,
  outcome: AuditOutcome,
  at: Date,
): AuditEvent {
  return store.record(
    tenant,
    {
      action: 'test.action',
      resource_type: 'system',
      resource_id: 'r1',
      outcome,
      severity: 'info',
      actor_username: 'u',
      actor_role: 'admin',
      correlation_id: correlation_id ?? undefined,
    },
    at,
  );
}

function drainList(store: AuditTrailStore, tenant: string) {
  return store.list(tenant, { page: 1, page_size: 500 }).items;
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M15.16 — empty input', () => {
  test('zero events → 5 zero buckets + null leaderboards', () => {
    const s = buildAuditCorrelationDurationHistogram('BIL', [], NOW);
    expect(s.total_correlations).toBe(0);
    expect(s.total_events_with_correlation).toBe(0);
    expect(s.buckets.length).toBe(5);
    for (const b of s.buckets) {
      expect(b.count).toBe(0);
      expect(b.has_failure_count).toBe(0);
      expect(b.sample_correlation_ids).toEqual([]);
    }
    expect(s.peak_bucket).toBeNull();
    expect(s.mean_duration_ms).toBeNull();
    expect(s.median_duration_ms).toBeNull();
    expect(s.p95_duration_ms).toBeNull();
    expect(s.longest_correlation).toBeNull();
    expect(s.failed_correlations).toEqual([]);
  });
});

describe('M15.16 — canonical bucket order', () => {
  test('buckets[] in canonical order', () => {
    const s = buildAuditCorrelationDurationHistogram('BIL', [], NOW);
    expect(s.buckets.map((b) => b.bucket)).toEqual([...ALL_CORRELATION_DURATION_BUCKETS]);
  });

  test('every bucket exposes label + min_ms + max_ms metadata', () => {
    const s = buildAuditCorrelationDurationHistogram('BIL', [], NOW);
    for (const b of s.buckets) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.min_ms).toBeGreaterThanOrEqual(0);
    }
    // day_plus is the only bucket with null max_ms
    const dayPlus = s.buckets.find((b) => b.bucket === 'day_plus')!;
    expect(dayPlus.max_ms).toBeNull();
  });
});

describe('M15.16 — null correlation_id excluded', () => {
  test('events without correlation_id not counted in correlations', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', null, 'success', NOW);
    record(store, 'BIL', 'corr-1', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.total_correlations).toBe(1);
    expect(s.total_events_with_correlation).toBe(1);
  });
});

describe('M15.16 — single-event correlation → instant bucket', () => {
  test('correlation with 1 event has duration_ms=0 → instant', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.total_correlations).toBe(1);
    expect(s.buckets.find((b) => b.bucket === 'instant')!.count).toBe(1);
    expect(s.mean_duration_ms).toBe(0);
  });
});

describe('M15.16 — bucket boundaries', () => {
  test('fast bucket: events 2s apart → fast', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', new Date(NOW.getTime() - 2000));
    record(store, 'BIL', 'corr-1', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.buckets.find((b) => b.bucket === 'fast')!.count).toBe(1);
  });

  test('medium bucket: events 5m apart → medium', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', new Date(NOW.getTime() - 5 * 60 * 1000));
    record(store, 'BIL', 'corr-1', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.buckets.find((b) => b.bucket === 'medium')!.count).toBe(1);
  });

  test('slow bucket: events 3h apart → slow', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', new Date(NOW.getTime() - 3 * 60 * 60 * 1000));
    record(store, 'BIL', 'corr-1', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.buckets.find((b) => b.bucket === 'slow')!.count).toBe(1);
  });

  test('day_plus bucket: events 2d apart → day_plus', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000));
    record(store, 'BIL', 'corr-1', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.buckets.find((b) => b.bucket === 'day_plus')!.count).toBe(1);
  });
});

describe('M15.16 — strict-< upper bound at exact 1s', () => {
  test('1s exactly → fast (not instant)', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', new Date(NOW.getTime() - 1000));
    record(store, 'BIL', 'corr-1', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.buckets.find((b) => b.bucket === 'instant')!.count).toBe(0);
    expect(s.buckets.find((b) => b.bucket === 'fast')!.count).toBe(1);
  });
});

describe('M15.16 — has_failure_count tracking', () => {
  test('correlation with non-success event flagged', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', new Date(NOW.getTime() - 2000));
    record(store, 'BIL', 'corr-1', 'failure', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    const fast = s.buckets.find((b) => b.bucket === 'fast')!;
    expect(fast.has_failure_count).toBe(1);
  });

  test('all-success correlation not flagged', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', new Date(NOW.getTime() - 2000));
    record(store, 'BIL', 'corr-1', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    const fast = s.buckets.find((b) => b.bucket === 'fast')!;
    expect(fast.has_failure_count).toBe(0);
  });
});

describe('M15.16 — peak_bucket', () => {
  test('highest-count bucket wins; canonical tie-break', () => {
    const store = new InMemoryAuditTrailStore();
    // 2 instant + 1 fast
    record(store, 'BIL', 'inst-1', 'success', NOW);
    record(store, 'BIL', 'inst-2', 'success', NOW);
    record(store, 'BIL', 'fast-1', 'success', new Date(NOW.getTime() - 2000));
    record(store, 'BIL', 'fast-1', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.peak_bucket).toBe('instant');
    expect(s.peak_count).toBe(2);
  });

  test('canonical tie-break: instant wins over fast at tied 1', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'inst-1', 'success', NOW);
    record(store, 'BIL', 'fast-1', 'success', new Date(NOW.getTime() - 2000));
    record(store, 'BIL', 'fast-1', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.peak_bucket).toBe('instant');
  });

  test('null when zero correlations', () => {
    const s = buildAuditCorrelationDurationHistogram('BIL', [], NOW);
    expect(s.peak_bucket).toBeNull();
  });
});

describe('M15.16 — samples cap 3 longest-first', () => {
  test('top 3 longest within bucket', () => {
    const store = new InMemoryAuditTrailStore();
    // 5 fast correlations, varying durations within fast bucket
    for (let i = 0; i < 5; i++) {
      record(store, 'BIL', `fast-${i}`, 'success', new Date(NOW.getTime() - (2000 + i * 1000)));
      record(store, 'BIL', `fast-${i}`, 'success', NOW);
    }
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    const fast = s.buckets.find((b) => b.bucket === 'fast')!;
    expect(fast.count).toBe(5);
    expect(fast.sample_correlation_ids.length).toBe(3);
    // longest = fast-4 (6s), then fast-3 (5s), then fast-2 (4s)
    expect(fast.sample_correlation_ids[0]).toBe('fast-4');
    expect(fast.sample_correlation_ids[1]).toBe('fast-3');
    expect(fast.sample_correlation_ids[2]).toBe('fast-2');
  });
});

describe('M15.16 — mean / median / p95', () => {
  test('over full duration distribution', () => {
    const store = new InMemoryAuditTrailStore();
    // 3 correlations: 1000ms / 2000ms / 3000ms
    record(store, 'BIL', 'a', 'success', new Date(NOW.getTime() - 1000));
    record(store, 'BIL', 'a', 'success', NOW);
    record(store, 'BIL', 'b', 'success', new Date(NOW.getTime() - 2000));
    record(store, 'BIL', 'b', 'success', NOW);
    record(store, 'BIL', 'c', 'success', new Date(NOW.getTime() - 3000));
    record(store, 'BIL', 'c', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.mean_duration_ms).toBe(2000);
    expect(s.median_duration_ms).toBe(2000);
    // p95 of [1k, 2k, 3k]: rank = 0.95 * 2 = 1.9; lower=2k, upper=3k, frac=0.9 → 2900
    expect(s.p95_duration_ms).toBe(2900);
  });
});

describe('M15.16 — longest_correlation', () => {
  test('id with longest duration; canonical asc tie-break', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'short', 'success', new Date(NOW.getTime() - 1000));
    record(store, 'BIL', 'short', 'success', NOW);
    record(store, 'BIL', 'long', 'success', new Date(NOW.getTime() - 5000));
    record(store, 'BIL', 'long', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.longest_correlation?.correlation_id).toBe('long');
    expect(s.longest_correlation?.duration_ms).toBe(5000);
  });

  test('null on empty', () => {
    const s = buildAuditCorrelationDurationHistogram('BIL', [], NOW);
    expect(s.longest_correlation).toBeNull();
  });
});

describe('M15.16 — failed_correlations', () => {
  test('subset with has_failure=true; sorted duration desc + id asc', () => {
    const store = new InMemoryAuditTrailStore();
    // Failed long
    record(store, 'BIL', 'long-fail', 'success', new Date(NOW.getTime() - 5000));
    record(store, 'BIL', 'long-fail', 'failure', NOW);
    // Success short
    record(store, 'BIL', 'short-ok', 'success', new Date(NOW.getTime() - 1000));
    record(store, 'BIL', 'short-ok', 'success', NOW);
    // Failed short
    record(store, 'BIL', 'short-fail', 'denied', new Date(NOW.getTime() - 1000));
    record(store, 'BIL', 'short-fail', 'success', NOW);
    const s = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    expect(s.failed_correlations).toEqual(['long-fail', 'short-fail']);
    expect(s.failed_correlations).not.toContain('short-ok');
  });
});

describe('M15.16 — tenant scoping', () => {
  test('BIL correlations invisible to BANK_DEMO', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', NOW);
    const bil = buildAuditCorrelationDurationHistogram('BIL', drainList(store, 'BIL'), NOW);
    const bank = buildAuditCorrelationDurationHistogram('BANK_DEMO', drainList(store, 'BANK_DEMO'), NOW);
    expect(bil.total_correlations).toBe(1);
    expect(bank.total_correlations).toBe(0);
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M15.16 — GET /v1/audit/correlation-duration-histogram', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeCdhApp('admin');
    const r = await request(app)
      .get('/v1/audit/correlation-duration-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_correlations).toBe(0);
    expect(r.body.body.buckets.length).toBe(5);
  });

  test('populated → reflects correlations', async () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', new Date(NOW.getTime() - 2000));
    record(store, 'BIL', 'corr-1', 'success', NOW);
    record(store, 'BIL', 'corr-2', 'failure', NOW);
    const { app } = makeCdhApp('admin', store);
    const r = await request(app)
      .get('/v1/audit/correlation-duration-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_correlations).toBe(2);
    expect(r.body.body.failed_correlations).toContain('corr-2');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCdhApp('case_owner');
    const r = await request(app)
      .get('/v1/audit/correlation-duration-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'corr-1', 'success', NOW);
    const { app } = makeCdhApp('admin', store);
    const bankR = await request(app)
      .get('/v1/audit/correlation-duration-histogram')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_correlations).toBe(0);
  });

  test('M15.10 /v1/audit/correlations sibling regression still 200', async () => {
    const { app } = makeCdhApp('admin');
    const r = await request(app)
      .get('/v1/audit/correlations')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
