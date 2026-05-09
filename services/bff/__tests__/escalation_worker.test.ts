// T6 M14.25 — escalation worker tests.
//
// Pure-helper tests use stub stores (Map-backed) so the suite runs
// hermetic without PG. Route tests wire makeApp() with the in-memory
// sibling stores from M14.16-18 + the in-memory dispatch log from
// M14.24.

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
  computeDueEscalations,
  dispatchDueEscalations,
  filterAlreadyDispatched,
  type OpenCaseRef,
} from '../src/admin/escalation_worker';
import type {
  CaseScenario,
  EscalationMatrixRule,
  NotificationTemplate,
} from '../src/admin/case_scenarios_types';

const NOW = new Date('2026-05-09T12:00:00.000Z');
const ACTOR = { actor_id: 'alice.admin' };
const TENANT = 'BIL';
const TH_BIL = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API' };

// ─── Pure helpers — stub-backed ─────────────────────────────────────

function mkRule(over: Partial<EscalationMatrixRule> = {}): EscalationMatrixRule {
  const ts = NOW.toISOString();
  return {
    escalation_id: randomUUID(),
    tenant_id: TENANT,
    name: 'Fraud P1 fast',
    case_category: 'fraud',
    priority: 'P1',
    level_1_after_minutes: 15,
    level_1_role: 'supervisor',
    level_2_after_minutes: 60,
    level_2_role: 'risk_analyst',
    level_3_after_minutes: 240,
    level_3_role: 'admin',
    status: 'ACTIVE',
    created_by: 'system:seed',
    updated_by: null,
    created_at: ts,
    updated_at: ts,
    ...over,
  };
}
function mkTpl(over: Partial<NotificationTemplate> = {}): NotificationTemplate {
  const ts = NOW.toISOString();
  return {
    template_id: randomUUID(),
    tenant_id: TENANT,
    name: 'Escalation alert',
    channel: 'EMAIL',
    subject: 'Case {{case_id}} escalated to L{{escalation_level}} ({{escalation_role}})',
    body: 'Case {{case_id}} ({{priority}} {{case_category}}) age {{case_age_minutes}}m hit L{{escalation_level}} → {{escalation_role}}',
    locale: 'en-IN',
    status: 'ACTIVE',
    created_by: 'system:seed',
    updated_by: null,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    ...over,
  };
}
function mkScenario(escalation_id: string, template_id: string | null, over: Partial<CaseScenario> = {}): CaseScenario {
  const ts = NOW.toISOString();
  return {
    scenario_id: randomUUID(),
    tenant_id: TENANT,
    name: 'Fraud P1 scenario',
    case_category: 'fraud',
    priority: 'P1',
    trigger_indicator_id: null,
    trigger_threshold: null,
    default_escalation_id: escalation_id,
    notification_template_id: template_id,
    checklist: [],
    status: 'ACTIVE',
    created_by: 'system:seed',
    updated_by: null,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    ...over,
  };
}
function ageOpenedAt(minutesAgo: number): string {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
}
const mkCase = (id: string, ageMin: number, over: Partial<OpenCaseRef> = {}): OpenCaseRef => ({
  case_id: id,
  case_category: 'fraud',
  priority: 'P1',
  opened_at: ageOpenedAt(ageMin),
  ...over,
});

