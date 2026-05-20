// services/bff/__tests__/recon_engine.test.ts
//
// Phase A.4 — Reconciliation & Controls. Tests mirror Phase A.3
// DQ Engine: enum invariants + pure executor + store lifecycle +
// run-now + dashboard + routes.

import request from 'supertest';
import {
  ALL_RECON_KINDS,
  ALL_RECON_SEVERITIES,
  buildReconDashboard,
  executeRecon,
  InMemoryReconStore,
  isReconKind,
  isReconSeverity,
  RECON_DEFINITION_CAP_PER_TENANT,
  RECON_SAMPLE_BREAKS_CAP,
  ReconError,
  runReconcile,
  type ReconDefinition,
} from '../src/recon/recon_engine';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function mkDef(over: Partial<ReconDefinition> = {}): ReconDefinition {
  return {
    recon_id: 'cbs_vs_mart_loans',
    tenant_id: 'BIL',
    name: 'CBS loans vs mart',
    description: null,
    source_label: 'cbs.loan_book',
    target_label: 'mart.loan_360',
    kind: 'amount_match',
    key_field: 'loan_id',
    amount_field: 'outstanding',
    amount_tolerance: 0,
    severity: 'high',
    active: true,
    created_at: NOW.toISOString(),
    created_by: 'alice.admin',
    updated_at: NOW.toISOString(),
    updated_by: 'alice.admin',
    deleted_at: null,
    deleted_by: null,
    ...over,
  };
}

function makeReconApp(role: string = 'admin', overrides: {
  reconStore?: InMemoryReconStore;
  recoveryStore?: InMemoryRecoveryStore;
} = {}) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    reconStore: overrides.reconStore ?? new InMemoryReconStore(),
    recoveryStore: overrides.recoveryStore ?? new InMemoryRecoveryStore(),
  });
  return app;
}

// ─── 1. Enum invariants ──────────────────────────────────────────────

describe('Recon enums', () => {
  test('3 kinds', () => {
    expect(ALL_RECON_KINDS).toEqual(['count_only', 'amount_match', 'set_diff']);
  });
  test('3 severities', () => {
    expect(ALL_RECON_SEVERITIES).toEqual(['high', 'medium', 'low']);
  });
  test('type guards', () => {
    expect(isReconKind('amount_match')).toBe(true);
    expect(isReconKind('bogus')).toBe(false);
    expect(isReconSeverity('high')).toBe(true);
    expect(isReconSeverity('critical')).toBe(false);
  });
});

// ─── 2. Pure executor ────────────────────────────────────────────────

