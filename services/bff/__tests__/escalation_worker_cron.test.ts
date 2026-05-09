// T6 M14.25b — escalation worker cron tests.
//
// Cron logic is tested with an injected scheduler stub so real timers
// don't fire (no flakes from setInterval timing). The CmsCaseSourceFromStore
// adapter gets its own focused tests against a stub CmsCaseStore.list().

import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  InMemoryNotificationTemplateStore,
  validateCreate as validateTplCreate,
} from '../src/admin/notification_templates_store';
import {
  InMemoryEscalationMatrixStore,
  validateCreate as validateEscCreate,
} from '../src/admin/escalation_matrix_store';
import {
  InMemoryCaseScenarioStore,
  validateCreate as validateScenarioCreate,
  type CaseScenarioStoreDeps,
} from '../src/admin/case_scenarios_store';
import { InMemoryNotificationDispatchStore } from '../src/admin/notification_dispatch_store';
import {
  CmsCaseSourceFromMemory,
  CmsCaseSourceFromStore,
  EscalationWorkerCron,
  type CmsCaseRow,
  type OpenCaseRef,
} from '../src/admin/escalation_worker';

const NOW = new Date('2026-05-09T12:00:00.000Z');
const ACTOR = { actor_id: 'alice.admin' };
const TENANT = 'BIL';
const TH_BIL = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API' };

function ageOpenedAt(minutesAgo: number): string {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
}

// Build the standard quartet (template + matrix + scenario + dispatch
// log) the cron + routes need.
async function makeStores() {
  const tplStore = new InMemoryNotificationTemplateStore();
  const escStore = new InMemoryEscalationMatrixStore();
  const dispatchStore = new InMemoryNotificationDispatchStore();

  const tplDraft = await tplStore.create(
    TENANT,
    validateTplCreate({
      name: 'Cron tpl',
      channel: 'EMAIL',
      subject: 'Case {{case_id}} → L{{escalation_level}}',
      body: 'Case {{case_id}} ({{priority}} {{case_category}}) escalated to {{escalation_role}}',
    }),
    ACTOR,
    NOW,
  );
  const tpl = await tplStore.activate(TENANT, tplDraft.template_id, ACTOR, NOW);

  const rule = await escStore.create(
    TENANT,
    validateEscCreate({
      name: 'Cron esc rule',
      case_category: 'fraud',
      priority: 'P1',
      level_1_after_minutes: 15,
      level_1_role: 'supervisor',
      level_2_after_minutes: 60,
      level_2_role: 'risk_analyst',
    }),
    ACTOR,
    NOW,
  );

  const fkDeps: CaseScenarioStoreDeps = {
    resolveEscalation: async (tid, id) => {
      const r = await escStore.get(tid, id);
      return r ? { status: r.status } : null;
    },
    resolveTemplate: async (tid, id) => {
      const r = await tplStore.get(tid, id);
      return r ? { status: r.status, deleted_at: r.deleted_at } : null;
    },
  };
  const scenarioStore = new InMemoryCaseScenarioStore(fkDeps);
  const sc = await scenarioStore.create(
    TENANT,
    validateScenarioCreate({
      name: 'Cron scenario',
      case_category: 'fraud',
      priority: 'P1',
      default_escalation_id: rule.escalation_id,
      notification_template_id: tpl.template_id,
    }),
    ACTOR,
    NOW,
  );
  await scenarioStore.activate(TENANT, sc.scenario_id, ACTOR, NOW);

  return {
    templateStore: tplStore,
    escalationMatrixStore: escStore,
    scenarioStore,
    dispatchStore,
  };
}

const mkOpenCase = (id: string, ageMin: number, over: Partial<OpenCaseRef> = {}): OpenCaseRef => ({
  case_id: id,
  case_category: 'fraud',
  priority: 'P1',
  opened_at: ageOpenedAt(ageMin),
  ...over,
});

// ─── CmsCaseSourceFromStore adapter ─────────────────────────────────

