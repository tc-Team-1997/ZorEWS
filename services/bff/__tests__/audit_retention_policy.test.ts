// services/bff/__tests__/audit_retention_policy.test.ts
//
// Phase D.3 — Audit Admin retention policy tests.

import request from 'supertest';
import {
  ALL_RETENTION_STRATEGIES,
  ALL_RETENTION_SCOPES,
  isRetentionStrategy,
  isRetentionScope,
  InMemoryAuditRetentionPolicyStore,
  AuditRetentionError,
  AUDIT_RETENTION_CAP_PER_TENANT,
  RETENTION_DAYS_MAX,
} from '../src/audit/retention_policy';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T11:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeRetentionApp(
  role: string = 'admin',
  overrides: { auditRetentionPolicyStore?: InMemoryAuditRetentionPolicyStore } = {},
) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditRetentionPolicyStore:
      overrides.auditRetentionPolicyStore ?? new InMemoryAuditRetentionPolicyStore(),
  });
  return app;
}

// ── 1. Type guards + closed enums ─────────────────────────────────────

describe('audit_retention constants', () => {
  test('ALL_RETENTION_STRATEGIES is a stable 3-value enum', () => {
    expect(ALL_RETENTION_STRATEGIES).toEqual(['count_cap', 'time_window', 'never_purge']);
  });

  test('ALL_RETENTION_SCOPES carries audit_trail', () => {
    expect(ALL_RETENTION_SCOPES).toContain('audit_trail');
  });

  test('isRetentionStrategy accepts every value', () => {
    for (const s of ALL_RETENTION_STRATEGIES) expect(isRetentionStrategy(s)).toBe(true);
    expect(isRetentionStrategy('mystery')).toBe(false);
  });

  test('isRetentionScope accepts every value', () => {
    for (const s of ALL_RETENTION_SCOPES) expect(isRetentionScope(s)).toBe(true);
    expect(isRetentionScope('case_events')).toBe(false);
  });
});

// ── 2. Store CRUD + invariants ────────────────────────────────────────