describe('executeRecon', () => {
  test('all matched, balanced amounts', () => {
    const def = mkDef();
    const r = executeRecon(
      def,
      [{ loan_id: 'L1', outstanding: 100 }, { loan_id: 'L2', outstanding: 200 }],
      [{ loan_id: 'L1', outstanding: 100 }, { loan_id: 'L2', outstanding: 200 }],
    );
    expect(r.source_count).toBe(2);
    expect(r.target_count).toBe(2);
    expect(r.matched_count).toBe(2);
    expect(r.source_only_count).toBe(0);
    expect(r.target_only_count).toBe(0);
    expect(r.amount_mismatch_count).toBe(0);
    expect(r.source_total).toBe(300);
    expect(r.target_total).toBe(300);
    expect(r.difference).toBe(0);
    expect(r.sample_breaks).toEqual([]);
  });

  test('source_only when target missing key', () => {
    const def = mkDef();
    const r = executeRecon(
      def,
      [{ loan_id: 'L1', outstanding: 100 }, { loan_id: 'L_GHOST', outstanding: 50 }],
      [{ loan_id: 'L1', outstanding: 100 }],
    );
    expect(r.matched_count).toBe(1);
    expect(r.source_only_count).toBe(1);
    expect(r.sample_breaks.find((b) => b.key === 'L_GHOST')).toBeDefined();
    expect(r.sample_breaks.find((b) => b.key === 'L_GHOST')?.kind).toBe('source_only');
  });

  test('target_only when source missing key', () => {
    const def = mkDef();
    const r = executeRecon(
      def,
      [{ loan_id: 'L1', outstanding: 100 }],
      [{ loan_id: 'L1', outstanding: 100 }, { loan_id: 'L_NEW', outstanding: 99 }],
    );
    expect(r.matched_count).toBe(1);
    expect(r.target_only_count).toBe(1);
    expect(r.sample_breaks.find((b) => b.key === 'L_NEW')?.kind).toBe('target_only');
  });

  test('amount_mismatch within tolerance passes', () => {
    const def = mkDef({ amount_tolerance: 0.5 });
    const r = executeRecon(
      def,
      [{ loan_id: 'L1', outstanding: 100.0 }],
      [{ loan_id: 'L1', outstanding: 100.4 }],
    );
    expect(r.matched_count).toBe(1);
    expect(r.amount_mismatch_count).toBe(0);
  });

  test('amount_mismatch outside tolerance fails', () => {
    const def = mkDef({ amount_tolerance: 0.5 });
    const r = executeRecon(
      def,
      [{ loan_id: 'L1', outstanding: 100.0 }],
      [{ loan_id: 'L1', outstanding: 101.0 }],
    );
    expect(r.amount_mismatch_count).toBe(1);
    expect(r.sample_breaks[0].kind).toBe('amount_mismatch');
    expect(r.sample_breaks[0].delta).toBeCloseTo(-1, 5);
  });

  test('non-finite amounts treated as null + non-equal counts as mismatch', () => {
    const def = mkDef();
    const r = executeRecon(
      def,
      [{ loan_id: 'L1', outstanding: 100 }],
      [{ loan_id: 'L1', outstanding: 'broken' }],
    );
    expect(r.amount_mismatch_count).toBe(1);
    expect(r.sample_breaks[0].source_amount).toBe(100);
    expect(r.sample_breaks[0].target_amount).toBeNull();
  });

  test('count_only kind ignores amount comparison', () => {
    const def = mkDef({ kind: 'count_only', amount_field: null });
    const r = executeRecon(
      def,
      [{ loan_id: 'L1', outstanding: 100 }],
      [{ loan_id: 'L1', outstanding: 200 }],
    );
    expect(r.matched_count).toBe(1);
    expect(r.amount_mismatch_count).toBe(0);
    expect(r.source_total).toBeNull();
    expect(r.target_total).toBeNull();
  });

  test('records missing key field surface as side_only', () => {
    const def = mkDef();
    const r = executeRecon(
      def,
      [{ outstanding: 100 }, { loan_id: 'L1', outstanding: 100 }],
      [{ loan_id: 'L1', outstanding: 100 }],
    );
    expect(r.source_count).toBe(2);
    expect(r.matched_count).toBe(1);
    expect(r.source_only_count).toBe(1);
  });

  test('sample_breaks capped at RECON_SAMPLE_BREAKS_CAP', () => {
    const def = mkDef({ kind: 'count_only', amount_field: null });
    const source = Array.from({ length: 200 }, (_, i) => ({ loan_id: `L${i}` }));
    const r = executeRecon(def, source, []);
    expect(r.source_only_count).toBe(200);
    expect(r.sample_breaks.length).toBe(RECON_SAMPLE_BREAKS_CAP);
  });

  test('difference computed when amount totals exist', () => {
    const def = mkDef();
    const r = executeRecon(
      def,
      [{ loan_id: 'L1', outstanding: 100 }],
      [{ loan_id: 'L1', outstanding: 90 }],
    );
    expect(r.source_total).toBe(100);
    expect(r.target_total).toBe(90);
    expect(r.difference).toBe(10);
  });
});

// ─── 3. Store lifecycle ─────────────────────────────────────────────

