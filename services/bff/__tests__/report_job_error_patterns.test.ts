// services/bff/__tests__/report_job_error_patterns.test.ts
//
// T6 M12.15 — Report job error pattern clustering.

import request from 'supertest';
import {
  clusterReportJobFailures,
  REPORT_FAILURE_CLUSTERS_CAP,
} from '../src/report_job_error_patterns';
import {
  InMemoryReportJobStore,
  type ReportJobStore,
} from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeFpApp(role: string = 'admin', reportJobStore?: ReportJobStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    reportJobStore: reportJobStore ?? new InMemoryReportJobStore(),
  });
}

function submitAndFail(
  store: ReportJobStore,
  tenant: string,
  report_id: string,
  format: 'json' | 'csv' | 'pdf' | 'xlsx',
  errorMsg: string,
  at: Date = NOW,
) {
  const job = store.submit(
    tenant,
    { report_id, format },
    'analyst',
    at,
  );
  store.markFailed(tenant, job.job_id, errorMsg);
  return job;
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M12.15 — empty store', () => {
  test('zero jobs → zero clusters + zero counts', () => {
    const store = new InMemoryReportJobStore();
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.sample_size).toBe(0);
    expect(s.failure_count).toBe(0);
    expect(s.distinct_patterns).toBe(0);
    expect(s.clusters).toEqual([]);
  });
});

describe('M12.15 — successful jobs don\'t contribute', () => {
  test('only failed jobs counted', () => {
    const store = new InMemoryReportJobStore();
    store.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'pdf' }, 'a', NOW);
    store.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'pdf' }, 'a', NOW);
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'database timeout after 30s');
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.sample_size).toBe(3);
    expect(s.failure_count).toBe(1);
    expect(s.distinct_patterns).toBe(1);
  });
});

describe('M12.15 — empty error_message skipped', () => {
  test('failed job with empty error_message excluded', () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', '');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', '   ');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'real error');
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.failure_count).toBe(1);
  });
});

describe('M12.15 — single cluster grouping', () => {
  test('similar errors normalised into one cluster', () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'database timeout after 30s');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'database timeout after 45s');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'database timeout after 60s');
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.failure_count).toBe(3);
    expect(s.distinct_patterns).toBe(1);
    expect(s.clusters.length).toBe(1);
    expect(s.clusters[0].count).toBe(3);
  });
});

describe('M12.15 — multiple distinct clusters', () => {
  test('different patterns → separate clusters', () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'timeout after 30s');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'permission denied for user analyst');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'out of memory allocating 5GB');
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.failure_count).toBe(3);
    expect(s.distinct_patterns).toBe(3);
    expect(s.clusters.length).toBe(3);
  });
});

describe('M12.15 — cluster sort: count desc then last_failed_at desc', () => {
  test('biggest cluster first', () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'big error 1');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'big error 2');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'big error 3');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'unique problem');
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.clusters[0].count).toBe(3);
    expect(s.clusters[1].count).toBe(1);
  });
});

describe('M12.15 — top-N cap', () => {
  test('clusters capped at REPORT_FAILURE_CLUSTERS_CAP', () => {
    const store = new InMemoryReportJobStore();
    // Create 15 distinct error patterns
    for (let i = 0; i < 15; i++) {
      submitAndFail(
        store,
        'BIL',
        'rbi_quarterly_summary',
        'pdf',
        `unique-error-type-${String.fromCharCode(97 + i)}`,
      );
    }
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.distinct_patterns).toBe(15);
    expect(s.clusters.length).toBe(REPORT_FAILURE_CLUSTERS_CAP);
  });
});

describe('M12.15 — recent_messages cap 3 newest-first', () => {
  test('exemplars sorted newest first capped at 3', () => {
    const store = new InMemoryReportJobStore();
    // Same normalised pattern, different raw messages, sequential timestamps
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf',
      'timeout after 10s',
      new Date('2026-05-17T10:00:00.000Z'));
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf',
      'timeout after 20s',
      new Date('2026-05-17T11:00:00.000Z'));
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf',
      'timeout after 30s',
      new Date('2026-05-17T12:00:00.000Z'));
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf',
      'timeout after 40s',
      new Date('2026-05-17T13:00:00.000Z'));
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.clusters[0].count).toBe(4);
    expect(s.clusters[0].recent_messages.length).toBe(3);
    // Newest-first ordering
    expect(s.clusters[0].recent_messages[0]).toMatch(/40s/);
    expect(s.clusters[0].recent_messages[1]).toMatch(/30s/);
    expect(s.clusters[0].recent_messages[2]).toMatch(/20s/);
  });
});