describe('computeDueEscalations (M14.25)', () => {
  it('emits L1 only when only L1 window is met', async () => {
    const rule = mkRule({});
    const tpl = mkTpl();
    const scenario = mkScenario(rule.escalation_id, tpl.template_id);
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('c-1', 30)], // 30m old → L1 (15m) yes, L2 (60m) no, L3 no
      [scenario],
      async (id) => (id === rule.escalation_id ? rule : null),
      async (id) => (id === tpl.template_id ? tpl : null),
      NOW,
    );
    expect(out.due.map((d) => d.level)).toEqual([1]);
    expect(out.due[0]!.role).toBe('supervisor');
    expect(out.due[0]!.case_age_minutes).toBe(30);
  });

  it('emits L1+L2 when both windows met but L3 not yet', async () => {
    const rule = mkRule();
    const tpl = mkTpl();
    const scenario = mkScenario(rule.escalation_id, tpl.template_id);
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('c-1', 90)], // L1 yes (15), L2 yes (60), L3 no (240)
      [scenario],
      async () => rule,
      async () => tpl,
      NOW,
    );
    expect(out.due.map((d) => d.level).sort()).toEqual([1, 2]);
  });

  it('emits L1+L2+L3 when all windows met', async () => {
    const rule = mkRule();
    const tpl = mkTpl();
    const scenario = mkScenario(rule.escalation_id, tpl.template_id);
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('c-1', 300)],
      [scenario],
      async () => rule,
      async () => tpl,
      NOW,
    );
    expect(out.due.map((d) => d.level).sort()).toEqual([1, 2, 3]);
  });

  it('rendered subject + body contain substituted vars', async () => {
    const rule = mkRule();
    const tpl = mkTpl();
    const scenario = mkScenario(rule.escalation_id, tpl.template_id);
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('CASE-001', 30)],
      [scenario],
      async () => rule,
      async () => tpl,
      NOW,
    );
    expect(out.due[0]!.rendered_subject).toContain('CASE-001');
    expect(out.due[0]!.rendered_subject).toContain('L1');
    expect(out.due[0]!.rendered_subject).toContain('supervisor');
    expect(out.due[0]!.rendered_body).toContain('30m');
  });

  it('emits nothing when no scenario matches (case_category, priority)', async () => {
    const rule = mkRule();
    const tpl = mkTpl();
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('c-1', 30, { case_category: 'unknown' })],
      [mkScenario(rule.escalation_id, tpl.template_id)],
      async () => rule,
      async () => tpl,
      NOW,
    );
    expect(out.due).toEqual([]);
    expect(out.cases_with_no_scenario).toBe(1);
  });

  it('skips cases when the matched scenario points at an ARCHIVED escalation rule', async () => {
    const rule = mkRule({ status: 'ARCHIVED' });
    const tpl = mkTpl();
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('c-1', 30)],
      [mkScenario(rule.escalation_id, tpl.template_id)],
      async () => rule,
      async () => tpl,
      NOW,
    );
    expect(out.due).toEqual([]);
    expect(out.cases_with_archived_escalation).toBe(1);
  });

  it('skips L3 when level_3 columns are null (single-level rule)', async () => {
    const rule = mkRule({
      level_2_after_minutes: null,
      level_2_role: null,
      level_3_after_minutes: null,
      level_3_role: null,
    });
    const tpl = mkTpl();
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('c-1', 1000)], // very old
      [mkScenario(rule.escalation_id, tpl.template_id)],
      async () => rule,
      async () => tpl,
      NOW,
    );
    expect(out.due.map((d) => d.level)).toEqual([1]);
  });

  it('falls back to no-template placeholder when scenario has no template', async () => {
    const rule = mkRule();
    const scenario = mkScenario(rule.escalation_id, null);
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('c-1', 30)],
      [scenario],
      async () => rule,
      async () => null,
      NOW,
    );
    expect(out.due.length).toBe(1);
    expect(out.due[0]!.template_id).toBeNull();
    expect(out.due[0]!.template_name).toBe('(no template)');
    expect(out.due[0]!.channel).toBe('IN_APP');
    // Placeholder satisfies the channel ↔ subject CHECK (IN_APP → non-null subject)
    expect(out.due[0]!.rendered_subject).not.toBeNull();
    expect(out.due[0]!.rendered_body).toContain('c-1'); // case_id present in placeholder
  });

  it('falls back to placeholder when template was archived after scenario was wired', async () => {
    const rule = mkRule();
    const tpl = mkTpl({ status: 'ARCHIVED', deleted_at: NOW.toISOString() });
    const scenario = mkScenario(rule.escalation_id, tpl.template_id);
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('c-1', 30)],
      [scenario],
      async () => rule,
      async () => tpl,
      NOW,
    );
    expect(out.due[0]!.template_id).toBeNull(); // signals template was unusable
  });

  it('newest ACTIVE scenario wins when multiple match (case_category, priority)', async () => {
    const rule = mkRule();
    const tpl = mkTpl();
    const oldScenario = mkScenario(rule.escalation_id, tpl.template_id, {
      name: 'old', updated_at: '2026-01-01T00:00:00Z',
    });
    const newScenario = mkScenario(rule.escalation_id, tpl.template_id, {
      name: 'new', updated_at: '2026-05-01T00:00:00Z',
    });
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('c-1', 30)],
      [oldScenario, newScenario],
      async () => rule,
      async () => tpl,
      NOW,
    );
    expect(out.due[0]!.scenario_id).toBe(newScenario.scenario_id);
  });

  it('case context_vars merge into render context', async () => {
    const rule = mkRule();
    const tpl = mkTpl({ body: 'Hello {{customer_name}} re case {{case_id}}' });
    const scenario = mkScenario(rule.escalation_id, tpl.template_id);
    const out = await computeDueEscalations(
      TENANT,
      [mkCase('c-1', 30, { context_vars: { customer_name: 'Alice' } })],
      [scenario],
      async () => rule,
      async () => tpl,
      NOW,
    );
    expect(out.due[0]!.rendered_body).toContain('Alice');
  });
});