describe('InMemoryReconStore — definitions CRUD', () => {
  test('create + get + list', () => {
    const s = new InMemoryReconStore();
    const d = s.createDefinition(
      'BIL',
      {
        recon_id: 'r_alpha',
        name: 'Alpha',
        source_label: 's',
        target_label: 't',
        kind: 'count_only',
        key_field: 'id',
      },
      'a',
      NOW,
    );
    expect(d.recon_id).toBe('r_alpha');
    expect(d.severity).toBe('medium');
    expect(d.amount_tolerance).toBe(0);
    expect(s.listDefinitions('BIL').length).toBe(1);
  });

  test('amount_match requires amount_field', () => {
    const s = new InMemoryReconStore();
    expect(() =>
      s.createDefinition(
        'BIL',
        {
          recon_id: 'r_alpha',
          name: 'Alpha',
          source_label: 's',
          target_label: 't',
          kind: 'amount_match',
          key_field: 'id',
        },
        'a',
        NOW,
      ),
    ).toThrow(ReconError);
  });

  test('invalid recon_id format rejected', () => {
    const s = new InMemoryReconStore();
    expect(() =>
      s.createDefinition(
        'BIL',
        {
          recon_id: 'BadCase',
          name: 'X',
          source_label: 's',
          target_label: 't',
          kind: 'count_only',
          key_field: 'id',
        },
        'a',
        NOW,
      ),
    ).toThrow(ReconError);
  });

  test('negative tolerance rejected', () => {
    const s = new InMemoryReconStore();
    expect(() =>
      s.createDefinition(
        'BIL',
        {
          recon_id: 'r_alpha',
          name: 'X',
          source_label: 's',
          target_label: 't',
          kind: 'amount_match',
          key_field: 'id',
          amount_field: 'amount',
          amount_tolerance: -0.01,
        },
        'a',
        NOW,
      ),
    ).toThrow(ReconError);
  });

  test('duplicate recon_id rejected', () => {
    const s = new InMemoryReconStore();
    const i = {
      recon_id: 'r_alpha',
      name: 'X',
      source_label: 's',
      target_label: 't',
      kind: 'count_only' as const,
      key_field: 'id',
    };
    s.createDefinition('BIL', i, 'a', NOW);
    expect(() => s.createDefinition('BIL', i, 'a', NOW)).toThrow(ReconError);
  });

  test('cap_reached', () => {
    const s = new InMemoryReconStore();
    for (let i = 0; i < RECON_DEFINITION_CAP_PER_TENANT; i++) {
      s.createDefinition(
        'BIL',
        {
          recon_id: `r_${String(i).padStart(4, '0')}`,
          name: `n${i}`,
          source_label: 's',
          target_label: 't',
          kind: 'count_only',
          key_field: 'id',
        },
        'a',
        NOW,
      );
    }
    expect(() =>
      s.createDefinition(
        'BIL',
        {
          recon_id: 'r_overflow',
          name: 'OF',
          source_label: 's',
          target_label: 't',
          kind: 'count_only',
          key_field: 'id',
        },
        'a',
        NOW,
      ),
    ).toThrow(ReconError);
  });

  test('update preserves amount_field invariant when switching kinds', () => {
    const s = new InMemoryReconStore();
    s.createDefinition(
      'BIL',
      {
        recon_id: 'r_alpha',
        name: 'X',
        source_label: 's',
        target_label: 't',
        kind: 'count_only',
        key_field: 'id',
      },
      'a',
      NOW,
    );
    // Switching to amount_match without supplying amount_field → reject.
    expect(() =>
      s.updateDefinition('BIL', 'r_alpha', { kind: 'amount_match' }, 'b', NOW),
    ).toThrow(ReconError);
    // Supplying both is fine.
    const u = s.updateDefinition(
      'BIL',
      'r_alpha',
      { kind: 'amount_match', amount_field: 'amount' },
      'b',
      new Date(NOW.getTime() + 1000),
    );
    expect(u.kind).toBe('amount_match');
    expect(u.amount_field).toBe('amount');
  });

  test('soft-delete + restore round-trip', () => {
    const s = new InMemoryReconStore();
    s.createDefinition(
      'BIL',
      {
        recon_id: 'r_alpha',
        name: 'X',
        source_label: 's',
        target_label: 't',
        kind: 'count_only',
        key_field: 'id',
      },
      'a',
      NOW,
    );
    const t = s.softDeleteDefinition('BIL', 'r_alpha', 'b', NOW);
    expect(t.deleted_at).toBe(NOW.toISOString());
    expect(s.getDefinition('BIL', 'r_alpha')).toBeNull();
    expect(s.restoreDefinition(t)).toBe(true);
    expect(s.getDefinition('BIL', 'r_alpha')?.deleted_at).toBeNull();
  });

  test('tenant scoping', () => {
    const s = new InMemoryReconStore();
    s.createDefinition('BIL', { recon_id: 'r_alpha', name: 'BIL', source_label: 's', target_label: 't', kind: 'count_only', key_field: 'id' }, 'a', NOW);
    s.createDefinition('BANK_DEMO', { recon_id: 'r_alpha', name: 'BANK', source_label: 's', target_label: 't', kind: 'count_only', key_field: 'id' }, 'a', NOW);
    expect(s.getDefinition('BIL', 'r_alpha')?.name).toBe('BIL');
    expect(s.getDefinition('BANK_DEMO', 'r_alpha')?.name).toBe('BANK');
  });
});

