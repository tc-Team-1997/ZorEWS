// services/bff/__tests__/reports_scheduler_module_smoke.test.ts
//
// Module 3.3 — Reports & BI scheduler smoke.
//
// Per cross-cutting #1 + "if already exist please dont do that again":
// all 8 spec routes pre-existed:
//   GET    /v1/reports/catalog                          (M12.1)
//   POST   /v1/reports/builder/{run,preview,export.csv} (T4.6)
//   GET/POST /v1/reports/builder/saved                  (T4.6.3)
//   GET/POST /v1/reports/schedules                      (M12.2)
//   GET    /v1/reports/jobs                             (M12.1)
//   GET    /v1/reports/schedules/upcoming               (M12.7)
//
// M3.3 closes the missing acceptance criterion — "daily report fires
// within ±5 min of configured time; failure triggers retry per policy."
//
// Additions:
//   - RB-2 config keys: reporting.scheduler_tolerance_minutes,
//     scheduler_max_retries, scheduler_retry_backoff_minutes
//   - RB-3 pure findDueSchedulesWithTolerance + computeBackoffMinutes
//     + canRetryNow + recordFailure/clearRetryState store methods
//   - RB-4 POST /v1/reports/schedules/tick worker route
//
// Spec-acceptance test cases below cover the ±5 min tolerance + retry
// behaviour end-to-end via the new tick route.

import request from 'supertest';
import {
  InMemoryReportScheduleStore,
  findDueSchedulesWithTolerance,
  canRetryNow,
  computeBackoffMinutes,
  type ReportScheduleInput,
  type ReportScheduleEntry,
} from '../src/report_schedules';
import { InMemoryReportJobStore } from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { defaultAuditTrailStore } from '../src/audit_trail';
import { defaultConfigStore } from '../src/admin_config';

const NOW = new Date('2026-05-24T06:00:00.000Z');
const TH = {
  'x-tenant-id': 'BIL',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};

const VALID: ReportScheduleInput = {
  report_id: 'portfolio_snapshot_daily',
  format: 'pdf',
  name: 'Portfolio daily PDF',
  cadence: 'daily',
  hour_utc: 6,
  recipients: ['ops@bil.example.com'],
};

function makeSmokeApp(role = 'admin') {
  const reportScheduleStore = new InMemoryReportScheduleStore();
  const reportJobStore = new InMemoryReportJobStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    reportScheduleStore,
    reportJobStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, reportScheduleStore, reportJobStore };
}

/** Seed a schedule with a known next_run_at by creating then patching
 *  the in-memory bucket directly. (computeNextRun otherwise pins it
 *  to the next 06:00 UTC which the tick test wants to vary.) */
function seedWithNextRun(
  store: InMemoryReportScheduleStore,
  tenant_id: string,
  next_run_at: Date,
  overrides: Partial<ReportScheduleInput> = {},
): ReportScheduleEntry {
  const entry = store.create(tenant_id, { ...VALID, ...overrides }, 'admin', NOW);
  // Reach into the bucket to override next_run_at — the tick worker
  // reads via list/listDue so the override sticks for filtering.
  const updated = store.update(
    tenant_id,
    entry.schedule_id,
    { enabled: entry.enabled },
    NOW,
  );
  // Override via update doesn't touch next_run_at unless cadence/timing
  // changes. Cheat by reading the bucket through a re-fetch + manual
  // patch. We use a small trick: the InMemoryReportScheduleStore
  // exposes get() — we replace next_run_at directly on the returned
  // reference, but updates require going through .update() which
  // RESETS next_run_at when timing changes... so use markRun trick:
  // overshoot a tiny step then reset. Cleanest: re-read store state
  // and write directly via the bucket reference.
  // Practical solution: mutate via the public surface by setting a
  // custom hour_utc + cadence='daily' so the recompute yields a known
  // value. Or: use the underlying bucket via private access (cast).
  const bucket = (store as unknown as {
    perTenant: Map<string, Map<string, ReportScheduleEntry>>;
  }).perTenant.get(tenant_id);
  if (bucket) {
    const cur = bucket.get(updated.schedule_id);
    if (cur) {
      bucket.set(updated.schedule_id, { ...cur, next_run_at: next_run_at.toISOString() });
    }
  }
  return store.get(tenant_id, updated.schedule_id)!;
}

