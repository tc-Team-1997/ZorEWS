// services/bff/__tests__/cms_automation.test.ts
//
// CMS-4 — automation surface tests.

import request from 'supertest';
import {
  ALERT_SEVERITY_TO_PRIORITY,
  CMS_POOL_CAP_PER_TENANT,
  InMemoryAssigneePoolStore,
  autoCreateCaseFromAlert,
  findInactiveCases,
} from '../src/cms_automation';
import { InMemoryCmsCaseStore } from '../src/cms_store';
import { CmsCaseError, type CmsCase } from '../src/cms_cases';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T10:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── autoCreateCaseFromAlert (pure) ──────────────────────────────────

describe('CMS-4 — autoCreateCaseFromAlert', () => {
  test('creates a case from RED alert with priority P1', () => {
    const store = new InMemoryCmsCaseStore();
    const r = autoCreateCaseFromAlert(
      {
        alert_id: 'alrt-1',
        alert_severity: 'RED',
        customer_id: 'cust-001',
        rule_id: 'RULE_CREDIT_001',
        rule_name: 'High EMI Bounce',
      },
      store,
      'BIL',
      [],
      'system',
      NOW,
    );
    expect(r.created).toBe(true);
    expect(r.case.priority).toBe('P1');
    expect(r.case.alert_id).toBe('alrt-1');
    expect(r.case.title).toContain('RED');
    expect(r.case.title).toContain('cust-001');
    expect(r.case.tags).toContain('auto:red');
    expect(r.case.assigned_to).toBeNull();
  });

  test('idempotent: re-firing same alert_id returns existing case', () => {
    const store = new InMemoryCmsCaseStore();
    const r1 = autoCreateCaseFromAlert(
      { alert_id: 'alrt-1', alert_severity: 'RED' },
      store,
      'BIL',
      [],
      'system',
      NOW,
    );
    const r2 = autoCreateCaseFromAlert(
      { alert_id: 'alrt-1', alert_severity: 'RED' },
      store,
      'BIL',
      [],
      'system',
      NOW,
    );
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.matched_case_id).toBe(r1.case.case_id);
    expect(store.list('BIL', {})).toHaveLength(1);
  });

  test('uses pool[0] as initial assignee when pool non-empty', () => {
    const store = new InMemoryCmsCaseStore();
    const r = autoCreateCaseFromAlert(
      { alert_id: 'alrt-2', alert_severity: 'ORANGE' },
      store,
      'BIL',
      ['alice', 'bob'],
      'system',
      NOW,
    );
    expect(r.case.assigned_to).toBe('alice');
    expect(r.case.status).toBe('ASSIGNED');
  });

  test('priority mapping covers RED/ORANGE/YELLOW/GREEN + critical/high/medium/low', () => {
    expect(ALERT_SEVERITY_TO_PRIORITY.RED).toBe('P1');
    expect(ALERT_SEVERITY_TO_PRIORITY.ORANGE).toBe('P2');
    expect(ALERT_SEVERITY_TO_PRIORITY.YELLOW).toBe('P3');
    expect(ALERT_SEVERITY_TO_PRIORITY.GREEN).toBe('P4');
    expect(ALERT_SEVERITY_TO_PRIORITY.critical).toBe('P1');
    expect(ALERT_SEVERITY_TO_PRIORITY.low).toBe('P4');
  });

  test('lower-case alert severity accepted', () => {
    const store = new InMemoryCmsCaseStore();
    const r = autoCreateCaseFromAlert(
      { alert_id: 'alrt-x', alert_severity: 'red' },
      store,
      'BIL',
      [],
      'system',
      NOW,
    );
    expect(r.case.priority).toBe('P1');
  });

  test('unknown severity → invalid_input', () => {
    const store = new InMemoryCmsCaseStore();
    expect(() =>
      autoCreateCaseFromAlert(
        { alert_id: 'a', alert_severity: 'BLUE' },
        store,
        'BIL',
        [],
        'system',
        NOW,
      ),
    ).toThrow(/alert_severity/);
  });

  test('missing alert_id → invalid_input', () => {
    const store = new InMemoryCmsCaseStore();
    expect(() =>
      autoCreateCaseFromAlert(
        { alert_severity: 'RED' } as never,
        store,
        'BIL',
        [],
        'system',
        NOW,
      ),
    ).toThrow(/alert_id/);
  });

  test('cross-tenant: same alert_id in BANK_DEMO creates a separate case', () => {
    const store = new InMemoryCmsCaseStore();
    const a = autoCreateCaseFromAlert(
      { alert_id: 'alrt-x', alert_severity: 'RED' },
      store,
      'BIL',
      [],
      'system',
      NOW,
    );
    const b = autoCreateCaseFromAlert(
      { alert_id: 'alrt-x', alert_severity: 'RED' },
      store,
      'BANK_DEMO',
      [],
      'system',
      NOW,
    );
    expect(a.case.tenant_id).toBe('BIL');
    expect(b.case.tenant_id).toBe('BANK_DEMO');
    expect(a.case.case_id).not.toBe(b.case.case_id);
  });
});