// ─── 4. runReconcile composition ──────────────────────────────────────

describe('runReconcile', () => {
  function setup() {
    const s = new InMemoryReconStore();
    s.createDefinition(
      'BIL',
      {
        recon_id: 'r_alpha',
        name: 'Alpha',
        source_label: 'src',
        target_label: 'tgt',
        kind: 'amount_match',
        key_field: 'id',
        amount_field: 'amount',
      },
      'admin',
      NOW,
    );
    return s;
  }

  test('balanced records → status=balanced', () => {
    const s = setup();
    const r = runReconcile(s, 'BIL', {
      recon_id: 'r_alpha',
      source_records: [{ id: '1', amount: 100 }],
      target_records: [{ id: '1', amount: 100 }],
      triggered_by: 'admin',
    }, NOW);
    expect(r.status).toBe('balanced');
    expect(r.matched_count).toBe(1);
  });

  test('with breaks → status=breaks_found', () => {
    const s = setup();
    const r = runReconcile(s, 'BIL', {
      recon_id: 'r_alpha',
      source_records: [{ id: '1', amount: 100 }, { id: '2', amount: 50 }],
      target_records: [{ id: '1', amount: 100 }],
      triggered_by: 'admin',
    }, NOW);
    expect(r.status).toBe('breaks_found');
    expect(r.source_only_count).toBe(1);
  });

  test('unknown recon → ReconError', () => {
    const s = setup();
    expect(() =>
      runReconcile(s, 'BIL', {
        recon_id: 'ghost',
        source_records: [],
        target_records: [],
        triggered_by: 'admin',
      }, NOW),
    ).toThrow(ReconError);
  });

  test('inactive → ReconError recon_inactive', () => {
    const s = setup();
    s.updateDefinition('BIL', 'r_alpha', { active: false }, 'a', NOW);
    expect(() =>
      runReconcile(s, 'BIL', {
        recon_id: 'r_alpha',
        source_records: [],
        target_records: [],
        triggered_by: 'admin',
      }, NOW),
    ).toThrow(ReconError);
  });

  test('run recorded', () => {
    const s = setup();
    const r = runReconcile(s, 'BIL', {
      recon_id: 'r_alpha',
      source_records: [{ id: '1', amount: 100 }],
      target_records: [{ id: '1', amount: 100 }],
      triggered_by: 'admin',
    }, NOW);
    expect(s.getRun('BIL', r.run_id)?.run_id).toBe(r.run_id);
    expect(s.listRuns('BIL').length).toBe(1);
  });
});

// ─── 5. Dashboard ─────────────────────────────────────────────────────

describe('buildReconDashboard', () => {
  test('zero state', () => {
    const s = new InMemoryReconStore();
    const d = buildReconDashboard(s, 'BIL', NOW);
    expect(d.total_definitions).toBe(0);
    expect(d.definitions_status).toEqual([]);
  });

  test('rollup with mixed runs', () => {
    const s = new InMemoryReconStore();
    s.createDefinition('BIL', {
      recon_id: 'r_alpha',
      name: 'Alpha',
      source_label: 's',
      target_label: 't',
      kind: 'amount_match',
      key_field: 'id',
      amount_field: 'amount',
      severity: 'high',
    }, 'a', NOW);
    s.createDefinition('BIL', {
      recon_id: 'r_beta',
      name: 'Beta',
      source_label: 's',
      target_label: 't',
      kind: 'count_only',
      key_field: 'id',
      severity: 'low',
    }, 'a', NOW);
    runReconcile(s, 'BIL', {
      recon_id: 'r_alpha',
      source_records: [{ id: '1', amount: 100 }, { id: '2', amount: 50 }],
      target_records: [{ id: '1', amount: 100 }],
      triggered_by: 'admin',
    }, NOW);
    runReconcile(s, 'BIL', {
      recon_id: 'r_beta',
      source_records: [{ id: '1' }],
      target_records: [{ id: '1' }],
      triggered_by: 'admin',
    }, NOW);
    const d = buildReconDashboard(s, 'BIL', NOW);
    expect(d.total_definitions).toBe(2);
    expect(d.total_balanced).toBe(1);
    expect(d.total_breaks_found).toBe(1);
    expect(d.by_severity.high.breaks_24h).toBe(1);
    expect(d.by_kind.amount_match.runs).toBe(1);
    // Worst (most breaks) first.
    expect(d.definitions_status[0].recon_id).toBe('r_alpha');
    expect(d.definitions_status[0].latest_breaks).toBe(1);
  });
});

