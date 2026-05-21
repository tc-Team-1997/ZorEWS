// services/bff/__tests__/dr_admin.test.ts
//
// Phase E.1 — DR admin runbook + game-day surface tests.

import request from 'supertest';
import {
  ALL_DR_CADENCES,
  ALL_DR_SCORE_DIMENSIONS,
  ALL_DR_SCORES,
  ALL_DR_VERDICTS,
  isDrCadence,
  computeVerdict,
  InMemoryDrGameDayLedger,
  DrAdminError,
  DR_RTO_RPO_TARGETS,
  DR_RUNBOOK_STEPS,
  DR_GAME_DAY_SCOPE,
  DR_GAME_DAY_CAP_PER_TENANT,
  YEAR_MIN,
  YEAR_MAX,
  type DrGameDayCreateInput,
} from '../src/dr/dr_admin';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T13:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeDrApp(
  role: string = 'admin',
  overrides: { drGameDayLedger?: InMemoryDrGameDayLedger } = {},
) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    drGameDayLedger: overrides.drGameDayLedger ?? new InMemoryDrGameDayLedger(),
  });
  return app;
}

const validInput = (over: Partial<DrGameDayCreateInput> = {}): DrGameDayCreateInput => ({
  record_id: 'r_q1_2026',
  cadence: 'Q1',
  year: 2026,
  executed_at: '2026-03-15T09:00:00.000Z',
  incident_commander: 'risk-it.lead',
  scope_summary: 'Aurora promotion + failback drill',
  scores: ALL_DR_SCORE_DIMENSIONS.map((d) => ({
    dimension: d,
    score: 'pass' as const,
    notes: null,
  })),
  observed_rto_minutes: 12,
  observed_rpo_minutes: 3,
  remediation_jira_keys: ['DR-101', 'DR-102'],
  notes: 'No findings.',
  ...over,
});

// ── 1. Enum + type guards ─────────────────────────────────────────────

describe('dr_admin constants', () => {
  test('ALL_DR_CADENCES is Q1..Q4', () => {
    expect(ALL_DR_CADENCES).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
  });

  test('ALL_DR_SCORE_DIMENSIONS has 6 dimensions', () => {
    expect(ALL_DR_SCORE_DIMENSIONS.length).toBe(6);
  });

  test('isDrCadence accepts every cadence', () => {
    for (const c of ALL_DR_CADENCES) expect(isDrCadence(c)).toBe(true);
    expect(isDrCadence('Q5')).toBe(false);
  });

  test('catalog mirrors docs/dr-runbook.md: 6 RTO/RPO targets + 7 failover steps + 4 scope rows', () => {
    expect(DR_RTO_RPO_TARGETS.length).toBeGreaterThanOrEqual(5);
    expect(DR_RUNBOOK_STEPS.length).toBe(7);
    expect(DR_GAME_DAY_SCOPE.length).toBe(4);
  });

  test('RTO/RPO targets cover Aurora, MSK, EKS, S3', () => {
    const resources = DR_RTO_RPO_TARGETS.map((t) => t.resource);
    expect(resources).toContain('Aurora primary');
    expect(resources.some((r) => r.includes('MSK'))).toBe(true);
    expect(resources.some((r) => r.includes('EKS'))).toBe(true);
  });
});

// ── 2. computeVerdict ─────────────────────────────────────────────────

describe('computeVerdict', () => {
  test('all pass → green', () => {
    const scores = ALL_DR_SCORE_DIMENSIONS.map((d) => ({
      dimension: d,
      score: 'pass' as const,
      notes: null,
    }));
    expect(computeVerdict(scores)).toBe('green');
  });

  test('any fail → red', () => {
    const scores = ALL_DR_SCORE_DIMENSIONS.map((d, i) => ({
      dimension: d,
      score: (i === 0 ? 'fail' : 'pass') as 'fail' | 'pass',
      notes: null,
    }));
    expect(computeVerdict(scores)).toBe('red');
  });

  test('mix of pass + marginal (no fail) → amber', () => {
    const scores = ALL_DR_SCORE_DIMENSIONS.map((d, i) => ({
      dimension: d,
      score: (i === 0 ? 'marginal' : 'pass') as 'marginal' | 'pass',
      notes: null,
    }));
    expect(computeVerdict(scores)).toBe('amber');
  });

  test('empty scores → amber (neutral)', () => {
    expect(computeVerdict([])).toBe('amber');
  });
});

