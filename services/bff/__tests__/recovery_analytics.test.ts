// services/bff/__tests__/recovery_analytics.test.ts
//
// Recovery Center Phase 3 — operator analytics endpoint
// GET /v1/recovery/analytics?days=N.
//
// Two layers tested:
//   1. summarizeRecoveryActivity pure-function: time-bucketing,
//      per-actor / entity_type / module rollups, restore/purge cohort
//      rates, time-to-restore mean + p50 + p95.
//   2. /v1/recovery/analytics route: drains the recovery store across
//      all 3 statuses, feeds the resolver, returns the envelope.
//
// MSW is not in play — these are direct supertest hits against a
// makeApp + InMemoryRecoveryStore wired together per-test.

import request from 'supertest';
import {
  summarizeRecoveryActivity,
  validateAnalyticsInput,
  RecoveryAnalyticsError,
  type RecoveryAnalyticsResult,
} from '../src/recovery/analytics';
import type { DeletedRecord } from '../src/recovery/types';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';
import { _resetRecoveryAdapters } from '../src/recovery/adapters';

const NOW = new Date('2026-05-21T12:00:00.000Z');

function rec(overrides: Partial<DeletedRecord>): DeletedRecord {
  return {
    recovery_id: `rec-${Math.random().toString(36).slice(2, 10)}`,
    tenant_id: 'BANK_DEMO',
    module: 'bff',
    entity_type: 'webhook_subscription',
    original_id: 'wh-x',
    original_table: 'app_bff.webhook_subscriptions',
    payload: { id: 'wh-x' },
    deleted_by: 'alice.admin',
    deleted_at: NOW.toISOString(),
    deletion_reason: null,
    source_action: 'user_initiated',
    prior_status: 'active',
    restored_at: null,
    restored_by: null,
    purged_at: null,
    purged_by: null,
    status: 'archived',
    ...overrides,
  };
}

const TENANT = 'BANK_DEMO';
const ANALYSIS_OPTS = { tenant_id: TENANT, days: 30, now: NOW };

// ─── validateAnalyticsInput ─────────────────────────────────────────

describe('validateAnalyticsInput', () => {
  test('happy: days=30 + valid tenant + now', () => {
    expect(() => validateAnalyticsInput(ANALYSIS_OPTS)).not.toThrow();
  });

  test('rejects missing tenant_id', () => {
    expect(() => validateAnalyticsInput({ ...ANALYSIS_OPTS, tenant_id: '' })).toThrow(
      RecoveryAnalyticsError,
    );
  });

  test('rejects days < 1', () => {
    expect(() => validateAnalyticsInput({ ...ANALYSIS_OPTS, days: 0 })).toThrow(/days/);
  });

  test('rejects days > 365', () => {
    expect(() => validateAnalyticsInput({ ...ANALYSIS_OPTS, days: 366 })).toThrow(/days/);
  });

  test('rejects non-integer days', () => {
    expect(() => validateAnalyticsInput({ ...ANALYSIS_OPTS, days: 7.5 })).toThrow(/days/);
  });

  test('rejects invalid Date for now', () => {
    expect(() =>
      validateAnalyticsInput({ ...ANALYSIS_OPTS, now: new Date('not-a-date') }),
    ).toThrow(/now/);
  });
});

// ─── Empty / zero state ─────────────────────────────────────────────