// ─── 6. Routes ─────────────────────────────────────────────────────────

describe('routes — kinds', () => {
  test('happy', async () => {
    const app = makeReconApp('admin');
    const r = await request(app).get('/v1/recon/kinds').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.kinds).toEqual([...ALL_RECON_KINDS]);
    expect(r.body.body.severities).toEqual([...ALL_RECON_SEVERITIES]);
  });
  test('non-admin → 403', async () => {
    const app = makeReconApp('field_officer');
    const r = await request(app).get('/v1/recon/kinds').set(TH);
    expect(r.status).toBe(403);
  });
});

describe('routes — definitions CRUD', () => {
  const validDef = {
    recon_id: 'cbs_vs_mart',
    name: 'CBS vs mart',
    source_label: 'cbs.loan_book',
    target_label: 'mart.loan_360',
    kind: 'amount_match',
    key_field: 'loan_id',
    amount_field: 'outstanding',
  };

  test('POST 201', async () => {
    const app = makeReconApp('admin');
    const r = await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    expect(r.status).toBe(201);
    expect(r.body.body.recon_id).toBe('cbs_vs_mart');
  });

  test('POST duplicate 409', async () => {
    const store = new InMemoryReconStore();
    const app = makeReconApp('admin', { reconStore: store });
    await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    const r = await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_recon_id');
  });

  test('POST missing amount_field on amount_match → 400', async () => {
    const app = makeReconApp('admin');
    const { amount_field: _drop, ...withoutAmount } = validDef;
    void _drop;
    const r = await request(app).post('/v1/recon/definitions').set(TH).send(withoutAmount);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_missing_amount_field');
  });

  test('GET list filtered by kind', async () => {
    const store = new InMemoryReconStore();
    const app = makeReconApp('admin', { reconStore: store });
    await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    await request(app)
      .post('/v1/recon/definitions')
      .set(TH)
      .send({ ...validDef, recon_id: 'r_count', kind: 'count_only', amount_field: null });
    const r = await request(app).get('/v1/recon/definitions?kind=amount_match').set(TH);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].recon_id).toBe('cbs_vs_mart');
  });

  test('GET single 404 unknown', async () => {
    const app = makeReconApp('admin');
    const r = await request(app).get('/v1/recon/definitions/ghost').set(TH);
    expect(r.status).toBe(404);
  });

  test('PATCH applies', async () => {
    const store = new InMemoryReconStore();
    const app = makeReconApp('admin', { reconStore: store });
    await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    const r = await request(app)
      .patch('/v1/recon/definitions/cbs_vs_mart')
      .set(TH)
      .send({ amount_tolerance: 0.5 });
    expect(r.status).toBe(200);
    expect(r.body.body.amount_tolerance).toBe(0.5);
  });

  test('DELETE soft-deletes + archives', async () => {
    const store = new InMemoryReconStore();
    const recovery = new InMemoryRecoveryStore();
    const app = makeReconApp('admin', { reconStore: store, recoveryStore: recovery });
    await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    const r = await request(app).delete('/v1/recon/definitions/cbs_vs_mart').set(TH);
    expect(r.status).toBe(204);
    const archived = await recovery.list({ tenant_id: 'BIL', entity_type: 'recon_definition' });
    expect(archived.items.length).toBe(1);
    expect(archived.items[0].original_table).toBe('app_recon.definitions');
  });

  test('tenant scoping', async () => {
    const store = new InMemoryReconStore();
    const app = makeReconApp('admin', { reconStore: store });
    await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    const r = await request(app).get('/v1/recon/definitions').set(TH_BANK);
    expect(r.body.body.total).toBe(0);
  });
});