// ─── InMemoryAssigneePoolStore ───────────────────────────────────────

describe('CMS-4 — InMemoryAssigneePoolStore', () => {
  test('empty initial state', () => {
    const s = new InMemoryAssigneePoolStore();
    expect(s.get('BIL').members).toEqual([]);
  });

  test('setMembers + get round-trip', () => {
    const s = new InMemoryAssigneePoolStore();
    s.setMembers('BIL', ['alice', 'bob'], 'admin', NOW);
    expect(s.get('BIL').members).toEqual(['alice', 'bob']);
  });

  test('rejects non-array members', () => {
    const s = new InMemoryAssigneePoolStore();
    expect(() => s.setMembers('BIL', 'alice' as never, 'admin', NOW)).toThrow(
      /members/,
    );
  });

  test('rejects > CMS_POOL_CAP_PER_TENANT', () => {
    const s = new InMemoryAssigneePoolStore();
    const tooMany = Array.from({ length: CMS_POOL_CAP_PER_TENANT + 1 }, (_, i) => `m-${i}`);
    expect(() => s.setMembers('BIL', tooMany, 'admin', NOW)).toThrow(
      /pool cap/,
    );
  });

  test('rejects duplicate members', () => {
    const s = new InMemoryAssigneePoolStore();
    expect(() => s.setMembers('BIL', ['alice', 'alice'], 'admin', NOW)).toThrow(
      /duplicate/,
    );
  });

  test('rejects empty string member', () => {
    const s = new InMemoryAssigneePoolStore();
    expect(() => s.setMembers('BIL', ['alice', ''], 'admin', NOW)).toThrow(
      /non-empty/,
    );
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryAssigneePoolStore();
    s.setMembers('BIL', ['alice'], 'admin', NOW);
    expect(s.get('BANK_DEMO').members).toEqual([]);
  });
});

// ─── findInactiveCases ───────────────────────────────────────────────