describe('M12.15 — sample_job_id points at newest failure', () => {
  test('sample_job_id from newest job in cluster', () => {
    const store = new InMemoryReportJobStore();
    const old = submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf',
      'timeout 10s', new Date('2026-05-17T10:00:00.000Z'));
    const newest = submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf',
      'timeout 20s', new Date('2026-05-17T11:00:00.000Z'));
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.clusters[0].sample_job_id).toBe(newest.job_id);
    expect(s.clusters[0].sample_job_id).not.toBe(old.job_id);
  });
});

describe('M12.15 — report_ids per cluster sorted asc', () => {
  test('cluster aggregates distinct report_ids', () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'timeout 10s');
    submitAndFail(store, 'BIL', 'irdai_claims_quarterly', 'pdf', 'timeout 20s');
    submitAndFail(store, 'BIL', 'agent_productivity_monthly', 'xlsx', 'timeout 30s');
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    // All 3 jobs collapse to the same pattern (timeout <N>s)
    expect(s.clusters[0].count).toBe(3);
    expect(s.clusters[0].report_ids.length).toBe(3);
    expect(s.clusters[0].report_ids).toEqual([
      'agent_productivity_monthly',
      'irdai_claims_quarterly',
      'rbi_quarterly_summary',
    ]);
  });

  test('same report_id twice → counted once in report_ids', () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'timeout 10s');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'timeout 20s');
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.clusters[0].count).toBe(2);
    expect(s.clusters[0].report_ids).toEqual(['rbi_quarterly_summary']);
  });
});

describe('M12.15 — pattern normalisation', () => {
  test('numbers replaced with <N>', () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'timeout after 30s');
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.clusters[0].pattern).toContain('<N>');
  });

  test('UUIDs replaced with <UUID>', () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf',
      'job a1b2c3d4-e5f6-1234-5678-9abcdef01234 not found');
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.clusters[0].pattern).toContain('<UUID>');
  });
});

describe('M12.15 — tenant scoping', () => {
  test('BIL failures invisible to BANK_DEMO', () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'timeout 30s');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'timeout 45s');
    const bil = clusterReportJobFailures(store, 'BIL', NOW);
    const bank = clusterReportJobFailures(store, 'BANK_DEMO', NOW);
    expect(bil.failure_count).toBe(2);
    expect(bank.failure_count).toBe(0);
  });
});

describe('M12.15 — tenant_id + generated_at echo', () => {
  test('envelope carries tenant_id + ISO timestamp', () => {
    const store = new InMemoryReportJobStore();
    const s = clusterReportJobFailures(store, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M12.15 — GET /v1/reports/jobs/error-patterns', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeFpApp('admin');
    const r = await request(app)
      .get('/v1/reports/jobs/error-patterns')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.clusters).toEqual([]);
    expect(r.body.body.failure_count).toBe(0);
  });

  test('populated → reflects failed jobs', async () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'timeout 30s');
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'timeout 60s');
    const { app } = makeFpApp('admin', store);
    const r = await request(app)
      .get('/v1/reports/jobs/error-patterns')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.failure_count).toBe(2);
    expect(r.body.body.distinct_patterns).toBe(1);
    expect(r.body.body.clusters[0].count).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFpApp('case_owner');
    const r = await request(app)
      .get('/v1/reports/jobs/error-patterns')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryReportJobStore();
    submitAndFail(store, 'BIL', 'rbi_quarterly_summary', 'pdf', 'timeout 30s');
    const { app } = makeFpApp('admin', store);
    const bankR = await request(app)
      .get('/v1/reports/jobs/error-patterns')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.failure_count).toBe(0);
    const bilR = await request(app)
      .get('/v1/reports/jobs/error-patterns')
      .set(TH_BIL);
    expect(bilR.body.body.failure_count).toBe(1);
  });

  test('literal `/error-patterns` not captured by `:job_id` wildcard', async () => {
    const { app } = makeFpApp('admin');
    const r = await request(app)
      .get('/v1/reports/jobs/error-patterns')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.clusters).toBeDefined();
  });

  test('M12.13 /v1/reports/jobs/daily-volume sibling regression still 200', async () => {
    const { app } = makeFpApp('admin');
    const r = await request(app)
      .get('/v1/reports/jobs/daily-volume')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
