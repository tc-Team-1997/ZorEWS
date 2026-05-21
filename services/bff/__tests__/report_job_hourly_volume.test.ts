// services/bff/__tests__/report_job_hourly_volume.test.ts
//
// T6 M12.18 — pure + HTTP route tests for the report job hourly
// volume distribution. Asserts: 24-bucket emission, partition
// invariants, peak-hour tie-break, every-key-present, distinct_
// requesters dedup, tenant scoping, mounted-before-:job_id ordering.

import {
  buildReportJobHourlyVolume,
  buildReportJobHourlyVolumeFromStore,
  HOURS_IN_DAY,
  ALL_REPORT_FORMATS_CANONICAL,
} from '../src/report_job_hourly_volume';
import {
  InMemoryReportJobStore,
  type JobStatus,
  type ReportFormat,
  type ReportJob,
} from '../src/reports_catalog';

const NOW = new Date('2026-05-21T12:00:00.000Z');

// Helper: ISO at a specific UTC hour for the day-of-NOW.
function atUtcHour(hour: number, day = '2026-05-15'): string {
  return `${day}T${String(hour).padStart(2, '0')}:30:00.000Z`;
}

function mkJob(
  hour: number,
  opts: Partial<ReportJob> & { tenant_id?: string } = {},
): ReportJob {
  return {
    job_id: opts.job_id ?? `j-${hour}-${Math.random().toString(36).slice(2, 6)}`,
    tenant_id: opts.tenant_id ?? 'BANK_DEMO',
    report_id: opts.report_id ?? 'r-sample',
    format: opts.format ?? 'json',
    status: opts.status ?? 'completed',
    requested_at: opts.requested_at ?? atUtcHour(hour),
    completed_at: opts.completed_at ?? null,
    requested_by: opts.requested_by ?? 'alice.admin',
    parameters: opts.parameters ?? {},
    download_url: opts.download_url ?? null,
    error_message: opts.error_message ?? null,
  };
}

// ---------------------------------------------------------------------
// buildReportJobHourlyVolume pure resolver
// ---------------------------------------------------------------------