// ── 3. Store CRUD ─────────────────────────────────────────────────────

describe('InMemoryDrGameDayLedger', () => {
  test('create happy path', () => {
    const led = new InMemoryDrGameDayLedger();
    const r = led.create('BIL', validInput(), 'admin', NOW);
    expect(r.record_id).toBe('r_q1_2026');
    expect(r.verdict).toBe('green');
    expect(r.scores.length).toBe(6);
    expect(r.remediation_jira_keys).toEqual(['DR-101', 'DR-102']);
  });

  test('create with mixed scores computes amber verdict', () => {
    const led = new InMemoryDrGameDayLedger();
    const r = led.create(
      'BIL',
      validInput({
        scores: [
          { dimension: 'rto_met', score: 'marginal', notes: 'Aurora took 17 min' },
          { dimension: 'rpo_met', score: 'pass', notes: null },
          { dimension: 'runbook_accuracy', score: 'pass', notes: null },
          { dimension: 'validator_findings', score: 'pass', notes: null },
          { dimension: 'comms_cadence', score: 'pass', notes: null },
          { dimension: 'audit_chain_integrity', score: 'pass', notes: null },
        ],
      }),
      'admin',
      NOW,
    );
    expect(r.verdict).toBe('amber');
  });

  test('create with one fail computes red verdict', () => {
    const led = new InMemoryDrGameDayLedger();
    const r = led.create(
      'BIL',
      validInput({
        scores: [
          { dimension: 'rto_met', score: 'fail', notes: 'Aurora took 45 min' },
          { dimension: 'rpo_met', score: 'pass', notes: null },
          { dimension: 'runbook_accuracy', score: 'pass', notes: null },
          { dimension: 'validator_findings', score: 'pass', notes: null },
          { dimension: 'comms_cadence', score: 'pass', notes: null },
          { dimension: 'audit_chain_integrity', score: 'pass', notes: null },
        ],
      }),
      'admin',
      NOW,
    );
    expect(r.verdict).toBe('red');
  });

  test('duplicate record_id → duplicate_record_id', () => {
    const led = new InMemoryDrGameDayLedger();
    led.create('BIL', validInput(), 'admin', NOW);
    expect(() => led.create('BIL', validInput(), 'admin', NOW)).toThrow(/duplicate_record_id/);
  });

  test('list sorted newest year + executed_at first', () => {
    const led = new InMemoryDrGameDayLedger();
    led.create('BIL', validInput({ record_id: 'r_2025_q1', year: 2025, executed_at: '2025-03-15T09:00:00.000Z' }), 'admin', NOW);
    led.create('BIL', validInput({ record_id: 'r_2026_q1', year: 2026, executed_at: '2026-03-15T09:00:00.000Z' }), 'admin', NOW);
    led.create('BIL', validInput({ record_id: 'r_2026_q2', year: 2026, executed_at: '2026-06-15T09:00:00.000Z', cadence: 'Q2' }), 'admin', NOW);
    const items = led.list('BIL');
    expect(items.map((i) => i.record_id)).toEqual(['r_2026_q2', 'r_2026_q1', 'r_2025_q1']);
  });

  test('soft-delete + restore round-trip', () => {
    const led = new InMemoryDrGameDayLedger();
    const r = led.create('BIL', validInput(), 'admin', NOW);
    led.softDelete('BIL', 'r_q1_2026', 'admin', NOW);
    expect(led.get('BIL', 'r_q1_2026')).toBeNull();
    expect(led.list('BIL', { include_deleted: true })).toHaveLength(1);
    expect(led.restore({ ...r, deleted_at: NOW.toISOString(), deleted_by: 'admin' })).toBe(true);
    expect(led.get('BIL', 'r_q1_2026')?.deleted_at).toBeNull();
    // Second restore over live row → conflict.
    expect(led.restore({ ...r })).toBe(false);
  });

  test('update merges + recomputes verdict', () => {
    const led = new InMemoryDrGameDayLedger();
    led.create('BIL', validInput(), 'admin', NOW);
    // Patch one score to fail → verdict flips red.
    const patched = led.update(
      'BIL',
      'r_q1_2026',
      {
        scores: [
          { dimension: 'rto_met', score: 'fail', notes: 'patched' },
          { dimension: 'rpo_met', score: 'pass', notes: null },
          { dimension: 'runbook_accuracy', score: 'pass', notes: null },
          { dimension: 'validator_findings', score: 'pass', notes: null },
          { dimension: 'comms_cadence', score: 'pass', notes: null },
          { dimension: 'audit_chain_integrity', score: 'pass', notes: null },
        ],
      },
      'admin',
      NOW,
    );
    expect(patched.verdict).toBe('red');
  });

  test('cross-tenant isolation', () => {
    const led = new InMemoryDrGameDayLedger();
    led.create('BIL', validInput(), 'admin', NOW);
    expect(led.list('BANK_DEMO')).toHaveLength(0);
    expect(led.get('BANK_DEMO', 'r_q1_2026')).toBeNull();
  });

  test('validation: invalid cadence', () => {
    const led = new InMemoryDrGameDayLedger();
    expect(() =>
      led.create(
        'BIL',
        validInput({ cadence: 'Q5' as never }),
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_cadence/);
  });

  test('validation: year out of range', () => {
    const led = new InMemoryDrGameDayLedger();
    expect(() => led.create('BIL', validInput({ year: YEAR_MIN - 1 }), 'admin', NOW)).toThrow(/invalid_year/);
    expect(() => led.create('BIL', validInput({ year: YEAR_MAX + 1 }), 'admin', NOW)).toThrow(/invalid_year/);
  });

  test('validation: invalid_executed_at', () => {
    const led = new InMemoryDrGameDayLedger();
    expect(() => led.create('BIL', validInput({ executed_at: '2026-03-15' }), 'admin', NOW)).toThrow(/invalid_executed_at/);
  });

  test('validation: scores must cover dimensions, no dupes', () => {
    const led = new InMemoryDrGameDayLedger();
    expect(() =>
      led.create(
        'BIL',
        validInput({
          scores: [
            { dimension: 'rto_met' as const, score: 'pass' as const, notes: null },
            { dimension: 'rto_met' as const, score: 'fail' as const, notes: null }, // dup
          ],
        }),
        'admin',
        NOW,
      ),
    ).toThrow(/duplicate dimension/);
  });

  test('validation: invalid jira key', () => {
    const led = new InMemoryDrGameDayLedger();
    expect(() =>
      led.create('BIL', validInput({ remediation_jira_keys: ['not-jira'] }), 'admin', NOW),
    ).toThrow(/invalid_jira_keys/);
  });

  test('validation: bad record_id', () => {
    const led = new InMemoryDrGameDayLedger();
    expect(() => led.create('BIL', validInput({ record_id: 'BAD ID' }), 'admin', NOW)).toThrow(/invalid_record_id/);
  });

  test('cap_reached at DR_GAME_DAY_CAP_PER_TENANT', () => {
    const led = new InMemoryDrGameDayLedger();
    for (let i = 0; i < DR_GAME_DAY_CAP_PER_TENANT; i++) {
      led.create('BIL', validInput({ record_id: `r_${i}_aa` }), 'admin', NOW);
    }
    expect(() => led.create('BIL', validInput({ record_id: 'r_over_aa' }), 'admin', NOW)).toThrow(/cap_reached/);
  });
});

// ── 4. Routes ─────────────────────────────────────────────────────────

describe('GET /v1/dr/runbook', () => {
  test('admin → 200 with runbook + checklist + enums', async () => {
    const app = makeDrApp('admin');
    const r = await request(app).get('/v1/dr/runbook').set(TH_BIL);
    expect(r.status).toBe(200);
    const body = r.body.body;
    expect(body.rto_rpo_targets.length).toBeGreaterThan(0);
    expect(body.failover_steps.length).toBe(7);
    expect(body.game_day_scope.length).toBe(4);
    expect(body.cadences).toEqual([...ALL_DR_CADENCES]);
    expect(body.score_dimensions.length).toBe(6);
  });

  test('field_officer → 403', async () => {
    const app = makeDrApp('field_officer');
    const r = await request(app).get('/v1/dr/runbook').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/dr/game-days', () => {
  test('happy path → 201 + record', async () => {
    const app = makeDrApp('admin');
    const r = await request(app).post('/v1/dr/game-days').set(TH_BIL).send(validInput());
    expect(r.status).toBe(201);
    expect(r.body.body.record_id).toBe('r_q1_2026');
    expect(r.body.body.verdict).toBe('green');
  });

  test('accepts enveloped body', async () => {
    const app = makeDrApp('admin');
    const r = await request(app)
      .post('/v1/dr/game-days')
      .set(TH_BIL)
      .send({ header: { requestId: 'x' }, body: validInput() });
    expect(r.status).toBe(201);
  });

  test('duplicate record_id → 409', async () => {
    const app = makeDrApp('admin');
    await request(app).post('/v1/dr/game-days').set(TH_BIL).send(validInput());
    const r = await request(app).post('/v1/dr/game-days').set(TH_BIL).send(validInput());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_record_id');
  });

  test('invalid cadence → 400', async () => {
    const app = makeDrApp('admin');
    const r = await request(app)
      .post('/v1/dr/game-days')
      .set(TH_BIL)
      .send(validInput({ cadence: 'Q9' as never }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_cadence');
  });

  test('field_officer → 403', async () => {
    const app = makeDrApp('field_officer');
    const r = await request(app).post('/v1/dr/game-days').set(TH_BIL).send(validInput());
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/dr/game-days', () => {
  test('admin → list', async () => {
    const led = new InMemoryDrGameDayLedger();
    const app = makeDrApp('admin', { drGameDayLedger: led });
    led.create('BIL', validInput(), 'admin', NOW);
    const r = await request(app).get('/v1/dr/game-days').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
  });

  test('cross-tenant invisibility', async () => {
    const led = new InMemoryDrGameDayLedger();
    const app = makeDrApp('admin', { drGameDayLedger: led });
    led.create('BIL', validInput(), 'admin', NOW);
    const r = await request(app).get('/v1/dr/game-days').set(TH_BANK);
    expect(r.body.body.total).toBe(0);
  });
});

describe('GET /v1/dr/game-days/:record_id', () => {
  test('happy + 404', async () => {
    const led = new InMemoryDrGameDayLedger();
    const app = makeDrApp('admin', { drGameDayLedger: led });
    led.create('BIL', validInput(), 'admin', NOW);
    const ok = await request(app).get('/v1/dr/game-days/r_q1_2026').set(TH_BIL);
    expect(ok.status).toBe(200);
    const miss = await request(app).get('/v1/dr/game-days/nope').set(TH_BIL);
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('EWS_404_unknown_record');
  });

  test('cross-tenant lookup → 404', async () => {
    const led = new InMemoryDrGameDayLedger();
    const app = makeDrApp('admin', { drGameDayLedger: led });
    led.create('BIL', validInput(), 'admin', NOW);
    const r = await request(app).get('/v1/dr/game-days/r_q1_2026').set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /v1/dr/game-days/:record_id', () => {
  test('happy path recomputes verdict', async () => {
    const led = new InMemoryDrGameDayLedger();
    const app = makeDrApp('admin', { drGameDayLedger: led });
    led.create('BIL', validInput(), 'admin', NOW);
    const r = await request(app)
      .patch('/v1/dr/game-days/r_q1_2026')
      .set(TH_BIL)
      .send({
        scores: [
          { dimension: 'rto_met', score: 'fail', notes: 'patched' },
          { dimension: 'rpo_met', score: 'pass', notes: null },
          { dimension: 'runbook_accuracy', score: 'pass', notes: null },
          { dimension: 'validator_findings', score: 'pass', notes: null },
          { dimension: 'comms_cadence', score: 'pass', notes: null },
          { dimension: 'audit_chain_integrity', score: 'pass', notes: null },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.verdict).toBe('red');
  });

  test('unknown record → 404', async () => {
    const app = makeDrApp('admin');
    const r = await request(app).patch('/v1/dr/game-days/nope').set(TH_BIL).send({});
    expect(r.status).toBe(404);
  });
});

describe('DELETE /v1/dr/game-days/:record_id', () => {
  test('happy → 204', async () => {
    const led = new InMemoryDrGameDayLedger();
    const app = makeDrApp('admin', { drGameDayLedger: led });
    led.create('BIL', validInput(), 'admin', NOW);
    const r = await request(app).delete('/v1/dr/game-days/r_q1_2026').set(TH_BIL);
    expect(r.status).toBe(204);
    expect(led.get('BIL', 'r_q1_2026')).toBeNull();
  });

  test('unknown → 404', async () => {
    const app = makeDrApp('admin');
    const r = await request(app).delete('/v1/dr/game-days/nope').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('field_officer → 403', async () => {
    const app = makeDrApp('field_officer');
    const r = await request(app).delete('/v1/dr/game-days/r_q1_2026').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