describe('InMemoryAuditRetentionPolicyStore', () => {
  test('create time_window policy with retention_days', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    const e = s.create(
      'BIL',
      {
        policy_id: 'p_rbi_7y',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 2555,
      },
      'admin',
      NOW,
    );
    expect(e.strategy).toBe('time_window');
    expect(e.retention_days).toBe(2555);
    expect(e.max_events).toBeNull();
    expect(e.active).toBe(true);
  });

  test('create count_cap policy with max_events', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    const e = s.create(
      'BIL',
      {
        policy_id: 'p_dev_cap',
        scope: 'audit_trail',
        strategy: 'count_cap',
        max_events: 5000,
      },
      'admin',
      NOW,
    );
    expect(e.max_events).toBe(5000);
    expect(e.retention_days).toBeNull();
  });

  test('create never_purge policy zeroes both fields', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    const e = s.create(
      'BIL',
      {
        policy_id: 'p_worm',
        scope: 'audit_trail',
        strategy: 'never_purge',
      },
      'admin',
      NOW,
    );
    expect(e.retention_days).toBeNull();
    expect(e.max_events).toBeNull();
  });

  test('time_window without retention_days → invalid_retention_days', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    expect(() =>
      s.create(
        'BIL',
        { policy_id: 'p1', scope: 'audit_trail', strategy: 'time_window' },
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_retention_days/);
  });

  test('time_window with max_events → invalid_max_events', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    expect(() =>
      s.create(
        'BIL',
        {
          policy_id: 'p1',
          scope: 'audit_trail',
          strategy: 'time_window',
          retention_days: 365,
          max_events: 9999,
        },
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_max_events/);
  });

  test('count_cap without max_events → invalid_max_events', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    expect(() =>
      s.create(
        'BIL',
        { policy_id: 'p1', scope: 'audit_trail', strategy: 'count_cap' },
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_max_events/);
  });

  test('never_purge with retention_days → invalid_retention_days', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    expect(() =>
      s.create(
        'BIL',
        {
          policy_id: 'p1',
          scope: 'audit_trail',
          strategy: 'never_purge',
          retention_days: 30,
        },
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_retention_days/);
  });

  test('retention_days bounds enforced', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    expect(() =>
      s.create(
        'BIL',
        {
          policy_id: 'p1',
          scope: 'audit_trail',
          strategy: 'time_window',
          retention_days: 0,
        },
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_retention_days/);
    expect(() =>
      s.create(
        'BIL',
        {
          policy_id: 'p2',
          scope: 'audit_trail',
          strategy: 'time_window',
          retention_days: RETENTION_DAYS_MAX + 1,
        },
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_retention_days/);
    // Boundary accepted
    expect(
      s.create(
        'BIL',
        {
          policy_id: 'p3',
          scope: 'audit_trail',
          strategy: 'time_window',
          retention_days: RETENTION_DAYS_MAX,
        },
        'admin',
        NOW,
      ).retention_days,
    ).toBe(RETENTION_DAYS_MAX);
  });

  test('duplicate scope (active+active) refused', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    expect(() =>
      s.create(
        'BIL',
        {
          policy_id: 'p2',
          scope: 'audit_trail',
          strategy: 'count_cap',
          max_events: 5000,
        },
        'admin',
        NOW,
      ),
    ).toThrow(/duplicate_scope/);
  });

  test('inactive duplicate scope is fine', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
        active: false,
      },
      'admin',
      NOW,
    );
    expect(() =>
      s.create(
        'BIL',
        {
          policy_id: 'p2',
          scope: 'audit_trail',
          strategy: 'count_cap',
          max_events: 5000,
        },
        'admin',
        NOW,
      ),
    ).not.toThrow();
  });

  test('list sorted by (scope, policy_id)', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    s.create(
      'BIL',
      {
        policy_id: 'p2',
        scope: 'audit_trail',
        strategy: 'never_purge',
        active: false,
      },
      'admin',
      NOW,
    );
    s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    const items = s.list('BIL');
    expect(items.map((i) => i.policy_id)).toEqual(['p1', 'p2']);
  });

  test('resolveActive returns the active policy for a scope', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    const a = s.resolveActive('BIL', 'audit_trail');
    expect(a?.policy_id).toBe('p1');
    expect(s.resolveActive('BANK_DEMO', 'audit_trail')).toBeNull();
  });

  test('resolveActive returns null when no active row matches', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
        active: false,
      },
      'admin',
      NOW,
    );
    expect(s.resolveActive('BIL', 'audit_trail')).toBeNull();
  });

  test('update merging fixes strategy/retention_days invariants', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    // Switch to count_cap with retention_days still set → must throw on
    // the merged result.
    expect(() =>
      s.update('BIL', 'p1', { strategy: 'count_cap' }, 'admin', NOW),
    ).toThrow(/invalid_max_events/);
    // Switch with max_events supplied → ok; retention_days nulled.
    const ok = s.update(
      'BIL',
      'p1',
      { strategy: 'count_cap', retention_days: null, max_events: 5000 },
      'admin',
      NOW,
    );
    expect(ok.strategy).toBe('count_cap');
    expect(ok.max_events).toBe(5000);
    expect(ok.retention_days).toBeNull();
  });

  test('update to never_purge zeroes both fields', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    const ok = s.update(
      'BIL',
      'p1',
      { strategy: 'never_purge', retention_days: null },
      'admin',
      NOW,
    );
    expect(ok.retention_days).toBeNull();
    expect(ok.max_events).toBeNull();
  });

  test('update re-activation refused if another active policy holds scope', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    s.create(
      'BIL',
      {
        policy_id: 'p2',
        scope: 'audit_trail',
        strategy: 'never_purge',
        active: false,
      },
      'admin',
      NOW,
    );
    expect(() =>
      s.update('BIL', 'p2', { active: true }, 'admin', NOW),
    ).toThrow(/duplicate_scope/);
  });

  test('soft-delete excludes from list by default', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    s.softDelete('BIL', 'p1', 'admin', NOW);
    expect(s.list('BIL')).toHaveLength(0);
    expect(s.list('BIL', { include_deleted: true })).toHaveLength(1);
    expect(s.get('BIL', 'p1')).toBeNull();
    // After delete, scope is free again.
    expect(() =>
      s.create(
        'BIL',
        {
          policy_id: 'p2',
          scope: 'audit_trail',
          strategy: 'never_purge',
        },
        'admin',
        NOW,
      ),
    ).not.toThrow();
  });

  test('restore refuses when scope already held by an active policy', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    const e1 = s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    s.softDelete('BIL', 'p1', 'admin', NOW);
    // Now create a new active policy on the same scope.
    s.create(
      'BIL',
      {
        policy_id: 'p2',
        scope: 'audit_trail',
        strategy: 'never_purge',
      },
      'admin',
      NOW,
    );
    // Restoring p1 (active=true) must fail.
    expect(
      s.restore({
        ...e1,
        active: true,
        deleted_at: NOW.toISOString(),
        deleted_by: 'admin',
      }),
    ).toBe(false);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    s.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    expect(s.list('BANK_DEMO')).toHaveLength(0);
    expect(s.get('BANK_DEMO', 'p1')).toBeNull();
  });

  test('cap_reached', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    for (let i = 0; i < AUDIT_RETENTION_CAP_PER_TENANT; i++) {
      s.create(
        'BIL',
        {
          policy_id: `p${i}_aa`,
          scope: 'audit_trail',
          strategy: 'time_window',
          retention_days: 365,
          active: false,
        },
        'admin',
        NOW,
      );
    }
    expect(() =>
      s.create(
        'BIL',
        {
          policy_id: 'p_over',
          scope: 'audit_trail',
          strategy: 'time_window',
          retention_days: 365,
        },
        'admin',
        NOW,
      ),
    ).toThrow(/cap_reached/);
  });

  test('validation: bad policy_id', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    expect(() =>
      s.create(
        'BIL',
        {
          policy_id: 'BAD ID',
          scope: 'audit_trail',
          strategy: 'time_window',
          retention_days: 365,
        },
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_policy_id/);
  });

  test('notes ≤ NOTES_MAX_LEN', () => {
    const s = new InMemoryAuditRetentionPolicyStore();
    expect(() =>
      s.create(
        'BIL',
        {
          policy_id: 'p1',
          scope: 'audit_trail',
          strategy: 'time_window',
          retention_days: 365,
          notes: 'x'.repeat(2001),
        },
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_notes/);
  });
});