describe('buildReportJobHourlyVolume (pure resolver)', () => {
  test('empty input → 24 zero buckets + all leaderboards null/empty', () => {
    const r = buildReportJobHourlyVolume('BANK_DEMO', [], NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe('2026-05-21T12:00:00.000Z');
    expect(r.total_jobs).toBe(0);
    expect(r.by_hour).toHaveLength(HOURS_IN_DAY);
    // Every bucket zero with every key present
    for (let h = 0; h < HOURS_IN_DAY; h++) {
      expect(r.by_hour[h].hour).toBe(h);
      expect(r.by_hour[h].total).toBe(0);
      expect(Object.keys(r.by_hour[h].by_status).sort()).toEqual(
        ['completed', 'failed', 'queued', 'running'].sort(),
      );
      expect(Object.keys(r.by_hour[h].by_format).sort()).toEqual(
        ['csv', 'json', 'pdf', 'xlsx'].sort(),
      );
      expect(r.by_hour[h].distinct_requesters).toBe(0);
    }
    expect(r.peak_hour).toBeNull();
    expect(r.peak_count).toBe(0);
    expect(r.mean_per_hour).toBe(0);
    expect(r.quiet_hours).toHaveLength(HOURS_IN_DAY);
    expect(r.busiest_format).toBeNull();
  });

  test('hours emitted in canonical 0..23 order', () => {
    const r = buildReportJobHourlyVolume('BANK_DEMO', [], NOW);
    expect(r.by_hour.map((b) => b.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  test('single job placed at correct UTC hour bucket (14:30 → bucket 14)', () => {
    const r = buildReportJobHourlyVolume('BANK_DEMO', [mkJob(14)], NOW);
    expect(r.total_jobs).toBe(1);
    expect(r.by_hour[14].total).toBe(1);
    expect(r.by_hour[14].by_status.completed).toBe(1);
    expect(r.by_hour[14].by_format.json).toBe(1);
    expect(r.by_hour[14].distinct_requesters).toBe(1);
    // Every other bucket zero
    for (let h = 0; h < HOURS_IN_DAY; h++) {
      if (h !== 14) expect(r.by_hour[h].total).toBe(0);
    }
  });

  test('boundary hours 0 + 23', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [mkJob(0), mkJob(23)],
      NOW,
    );
    expect(r.by_hour[0].total).toBe(1);
    expect(r.by_hour[23].total).toBe(1);
    expect(r.total_jobs).toBe(2);
  });

  test('by_status accumulation across multi-status hour', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [
        mkJob(10, { status: 'queued' }),
        mkJob(10, { status: 'running' }),
        mkJob(10, { status: 'completed' }),
        mkJob(10, { status: 'failed' }),
      ],
      NOW,
    );
    expect(r.by_hour[10].total).toBe(4);
    expect(r.by_hour[10].by_status).toEqual({
      queued: 1,
      running: 1,
      completed: 1,
      failed: 1,
    });
  });

  test('by_format accumulation across multi-format hour', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [
        mkJob(8, { format: 'json' }),
        mkJob(8, { format: 'csv' }),
        mkJob(8, { format: 'pdf' }),
        mkJob(8, { format: 'xlsx' }),
        mkJob(8, { format: 'json' }),
      ],
      NOW,
    );
    expect(r.by_hour[8].total).toBe(5);
    expect(r.by_hour[8].by_format).toEqual({
      json: 2,
      csv: 1,
      pdf: 1,
      xlsx: 1,
    });
  });

  test('distinct_requesters Set-deduped per bucket', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [
        mkJob(9, { requested_by: 'alice.admin' }),
        mkJob(9, { requested_by: 'alice.admin' }),
        mkJob(9, { requested_by: 'bob.maker' }),
        mkJob(9, { requested_by: 'alice.admin' }),
      ],
      NOW,
    );
    expect(r.by_hour[9].total).toBe(4);
    expect(r.by_hour[9].distinct_requesters).toBe(2);
  });

  test('per-bucket partition: Σ by_status = bucket.total', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [
        mkJob(7, { status: 'completed' }),
        mkJob(7, { status: 'completed' }),
        mkJob(7, { status: 'failed' }),
      ],
      NOW,
    );
    const sum = Object.values(r.by_hour[7].by_status).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.by_hour[7].total);
  });

  test('per-bucket partition: Σ by_format = bucket.total', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [mkJob(12, { format: 'json' }), mkJob(12, { format: 'csv' })],
      NOW,
    );
    const sum = Object.values(r.by_hour[12].by_format).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.by_hour[12].total);
  });

  test('total partition: Σ by_hour.total = total_jobs', () => {
    const jobs = [mkJob(2), mkJob(5), mkJob(5), mkJob(15)];
    const r = buildReportJobHourlyVolume('BANK_DEMO', jobs, NOW);
    const sum = r.by_hour.reduce((a, b) => a + b.total, 0);
    expect(sum).toBe(r.total_jobs);
    expect(sum).toBe(4);
  });

  test('peak_hour formula + earliest-hour-wins tie-break', () => {
    // hour 3 has 2 jobs, hour 5 has 2 jobs → earliest (3) wins
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [mkJob(3), mkJob(3), mkJob(5), mkJob(5)],
      NOW,
    );
    expect(r.peak_hour).toBe(3);
    expect(r.peak_count).toBe(2);
  });

  test('peak_hour highest-count wins over earlier-tied', () => {
    // hour 1 has 1, hour 8 has 3 → 8 wins
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [mkJob(1), mkJob(8), mkJob(8), mkJob(8)],
      NOW,
    );
    expect(r.peak_hour).toBe(8);
    expect(r.peak_count).toBe(3);
  });

  test('mean_per_hour = Math.round(total_jobs / 24)', () => {
    // 24 jobs across 24 hours → mean 1
    const jobs = Array.from({ length: 24 }, (_, h) => mkJob(h));
    expect(buildReportJobHourlyVolume('BANK_DEMO', jobs, NOW).mean_per_hour).toBe(1);
    // 12 jobs → 0.5 → rounds to 1 (Math.round 0.5 → 1 in JS)
    const half = Array.from({ length: 12 }, (_, h) => mkJob(h));
    expect(buildReportJobHourlyVolume('BANK_DEMO', half, NOW).mean_per_hour).toBe(1);
    // 11 jobs → 0.458 → rounds to 0
    const less = Array.from({ length: 11 }, (_, h) => mkJob(h));
    expect(buildReportJobHourlyVolume('BANK_DEMO', less, NOW).mean_per_hour).toBe(0);
  });

  test('quiet_hours in canonical asc order; empty when every hour active', () => {
    // Only hour 5 active → quiet_hours = [0..4, 6..23] (23 entries)
    const r = buildReportJobHourlyVolume('BANK_DEMO', [mkJob(5)], NOW);
    expect(r.quiet_hours).toHaveLength(23);
    expect(r.quiet_hours.includes(5)).toBe(false);
    // Validate sorted asc
    for (let i = 1; i < r.quiet_hours.length; i++) {
      expect(r.quiet_hours[i]).toBeGreaterThan(r.quiet_hours[i - 1]);
    }
    // All 24 hours active → quiet_hours empty
    const full = Array.from({ length: 24 }, (_, h) => mkJob(h));
    const r2 = buildReportJobHourlyVolume('BANK_DEMO', full, NOW);
    expect(r2.quiet_hours).toEqual([]);
  });

  test('busiest_format canonical tie-break (json wins over csv at tied 1)', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [mkJob(10, { format: 'json' }), mkJob(11, { format: 'csv' })],
      NOW,
    );
    expect(r.busiest_format).toBe('json');
  });

  test('busiest_format highest count wins over canonical position', () => {
    // 1 json + 3 pdf → pdf wins
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [
        mkJob(10, { format: 'json' }),
        mkJob(11, { format: 'pdf' }),
        mkJob(12, { format: 'pdf' }),
        mkJob(13, { format: 'pdf' }),
      ],
      NOW,
    );
    expect(r.busiest_format).toBe('pdf');
  });

  test('cross-tenant jobs filtered out', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [
        mkJob(10, { tenant_id: 'BANK_DEMO' }),
        mkJob(11, { tenant_id: 'BIL' }),
        mkJob(12, { tenant_id: 'BIL' }),
      ],
      NOW,
    );
    expect(r.total_jobs).toBe(1);
    expect(r.by_hour[10].total).toBe(1);
    expect(r.by_hour[11].total).toBe(0);
  });

  test('rejects empty tenant_id', () => {
    expect(() => buildReportJobHourlyVolume('', [], NOW)).toThrow(/tenant_id/);
  });

  test('malformed requested_at silently skipped (not counted)', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [
        mkJob(8),
        mkJob(0, { requested_at: 'not_a_date' }),
        mkJob(0, { requested_at: '' }),
      ],
      NOW,
    );
    expect(r.total_jobs).toBe(1);
    expect(r.by_hour[8].total).toBe(1);
    expect(r.by_hour[0].total).toBe(0);
  });

  test('out-of-enum status silently skipped from by_status (still counted in total)', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [
        mkJob(10),
        mkJob(10, { status: 'bogus' as unknown as JobStatus }),
      ],
      NOW,
    );
    expect(r.total_jobs).toBe(2);
    // by_status only has the valid one
    expect(r.by_hour[10].by_status.completed).toBe(1);
    expect(Object.values(r.by_hour[10].by_status).reduce((a, b) => a + b, 0)).toBe(1);
  });

  test('out-of-enum format silently skipped from by_format', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [
        mkJob(10, { format: 'json' }),
        mkJob(10, { format: 'bogus' as unknown as ReportFormat }),
      ],
      NOW,
    );
    expect(r.total_jobs).toBe(2);
    expect(r.by_hour[10].by_format.json).toBe(1);
    expect(Object.values(r.by_hour[10].by_format).reduce((a, b) => a + b, 0)).toBe(1);
  });

  test('empty requested_by not added to distinct_requesters', () => {
    const r = buildReportJobHourlyVolume(
      'BANK_DEMO',
      [
        mkJob(10, { requested_by: '' }),
        mkJob(10, { requested_by: 'alice.admin' }),
      ],
      NOW,
    );
    expect(r.by_hour[10].total).toBe(2);
    expect(r.by_hour[10].distinct_requesters).toBe(1);
  });

  test('ALL_REPORT_FORMATS_CANONICAL exported in spec order', () => {
    expect(ALL_REPORT_FORMATS_CANONICAL).toEqual(['json', 'csv', 'pdf', 'xlsx']);
  });
});

