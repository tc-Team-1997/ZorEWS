// services/bff/__tests__/analytics_stage_migration.test.ts
//
// T4.1 4d — Stage Migration sub-dashboard. Three layers:
//   1. severityToStage mapping.
//   2. Pure resolver — 3×3 matrix, totals, upgrades/downgrades/
//      stationary counts, new + exited customers, segment filter.
//   3. Route — RBAC, envelope, validation.

import request from 'supertest';
import {
  computeStageMigration,
  InMemoryStageMigrationSource,
  severityToStage,
  STAGE_CODES,
  type StageSnapshotRow,
} from '../src/analytics/stage_migration';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-08T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

describe('severityToStage', () => {
  test('maps severities to 3 stages, collapsing high+critical', () => {
    expect(severityToStage('low')).toBe('stage_1');
    expect(severityToStage('medium')).toBe('stage_2');
    expect(severityToStage('high')).toBe('stage_3');
    expect(severityToStage('critical')).toBe('stage_3');
  });
});

describe('computeStageMigration', () => {
  test('empty snapshots → 9 zero cells, all totals zero', () => {
    const out = computeStageMigration({
      tenant_id: 'BANK_DEMO', current: [], prior: [], asOf: NOW,
    });
    expect(out.matrix).toHaveLength(9);
    expect(out.matrix.every((c) => c.count === 0)).toBe(true);
    expect(out.totals.every((t) => t.current === 0 && t.prior === 0 && t.delta === 0)).toBe(true);
    expect(out.upgrades_count).toBe(0);
    expect(out.downgrades_count).toBe(0);
    expect(out.stationary_count).toBe(0);
    expect(out.new_customers_count).toBe(0);
    expect(out.exited_customers_count).toBe(0);
  });

  test('stationary, upgrade, downgrade, new, exited paths all increment correctly', () => {
    const prior: StageSnapshotRow[] = [
      { customer_id: 'a', stage: 'stage_1' },  // stays at 1
      { customer_id: 'b', stage: 'stage_2' },  // moves UP to 3 (upgrade)
      { customer_id: 'c', stage: 'stage_3' },  // moves DOWN to 1 (downgrade)
      { customer_id: 'd', stage: 'stage_2' },  // exits (gone in current)
    ];
    const current: StageSnapshotRow[] = [
      { customer_id: 'a', stage: 'stage_1' },
      { customer_id: 'b', stage: 'stage_3' },
      { customer_id: 'c', stage: 'stage_1' },
      { customer_id: 'e', stage: 'stage_2' }, // new (no prior)
    ];
    const out = computeStageMigration({
      tenant_id: 'BANK_DEMO', current, prior, asOf: NOW,
    });

    expect(out.stationary_count).toBe(1);
    expect(out.upgrades_count).toBe(1);
    expect(out.downgrades_count).toBe(1);
    expect(out.new_customers_count).toBe(1);
    expect(out.exited_customers_count).toBe(1);

    const cell = (from: string, to: string) =>
      out.matrix.find((c) => c.from === from && c.to === to)!;
    expect(cell('stage_1', 'stage_1').count).toBe(1); // a
    expect(cell('stage_2', 'stage_3').count).toBe(1); // b upgrade
    expect(cell('stage_3', 'stage_1').count).toBe(1); // c downgrade
  });

  test('totals reflect snapshot counts + delta', () => {
    const prior: StageSnapshotRow[] = [
      { customer_id: 'a', stage: 'stage_1' },
      { customer_id: 'b', stage: 'stage_1' },
      { customer_id: 'c', stage: 'stage_2' },
    ];
    const current: StageSnapshotRow[] = [
      { customer_id: 'a', stage: 'stage_2' },
      { customer_id: 'b', stage: 'stage_2' },
      { customer_id: 'c', stage: 'stage_3' },
    ];
    const out = computeStageMigration({
      tenant_id: 'BANK_DEMO', current, prior, asOf: NOW,
    });
    const t = Object.fromEntries(out.totals.map((s) => [s.stage, s]));
    expect(t.stage_1.current).toBe(0);
    expect(t.stage_1.prior).toBe(2);
    expect(t.stage_1.delta).toBe(-2);
    expect(t.stage_2.current).toBe(2);
    expect(t.stage_2.delta).toBe(1);
    expect(t.stage_3.current).toBe(1);
    expect(t.stage_3.delta).toBe(1);
  });

  test('matrix is always 3×3 in stable order', () => {
    const out = computeStageMigration({
      tenant_id: 'BANK_DEMO', current: [], prior: [], asOf: NOW,
    });
    // Order is row-major: (1→1), (1→2), (1→3), (2→1), (2→2), (2→3), (3→1), (3→2), (3→3)
    const expected = STAGE_CODES.flatMap((from) =>
      STAGE_CODES.map((to) => ({ from, to })),
    );
    expect(out.matrix.map((c) => ({ from: c.from, to: c.to }))).toEqual(expected);
  });

  test('segment filter narrows the snapshot', () => {
    const segOf = (id: string) => (id === 'b' ? 'sme' : 'retail');
    const prior: StageSnapshotRow[] = [
      { customer_id: 'a', stage: 'stage_1' },
      { customer_id: 'b', stage: 'stage_1' },
    ];
    const current: StageSnapshotRow[] = [
      { customer_id: 'a', stage: 'stage_2' },
      { customer_id: 'b', stage: 'stage_3' },
    ];
    const out = computeStageMigration({
      tenant_id: 'BANK_DEMO', current, prior,
      filter: { segment: 'sme' },
      segmentOf: segOf,
      asOf: NOW,
    });
    expect(out.upgrades_count).toBe(1); // only b counts
    expect(out.totals.find((t) => t.stage === 'stage_3')!.current).toBe(1);
  });
});

// ── Route ──────────────────────────────────────────────────────────────

function makeAppFor(role = 'admin', snapshots: Map<number, StageSnapshotRow[]>) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    stageMigrationSource: new InMemoryStageMigrationSource((asOf) => {
      // Map by epoch-day so the mock returns different snapshots for current vs prior
      const day = Math.floor(asOf.getTime() / 86_400_000);
      return snapshots.get(day) ?? [];
    }),
  }).app;
}

describe('GET /v1/analytics/stage-migration', () => {
  test('happy path returns 3×3 matrix in EWS envelope', async () => {
    const today = Math.floor(NOW.getTime() / 86_400_000);
    const priorDay = today - 30;
    const map = new Map<number, StageSnapshotRow[]>();
    map.set(today, [
      { customer_id: 'a', stage: 'stage_1' },
      { customer_id: 'b', stage: 'stage_3' },
    ]);
    map.set(priorDay, [
      { customer_id: 'a', stage: 'stage_1' },
      { customer_id: 'b', stage: 'stage_1' },
    ]);

    const r = await request(makeAppFor('admin', map))
      .get('/v1/analytics/stage-migration')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(200);
    expect(r.body.body.matrix).toHaveLength(9);
    expect(r.body.body.upgrades_count).toBe(1);
    expect(r.body.body.stationary_count).toBe(1);
  });

  test('400 on invalid as_of', async () => {
    const r = await request(makeAppFor('admin', new Map()))
      .get('/v1/analytics/stage-migration?as_of=xxx')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(400);
  });

  test('403 for collection_officer', async () => {
    const r = await request(makeAppFor('collection_officer', new Map()))
      .get('/v1/analytics/stage-migration')
      .set(TH)
      .set('x-apex-role', 'collection_officer');
    expect(r.status).toBe(403);
  });
});