// ── 3. Routes ─────────────────────────────────────────────────────────

describe('GET /v1/admin/audit-retention/strategies', () => {
  test('admin → 200 with both enums', async () => {
    const app = makeRetentionApp('admin');
    const r = await request(app).get('/v1/admin/audit-retention/strategies').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.strategies).toEqual([...ALL_RETENTION_STRATEGIES]);
    expect(r.body.body.scopes).toEqual([...ALL_RETENTION_SCOPES]);
  });

  test('field_officer → 403', async () => {
    const app = makeRetentionApp('field_officer');
    const r = await request(app).get('/v1/admin/audit-retention/strategies').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/admin/audit-retention', () => {
  test('happy path → 201 + time_window entry', async () => {
    const app = makeRetentionApp('admin');
    const r = await request(app)
      .post('/v1/admin/audit-retention')
      .set(TH_BIL)
      .send({
        policy_id: 'p_rbi_7y',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 2555,
        notes: 'RBI Cyber Resilience §4.1 — 7 year retention',
      });
    expect(r.status).toBe(201);
    expect(r.body.body.retention_days).toBe(2555);
  });

  test('accepts enveloped body', async () => {
    const app = makeRetentionApp('admin');
    const r = await request(app)
      .post('/v1/admin/audit-retention')
      .set(TH_BIL)
      .send({
        header: { requestId: 'x' },
        body: {
          policy_id: 'p1',
          scope: 'audit_trail',
          strategy: 'never_purge',
        },
      });
    expect(r.status).toBe(201);
  });

  test('duplicate policy_id → 409', async () => {
    const app = makeRetentionApp('admin');
    const body = {
      policy_id: 'p1',
      scope: 'audit_trail',
      strategy: 'time_window',
      retention_days: 365,
    };
    await request(app).post('/v1/admin/audit-retention').set(TH_BIL).send(body);
    const r2 = await request(app).post('/v1/admin/audit-retention').set(TH_BIL).send(body);
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('EWS_409_duplicate_policy_id');
  });

  test('duplicate scope → 409', async () => {
    const app = makeRetentionApp('admin');
    await request(app).post('/v1/admin/audit-retention').set(TH_BIL).send({
      policy_id: 'p1',
      scope: 'audit_trail',
      strategy: 'time_window',
      retention_days: 365,
    });
    const r2 = await request(app).post('/v1/admin/audit-retention').set(TH_BIL).send({
      policy_id: 'p2',
      scope: 'audit_trail',
      strategy: 'count_cap',
      max_events: 5000,
    });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('EWS_409_duplicate_scope');
  });

  test('invalid_strategy → 400 with code-routed error', async () => {
    const app = makeRetentionApp('admin');
    const r = await request(app)
      .post('/v1/admin/audit-retention')
      .set(TH_BIL)
      .send({
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'nope',
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_strategy');
  });

  test('time_window missing retention_days → 400', async () => {
    const app = makeRetentionApp('admin');
    const r = await request(app)
      .post('/v1/admin/audit-retention')
      .set(TH_BIL)
      .send({
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_retention_days');
  });

  test('field_officer → 403', async () => {
    const app = makeRetentionApp('field_officer');
    const r = await request(app)
      .post('/v1/admin/audit-retention')
      .set(TH_BIL)
      .send({
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'never_purge',
      });
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/admin/audit-retention', () => {
  test('admin → list', async () => {
    const store = new InMemoryAuditRetentionPolicyStore();
    const app = makeRetentionApp('admin', { auditRetentionPolicyStore: store });
    store.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    const r = await request(app).get('/v1/admin/audit-retention').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
  });

  test('cross-tenant invisibility', async () => {
    const store = new InMemoryAuditRetentionPolicyStore();
    const app = makeRetentionApp('admin', { auditRetentionPolicyStore: store });
    store.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    const r = await request(app).get('/v1/admin/audit-retention').set(TH_BANK);
    expect(r.body.body.total).toBe(0);
  });
});

describe('GET /v1/admin/audit-retention/active/:scope', () => {
  test('happy path returns the active policy', async () => {
    const store = new InMemoryAuditRetentionPolicyStore();
    const app = makeRetentionApp('admin', { auditRetentionPolicyStore: store });
    store.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    const r = await request(app).get('/v1/admin/audit-retention/active/audit_trail').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.policy.policy_id).toBe('p1');
  });

  test('no policy → null', async () => {
    const app = makeRetentionApp('admin');
    const r = await request(app).get('/v1/admin/audit-retention/active/audit_trail').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.policy).toBeNull();
  });

  test('invalid scope → 400', async () => {
    const app = makeRetentionApp('admin');
    const r = await request(app).get('/v1/admin/audit-retention/active/bogus').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_scope');
  });
});

describe('GET /v1/admin/audit-retention/:policy_id', () => {
  test('happy + 404', async () => {
    const store = new InMemoryAuditRetentionPolicyStore();
    const app = makeRetentionApp('admin', { auditRetentionPolicyStore: store });
    store.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    const ok = await request(app).get('/v1/admin/audit-retention/p1').set(TH_BIL);
    expect(ok.status).toBe(200);
    const miss = await request(app).get('/v1/admin/audit-retention/nope').set(TH_BIL);
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('EWS_404_unknown_policy');
  });
});

describe('PATCH /v1/admin/audit-retention/:policy_id', () => {
  test('updates active flag', async () => {
    const store = new InMemoryAuditRetentionPolicyStore();
    const app = makeRetentionApp('admin', { auditRetentionPolicyStore: store });
    store.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    const r = await request(app)
      .patch('/v1/admin/audit-retention/p1')
      .set(TH_BIL)
      .send({ active: false });
    expect(r.status).toBe(200);
    expect(r.body.body.active).toBe(false);
  });

  test('unknown policy → 404', async () => {
    const app = makeRetentionApp('admin');
    const r = await request(app)
      .patch('/v1/admin/audit-retention/nope')
      .set(TH_BIL)
      .send({ active: false });
    expect(r.status).toBe(404);
  });

  test('merge invariant violation → 400', async () => {
    const store = new InMemoryAuditRetentionPolicyStore();
    const app = makeRetentionApp('admin', { auditRetentionPolicyStore: store });
    store.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    // Switch to count_cap without supplying max_events.
    const r = await request(app)
      .patch('/v1/admin/audit-retention/p1')
      .set(TH_BIL)
      .send({ strategy: 'count_cap' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_max_events');
  });

  test('reactivation conflict → 409', async () => {
    const store = new InMemoryAuditRetentionPolicyStore();
    const app = makeRetentionApp('admin', { auditRetentionPolicyStore: store });
    store.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    store.create(
      'BIL',
      {
        policy_id: 'p2',
        scope: 'audit_trail',
        strategy: 'never_purge',
        active: false,
      },
      'admin',
      NOW,
    );
    const r = await request(app)
      .patch('/v1/admin/audit-retention/p2')
      .set(TH_BIL)
      .send({ active: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_scope');
  });
});

describe('DELETE /v1/admin/audit-retention/:policy_id', () => {
  test('happy path → 204 + soft-deleted', async () => {
    const store = new InMemoryAuditRetentionPolicyStore();
    const app = makeRetentionApp('admin', { auditRetentionPolicyStore: store });
    store.create(
      'BIL',
      {
        policy_id: 'p1',
        scope: 'audit_trail',
        strategy: 'time_window',
        retention_days: 365,
      },
      'admin',
      NOW,
    );
    const r = await request(app).delete('/v1/admin/audit-retention/p1').set(TH_BIL);
    expect(r.status).toBe(204);
    expect(store.get('BIL', 'p1')).toBeNull();
    expect(store.list('BIL', { include_deleted: true })).toHaveLength(1);
  });

  test('unknown → 404', async () => {
    const app = makeRetentionApp('admin');
    const r = await request(app).delete('/v1/admin/audit-retention/nope').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('field_officer → 403', async () => {
    const app = makeRetentionApp('field_officer');
    const r = await request(app).delete('/v1/admin/audit-retention/p1').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
