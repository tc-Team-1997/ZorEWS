// services/bff/__tests__/ai_retraining.test.ts
//
// T5.1.1 — Retraining schedule + outcome ledger.

import request from 'supertest';
import {
  ALL_RETRAINING_CADENCES,
  ALL_RETRAINING_OUTCOME_STATUSES,
  InMemoryRetrainingOutcomeStore,
  InMemoryRetrainingScheduleStore,
  RetrainingError,
  buildFleetRetrainingStatus,
  computeNextRetrainAt,
  isRetrainingCadence,
  isRetrainingOutcomeStatus,
  _resetDefaultRetrainingStores,
} from '../src/ai_retraining';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const TENANT = 'BIL';
const HEADERS = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };

function isoDelta(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function makeRetrainApp(role: string = 'admin') {
  _resetDefaultRetrainingStores();
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure helpers ────────────────────────────────────────────────────

describe('cadence helpers', () => {
  test('5 cadence values + type guard', () => {
    expect(ALL_RETRAINING_CADENCES).toEqual([
      'monthly',
      'quarterly',
      'biannual',
      'annual',
      'drift_triggered',
    ]);
    expect(isRetrainingCadence('monthly')).toBe(true);
    expect(isRetrainingCadence('weekly')).toBe(false);
    expect(isRetrainingCadence(42)).toBe(false);
  });

  test('outcome status enum + type guard', () => {
    expect(ALL_RETRAINING_OUTCOME_STATUSES).toEqual([
      'success',
      'failure',
      'rolled_back',
      'in_progress',
    ]);
    expect(isRetrainingOutcomeStatus('success')).toBe(true);
    expect(isRetrainingOutcomeStatus('bogus')).toBe(false);
  });

  test('computeNextRetrainAt monthly adds 1 month', () => {
    const r = computeNextRetrainAt('monthly', new Date('2026-01-15T00:00:00Z'));
    expect(r).toBe('2026-02-15T00:00:00.000Z');
  });

  test('computeNextRetrainAt quarterly adds 3 months', () => {
    const r = computeNextRetrainAt('quarterly', new Date('2026-01-15T00:00:00Z'));
    expect(r).toBe('2026-04-15T00:00:00.000Z');
  });

  test('computeNextRetrainAt biannual + annual', () => {
    expect(computeNextRetrainAt('biannual', new Date('2026-01-15T00:00:00Z'))).toBe(
      '2026-07-15T00:00:00.000Z',
    );
    expect(computeNextRetrainAt('annual', new Date('2026-01-15T00:00:00Z'))).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });

  test('drift_triggered returns null (no scheduled time)', () => {
    expect(computeNextRetrainAt('drift_triggered', new Date())).toBeNull();
  });
});

// ─── ScheduleStore ───────────────────────────────────────────────────

describe('InMemoryRetrainingScheduleStore', () => {
  test('create + list happy path; defaults next_retrain_at from cadence', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const row = s.create(
      { model_id: 'pd-v3', cadence: 'quarterly' },
      { tenant_id: TENANT, now: NOW, actor: 'alice' },
    );
    expect(row.schedule_id).toMatch(/^rts-BIL-/);
    expect(row.next_retrain_at).toBe(computeNextRetrainAt('quarterly', NOW));
    expect(row.enabled).toBe(true);
    expect(row.last_retrained_at).toBeNull();
    expect(row.created_by).toBe('alice');
    const list = s.list(TENANT);
    expect(list).toHaveLength(1);
    expect(list[0].schedule_id).toBe(row.schedule_id);
  });

  test('caller-supplied next_retrain_at preserved', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const at = '2026-07-01T00:00:00.000Z';
    const row = s.create(
      { model_id: 'pd-v3', cadence: 'quarterly', next_retrain_at: at },
      { tenant_id: TENANT, now: NOW, actor: 'a' },
    );
    expect(row.next_retrain_at).toBe(at);
  });

  test('drift_triggered with no next_retrain_at → far-future sentinel', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const row = s.create(
      { model_id: 'pd-v3', cadence: 'drift_triggered', drift_trigger_threshold: 0.25 },
      { tenant_id: TENANT, now: NOW, actor: 'a' },
    );
    expect(new Date(row.next_retrain_at).getTime()).toBeGreaterThan(
      NOW.getTime() + 365 * 24 * 60 * 60 * 1000,
    );
    expect(row.drift_trigger_threshold).toBe(0.25);
  });

  test('duplicate model_id throws duplicate_schedule', () => {
    const s = new InMemoryRetrainingScheduleStore();
    s.create({ model_id: 'pd-v3', cadence: 'monthly' }, { tenant_id: TENANT, now: NOW, actor: 'a' });
    expect(() =>
      s.create({ model_id: 'pd-v3', cadence: 'quarterly' }, { tenant_id: TENANT, now: NOW, actor: 'a' }),
    ).toThrow(RetrainingError);
  });

  test('invalid cadence → invalid_cadence', () => {
    const s = new InMemoryRetrainingScheduleStore();
    expect(() =>
      s.create({ model_id: 'pd-v3', cadence: 'weekly' as never }, { tenant_id: TENANT, now: NOW, actor: 'a' }),
    ).toThrow(/cadence/);
  });

  test('drift_trigger_threshold out of [0,1] → invalid_threshold', () => {
    const s = new InMemoryRetrainingScheduleStore();
    expect(() =>
      s.create(
        { model_id: 'pd-v3', cadence: 'drift_triggered', drift_trigger_threshold: 1.5 },
        { tenant_id: TENANT, now: NOW, actor: 'a' },
      ),
    ).toThrow(/threshold/);
  });

  test('update + getByModel + tenant scoping', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const r1 = s.create({ model_id: 'pd-v3', cadence: 'quarterly' }, { tenant_id: TENANT, now: NOW, actor: 'a' });
    const r2 = s.update(TENANT, r1.schedule_id, { cadence: 'monthly', enabled: false }, { now: NOW, actor: 'a' });
    expect(r2.cadence).toBe('monthly');
    expect(r2.enabled).toBe(false);
    // cadence change recomputes next_retrain_at.
    expect(r2.next_retrain_at).not.toBe(r1.next_retrain_at);

    // Cross-tenant invisibility.
    expect(s.getByModel('BANK_DEMO', 'pd-v3')).toBeNull();
    expect(s.getByModel(TENANT, 'pd-v3')!.schedule_id).toBe(r1.schedule_id);
  });

  test('delete returns false on miss; true + removes on hit', () => {
    const s = new InMemoryRetrainingScheduleStore();
    expect(s.delete(TENANT, 'rts-missing')).toBe(false);
    const r = s.create({ model_id: 'm', cadence: 'monthly' }, { tenant_id: TENANT, now: NOW, actor: 'a' });
    expect(s.delete(TENANT, r.schedule_id)).toBe(true);
    expect(s.list(TENANT)).toHaveLength(0);
  });

  test('recordSuccess auto-advances next_retrain_at + sets last_retrained_at', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const r1 = s.create({ model_id: 'pd-v3', cadence: 'quarterly' }, { tenant_id: TENANT, now: NOW, actor: 'a' });
    const completedAt = '2026-04-01T00:00:00.000Z';
    s.recordSuccess(TENANT, 'pd-v3', completedAt, NOW);
    const r2 = s.getByModel(TENANT, 'pd-v3')!;
    expect(r2.last_retrained_at).toBe(completedAt);
    expect(r2.next_retrain_at).toBe(computeNextRetrainAt('quarterly', new Date(completedAt)));
  });
});