beforeEach(() => {
  (defaultAuditTrailStore as unknown as { reset(): void }).reset();
  try {
    defaultConfigStore.reset('BIL', 'reporting.scheduler_tolerance_minutes');
  } catch {
    /* not set */
  }
  try {
    defaultConfigStore.reset('BIL', 'reporting.scheduler_max_retries');
  } catch {
    /* not set */
  }
  try {
    defaultConfigStore.reset('BIL', 'reporting.scheduler_retry_backoff_minutes');
  } catch {
    /* not set */
  }
});

describe('M3.3 Pure helpers', () => {
  it('computeBackoffMinutes: exponential, base capped at 24h', () => {
    expect(computeBackoffMinutes(1, 5)).toBe(5);
    expect(computeBackoffMinutes(2, 5)).toBe(10);
    expect(computeBackoffMinutes(3, 5)).toBe(20);
    expect(computeBackoffMinutes(4, 5)).toBe(40);
    expect(computeBackoffMinutes(20, 60)).toBe(24 * 60); // capped
    // Defensive
    expect(computeBackoffMinutes(0, 5)).toBe(5);
    expect(computeBackoffMinutes(Number.NaN, 5)).toBe(5);
  });

  it('findDueSchedulesWithTolerance: ±5 min window honoured (acceptance)', () => {
    const store = new InMemoryReportScheduleStore();
    const at = (delta_min: number) => new Date(NOW.getTime() + delta_min * 60_000);

    // 3 schedules: one 4min in future (in window), one 6min in future (NOT in window),
    // one 10min in past (overdue — fires).
    const inWindow = seedWithNextRun(store, 'BIL', at(4), { name: 'in-window' });
    const outOfWindow = seedWithNextRun(store, 'BIL', at(6), { name: 'out-of-window' });
    const overdue = seedWithNextRun(store, 'BIL', at(-10), { name: 'overdue' });

    const items = store.list('BIL', 1, 100).items;
    const due = findDueSchedulesWithTolerance(items, NOW, 5);
    const ids = due.map((d) => d.schedule_id);
    expect(ids).toContain(inWindow.schedule_id);
    expect(ids).toContain(overdue.schedule_id);
    expect(ids).not.toContain(outOfWindow.schedule_id);

    // Overdue fires first (oldest-due-first sort)
    expect(due[0].schedule_id).toBe(overdue.schedule_id);
  });

  it('findDueSchedulesWithTolerance: respects retry backoff window', () => {
    const store = new InMemoryReportScheduleStore();
    const at = (delta_min: number) => new Date(NOW.getTime() + delta_min * 60_000);
    const sch = seedWithNextRun(store, 'BIL', at(-5), { name: 'failing' });

    // Record a failure with next_retry_at 10min in the future
    store.recordFailure('BIL', sch.schedule_id, {
      error_message: 'transient',
      max_retries: 3,
      backoff_minutes: 10,
      now: NOW,
    });

    const items = store.list('BIL', 1, 100).items;
    // Schedule is due but in backoff → skipped
    expect(findDueSchedulesWithTolerance(items, NOW, 5)).toHaveLength(0);

    // 11 min later, backoff window has passed → fires
    const later = new Date(NOW.getTime() + 11 * 60_000);
    expect(findDueSchedulesWithTolerance(items, later, 5)).toHaveLength(1);
  });

  it('findDueSchedulesWithTolerance: parked schedules are NEVER eligible', () => {
    const store = new InMemoryReportScheduleStore();
    const sch = seedWithNextRun(store, 'BIL', new Date(NOW.getTime() - 60_000));
    // Force park: max_retries=1 so attempt=1 immediately parks
    store.recordFailure('BIL', sch.schedule_id, {
      error_message: 'permanent',
      max_retries: 1,
      backoff_minutes: 5,
      now: NOW,
    });
    const items = store.list('BIL', 1, 100).items;
    const after = items[0];
    expect(after.retry_state?.parked).toBe(true);

    // Even 1 year later — still skipped because parked
    const farFuture = new Date(NOW.getTime() + 365 * 86_400_000);
    expect(findDueSchedulesWithTolerance(items, farFuture, 5)).toHaveLength(0);
    expect(canRetryNow(after, farFuture)).toBe(false);
  });
});