describe('routes — run + runs + dashboard', () => {
  const validDef = {
    recon_id: 'cbs_vs_mart',
    name: 'CBS vs mart',
    source_label: 'cbs.loan_book',
    target_label: 'mart.loan_360',
    kind: 'amount_match',
    key_field: 'loan_id',
    amount_field: 'outstanding',
  };

  test('POST /run balanced', async () => {
    const store = new InMemoryReconStore();
    const app = makeReconApp('admin', { reconStore: store });
    await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    const r = await request(app)
      .post('/v1/recon/definitions/cbs_vs_mart/run')
      .set(TH)
      .send({
        source_records: [{ loan_id: 'L1', outstanding: 100 }],
        target_records: [{ loan_id: 'L1', outstanding: 100 }],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('balanced');
  });

  test('POST /run breaks', async () => {
    const store = new InMemoryReconStore();
    const app = makeReconApp('admin', { reconStore: store });
    await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    const r = await request(app)
      .post('/v1/recon/definitions/cbs_vs_mart/run')
      .set(TH)
      .send({
        source_records: [{ loan_id: 'L1', outstanding: 100 }, { loan_id: 'L2', outstanding: 50 }],
        target_records: [{ loan_id: 'L1', outstanding: 100 }],
      });
    expect(r.body.body.status).toBe('breaks_found');
    expect(r.body.body.source_only_count).toBe(1);
  });

  test('POST /run unknown → 404', async () => {
    const app = makeReconApp('admin');
    const r = await request(app)
      .post('/v1/recon/definitions/ghost/run')
      .set(TH)
      .send({ source_records: [], target_records: [] });
    expect(r.status).toBe(404);
  });

  test('POST /run inactive → 409', async () => {
    const store = new InMemoryReconStore();
    const app = makeReconApp('admin', { reconStore: store });
    await request(app)
      .post('/v1/recon/definitions')
      .set(TH)
      .send({ ...validDef, active: false });
    const r = await request(app)
      .post('/v1/recon/definitions/cbs_vs_mart/run')
      .set(TH)
      .send({ source_records: [], target_records: [] });
    expect(r.status).toBe(409);
  });

  test('GET /runs invalid status → 400', async () => {
    const app = makeReconApp('admin');
    const r = await request(app).get('/v1/recon/runs?status=bogus').set(TH);
    expect(r.status).toBe(400);
  });

  test('GET /runs lists', async () => {
    const store = new InMemoryReconStore();
    const app = makeReconApp('admin', { reconStore: store });
    await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    await request(app)
      .post('/v1/recon/definitions/cbs_vs_mart/run')
      .set(TH)
      .send({
        source_records: [{ loan_id: 'L1', outstanding: 100 }],
        target_records: [{ loan_id: 'L1', outstanding: 100 }],
      });
    const r = await request(app).get('/v1/recon/runs').set(TH);
    expect(r.body.body.items.length).toBe(1);
  });

  test('GET /dashboard rollup', async () => {
    const store = new InMemoryReconStore();
    const app = makeReconApp('admin', { reconStore: store });
    await request(app).post('/v1/recon/definitions').set(TH).send(validDef);
    await request(app)
      .post('/v1/recon/definitions/cbs_vs_mart/run')
      .set(TH)
      .send({
        source_records: [{ loan_id: 'L1', outstanding: 100 }, { loan_id: 'L2', outstanding: 50 }],
        target_records: [{ loan_id: 'L1', outstanding: 100 }],
      });
    const r = await request(app).get('/v1/recon/dashboard').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_breaks_found).toBe(1);
    expect(r.body.body.definitions_status[0].recon_id).toBe('cbs_vs_mart');
  });

  test('GET /dashboard non-admin 403', async () => {
    const app = makeReconApp('field_officer');
    const r = await request(app).get('/v1/recon/dashboard').set(TH);
    expect(r.status).toBe(403);
  });
});