describe('CmsCaseSourceFromStore (M14.25b)', () => {
  it('maps every open status into OpenCaseRef and skips CLOSED', async () => {
    const calls: string[] = [];
    const stubStore = {
      list: (tenant_id: string, filter: { status?: string }) => {
        calls.push(`${tenant_id}:${filter.status}`);
        // Return one row per status the source iterates.
        if (filter.status === 'OPEN')
          return [{ case_id: 'c-open', case_category: 'fraud', priority: 'P1', created_at: NOW.toISOString() } as CmsCaseRow];
        if (filter.status === 'ASSIGNED')
          return [{ case_id: 'c-assigned', case_category: 'kyc', priority: 'P3', created_at: NOW.toISOString() } as CmsCaseRow];
        if (filter.status === 'INVESTIGATING')
          return [{ case_id: 'c-inv', case_category: 'fraud', priority: 'P2', created_at: NOW.toISOString() } as CmsCaseRow];
        if (filter.status === 'PENDING_APPROVAL')
          return [{ case_id: 'c-pend', case_category: 'fraud', priority: 'P1', created_at: NOW.toISOString() } as CmsCaseRow];
        return [];
      },
    };
    const src = new CmsCaseSourceFromStore(stubStore);
    const out = await src.listOpen(TENANT);
    expect(out.map((c) => c.case_id).sort()).toEqual([
      'c-assigned', 'c-inv', 'c-open', 'c-pend',
    ]);
    // Calls are made for the 4 open states only — CLOSED is omitted
    expect(calls).toEqual([
      `${TENANT}:OPEN`,
      `${TENANT}:ASSIGNED`,
      `${TENANT}:INVESTIGATING`,
      `${TENANT}:PENDING_APPROVAL`,
    ]);
  });

  it('null case_category falls back to default_fallback', async () => {
    const stubStore = {
      list: (_tid: string, f: { status?: string }) =>
        f.status === 'OPEN'
          ? [{ case_id: 'c-1', case_category: null, priority: 'P1', created_at: NOW.toISOString() } as CmsCaseRow]
          : [],
    };
    const src = new CmsCaseSourceFromStore(stubStore);
    const out = await src.listOpen(TENANT);
    expect(out[0]!.case_category).toBe('default_fallback');
  });

  it('passes customer_id + title into context_vars when present', async () => {
    const stubStore = {
      list: (_tid: string, f: { status?: string }) =>
        f.status === 'OPEN'
          ? [{
              case_id: 'c-ctx',
              case_category: 'fraud',
              priority: 'P1',
              created_at: NOW.toISOString(),
              customer_id: 'cust-7',
              title: 'High-value fraud',
            } as CmsCaseRow]
          : [],
    };
    const src = new CmsCaseSourceFromStore(stubStore);
    const out = await src.listOpen(TENANT);
    expect(out[0]!.context_vars).toEqual({ customer_id: 'cust-7', case_title: 'High-value fraud' });
  });
});

// ─── EscalationWorkerCron behaviour ─────────────────────────────────

describe('EscalationWorkerCron — runTick (M14.25b)', () => {
  it('dispatches due levels on first tick + 0 on second tick (idempotency)', async () => {
    const stores = await makeStores();
    const cases: OpenCaseRef[] = [mkOpenCase('CRON-001', 90)];
    const cron = new EscalationWorkerCron({
      ...stores,
      caseSource: new CmsCaseSourceFromMemory({ [TENANT]: cases }),
      tenants: [TENANT],
      intervalMs: 60_000,
      now: () => NOW,
    });
    const t1 = await cron.runTick();
    expect(t1).toEqual({ tenants: 1, dispatched: 2, inspected: 1 }); // L1 + L2
    const t2 = await cron.runTick();
    expect(t2.dispatched).toBe(0); // already-dispatched filter
    const log = await stores.dispatchStore.list(TENANT, { trigger: 'escalation_worker' });
    expect(log.total).toBe(2);
  });

  it('iterates multiple tenants in one tick + isolates per-tenant errors', async () => {
    const stores = await makeStores();
    const failingSource = {
      listOpen: async (tenant_id: string) => {
        if (tenant_id === 'BAD') throw new Error('source blew up');
        return [mkOpenCase('OK-001', 90)];
      },
    };
    const cron = new EscalationWorkerCron({
      ...stores,
      caseSource: failingSource,
      tenants: [TENANT, 'BAD', 'GOOD_BUT_NO_DATA'],
      intervalMs: 60_000,
      now: () => NOW,
    });
    const t = await cron.runTick();
    expect(t.tenants).toBe(3);
    // The BIL source returned OK-001 (1 case → L1 + L2 = 2 dispatches).
    // GOOD_BUT_NO_DATA also returned OK-001 since the stub doesn't
    // discriminate on tenant — same case dispatched once per tenant
    // (different reference because dispatch log is tenant-scoped).
    expect(t.dispatched).toBeGreaterThanOrEqual(2);
    expect(cron.status().last_error).toMatch(/BAD: source blew up/);
  });

  it('single-flight: re-entrant runTick returns zeroes', async () => {
    const stores = await makeStores();
    let resolveSource: (v: OpenCaseRef[]) => void = () => {};
    const slowSource = {
      listOpen: () =>
        new Promise<OpenCaseRef[]>((resolve) => {
          resolveSource = resolve;
        }),
    };
    const cron = new EscalationWorkerCron({
      ...stores,
      caseSource: slowSource,
      tenants: [TENANT],
      intervalMs: 60_000,
      now: () => NOW,
    });
    const first = cron.runTick();
    const second = await cron.runTick();
    expect(second).toEqual({ tenants: 0, dispatched: 0, inspected: 0 });
    resolveSource([]);
    await first;
  });

  it('status() reflects last_run_at + last_run_dispatched + total_runs', async () => {
    const stores = await makeStores();
    const cron = new EscalationWorkerCron({
      ...stores,
      caseSource: new CmsCaseSourceFromMemory({ [TENANT]: [mkOpenCase('S-1', 90)] }),
      tenants: [TENANT],
      intervalMs: 60_000,
      now: () => NOW,
    });
    expect(cron.status().total_runs).toBe(0);
    expect(cron.status().last_run_at).toBeNull();
    await cron.runTick();
    const s1 = cron.status();
    expect(s1.total_runs).toBe(1);
    expect(s1.last_run_at).toBe(NOW.toISOString());
    expect(s1.last_run_dispatched).toBe(2);
    expect(s1.last_run_inspected).toBe(1);
    expect(s1.last_error).toBeNull();
    await cron.runTick();
    expect(cron.status().total_runs).toBe(2);
  });

  it('start() schedules via injected scheduler; stop() clears it', async () => {
    const stores = await makeStores();
    const intervals: Array<{ ms: number; cb: () => void }> = [];
    const handles: unknown[] = [];
    const sched = {
      setInterval: (cb: () => void, ms: number) => {
        intervals.push({ ms, cb });
        const h = { _id: intervals.length };
        handles.push(h);
        return h;
      },
      clearInterval: (h: unknown) => {
        const idx = handles.indexOf(h);
        if (idx >= 0) handles.splice(idx, 1);
      },
    };
    const cron = new EscalationWorkerCron({
      ...stores,
      caseSource: new CmsCaseSourceFromMemory({}),
      tenants: [TENANT],
      intervalMs: 5_000,
      now: () => NOW,
      scheduler: sched,
    });
    expect(cron.status().running).toBe(false);
    cron.start();
    expect(intervals.length).toBe(1);
    expect(intervals[0]!.ms).toBe(5_000);
    expect(cron.status().running).toBe(true);
    expect(handles.length).toBe(1);
    cron.stop();
    expect(handles.length).toBe(0);
    expect(cron.status().running).toBe(false);
  });

  it('start() is idempotent (second call does not double-schedule)', async () => {
    const stores = await makeStores();
    const intervals: Array<{ ms: number; cb: () => void }> = [];
    const sched = {
      setInterval: (cb: () => void, ms: number) => {
        intervals.push({ ms, cb });
        return { _id: intervals.length };
      },
      clearInterval: () => {},
    };
    const cron = new EscalationWorkerCron({
      ...stores,
      caseSource: new CmsCaseSourceFromMemory({}),
      tenants: [TENANT],
      intervalMs: 5_000,
      now: () => NOW,
      scheduler: sched,
    });
    cron.start();
    cron.start();
    cron.start();
    expect(intervals.length).toBe(1);
    cron.stop();
  });
});

