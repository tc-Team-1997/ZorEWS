import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  InMemoryJobSchedulerStore,
  JobSchedulerConfigError,
  isJobCategory,
  isJobFrequency,
  isJobRunStatus,
  ALL_JOB_CATEGORIES,
  ALL_JOB_FREQUENCIES,
  ALL_JOB_RUN_STATUSES,
  _resetJobSchedulerStore,
  type ScheduledJob,
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

// ─── Enums ───────────────────────────────────────────────────────────

describe('job_scheduler_config — enums', () => {
  it('closed enums + guards agree', () => {
    expect(ALL_JOB_CATEGORIES).toEqual(['ingestion', 'reporting', 'ml', 'workflow', 'data_quality', 'system']);
    expect(ALL_JOB_RUN_STATUSES).toContain('never_run');
    expect(ALL_JOB_FREQUENCIES).toContain('realtime');
    expect(isJobCategory('ml')).toBe(true);
    expect(isJobCategory('nope')).toBe(false);
    expect(isJobFrequency('daily')).toBe(true);
    expect(isJobFrequency('fortnightly')).toBe(false);
    expect(isJobRunStatus('partial')).toBe(true);
  });
});

// ─── Store ───────────────────────────────────────────────────────────

describe('job_scheduler_config — store', () => {
  function fresh() {
    return new InMemoryJobSchedulerStore();
  }

  it('seeds the platform job inventory across every category', () => {
    const jobs = fresh().list(TENANT, NOW_MS);
    expect(jobs.length).toBeGreaterThanOrEqual(10);
    const cats = new Set(jobs.map((j) => j.category));
    expect(cats.has('ingestion')).toBe(true);
    expect(cats.has('ml')).toBe(true);
    expect(cats.has('workflow')).toBe(true);
    // every enabled job has a next_run_at; the Year-2 backfill DAG is never_run.
    expect(jobs.every((j) => j.next_run_at !== null)).toBe(true);
    expect(jobs.some((j) => j.last_run_status === 'never_run')).toBe(true);
  });

  it('last-run synthesis is deterministic per (tenant, day)', () => {
    const a = fresh().list(TENANT, NOW_MS);
    const b = fresh().list(TENANT, NOW_MS);
    expect(a.map((j) => j.last_run_status)).toEqual(b.map((j) => j.last_run_status));
  });

  it('list filters by category / status / enabled + defensive copies', () => {
    const s = fresh();
    expect(s.list(TENANT, NOW_MS, 'ml').every((j) => j.category === 'ml')).toBe(true);
    const all = s.list(TENANT, NOW_MS);
    all[0].frequency = 'monthly';
    expect(s.list(TENANT, NOW_MS).find((j) => j.job_id === all[0].job_id)!.frequency).not.toBe('monthly');
  });

  it('setEnabled pauses (clears next_run_at) + resumes', () => {
    const s = fresh();
    const id = s.list(TENANT, NOW_MS)[0].job_id;
    const paused = s.setEnabled(TENANT, id, false, NOW_MS);
    expect(paused.enabled).toBe(false);
    expect(paused.next_run_at).toBeNull();
    const resumed = s.setEnabled(TENANT, id, true, NOW_MS);
    expect(resumed.enabled).toBe(true);
    expect(resumed.next_run_at).not.toBeNull();
    expect(() => s.setEnabled(TENANT, 'job-NOPE', true, NOW_MS)).toThrow(/unknown_job|unknown job/);
  });

  it('setFrequency validates + recomputes next_run_at', () => {
    const s = fresh();
    const id = s.list(TENANT, NOW_MS)[0].job_id;
    const up = s.setFrequency(TENANT, id, 'weekly', NOW_MS);
    expect(up.frequency).toBe('weekly');
    // weekly = 10080 min from now
    expect(Date.parse(up.next_run_at!) - NOW_MS).toBe(10080 * 60_000);
    expect(() => s.setFrequency(TENANT, id, 'fortnightly', NOW_MS)).toThrow(/frequency/);
  });

  it('runNow records a fresh run + advances next_run_at; refuses disabled + unknown', () => {
    const s = fresh();
    const id = s.list(TENANT, NOW_MS)[0].job_id;
    const r = s.runNow(TENANT, id, 'alice', NOW_MS);
    expect(r.job_id).toBe(id);
    expect(['success', 'partial', 'failure']).toContain(r.status);
    const after = s.get(TENANT, id, NOW_MS)!;
    expect(after.last_run_at).toBe(r.ran_at);
    expect(after.last_run_status).toBe(r.status);
    s.setEnabled(TENANT, id, false, NOW_MS);
    expect(() => s.runNow(TENANT, id, 'alice', NOW_MS)).toThrow(/disabled/);
    expect(() => s.runNow(TENANT, 'job-NOPE', 'alice', NOW_MS)).toThrow(/unknown/);
  });

  it('summary partitions by category + status and flags attention', () => {
    const s = fresh();
    const sum = s.summary(TENANT, NOW_MS);
    expect(sum.total_jobs).toBe(s.list(TENANT, NOW_MS).length);
    const catSum = Object.values(sum.by_category).reduce((a, b) => a + b, 0);
    expect(catSum).toBe(sum.total_jobs);
    const statSum = Object.values(sum.by_status).reduce((a, b) => a + b, 0);
    expect(statSum).toBe(sum.total_jobs);
    expect(sum.enabled_count + sum.disabled_count).toBe(sum.total_jobs);
    expect(sum.failing_count).toBe(sum.by_status.failure);
    // attention_required entries are all failures or overdue
    expect(sum.attention_required.every((a) => /failed|overdue/.test(a.reason))).toBe(true);
  });

  it('is tenant-scoped', () => {
    const s = fresh();
    const id = s.list(TENANT, NOW_MS)[0].job_id;
    s.setEnabled(TENANT, id, false, NOW_MS);
    // BIL has its own seeded copy — same job_id pattern but enabled.
    const bilId = id.replace('BANK_DEMO', 'BIL');
    expect(s.get('BIL', bilId, NOW_MS)!.enabled).toBe(true);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

describe('job_scheduler_config — routes', () => {
  beforeEach(() => _resetJobSchedulerStore());

  it('GET /jobs returns the inventory; ?category filters', async () => {
    const all = await request(app()).get('/v1/config/jobs').set(H);
    expect(all.status).toBe(200);
    expect(all.body.body.total).toBeGreaterThanOrEqual(10);
    const ml = await request(app()).get('/v1/config/jobs?category=ml').set(H);
    expect(ml.body.body.jobs.every((j: ScheduledJob) => j.category === 'ml')).toBe(true);
  });

  it('GET /jobs/summary (literal not captured by :job_id)', async () => {
    const r = await request(app()).get('/v1/config/jobs/summary').set(H);
    expect(r.status).toBe(200);
    expect(typeof r.body.body.total_jobs).toBe('number');
    expect(r.body.body.by_category).toBeDefined();
    expect(Array.isArray(r.body.body.attention_required)).toBe(true);
  });

  it('GET /jobs/:id 200 then 404', async () => {
    const list = await request(app()).get('/v1/config/jobs').set(H);
    const id = list.body.body.jobs[0].job_id;
    expect((await request(app()).get(`/v1/config/jobs/${id}`).set(H)).status).toBe(200);
    const miss = await request(app()).get('/v1/config/jobs/job-NOPE').set(H);
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('EWS_404_unknown_job');
  });

  it('PATCH /jobs/:id toggles enabled + changes frequency; 400 on bad freq', async () => {
    const list = await request(app()).get('/v1/config/jobs').set(H);
    const id = list.body.body.jobs[0].job_id;
    const up = await request(app()).patch(`/v1/config/jobs/${id}`).set(H).send({ enabled: false, frequency: 'weekly' });
    expect(up.status).toBe(200);
    expect(up.body.body.enabled).toBe(false);
    expect(up.body.body.frequency).toBe('weekly');
    expect(up.body.body.next_run_at).toBeNull(); // disabled
    const bad = await request(app()).patch(`/v1/config/jobs/${id}`).set(H).send({ frequency: 'fortnightly' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('EWS_400_invalid_frequency');
    expect((await request(app()).patch('/v1/config/jobs/job-NOPE').set(H).send({ enabled: true })).status).toBe(404);
  });

  it('POST /jobs/:id/run returns 202 with a run result; 404 on unknown', async () => {
    const list = await request(app()).get('/v1/config/jobs').set(H);
    const id = list.body.body.jobs[0].job_id;
    const r = await request(app()).post(`/v1/config/jobs/${id}/run`).set(H);
    expect(r.status).toBe(202);
    expect(['success', 'partial', 'failure']).toContain(r.body.body.status);
    expect((await request(app()).post('/v1/config/jobs/job-NOPE/run').set(H)).status).toBe(404);
  });

  it('non-admin → 403; missing tenant header → 400', async () => {
    expect((await request(app('field_officer')).get('/v1/config/jobs').set(H)).status).toBe(403);
    expect((await request(app()).get('/v1/config/jobs').set({ 'X-Channel': 'API' })).status).toBe(400);
  });

  it('cross-tenant isolation — BIL pause invisible to BANK_DEMO', async () => {
    const bilH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-user': 'bil.admin' };
    const bilList = await request(app()).get('/v1/config/jobs').set(bilH);
    const bilId = bilList.body.body.jobs[0].job_id;
    await request(app()).patch(`/v1/config/jobs/${bilId}`).set(bilH).send({ enabled: false });
    const bankList = await request(app()).get('/v1/config/jobs').set(H);
    expect(bankList.body.body.jobs.every((j: ScheduledJob) => j.enabled)).toBe(true);
  });
});