function mkCase(over: Partial<CmsCase> = {}): CmsCase {
  return {
    case_id: 'cs-1',
    case_number: 'EWS-2026-00001',
    tenant_id: 'BIL',
    title: 't',
    description: '',
    alert_id: null,
    status: 'OPEN',
    priority: 'P2',
    assigned_to: null,
    created_by: 'admin',
    sla_due_at: NOW.toISOString(),
    resolved_at: null,
    resolution_category: null,
    resolution_notes: '',
    tags: [],
    is_locked: false,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

describe('CMS-4 — findInactiveCases', () => {
  test('empty input → empty output', () => {
    expect(findInactiveCases([], NOW)).toEqual([]);
  });

  test('filters out CLOSED cases', () => {
    const closed = mkCase({
      status: 'CLOSED',
      updated_at: new Date(NOW.getTime() - 100 * 3_600_000).toISOString(),
    });
    expect(findInactiveCases([closed], NOW)).toEqual([]);
  });

  test('returns cases idle past threshold (default 48h)', () => {
    const fresh = mkCase({
      case_id: 'fresh',
      updated_at: new Date(NOW.getTime() - 24 * 3_600_000).toISOString(),
    });
    const stale = mkCase({
      case_id: 'stale',
      updated_at: new Date(NOW.getTime() - 60 * 3_600_000).toISOString(),
    });
    const out = findInactiveCases([fresh, stale], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.case_id).toBe('stale');
    expect(out[0]!.inactive_hours).toBeCloseTo(60, 0);
  });

  test('threshold_hours configurable', () => {
    const c = mkCase({
      updated_at: new Date(NOW.getTime() - 10 * 3_600_000).toISOString(),
    });
    expect(findInactiveCases([c], NOW, 8)).toHaveLength(1);
    expect(findInactiveCases([c], NOW, 24)).toHaveLength(0);
  });

  test('sorts longest-inactive first', () => {
    const a = mkCase({
      case_id: 'a',
      updated_at: new Date(NOW.getTime() - 50 * 3_600_000).toISOString(),
    });
    const b = mkCase({
      case_id: 'b',
      updated_at: new Date(NOW.getTime() - 100 * 3_600_000).toISOString(),
    });
    const out = findInactiveCases([a, b], NOW);
    expect(out.map((x) => x.case_id)).toEqual(['b', 'a']);
  });

  test('rejects bad threshold_hours', () => {
    expect(() => findInactiveCases([], NOW, 0)).toThrow(/threshold_hours/);
    expect(() => findInactiveCases([], NOW, 721)).toThrow(/threshold_hours/);
    expect(() => findInactiveCases([], NOW, 1.5)).toThrow(/threshold_hours/);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

function makeAutomationApp(role = 'admin') {
  const cmsCaseStore = new InMemoryCmsCaseStore();
  const cmsAssigneePoolStore = new InMemoryAssigneePoolStore();
  let nowVal = NOW;
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    cmsCaseStore,
    cmsAssigneePoolStore,
    now: () => nowVal,
    getRole: () => role,
  });
  return {
    ...built,
    cmsCaseStore,
    cmsAssigneePoolStore,
    setNow: (d: Date) => { nowVal = d; },
  };
}

describe('CMS-4 — POST /v1/cms/automation/auto-create-from-alert', () => {
  test('happy: 201 created=true', async () => {
    const { app } = makeAutomationApp('admin');
    const r = await request(app)
      .post('/v1/cms/automation/auto-create-from-alert')
      .set(TH_BIL)
      .send({ alert_id: 'alrt-1', alert_severity: 'RED', customer_id: 'cust-001' });
    expect(r.status).toBe(201);
    expect(r.body.body.created).toBe(true);
    expect(r.body.body.case.priority).toBe('P1');
  });

  test('idempotent: 200 created=false on re-fire', async () => {
    const { app } = makeAutomationApp('admin');
    await request(app)
      .post('/v1/cms/automation/auto-create-from-alert')
      .set(TH_BIL)
      .send({ alert_id: 'alrt-1', alert_severity: 'RED' });
    const r = await request(app)
      .post('/v1/cms/automation/auto-create-from-alert')
      .set(TH_BIL)
      .send({ alert_id: 'alrt-1', alert_severity: 'RED' });
    expect(r.status).toBe(200);
    expect(r.body.body.created).toBe(false);
    expect(r.body.body.matched_case_id).toBe(r.body.body.case.case_id);
  });

  test('with non-empty pool: case lands ASSIGNED to pool[0]', async () => {
    const { app, cmsAssigneePoolStore } = makeAutomationApp('admin');
    cmsAssigneePoolStore.setMembers('BIL', ['alice', 'bob'], 'admin', NOW);
    const r = await request(app)
      .post('/v1/cms/automation/auto-create-from-alert')
      .set(TH_BIL)
      .send({ alert_id: 'alrt-pool', alert_severity: 'RED' });
    expect(r.body.body.case.status).toBe('ASSIGNED');
    expect(r.body.body.case.assigned_to).toBe('alice');
  });

  test('bad severity → 400', async () => {
    const { app } = makeAutomationApp('admin');
    const r = await request(app)
      .post('/v1/cms/automation/auto-create-from-alert')
      .set(TH_BIL)
      .send({ alert_id: 'a', alert_severity: 'BLUE' });
    expect(r.status).toBe(400);
  });
});

describe('CMS-4 — GET/PUT /v1/cms/automation/pool', () => {
  test('GET empty pool', async () => {
    const { app } = makeAutomationApp('admin');
    const r = await request(app).get('/v1/cms/automation/pool').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.members).toEqual([]);
  });

  test('PUT replaces pool', async () => {
    const { app } = makeAutomationApp('admin');
    const r = await request(app)
      .put('/v1/cms/automation/pool')
      .set(TH_BIL)
      .send({ members: ['alice', 'bob'] });
    expect(r.status).toBe(200);
    expect(r.body.body.members).toEqual(['alice', 'bob']);
  });

  test('PUT > cap rejected', async () => {
    const { app } = makeAutomationApp('admin');
    const tooMany = Array.from({ length: CMS_POOL_CAP_PER_TENANT + 1 }, (_, i) => `m-${i}`);
    const r = await request(app)
      .put('/v1/cms/automation/pool')
      .set(TH_BIL)
      .send({ members: tooMany });
    expect(r.status).toBe(400);
  });

  test('PUT missing members → 400', async () => {
    const { app } = makeAutomationApp('admin');
    const r = await request(app).put('/v1/cms/automation/pool').set(TH_BIL).send({});
    expect(r.status).toBe(400);
  });
});

describe('CMS-4 — POST /v1/cms/cases/:id/assign-from-pool', () => {
  async function createCase(app: Parameters<typeof request>[0]) {
    const r = await request(app)
      .post('/v1/cms/cases')
      .set(TH_BIL)
      .send({ title: 't', priority: 'P2' });
    return r.body.body.case_id as string;
  }

  test('happy: rotates through pool', async () => {
    const { app, cmsAssigneePoolStore } = makeAutomationApp('admin');
    cmsAssigneePoolStore.setMembers('BIL', ['alice', 'bob', 'carol'], 'admin', NOW);
    const id = await createCase(app);
    const r1 = await request(app)
      .post(`/v1/cms/cases/${id}/assign-from-pool`)
      .set(TH_BIL);
    expect(r1.body.body.assigned_to).toBe('alice');
    const r2 = await request(app)
      .post(`/v1/cms/cases/${id}/assign-from-pool`)
      .set(TH_BIL);
    expect(r2.body.body.assigned_to).toBe('bob');
    const r3 = await request(app)
      .post(`/v1/cms/cases/${id}/assign-from-pool`)
      .set(TH_BIL);
    expect(r3.body.body.assigned_to).toBe('carol');
    const r4 = await request(app)
      .post(`/v1/cms/cases/${id}/assign-from-pool`)
      .set(TH_BIL);
    expect(r4.body.body.assigned_to).toBe('alice');
  });

  test('empty pool → 409', async () => {
    const { app } = makeAutomationApp('admin');
    const id = await createCase(app);
    const r = await request(app)
      .post(`/v1/cms/cases/${id}/assign-from-pool`)
      .set(TH_BIL);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_pool_empty');
  });

  test('unknown case → 404', async () => {
    const { app, cmsAssigneePoolStore } = makeAutomationApp('admin');
    cmsAssigneePoolStore.setMembers('BIL', ['alice'], 'admin', NOW);
    const r = await request(app)
      .post('/v1/cms/cases/no-such/assign-from-pool')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

describe('CMS-4 — GET /v1/cms/automation/inactive-cases', () => {
  async function createCase(app: Parameters<typeof request>[0]) {
    const r = await request(app)
      .post('/v1/cms/cases')
      .set(TH_BIL)
      .send({ title: 't', priority: 'P2' });
    return r.body.body.case_id as string;
  }

  test('empty when no stale cases', async () => {
    const { app } = makeAutomationApp('admin');
    await createCase(app);
    const r = await request(app)
      .get('/v1/cms/automation/inactive-cases')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(0);
  });

  test('lists cases past threshold', async () => {
    const { app, setNow } = makeAutomationApp('admin');
    await createCase(app);
    setNow(new Date(NOW.getTime() + 60 * 3600_000)); // 60h later
    const r = await request(app)
      .get('/v1/cms/automation/inactive-cases')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.threshold_hours).toBe(48);
  });

  test('?threshold_hours=8 narrower window', async () => {
    const { app, setNow } = makeAutomationApp('admin');
    await createCase(app);
    setNow(new Date(NOW.getTime() + 10 * 3600_000));
    const r = await request(app)
      .get('/v1/cms/automation/inactive-cases?threshold_hours=8')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('?threshold_hours=0 → 400', async () => {
    const { app } = makeAutomationApp('admin');
    const r = await request(app)
      .get('/v1/cms/automation/inactive-cases?threshold_hours=0')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });
});

describe('CMS-4 — error code surfaces', () => {
  test('CmsCaseError code preserved through autoCreate', () => {
    const store = new InMemoryCmsCaseStore();
    try {
      autoCreateCaseFromAlert(
        { alert_id: '', alert_severity: 'RED' },
        store,
        'BIL',
        [],
        'system',
        NOW,
      );
      fail('expected throw');
    } catch (e) {
      expect((e as CmsCaseError).code).toBe('invalid_input');
    }
  });
});