// ─── OutcomeStore ────────────────────────────────────────────────────

describe('InMemoryRetrainingOutcomeStore', () => {
  test('record happy path + duration_ms computed', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const o = new InMemoryRetrainingOutcomeStore(s);
    const row = o.record(
      {
        model_id: 'pd-v3',
        status: 'success',
        started_at: isoDelta(60_000),
        completed_at: isoDelta(0),
        new_version: 'v0.2.0',
        metrics: { auc: 0.88, brier: 0.05 },
      },
      { tenant_id: TENANT, now: NOW },
    );
    expect(row.duration_ms).toBe(60_000);
    expect(row.new_version).toBe('v0.2.0');
    expect(row.metrics).toEqual({ auc: 0.88, brier: 0.05 });
    expect(row.outcome_id).toMatch(/^rto-BIL-/);
  });

  test('successful outcome auto-advances linked schedule', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const o = new InMemoryRetrainingOutcomeStore(s);
    s.create({ model_id: 'pd-v3', cadence: 'quarterly' }, { tenant_id: TENANT, now: NOW, actor: 'a' });
    const completedAt = isoDelta(0);
    o.record(
      { model_id: 'pd-v3', status: 'success', started_at: isoDelta(120_000), completed_at: completedAt },
      { tenant_id: TENANT, now: NOW },
    );
    const sched = s.getByModel(TENANT, 'pd-v3')!;
    expect(sched.last_retrained_at).toBe(completedAt);
  });

  test('failure outcome does NOT advance schedule', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const o = new InMemoryRetrainingOutcomeStore(s);
    s.create({ model_id: 'pd-v3', cadence: 'quarterly' }, { tenant_id: TENANT, now: NOW, actor: 'a' });
    o.record(
      { model_id: 'pd-v3', status: 'failure', started_at: isoDelta(60_000), completed_at: isoDelta(0) },
      { tenant_id: TENANT, now: NOW },
    );
    expect(s.getByModel(TENANT, 'pd-v3')!.last_retrained_at).toBeNull();
  });

  test('list newest-first with filters', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const o = new InMemoryRetrainingOutcomeStore(s);
    o.record(
      { model_id: 'a', status: 'success', started_at: isoDelta(120_000), completed_at: isoDelta(60_000) },
      { tenant_id: TENANT, now: new Date(NOW_MS - 30_000) },
    );
    o.record(
      { model_id: 'b', status: 'failure', started_at: isoDelta(60_000), completed_at: isoDelta(0) },
      { tenant_id: TENANT, now: NOW },
    );
    const all = o.list(TENANT);
    expect(all[0].model_id).toBe('b'); // newest first
    expect(o.list(TENANT, { model_id: 'a' })).toHaveLength(1);
    expect(o.list(TENANT, { status: 'failure' })).toHaveLength(1);
  });

  test('non-numeric metrics rejected', () => {
    const o = new InMemoryRetrainingOutcomeStore();
    expect(() =>
      o.record(
        {
          model_id: 'm',
          status: 'success',
          started_at: isoDelta(0),
          completed_at: isoDelta(0),
          metrics: { auc: 'high' } as never,
        },
        { tenant_id: TENANT, now: NOW },
      ),
    ).toThrow(/metrics/);
  });

  test('invalid promoted_to rejected', () => {
    const o = new InMemoryRetrainingOutcomeStore();
    expect(() =>
      o.record(
        {
          model_id: 'm',
          status: 'success',
          started_at: isoDelta(0),
          completed_at: isoDelta(0),
          promoted_to: 'queue' as never,
        },
        { tenant_id: TENANT, now: NOW },
      ),
    ).toThrow(/promoted_to/);
  });
});