describe('filterAlreadyDispatched + dispatchDueEscalations idempotency (M14.25)', () => {
  it('first call dispatches; second call dispatches nothing (already-fired filter)', async () => {
    const rule = mkRule();
    const tpl = mkTpl();
    const scenario = mkScenario(rule.escalation_id, tpl.template_id);
    const dispatchStore = new InMemoryNotificationDispatchStore();

    const tick = async () => {
      const out = await computeDueEscalations(
        TENANT,
        [mkCase('c-A', 90)], // L1 + L2 due
        [scenario],
        async () => rule,
        async () => tpl,
        NOW,
      );
      const fresh = await filterAlreadyDispatched(TENANT, out.due, dispatchStore);
      const dispatched = await dispatchDueEscalations(TENANT, fresh, dispatchStore, NOW, 'system:test');
      return { computed: out.due.length, dispatched: dispatched.length };
    };

    const t1 = await tick();
    expect(t1).toEqual({ computed: 2, dispatched: 2 });
    const t2 = await tick();
    expect(t2).toEqual({ computed: 2, dispatched: 0 }); // both levels already fired
  });

  it('dispatches new levels as the case ages past more thresholds', async () => {
    const rule = mkRule();
    const tpl = mkTpl();
    const scenario = mkScenario(rule.escalation_id, tpl.template_id);
    const dispatchStore = new InMemoryNotificationDispatchStore();

    // First tick at 30m → only L1 fires
    const at30 = new Date(NOW.getTime());
    const out1 = await computeDueEscalations(
      TENANT,
      [{ case_id: 'c-1', case_category: 'fraud', priority: 'P1', opened_at: ageOpenedAt(30) }],
      [scenario],
      async () => rule,
      async () => tpl,
      at30,
    );
    const fresh1 = await filterAlreadyDispatched(TENANT, out1.due, dispatchStore);
    await dispatchDueEscalations(TENANT, fresh1, dispatchStore, at30, 'system:test');
    expect(fresh1.length).toBe(1);

    // Second tick when the case is 90m old → L2 NEW (L1 already fired)
    const at90 = new Date(at30.getTime());
    const out2 = await computeDueEscalations(
      TENANT,
      [{ case_id: 'c-1', case_category: 'fraud', priority: 'P1', opened_at: ageOpenedAt(90) }],
      [scenario],
      async () => rule,
      async () => tpl,
      at90,
    );
    const fresh2 = await filterAlreadyDispatched(TENANT, out2.due, dispatchStore);
    expect(fresh2.length).toBe(1);
    expect(fresh2[0]!.level).toBe(2);
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

async function makeAppWithStores(role = 'admin') {
  // Build the full store quartet so the worker mounts.
  const tplStore = new InMemoryNotificationTemplateStore();
  const escStore = new InMemoryEscalationMatrixStore();
  const dispatchStore = new InMemoryNotificationDispatchStore();
  // Seed one template + one matrix rule + one scenario tied together.
  const tplInput = validateTplCreate({
    name: 'Esc test tpl',
    channel: 'EMAIL',
    subject: 'Case {{case_id}} → L{{escalation_level}}',
    body: 'Case {{case_id}} ({{priority}} {{case_category}}) escalated to {{escalation_role}}',
  });
  const tplDraft = await tplStore.create(TENANT, tplInput, ACTOR, NOW);
  // Activate so the worker considers it eligible (DRAFT templates are
  // skipped — same rule as the BFF's case_scenarios FK validator).
  const tpl = await tplStore.activate(TENANT, tplDraft.template_id, ACTOR, NOW);
  const escInput = validateEscCreate({
    name: 'Esc test rule',
    case_category: 'fraud',
    priority: 'P1',
    level_1_after_minutes: 15,
    level_1_role: 'supervisor',
    level_2_after_minutes: 60,
    level_2_role: 'risk_analyst',
  });
  const rule = await escStore.create(TENANT, escInput, ACTOR, NOW);
  const fkDeps: CaseScenarioStoreDeps = {
    resolveEscalation: async (tenant, id) => {
      const r = await escStore.get(tenant, id);
      return r ? { status: r.status } : null;
    },
    resolveTemplate: async (tenant, id) => {
      const r = await tplStore.get(tenant, id);
      return r ? { status: r.status, deleted_at: r.deleted_at } : null;
    },
  };
  const scenarioStore = new InMemoryCaseScenarioStore(fkDeps);
  const scInput = validateScenarioCreate({
    name: 'Esc test scenario',
    case_category: 'fraud',
    priority: 'P1',
    default_escalation_id: rule.escalation_id,
    notification_template_id: tpl.template_id,
  });
  const sc = await scenarioStore.create(TENANT, scInput, ACTOR, NOW);
  // Activate scenario so the worker matches it.
  await scenarioStore.activate(TENANT, sc.scenario_id, ACTOR, NOW);

  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseScenarioStore: scenarioStore,
    escalationMatrixStore: escStore,
    notificationTemplateStore: tplStore,
    notificationDispatchStore: dispatchStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, tplStore, escStore, scenarioStore, dispatchStore };
}

describe('POST /v1/admin/escalations/preview (M14.25)', () => {
  test('happy: returns due[] with rendered subject/body, no dispatch', async () => {
    const { app, dispatchStore } = await makeAppWithStores();
    const r = await request(app)
      .post('/v1/admin/escalations/preview')
      .set(TH_BIL)
      .send({
        open_cases: [
          { case_id: 'C-001', case_category: 'fraud', priority: 'P1', opened_at: ageOpenedAt(90) },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.due.length).toBe(2); // L1 + L2 (we didn't seed L3)
    expect(r.body.body.due[0].rendered_subject).toContain('C-001');
    // Preview must NOT log
    const log = await dispatchStore.list(TENANT, {});
    expect(log.total).toBe(0);
  });

  test('400 on bad open_cases shape', async () => {
    const { app } = await makeAppWithStores();
    const r = await request(app)
      .post('/v1/admin/escalations/preview')
      .set(TH_BIL)
      .send({ open_cases: [{ case_id: 'X', priority: 'PX' }] });
    expect(r.status).toBe(400);
  });

  test('cases_inspected + cases_with_no_scenario diagnostics work', async () => {
    const { app } = await makeAppWithStores();
    const r = await request(app)
      .post('/v1/admin/escalations/preview')
      .set(TH_BIL)
      .send({
        open_cases: [
          { case_id: 'A', case_category: 'fraud', priority: 'P1', opened_at: ageOpenedAt(90) },
          { case_id: 'B', case_category: 'unmatched', priority: 'P1', opened_at: ageOpenedAt(90) },
        ],
      });
    expect(r.body.body.cases_inspected).toBe(2);
    expect(r.body.body.cases_with_no_scenario).toBe(1);
  });

  test('supervisor can preview', async () => {
    const { app } = await makeAppWithStores('supervisor');
    const r = await request(app)
      .post('/v1/admin/escalations/preview')
      .set(TH_BIL)
      .send({ open_cases: [] });
    expect(r.status).toBe(200);
  });

  test('case_owner role → 403 on preview', async () => {
    const { app } = await makeAppWithStores('case_owner');
    const r = await request(app)
      .post('/v1/admin/escalations/preview')
      .set(TH_BIL)
      .send({ open_cases: [] });
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/admin/escalations/tick (M14.25)', () => {
  test('dispatches due levels + appends one log entry per level', async () => {
    const { app, dispatchStore } = await makeAppWithStores();
    const r = await request(app)
      .post('/v1/admin/escalations/tick')
      .set({ ...TH_BIL, 'x-apex-user': 'alice.admin' })
      .send({
        open_cases: [
          { case_id: 'C-001', case_category: 'fraud', priority: 'P1', opened_at: ageOpenedAt(90) },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.dispatched.length).toBe(2);
    const log = await dispatchStore.list(TENANT, { trigger: 'escalation_worker' });
    expect(log.total).toBe(2);
    // References use the case:<id>:lvl:<n> convention.
    expect(log.items.map((e) => e.reference).sort()).toEqual([
      'case:C-001:lvl:1',
      'case:C-001:lvl:2',
    ]);
    // performed_by came from x-apex-user
    expect(log.items[0]!.performed_by).toBe('alice.admin');
  });

  test('idempotent: second tick at the same time dispatches 0', async () => {
    const { app } = await makeAppWithStores();
    const cases = [{ case_id: 'C-002', case_category: 'fraud', priority: 'P1', opened_at: ageOpenedAt(90) }];
    const t1 = await request(app).post('/v1/admin/escalations/tick').set(TH_BIL).send({ open_cases: cases });
    expect(t1.body.body.dispatched.length).toBe(2);
    const t2 = await request(app).post('/v1/admin/escalations/tick').set(TH_BIL).send({ open_cases: cases });
    expect(t2.body.body.dispatched.length).toBe(0);
    expect(t2.body.body.already_dispatched_count).toBe(2);
  });

  test('supervisor → 403 on tick (mutation, admin-only)', async () => {
    const { app } = await makeAppWithStores('supervisor');
    const r = await request(app)
      .post('/v1/admin/escalations/tick')
      .set(TH_BIL)
      .send({ open_cases: [] });
    expect(r.status).toBe(403);
  });
});