// ─── GET /v1/admin/escalations/worker/status route ──────────────────

describe('GET /v1/admin/escalations/worker/status (M14.25b)', () => {
  test('reports cron_wired=false when no cron is in deps', async () => {
    const stores = await makeStores();
    const built = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      caseScenarioStore: stores.scenarioStore,
      escalationMatrixStore: stores.escalationMatrixStore,
      notificationTemplateStore: stores.templateStore,
      notificationDispatchStore: stores.dispatchStore,
      now: () => NOW,
      getRole: () => 'admin',
    });
    const r = await request(built.app)
      .get('/v1/admin/escalations/worker/status')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.cron_wired).toBe(false);
    expect(r.body.body.running).toBe(false);
  });

  test('reports live status when a cron is wired', async () => {
    const stores = await makeStores();
    const cron = new EscalationWorkerCron({
      ...stores,
      caseSource: new CmsCaseSourceFromMemory({ [TENANT]: [mkOpenCase('STATUS-1', 90)] }),
      tenants: [TENANT],
      intervalMs: 30_000,
      now: () => NOW,
    });
    await cron.runTick();
    const built = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      caseScenarioStore: stores.scenarioStore,
      escalationMatrixStore: stores.escalationMatrixStore,
      notificationTemplateStore: stores.templateStore,
      notificationDispatchStore: stores.dispatchStore,
      escalationWorkerCron: cron,
      now: () => NOW,
      getRole: () => 'admin',
    });
    const r = await request(built.app)
      .get('/v1/admin/escalations/worker/status')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.cron_wired).toBe(true);
    expect(r.body.body.total_runs).toBe(1);
    expect(r.body.body.last_run_dispatched).toBe(2);
    expect(r.body.body.tenants).toEqual([TENANT]);
    expect(r.body.body.interval_ms).toBe(30_000);
  });

  test('case_owner role → 403', async () => {
    const stores = await makeStores();
    const built = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      caseScenarioStore: stores.scenarioStore,
      escalationMatrixStore: stores.escalationMatrixStore,
      notificationTemplateStore: stores.templateStore,
      notificationDispatchStore: stores.dispatchStore,
      now: () => NOW,
      getRole: () => 'case_owner',
    });
    const r = await request(built.app)
      .get('/v1/admin/escalations/worker/status')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
