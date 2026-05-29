import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  InMemoryJobSchedulerStore,
  JobSchedulerConfigError,
  JOB_RUN_LOG_CAP,
  ALL_JOB_RUN_STATUSES,
  _resetJobSchedulerStore,
} from '../src/job_scheduler_config';

const NOW = new Date('2026-05-29T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const TENANT = 'BANK_DEMO';
const H = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API', 'x-apex-user': 'alice.admin' };

function app(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

const CBS = `job-${TENANT}-CBS_INGESTION`;
const BACKFILL = `job-${TENANT}-FEATURE_STORE_BACKFILL`; // never_run seed

// ─── Store: listRuns / runStats ──────────────────────────────────────

describe('job_scheduler run telemetry — store', () => {
  function fresh() {
    return new InMemoryJobSchedulerStore();
  }

  it('seeds a consistent 8-entry history whose newest mirrors last_run_*', () => {
    const s = fresh();
    const job = s.get(TENANT, CBS, NOW_MS)!;
    const runs = s.listRuns(TENANT, CBS, NOW_MS, 50);
    expect(runs.length).toBe(8);
    // newest entry === the job's current last_run_*
    expect(runs[0].status).toBe(job.last_run_status);
    expect(runs[0].ran_at).toBe(job.last_run_at);
    expect(runs[0].duration_ms).toBe(job.last_run_duration_ms);
    // newest-first ordering
    for (let i = 1; i < runs.length; i++) {
      expect(Date.parse(runs[i - 1].ran_at)).toBeGreaterThanOrEqual(Date.parse(runs[i].ran_at));
    }
  });

  it('historical entries are terminal (never running) + carry scheduler as trigger', () => {
    const s = fresh();
    const runs = s.listRuns(TENANT, CBS, NOW_MS, 50);
    for (let i = 1; i < runs.length; i++) {
      expect(['success', 'partial', 'failure']).toContain(runs[i].status);
      expect(runs[i].triggered_by).toBe('scheduler');
    }
  });

  it('listRuns honours the limit (1..cap)', () => {
    const s = fresh();
    expect(s.listRuns(TENANT, CBS, NOW_MS, 3).length).toBe(3);
    expect(s.listRuns(TENANT, CBS, NOW_MS, 0).length).toBe(1); // clamped to ≥ 1
    expect(s.listRuns(TENANT, CBS, NOW_MS, 999).length).toBeLessThanOrEqual(JOB_RUN_LOG_CAP);
  });

  it('never_run job has an empty history + null stats', () => {
    const s = fresh();
    expect(s.listRuns(TENANT, BACKFILL, NOW_MS, 20)).toEqual([]);
    const stats = s.runStats(TENANT, BACKFILL, NOW_MS);
    expect(stats.total_runs).toBe(0);
    expect(stats.success_rate).toBeNull();
    expect(stats.mean_duration_ms).toBeNull();
    expect(stats.last_run_at).toBeNull();
    expect(stats.last_status).toBeNull();
  });

  it('runStats aggregates by_status + success_rate over terminal runs', () => {
    const s = fresh();
    const stats = s.runStats(TENANT, CBS, NOW_MS);
    expect(stats.total_runs).toBe(8);
    const sum = ALL_JOB_RUN_STATUSES.reduce((acc, k) => acc + stats.by_status[k], 0);
    expect(sum).toBe(8);
    const terminal = stats.by_status.success + stats.by_status.partial + stats.by_status.failure;
    if (terminal > 0) {
      expect(stats.success_rate).toBeCloseTo(stats.by_status.success / terminal, 5);
      expect(stats.mean_duration_ms).not.toBeNull();
    }
    expect(stats.last_status).toBe(s.get(TENANT, CBS, NOW_MS)!.last_run_status);
  });

  it('runNow prepends a real entry atop the history', () => {
    const s = fresh();
    const before = s.listRuns(TENANT, CBS, NOW_MS, 50).length;
    const result = s.runNow(TENANT, CBS, 'alice.admin', NOW_MS);
    const after = s.listRuns(TENANT, CBS, NOW_MS, 50);
    expect(after.length).toBe(before + 1);
    expect(after[0].status).toBe(result.status);
    expect(after[0].triggered_by).toBe('alice.admin');
    expect(after[0].ran_at).toBe(result.ran_at);
  });

  it('listRuns / runStats throw unknown_job for a bogus id', () => {
    const s = fresh();
    expect(() => s.listRuns(TENANT, 'job-X-NOPE', NOW_MS, 20)).toThrow(/unknown job/);
    expect(() => s.runStats(TENANT, 'job-X-NOPE', NOW_MS)).toThrow(JobSchedulerConfigError);
  });

  it('history is tenant-scoped', () => {
    const s = fresh();
    const bank = s.listRuns('BANK_DEMO', 'job-BANK_DEMO-CBS_INGESTION', NOW_MS, 50);
    const bil = s.listRuns('BIL', 'job-BIL-CBS_INGESTION', NOW_MS, 50);
    expect(bank.length).toBe(8);
    expect(bil.length).toBe(8);
    // distinct job_ids → distinct run_ids
    expect(bank[0].job_id).not.toBe(bil[0].job_id);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

describe('job_scheduler run telemetry — routes', () => {
  beforeEach(() => _resetJobSchedulerStore());

  it('GET /:job_id/runs returns recent history (admin)', async () => {
    const res = await request(app('admin')).get(`/v1/config/jobs/${CBS}/runs`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.job_id).toBe(CBS);
    expect(res.body.body.runs.length).toBe(8);
    expect(res.body.body.runs[0]).toHaveProperty('run_id');
  });

  it('GET /:job_id/runs?limit=3 narrows', async () => {
    const res = await request(app('admin')).get(`/v1/config/jobs/${CBS}/runs?limit=3`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.runs.length).toBe(3);
  });

  it('GET /:job_id/run-stats returns aggregate stats', async () => {
    const res = await request(app('admin')).get(`/v1/config/jobs/${CBS}/run-stats`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.total_runs).toBe(8);
    expect(res.body.body.by_status).toBeDefined();
  });

  it('a run-now then runs shows the new entry on top', async () => {
    await request(app('admin')).post(`/v1/config/jobs/${CBS}/run`).set(H).send({});
    const res = await request(app('admin')).get(`/v1/config/jobs/${CBS}/runs`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.runs.length).toBe(9);
    expect(res.body.body.runs[0].triggered_by).toBe('alice.admin');
  });

  it('404s an unknown job on both telemetry routes', async () => {
    const r1 = await request(app('admin')).get('/v1/config/jobs/job-X-NOPE/runs').set(H);
    expect(r1.status).toBe(404);
    expect(r1.body.error.code).toBe('EWS_404_unknown_job');
    const r2 = await request(app('admin')).get('/v1/config/jobs/job-X-NOPE/run-stats').set(H);
    expect(r2.status).toBe(404);
  });

  it('403s a non-admin', async () => {
    const res = await request(app('risk_analyst')).get(`/v1/config/jobs/${CBS}/runs`).set(H);
    expect(res.status).toBe(403);
  });

  it('does not shadow the existing GET /:job_id detail route', async () => {
    const res = await request(app('admin')).get(`/v1/config/jobs/${CBS}`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.job_id).toBe(CBS);
    expect(res.body.body.runs).toBeUndefined(); // detail, not the runs list
  });
});