describe('M3.3 POST /v1/reports/schedules/tick', () => {
  it('RB-A SPEC ACCEPTANCE — daily schedule fires within ±5 min: due schedule submits a job + advances next_run_at', async () => {
    const { app, reportScheduleStore, reportJobStore } = makeSmokeApp('admin');
    const sch = seedWithNextRun(
      reportScheduleStore,
      'BIL',
      new Date(NOW.getTime() + 2 * 60_000), // 2 min in future, well within ±5 min
    );

    const r = await request(app).post('/v1/reports/schedules/tick').set(TH).send({});
    expect(r.status).toBe(200);
    expect(r.body.body.fired).toHaveLength(1);
    expect(r.body.body.fired[0].schedule_id).toBe(sch.schedule_id);
    expect(r.body.body.fired[0].report_id).toBe(VALID.report_id);
    expect(r.body.body.fired[0].job_id).toMatch(/^rj-/);
    expect(r.body.body.tolerance_minutes).toBe(5); // default

    // markRun advanced next_run_at by 24h (daily cadence)
    const after = reportScheduleStore.get('BIL', sch.schedule_id)!;
    expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(new Date(sch.next_run_at).getTime());
    expect(after.last_run_at).toBe(NOW.toISOString());
    expect(after.retry_state).toBeFalsy();

    // Job landed in the job store
    const jobs = reportJobStore.list('BIL', {});
    expect(jobs.items).toHaveLength(1);
    expect(jobs.items[0].report_id).toBe(VALID.report_id);
    expect(jobs.items[0].requested_by).toBe('alice.admin');
  });

  it('RB-B SPEC ACCEPTANCE — failure triggers retry: simulate_failures schedules a retry with exponential backoff', async () => {
    const { app, reportScheduleStore } = makeSmokeApp('admin');
    const sch = seedWithNextRun(
      reportScheduleStore,
      'BIL',
      new Date(NOW.getTime() - 60_000), // 1 min ago — overdue, fires
    );

    const r = await request(app)
      .post('/v1/reports/schedules/tick')
      .set(TH)
      .send({ simulate_failures: [VALID.report_id] });
    expect(r.status).toBe(200);
    expect(r.body.body.fired).toHaveLength(0);
    expect(r.body.body.retried_later).toHaveLength(1);
    expect(r.body.body.retried_later[0].attempt).toBe(1);
    expect(r.body.body.retried_later[0].error).toMatch(/simulated_failure/);

    // Schedule now carries retry_state
    const after = reportScheduleStore.get('BIL', sch.schedule_id)!;
    expect(after.retry_state).toBeTruthy();
    expect(after.retry_state!.attempt).toBe(1);
    expect(after.retry_state!.parked).toBe(false);
    // Backoff at attempt 1 with base=5 → next_retry_at = now + 5min
    const nextRetry = new Date(after.retry_state!.next_retry_at).getTime();
    expect(nextRetry - NOW.getTime()).toBe(5 * 60_000);
  });

  it('RB-C max_retries cap parks the schedule + writes critical audit event', async () => {
    const { app, reportScheduleStore } = makeSmokeApp('admin');
    seedWithNextRun(reportScheduleStore, 'BIL', new Date(NOW.getTime() - 60_000));

    // max_retries=1 → first failure immediately parks
    const r = await request(app)
      .post('/v1/reports/schedules/tick')
      .set(TH)
      .send({ simulate_failures: [VALID.report_id], max_retries: 1 });
    expect(r.body.body.parked).toHaveLength(1);
    expect(r.body.body.retried_later).toHaveLength(0);

    // M15.1 audit chain — critical event
    const audit = defaultAuditTrailStore.list('BIL', { action: 'report.scheduler.fire' });
    const parkedEvt = audit.items.find((e) => e.outcome === 'failure' && e.severity === 'critical');
    expect(parkedEvt).toBeDefined();
    expect(parkedEvt!.metadata).toMatchObject({ parked: true, attempt: 1 });
  });

  it('RB-D backoff respected: in-backoff schedule is skipped on next tick, fires once window passes', async () => {
    const { app, reportScheduleStore } = makeSmokeApp('admin');
    const sch = seedWithNextRun(reportScheduleStore, 'BIL', new Date(NOW.getTime() - 60_000));

    // First tick fails — sets backoff
    await request(app)
      .post('/v1/reports/schedules/tick')
      .set(TH)
      .send({ simulate_failures: [VALID.report_id], backoff_minutes: 10 });

    // Tick at NOW+5min — still in backoff window
    const r2 = await request(app)
      .post('/v1/reports/schedules/tick')
      .set(TH)
      .send({ as_of: new Date(NOW.getTime() + 5 * 60_000).toISOString() });
    expect(r2.body.body.fired).toHaveLength(0);
    expect(r2.body.body.retried_later).toHaveLength(0);
    expect(r2.body.body.total_considered).toBe(1);

    // Tick at NOW+15min — backoff expired, schedule fires successfully
    const r3 = await request(app)
      .post('/v1/reports/schedules/tick')
      .set(TH)
      .send({ as_of: new Date(NOW.getTime() + 15 * 60_000).toISOString() });
    expect(r3.body.body.fired).toHaveLength(1);
    expect(r3.body.body.fired[0].schedule_id).toBe(sch.schedule_id);

    // Successful run clears retry_state
    const after = reportScheduleStore.get('BIL', sch.schedule_id)!;
    expect(after.retry_state).toBeFalsy();
  });

  it('RB-E dry-run returns candidates without mutating', async () => {
    const { app, reportScheduleStore, reportJobStore } = makeSmokeApp('admin');
    const sch = seedWithNextRun(reportScheduleStore, 'BIL', new Date(NOW.getTime()));

    const r = await request(app).post('/v1/reports/schedules/tick').set(TH).send({ dry_run: true });
    expect(r.status).toBe(200);
    expect(r.body.body.dry_run).toBe(true);
    expect(r.body.body.would_fire).toBe(1);
    expect(r.body.body.candidates[0].schedule_id).toBe(sch.schedule_id);
    expect(r.body.body.fired).toEqual([]);

    // Nothing mutated
    expect(reportJobStore.list('BIL', {}).items).toEqual([]);
    const after = reportScheduleStore.get('BIL', sch.schedule_id)!;
    expect(after.last_run_at).toBe(sch.last_run_at); // still null
  });

  it('RB-F RBAC + bad input — viewer 403, invalid params 400, missing tenant 400', async () => {
    const { app } = makeSmokeApp('viewer');
    const r1 = await request(app).post('/v1/reports/schedules/tick').set(TH).send({});
    expect(r1.status).toBe(403);

    const { app: adminApp } = makeSmokeApp('admin');
    // Bad tolerance
    const r2 = await request(adminApp)
      .post('/v1/reports/schedules/tick')
      .set(TH)
      .send({ tolerance_minutes: -5 });
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('EWS_400_invalid_input');

    // Bad as_of
    const r3 = await request(adminApp)
      .post('/v1/reports/schedules/tick')
      .set(TH)
      .send({ as_of: 'not-a-date' });
    expect(r3.status).toBe(400);

    // Missing tenant header
    const r4 = await request(adminApp)
      .post('/v1/reports/schedules/tick')
      .set({ 'x-channel': 'API', 'x-apex-role': 'admin' })
      .send({});
    expect(r4.status).toBe(400);
  });

  it('RB-G tenant isolation: BIL schedules invisible to BANK_DEMO tick', async () => {
    const { app, reportScheduleStore } = makeSmokeApp('admin');
    seedWithNextRun(reportScheduleStore, 'BIL', new Date(NOW.getTime()));

    const r = await request(app)
      .post('/v1/reports/schedules/tick')
      .set({ ...TH, 'x-tenant-id': 'BANK_DEMO' })
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.body.total_considered).toBe(0);
    expect(r.body.body.fired).toEqual([]);
  });
});