// ─── Fleet status ────────────────────────────────────────────────────

describe('buildFleetRetrainingStatus', () => {
  test('empty input → zero envelope, all_schedules_current=true', () => {
    const r = buildFleetRetrainingStatus(TENANT, [], [], NOW);
    expect(r.total_schedules).toBe(0);
    expect(r.total_overdue).toBe(0);
    expect(r.success_rate_30d).toBeNull();
    expect(r.all_schedules_current).toBe(true);
    expect(r.most_recent_outcome).toBeNull();
  });

  test('overdue schedule flagged is_overdue + all_schedules_current=false', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const row = s.create({ model_id: 'pd-v3', cadence: 'monthly' }, { tenant_id: TENANT, now: NOW, actor: 'a' });
    // Force the schedule into the past.
    s.update(
      TENANT,
      row.schedule_id,
      { next_retrain_at: isoDelta(24 * 60 * 60 * 1000) }, // 1d ago
      { now: NOW, actor: 'a' },
    );
    const summary = buildFleetRetrainingStatus(TENANT, s.list(TENANT), [], NOW);
    expect(summary.total_overdue).toBe(1);
    expect(summary.all_schedules_current).toBe(false);
    expect(summary.models[0].is_overdue).toBe(true);
    expect(summary.models[0].ms_until_next).toBeLessThan(0);
  });

  test('disabled schedule never overdue', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const row = s.create({ model_id: 'pd-v3', cadence: 'monthly' }, { tenant_id: TENANT, now: NOW, actor: 'a' });
    s.update(
      TENANT,
      row.schedule_id,
      { next_retrain_at: isoDelta(24 * 60 * 60 * 1000), enabled: false },
      { now: NOW, actor: 'a' },
    );
    const summary = buildFleetRetrainingStatus(TENANT, s.list(TENANT), [], NOW);
    expect(summary.total_overdue).toBe(0);
    expect(summary.models[0].is_overdue).toBe(false);
  });

  test('success_rate_30d = successes / total in window', () => {
    const o = new InMemoryRetrainingOutcomeStore();
    o.record(
      { model_id: 'a', status: 'success', started_at: isoDelta(120_000), completed_at: isoDelta(60_000) },
      { tenant_id: TENANT, now: NOW },
    );
    o.record(
      { model_id: 'b', status: 'failure', started_at: isoDelta(60_000), completed_at: isoDelta(0) },
      { tenant_id: TENANT, now: NOW },
    );
    o.record(
      { model_id: 'c', status: 'rolled_back', started_at: isoDelta(60_000), completed_at: isoDelta(0) },
      { tenant_id: TENANT, now: NOW },
    );
    const summary = buildFleetRetrainingStatus(TENANT, [], o.list(TENANT), NOW);
    expect(summary.total_outcomes_30d).toBe(3);
    expect(summary.total_success_30d).toBe(1);
    expect(summary.total_failure_30d).toBe(1);
    expect(summary.success_rate_30d).toBeCloseTo(1 / 3, 4);
  });

  test('models[] union of schedule + outcome model_ids, sorted asc', () => {
    const s = new InMemoryRetrainingScheduleStore();
    const o = new InMemoryRetrainingOutcomeStore(s);
    s.create({ model_id: 'pd-v3', cadence: 'quarterly' }, { tenant_id: TENANT, now: NOW, actor: 'a' });
    o.record(
      { model_id: 'fraud-v1', status: 'success', started_at: isoDelta(60_000), completed_at: isoDelta(0) },
      { tenant_id: TENANT, now: NOW },
    );
    const summary = buildFleetRetrainingStatus(TENANT, s.list(TENANT), o.list(TENANT), NOW);
    expect(summary.models.map((m) => m.model_id)).toEqual(['fraud-v1', 'pd-v3']);
    expect(summary.models[0].schedule).toBeNull(); // ad-hoc fraud-v1
    expect(summary.models[1].last_outcome).toBeNull(); // pd-v3 schedule with no outcome
  });

  test('days_since_last_success ignores failures', () => {
    const o = new InMemoryRetrainingOutcomeStore();
    const ms3d = 3 * 24 * 60 * 60 * 1000;
    o.record(
      {
        model_id: 'pd',
        status: 'success',
        started_at: isoDelta(ms3d + 60_000),
        completed_at: isoDelta(ms3d),
      },
      { tenant_id: TENANT, now: new Date(NOW_MS - ms3d) },
    );
    o.record(
      { model_id: 'pd', status: 'failure', started_at: isoDelta(60_000), completed_at: isoDelta(0) },
      { tenant_id: TENANT, now: NOW },
    );
    const summary = buildFleetRetrainingStatus(TENANT, [], o.list(TENANT), NOW);
    expect(summary.models[0].days_since_last_success).toBe(3);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

describe('Routes — /v1/ai/retraining/*', () => {
  test('POST schedule happy path', async () => {
    const { app } = makeRetrainApp('admin');
    const r = await request(app)
      .post('/v1/ai/retraining/schedules')
      .set(HEADERS)
      .send({ model_id: 'pd-v3', cadence: 'quarterly' });
    expect(r.status).toBe(201);
    expect(r.body.body.model_id).toBe('pd-v3');
    expect(r.body.body.cadence).toBe('quarterly');
    expect(r.body.body.created_by).toBe('alice.admin');
  });

  test('POST schedule rejects duplicate model_id → 409', async () => {
    const { app } = makeRetrainApp('admin');
    await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'monthly' });
    const r2 = await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'quarterly' });
    expect(r2.status).toBe(409);
    expect(r2.body.error?.code).toBe('EWS_409_duplicate_schedule');
  });

  test('POST schedule rejects invalid cadence → 400', async () => {
    const { app } = makeRetrainApp('admin');
    const r = await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'weekly' });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_invalid_cadence');
  });

  test('GET schedules list', async () => {
    const { app } = makeRetrainApp('admin');
    await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'quarterly' });
    await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'fraud-v1', cadence: 'monthly' });
    const r = await request(app).get('/v1/ai/retraining/schedules').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
  });

  test('GET single + 404 + cross-tenant 404', async () => {
    const { app } = makeRetrainApp('admin');
    const c = await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'quarterly' });
    const id = c.body.body.schedule_id;
    const r1 = await request(app).get(`/v1/ai/retraining/schedules/${id}`).set(HEADERS);
    expect(r1.status).toBe(200);
    const r2 = await request(app).get('/v1/ai/retraining/schedules/rts-missing').set(HEADERS);
    expect(r2.status).toBe(404);
    const r3 = await request(app).get(`/v1/ai/retraining/schedules/${id}`).set({ ...HEADERS, 'X-Tenant-ID': 'BANK_DEMO' });
    expect(r3.status).toBe(404);
  });

  test('PATCH schedule cadence change → recompute next_retrain_at', async () => {
    const { app } = makeRetrainApp('admin');
    const c = await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'monthly' });
    const before = c.body.body.next_retrain_at;
    const r = await request(app).patch(`/v1/ai/retraining/schedules/${c.body.body.schedule_id}`).set(HEADERS).send({ cadence: 'annual' });
    expect(r.status).toBe(200);
    expect(r.body.body.cadence).toBe('annual');
    expect(r.body.body.next_retrain_at).not.toBe(before);
  });

  test('DELETE schedule → 204 then 404', async () => {
    const { app } = makeRetrainApp('admin');
    const c = await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'quarterly' });
    const r1 = await request(app).delete(`/v1/ai/retraining/schedules/${c.body.body.schedule_id}`).set(HEADERS);
    expect(r1.status).toBe(204);
    const r2 = await request(app).get(`/v1/ai/retraining/schedules/${c.body.body.schedule_id}`).set(HEADERS);
    expect(r2.status).toBe(404);
  });

  test('POST outcome happy path + advances linked schedule', async () => {
    const { app } = makeRetrainApp('admin');
    await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'quarterly' });
    const r = await request(app)
      .post('/v1/ai/retraining/outcomes')
      .set(HEADERS)
      .send({
        model_id: 'pd-v3',
        status: 'success',
        started_at: isoDelta(60_000),
        completed_at: isoDelta(0),
        new_version: 'v0.2.0',
        metrics: { auc: 0.91 },
        promoted_to: 'staging',
        gate_decision: 'approved',
      });
    expect(r.status).toBe(201);
    expect(r.body.body.duration_ms).toBe(60_000);
    expect(r.body.body.gate_decision).toBe('approved');

    const status = await request(app).get('/v1/ai/retraining/status').set(HEADERS);
    expect(status.body.body.total_success_30d).toBe(1);
    expect(status.body.body.models[0].schedule.last_retrained_at).not.toBeNull();
  });

  test('GET outcomes filters by model_id + status', async () => {
    const { app } = makeRetrainApp('admin');
    await request(app)
      .post('/v1/ai/retraining/outcomes')
      .set(HEADERS)
      .send({ model_id: 'a', status: 'success', started_at: isoDelta(60_000), completed_at: isoDelta(0) });
    await request(app)
      .post('/v1/ai/retraining/outcomes')
      .set(HEADERS)
      .send({ model_id: 'b', status: 'failure', started_at: isoDelta(60_000), completed_at: isoDelta(0) });
    const r = await request(app).get('/v1/ai/retraining/outcomes?status=success').set(HEADERS);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.outcomes[0].model_id).toBe('a');
  });

  test('GET outcomes rejects bad status → 400', async () => {
    const { app } = makeRetrainApp('admin');
    const r = await request(app).get('/v1/ai/retraining/outcomes?status=bogus').set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_invalid_status');
  });

  test('GET status fleet rollup', async () => {
    const { app } = makeRetrainApp('admin');
    await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'quarterly' });
    await request(app)
      .post('/v1/ai/retraining/outcomes')
      .set(HEADERS)
      .send({ model_id: 'pd-v3', status: 'success', started_at: isoDelta(60_000), completed_at: isoDelta(0) });
    const r = await request(app).get('/v1/ai/retraining/status').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.total_schedules).toBe(1);
    expect(r.body.body.total_success_30d).toBe(1);
    expect(r.body.body.all_schedules_current).toBe(true);
    expect(r.body.body.models[0].model_id).toBe('pd-v3');
  });

  test('non-admin role 403 on schedule POST', async () => {
    const { app } = makeRetrainApp('risk_analyst'); // no audit:read
    const r = await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'quarterly' });
    expect(r.status).toBe(403);
  });

  test('tenant scoping — BIL schedule invisible to BANK_DEMO', async () => {
    const { app } = makeRetrainApp('admin');
    await request(app).post('/v1/ai/retraining/schedules').set(HEADERS).send({ model_id: 'pd-v3', cadence: 'quarterly' });
    const r = await request(app).get('/v1/ai/retraining/schedules').set({ ...HEADERS, 'X-Tenant-ID': 'BANK_DEMO' });
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });
});