// ---------------------------------------------------------------------
// buildReportJobHourlyVolumeFromStore drain helper
// ---------------------------------------------------------------------

describe('buildReportJobHourlyVolumeFromStore (store drain)', () => {
  test('empty store produces zero rollup', async () => {
    const store = new InMemoryReportJobStore({ cap: 1000 });
    const r = await buildReportJobHourlyVolumeFromStore(store, 'BANK_DEMO', NOW);
    expect(r.total_jobs).toBe(0);
  });

  test('populated store correctly bucketed', async () => {
    const store = new InMemoryReportJobStore({ cap: 1000 });
    // Submit 3 jobs — they all land at the now() hour (12 per NOW)
    store.submit('BANK_DEMO', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice.admin', NOW);
    store.submit('BANK_DEMO', { report_id: 'alerts_activity_weekly', format: 'csv' }, 'bob.maker', NOW);
    store.submit('BANK_DEMO', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice.admin', NOW);
    const r = await buildReportJobHourlyVolumeFromStore(store, 'BANK_DEMO', NOW);
    expect(r.total_jobs).toBe(3);
    expect(r.by_hour[12].total).toBe(3);
    expect(r.by_hour[12].by_format.json).toBe(2);
    expect(r.by_hour[12].by_format.csv).toBe(1);
    expect(r.by_hour[12].distinct_requesters).toBe(2);
  });

  test('tenant scoping: BIL jobs invisible to BANK_DEMO', async () => {
    const store = new InMemoryReportJobStore({ cap: 1000 });
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'pdf' }, 'bil.admin', NOW);
    const r = await buildReportJobHourlyVolumeFromStore(store, 'BANK_DEMO', NOW);
    expect(r.total_jobs).toBe(0);
  });

  test('rejects empty tenant_id', async () => {
    const store = new InMemoryReportJobStore({ cap: 1000 });
    await expect(
      buildReportJobHourlyVolumeFromStore(store, '', NOW),
    ).rejects.toThrow(/tenant_id/);
  });
});