describe('summarizeRecoveryActivity — empty', () => {
  test('zero records → zero-filled day buckets + null rates', () => {
    const r = summarizeRecoveryActivity([], ANALYSIS_OPTS);
    expect(r.total_archives_in_window).toBe(0);
    expect(r.total_restores_in_window).toBe(0);
    expect(r.total_purges_in_window).toBe(0);
    expect(r.by_day.length).toBe(30);
    for (const b of r.by_day) {
      expect(b.total).toBe(0);
      expect(b.by_status.archived).toBe(0);
      expect(b.by_status.restored).toBe(0);
      expect(b.by_status.purged).toBe(0);
    }
    expect(r.top_actors).toEqual([]);
    expect(r.by_entity_type).toEqual([]);
    expect(r.by_module).toEqual([]);
    expect(r.restore_rate).toBeNull();
    expect(r.purge_rate).toBeNull();
    expect(r.mean_time_to_restore_hours).toBeNull();
    expect(r.p50_time_to_restore_hours).toBeNull();
    expect(r.p95_time_to_restore_hours).toBeNull();
  });

  test('echoes tenant_id + generated_at + days + window bounds', () => {
    const r = summarizeRecoveryActivity([], ANALYSIS_OPTS);
    expect(r.tenant_id).toBe(TENANT);
    expect(r.days).toBe(30);
    expect(r.window_end).toBe(NOW.toISOString());
    expect(r.window_start).toBe(
      new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(r.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Day-bucketing ──────────────────────────────────────────────────

describe('summarizeRecoveryActivity — day-bucketing', () => {
  test('archive op today lands in the last bucket (window_end day)', () => {
    const r = summarizeRecoveryActivity(
      [rec({ deleted_at: NOW.toISOString() })],
      ANALYSIS_OPTS,
    );
    const lastBucket = r.by_day[r.by_day.length - 1]!;
    expect(lastBucket.date).toBe('2026-05-21');
    expect(lastBucket.by_status.archived).toBe(1);
    expect(lastBucket.total).toBe(1);
  });

  test('archive 5 days ago lands in the right bucket', () => {
    const fiveDaysAgo = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
    const r = summarizeRecoveryActivity(
      [rec({ deleted_at: fiveDaysAgo.toISOString() })],
      ANALYSIS_OPTS,
    );
    const target = r.by_day.find((b) => b.date === fiveDaysAgo.toISOString().slice(0, 10));
    expect(target).toBeDefined();
    expect(target!.by_status.archived).toBe(1);
  });

  test('archive 60 days ago is OUTSIDE the 30-day window — not counted', () => {
    const old = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000);
    const r = summarizeRecoveryActivity(
      [rec({ deleted_at: old.toISOString() })],
      ANALYSIS_OPTS,
    );
    expect(r.total_archives_in_window).toBe(0);
    expect(r.by_day.every((b) => b.total === 0)).toBe(true);
  });

  test('single restore op shows up in both the restore total + that day bucket', () => {
    const archivedAt = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
    const restoredAt = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const r = summarizeRecoveryActivity(
      [
        rec({
          deleted_at: archivedAt.toISOString(),
          restored_at: restoredAt.toISOString(),
          restored_by: 'admin',
          status: 'restored',
        }),
      ],
      ANALYSIS_OPTS,
    );
    expect(r.total_archives_in_window).toBe(1);
    expect(r.total_restores_in_window).toBe(1);
    const restoreDay = r.by_day.find((b) => b.date === restoredAt.toISOString().slice(0, 10))!;
    expect(restoreDay.by_status.restored).toBe(1);
  });

  test('purge op accumulates separately from archive', () => {
    const archivedAt = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const purgedAt = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);
    const r = summarizeRecoveryActivity(
      [
        rec({
          deleted_at: archivedAt.toISOString(),
          purged_at: purgedAt.toISOString(),
          purged_by: 'admin',
          status: 'purged',
        }),
      ],
      ANALYSIS_OPTS,
    );
    expect(r.total_archives_in_window).toBe(1);
    expect(r.total_purges_in_window).toBe(1);
    const purgeDay = r.by_day.find((b) => b.date === purgedAt.toISOString().slice(0, 10))!;
    expect(purgeDay.by_status.purged).toBe(1);
  });

  test('cross-tenant records are filtered out', () => {
    const r = summarizeRecoveryActivity(
      [
        rec({ tenant_id: 'OTHER_TENANT', deleted_at: NOW.toISOString() }),
        rec({ deleted_at: NOW.toISOString() }),
      ],
      ANALYSIS_OPTS,
    );
    expect(r.total_archives_in_window).toBe(1);
  });
});

// ─── Per-actor rollup ───────────────────────────────────────────────

describe('summarizeRecoveryActivity — top_actors', () => {
  test('counts archive + restore + purge separately, total sort desc + username asc tie-break', () => {
    const ts = NOW.toISOString();
    const records = [
      rec({ deleted_by: 'alice.admin', deleted_at: ts }),
      rec({ deleted_by: 'alice.admin', deleted_at: ts }),
      rec({ deleted_by: 'bob.risk', deleted_at: ts }),
      rec({
        deleted_by: 'carla.ops',
        deleted_at: ts,
        restored_at: ts,
        restored_by: 'carla.ops',
        status: 'restored',
      }),
    ];
    const r = summarizeRecoveryActivity(records, ANALYSIS_OPTS);
    expect(r.top_actors.length).toBe(3);
    // alice has 2 archives = 2 total
    // bob has 1 archive = 1 total
    // carla has 1 archive + 1 restore = 2 total
    // alice ties carla at 2; alice asc-wins tie-break.
    expect(r.top_actors[0]!.actor_username).toBe('alice.admin');
    expect(r.top_actors[0]!.total_archives).toBe(2);
    expect(r.top_actors[1]!.actor_username).toBe('carla.ops');
    expect(r.top_actors[1]!.total_archives).toBe(1);
    expect(r.top_actors[1]!.total_restores).toBe(1);
    expect(r.top_actors[2]!.actor_username).toBe('bob.risk');
  });

  test('capped at 10 actors', () => {
    const records = [];
    for (let i = 0; i < 15; i++) {
      records.push(
        rec({
          deleted_by: `user-${String(i).padStart(2, '0')}`,
          deleted_at: NOW.toISOString(),
        }),
      );
    }
    const r = summarizeRecoveryActivity(records, ANALYSIS_OPTS);
    expect(r.top_actors.length).toBe(10);
  });

  test('most_recent_at tracks the newest op timestamp across all 3 op types', () => {
    const oldTs = new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const midTs = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const records = [
      rec({ deleted_by: 'alice.admin', deleted_at: oldTs }),
      rec({
        deleted_by: 'someone-else',
        deleted_at: oldTs,
        restored_at: midTs,
        restored_by: 'alice.admin',
        status: 'restored',
      }),
    ];
    const r = summarizeRecoveryActivity(records, ANALYSIS_OPTS);
    const alice = r.top_actors.find((a) => a.actor_username === 'alice.admin')!;
    expect(alice.total_archives).toBe(1);
    expect(alice.total_restores).toBe(1);
    expect(alice.most_recent_at).toBe(midTs);
  });
});

// ─── Per-entity_type rollup ─────────────────────────────────────────

describe('summarizeRecoveryActivity — by_entity_type', () => {
  test('sorts by total_archives desc + entity_type asc tie-break', () => {
    const ts = NOW.toISOString();
    const records = [
      rec({ entity_type: 'webhook_subscription', deleted_at: ts }),
      rec({ entity_type: 'webhook_subscription', deleted_at: ts }),
      rec({ entity_type: 'webhook_subscription', deleted_at: ts }),
      rec({ entity_type: 'user_team', deleted_at: ts }),
      rec({ entity_type: 'service_client', deleted_at: ts }),
    ];
    const r = summarizeRecoveryActivity(records, ANALYSIS_OPTS);
    expect(r.by_entity_type[0]!.entity_type).toBe('webhook_subscription');
    expect(r.by_entity_type[0]!.total_archives).toBe(3);
    // user_team + service_client both at 1 archive → asc tie-break.
    expect(r.by_entity_type[1]!.entity_type).toBe('service_client');
    expect(r.by_entity_type[2]!.entity_type).toBe('user_team');
  });

  test('outstanding_delta = archives - restores', () => {
    const ts = NOW.toISOString();
    const records = [
      rec({ entity_type: 'webhook_subscription', deleted_at: ts }),
      rec({ entity_type: 'webhook_subscription', deleted_at: ts }),
      rec({
        entity_type: 'webhook_subscription',
        deleted_at: ts,
        restored_at: ts,
        restored_by: 'admin',
        status: 'restored',
      }),
    ];
    const r = summarizeRecoveryActivity(records, ANALYSIS_OPTS);
    const wh = r.by_entity_type.find((e) => e.entity_type === 'webhook_subscription')!;
    // 3 archives (the restored row was also archived), 1 restore.
    // outstanding_delta = 3 - 1 = 2.
    expect(wh.total_archives).toBe(3);
    expect(wh.total_restores).toBe(1);
    expect(wh.outstanding_delta).toBe(2);
  });

  test('capped at 20 entity_types', () => {
    const records = [];
    for (let i = 0; i < 25; i++) {
      records.push(rec({ entity_type: `entity_${i}`, deleted_at: NOW.toISOString() }));
    }
    const r = summarizeRecoveryActivity(records, ANALYSIS_OPTS);
    expect(r.by_entity_type.length).toBe(20);
  });
});

// ─── Restore / purge rates (cohort metric) ──────────────────────────

describe('summarizeRecoveryActivity — restore_rate + purge_rate', () => {
  test('100% restore rate when every archived row was restored', () => {
    const ts = NOW.toISOString();
    const records = [
      rec({ deleted_at: ts, restored_at: ts, restored_by: 'admin', status: 'restored' }),
      rec({ deleted_at: ts, restored_at: ts, restored_by: 'admin', status: 'restored' }),
    ];
    const r = summarizeRecoveryActivity(records, ANALYSIS_OPTS);
    expect(r.restore_rate).toBe(1);
    expect(r.purge_rate).toBe(0);
  });

  test('50% rate with 2 archives + 1 restore', () => {
    const ts = NOW.toISOString();
    const records = [
      rec({ deleted_at: ts }),
      rec({ deleted_at: ts, restored_at: ts, restored_by: 'admin', status: 'restored' }),
    ];
    const r = summarizeRecoveryActivity(records, ANALYSIS_OPTS);
    expect(r.restore_rate).toBe(0.5);
    expect(r.purge_rate).toBe(0);
  });

  test('null rates when no archives in window', () => {
    const r = summarizeRecoveryActivity([], ANALYSIS_OPTS);
    expect(r.restore_rate).toBeNull();
    expect(r.purge_rate).toBeNull();
  });

  test('archive-but-restored-outside-window still counts in cohort rate', () => {
    // Archived 5 days ago (in window), restored 40 days ago (out of
    // window). The restore op doesn't count in total_restores_in_window
    // but the row's cohort membership DOES count it for restore_rate.
    // Wait — this is impossible (you can't restore something archived
    // later). So this test is actually about the OPPOSITE: archived in
    // window, restored AFTER window. But "after window" means future,
    // which isn't a thing.
    // Better test: archive in window + status='restored' (any
    // restored_at) → counts toward cohort restore_rate regardless of
    // when the restore actually fired (as long as restored_at is
    // populated).
    const inWindow = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const r = summarizeRecoveryActivity(
      [
        rec({
          deleted_at: inWindow,
          restored_at: inWindow,
          restored_by: 'admin',
          status: 'restored',
        }),
      ],
      ANALYSIS_OPTS,
    );
    expect(r.restore_rate).toBe(1);
  });
});

// ─── Time-to-restore percentiles ────────────────────────────────────

describe('summarizeRecoveryActivity — time-to-restore', () => {
  test('null mean when zero restores in window', () => {
    const r = summarizeRecoveryActivity([rec({ deleted_at: NOW.toISOString() })], ANALYSIS_OPTS);
    expect(r.mean_time_to_restore_hours).toBeNull();
    expect(r.p50_time_to_restore_hours).toBeNull();
    expect(r.p95_time_to_restore_hours).toBeNull();
  });

  test('single 1-hour gap: mean=1.0, percentiles null (n<2)', () => {
    const archivedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const restoredAt = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const r = summarizeRecoveryActivity(
      [
        rec({
          deleted_at: archivedAt,
          restored_at: restoredAt,
          restored_by: 'admin',
          status: 'restored',
        }),
      ],
      ANALYSIS_OPTS,
    );
    expect(r.mean_time_to_restore_hours).toBe(1);
    expect(r.p50_time_to_restore_hours).toBeNull();
    expect(r.p95_time_to_restore_hours).toBeNull();
  });

  test('multi-record distribution computes mean + p50 + p95', () => {
    const records: DeletedRecord[] = [];
    // 1h, 2h, 3h, 4h, 5h gaps
    for (let h = 1; h <= 5; h++) {
      const archived = new Date(NOW.getTime() - (h + 1) * 60 * 60 * 1000).toISOString();
      const restored = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
      records.push(
        rec({
          deleted_at: archived,
          restored_at: restored,
          restored_by: 'admin',
          status: 'restored',
        }),
      );
    }
    const r = summarizeRecoveryActivity(records, ANALYSIS_OPTS);
    // gaps are 1, 2, 3, 4, 5 → mean=3.0, p50=3.0, p95=4.8
    expect(r.mean_time_to_restore_hours).toBe(3);
    expect(r.p50_time_to_restore_hours).toBe(3);
    expect(r.p95_time_to_restore_hours).toBe(4.8);
  });
});

// ─── Per-module rollup ──────────────────────────────────────────────

describe('summarizeRecoveryActivity — by_module', () => {
  test('bff vs auth-svc split correctly', () => {
    const ts = NOW.toISOString();
    const records = [
      rec({ module: 'bff', entity_type: 'webhook_subscription', deleted_at: ts }),
      rec({ module: 'bff', entity_type: 'saved_scenario', deleted_at: ts }),
      rec({ module: 'auth-svc', entity_type: 'user_team', deleted_at: ts }),
    ];
    const r = summarizeRecoveryActivity(records, ANALYSIS_OPTS);
    expect(r.by_module.length).toBe(2);
    expect(r.by_module[0]!.module).toBe('bff');
    expect(r.by_module[0]!.total_archives).toBe(2);
    expect(r.by_module[1]!.module).toBe('auth-svc');
  });
});

// ─── Route: GET /v1/recovery/analytics ─────────────────────────────

describe('GET /v1/recovery/analytics route', () => {
  function setup() {
    _resetRecoveryAdapters();
    const recoveryStore = new InMemoryRecoveryStore();
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      recoveryStore,
      now: () => NOW,
      getRole: () => 'admin',
    });
    return { app, recoveryStore };
  }

  const HEADERS = {
    'x-tenant-id': TENANT,
    'x-channel': 'API',
    'x-source-system': 'test',
    'x-apex-user': 'alice.admin',
  };

  test('200 with zero state when no records exist', async () => {
    const { app } = setup();
    const r = await request(app).get('/v1/recovery/analytics').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe(TENANT);
    expect(r.body.body.days).toBe(30);
    expect(r.body.body.total_archives_in_window).toBe(0);
    expect(r.body.body.by_day.length).toBe(30);
  });

  test('200 with populated state after archiving via the store', async () => {
    const { app, recoveryStore } = setup();
    // Seed the store with 3 archives using NOW as the timestamp so the
    // records fall within the analytics window. The app is bootstrapped
    // with now: () => NOW (2026-05-21); the window is [NOW-30d, NOW].
    // Without passing NOW to archive(), the store uses new Date() (real
    // current time) which is AFTER NOW, placing records outside the window
    // and producing total_archives_in_window = 0.
    for (let i = 0; i < 3; i++) {
      await recoveryStore.archive({
        tenant_id: TENANT,
        module: 'bff',
        entity_type: 'webhook_subscription',
        original_id: `wh-${i}`,
        original_table: 'app_bff.webhook_subscriptions',
        payload: { id: `wh-${i}` },
        deleted_by: 'alice.admin',
      }, NOW);
    }
    const r = await request(app).get('/v1/recovery/analytics').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.total_archives_in_window).toBe(3);
    expect(r.body.body.top_actors.length).toBe(1);
    expect(r.body.body.top_actors[0].actor_username).toBe('alice.admin');
    expect(r.body.body.top_actors[0].total_archives).toBe(3);
    expect(r.body.body.by_entity_type[0].entity_type).toBe('webhook_subscription');
    expect(r.body.body.by_entity_type[0].total_archives).toBe(3);
    expect(r.body.body.by_module[0].module).toBe('bff');
  });

  test('?days=7 narrows the window to 7 days', async () => {
    const { app } = setup();
    const r = await request(app).get('/v1/recovery/analytics?days=7').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.by_day.length).toBe(7);
  });

  test('?days=0 → 400 EWS_400_invalid_days', async () => {
    const { app } = setup();
    const r = await request(app).get('/v1/recovery/analytics?days=0').set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_days');
  });

  test('?days=400 → 400 EWS_400_invalid_days', async () => {
    const { app } = setup();
    const r = await request(app).get('/v1/recovery/analytics?days=400').set(HEADERS);
    expect(r.status).toBe(400);
  });

  test('?days=abc → 400 EWS_400_invalid_days', async () => {
    const { app } = setup();
    const r = await request(app).get('/v1/recovery/analytics?days=abc').set(HEADERS);
    expect(r.status).toBe(400);
  });

  test('non-admin role → 403 (recovery:list is admin-only)', async () => {
    _resetRecoveryAdapters();
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      recoveryStore: new InMemoryRecoveryStore(),
      now: () => NOW,
      getRole: () => 'risk_analyst',
    });
    const r = await request(app).get('/v1/recovery/analytics').set(HEADERS);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: a BIL admin sees only BIL data', async () => {
    const { app, recoveryStore } = setup();
    // Archive 2 BANK_DEMO records + 3 BIL records using NOW as the
    // timestamp to keep them inside the analytics window (see comment
    // in the populated-state test above).
    for (let i = 0; i < 2; i++) {
      await recoveryStore.archive({
        tenant_id: 'BANK_DEMO',
        module: 'bff',
        entity_type: 'webhook_subscription',
        original_id: `bank-${i}`,
        original_table: 'app_bff.webhook_subscriptions',
        payload: {},
        deleted_by: 'alice.admin',
      }, NOW);
    }
    for (let i = 0; i < 3; i++) {
      await recoveryStore.archive({
        tenant_id: 'BIL',
        module: 'bff',
        entity_type: 'webhook_subscription',
        original_id: `bil-${i}`,
        original_table: 'app_bff.webhook_subscriptions',
        payload: {},
        deleted_by: 'bil.admin',
      }, NOW);
    }
    const r = await request(app)
      .get('/v1/recovery/analytics')
      .set(HEADERS)
      .set('x-tenant-id', 'BIL');
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_archives_in_window).toBe(3);
  });

  test('literal /analytics segment is not captured by /:recovery_id wildcard', async () => {
    const { app } = setup();
    const r = await request(app).get('/v1/recovery/analytics').set(HEADERS);
    expect(r.status).toBe(200);
    // The body has the analytics shape (not a 404 from the :id route).
    const body = r.body.body as RecoveryAnalyticsResult;
    expect(body.by_day).toBeDefined();
    expect(body.tenant_id).toBe(TENANT);
  });
});