// ---------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/reports/jobs/hourly-volume', () => {
  test('admin happy path — empty store', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/reports/jobs/hourly-volume')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.by_hour).toHaveLength(24);
    expect(r.body.body.peak_hour).toBeNull();
  });

  test('403 when role lacks audit:read', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/reports/jobs/hourly-volume')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/reports/jobs/hourly-volume')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('cross-tenant: BIL admin sees empty when BANK_DEMO has jobs', async () => {
    // Each makeApp uses the singleton defaultReportJobStore — to test
    // tenant scoping cleanly, inject a per-test store via deps.
    const store = new InMemoryReportJobStore({ cap: 1000 });
    store.submit('BANK_DEMO', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice.admin', NOW);
    const { app } = makeApp({ reportJobStore: store });
    const r = await request(app)
      .get('/v1/reports/jobs/hourly-volume')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.total_jobs).toBe(0);
  });

  test('route mounted BEFORE /:job_id wildcard (literal segment wins)', async () => {
    // If /:job_id were mounted first, GET /v1/reports/jobs/hourly-volume
    // would be captured as a job_id lookup → 404. Since our route is
    // mounted first, it returns 200.
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/reports/jobs/hourly-volume')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    // Confirm by_hour is present (proves M12.18 route handled it,
    // not the :job_id wildcard which would return EWS_404_unknown_job)
    expect(r.body.body.by_hour).toBeDefined();
  });

  test('populated store reflects in response', async () => {
    const store = new InMemoryReportJobStore({ cap: 1000 });
    store.submit('BANK_DEMO', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice.admin', NOW);
    store.submit('BANK_DEMO', { report_id: 'alerts_activity_weekly', format: 'json' }, 'alice.admin', NOW);
    const { app } = makeApp({ reportJobStore: store });
    const r = await request(app)
      .get('/v1/reports/jobs/hourly-volume')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.total_jobs).toBe(2);
    expect(r.body.body.peak_hour).toBe(12); // NOW = 12:00 UTC
    expect(r.body.body.peak_count).toBe(2);
    expect(r.body.body.busiest_format).toBe('json');
  });
});
