// services/bff/__tests__/investigation_step_progress.test.ts
//
// T6 M9.9 — Investigation step progress.

import request from 'supertest';
import {
  summariseInvestigationSteps,
  listInvestigationStepBacklog,
} from '../src/investigation_step_progress';
import {
  InMemoryCaseInvestigationStore,
  type InvestigationStep,
  type CaseInvestigation,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkStep(o: Partial<InvestigationStep> & { step_id: string }): InvestigationStep {
  return {
    step_id: o.step_id,
    name: o.name ?? `Step ${o.step_id}`,
    description: o.description ?? 'step desc',
    completed: o.completed ?? false,
    completed_at: o.completed_at ?? null,
    completed_by: o.completed_by ?? null,
    evidence_link: o.evidence_link ?? null,
  };
}

function mkInv(o: Partial<CaseInvestigation> & { investigation_id: string; case_id: string; steps: InvestigationStep[] }): CaseInvestigation {
  return {
    investigation_id: o.investigation_id,
    tenant_id: o.tenant_id ?? 'BIL',
    case_id: o.case_id,
    customer_id: o.customer_id ?? 'cust-1',
    status: o.status ?? 'triage',
    decision: o.decision ?? null,
    opened_at: o.opened_at ?? '2026-05-14T00:00:00.000Z',
    opened_by: o.opened_by ?? 'alice',
    last_updated_at: o.last_updated_at ?? '2026-05-14T00:00:00.000Z',
    last_updated_by: o.last_updated_by ?? 'alice',
    closed_at: o.closed_at ?? null,
    steps: o.steps,
    notes_count: o.notes_count ?? 0,
    checklist_template_id: o.checklist_template_id ?? 'BUILT_IN',
  };
}

// ─── summariseInvestigationSteps — pure ──────────────────────────────

describe('M9.9 — empty steps', () => {
  test('investigation with zero steps → 0 counts, null oldest_pending', () => {
    const inv = mkInv({ investigation_id: 'i1', case_id: 'C1', steps: [] });
    const out = summariseInvestigationSteps(inv);
    expect(out.total_steps).toBe(0);
    expect(out.completed_count).toBe(0);
    expect(out.pending_count).toBe(0);
    expect(out.completion_rate).toBe(0);
    expect(out.oldest_pending_step).toBeNull();
    expect(out.recent_completions).toEqual([]);
  });
});

describe('M9.9 — all pending', () => {
  test('zero completions → completion_rate=0, first step is oldest_pending', () => {
    const inv = mkInv({
      investigation_id: 'i1',
      case_id: 'C1',
      steps: [
        mkStep({ step_id: 'verify_identity', name: 'Verify identity' }),
        mkStep({ step_id: 'pull_policy_history' }),
        mkStep({ step_id: 'aml_screen' }),
      ],
    });
    const out = summariseInvestigationSteps(inv);
    expect(out.total_steps).toBe(3);
    expect(out.completed_count).toBe(0);
    expect(out.pending_count).toBe(3);
    expect(out.completion_rate).toBe(0);
    expect(out.oldest_pending_step!.step_id).toBe('verify_identity');
    expect(out.oldest_pending_step!.name).toBe('Verify identity');
  });
});

describe('M9.9 — mixed completion', () => {
  test('first step done, second pending → oldest_pending=second', () => {
    const inv = mkInv({
      investigation_id: 'i1',
      case_id: 'C1',
      steps: [
        mkStep({ step_id: 's1', completed: true, completed_at: '2026-05-14T08:00:00Z', completed_by: 'alice' }),
        mkStep({ step_id: 's2' }),
        mkStep({ step_id: 's3' }),
      ],
    });
    const out = summariseInvestigationSteps(inv);
    expect(out.completed_count).toBe(1);
    expect(out.pending_count).toBe(2);
    expect(out.completion_rate).toBeCloseTo(1 / 3, 5);
    expect(out.oldest_pending_step!.step_id).toBe('s2');
  });
});

describe('M9.9 — all completed', () => {
  test('every step done → oldest_pending_step=null', () => {
    const inv = mkInv({
      investigation_id: 'i1',
      case_id: 'C1',
      steps: [
        mkStep({ step_id: 's1', completed: true, completed_at: '2026-05-14T08:00:00Z' }),
        mkStep({ step_id: 's2', completed: true, completed_at: '2026-05-14T09:00:00Z' }),
      ],
    });
    const out = summariseInvestigationSteps(inv);
    expect(out.completion_rate).toBe(1);
    expect(out.oldest_pending_step).toBeNull();
  });
});

describe('M9.9 — recent_completions ordering', () => {
  test('newest-first, capped at 5', () => {
    const steps: InvestigationStep[] = [];
    for (let i = 1; i <= 7; i += 1) {
      steps.push(
        mkStep({
          step_id: `s${i}`,
          completed: true,
          completed_at: `2026-05-14T0${i}:00:00.000Z`,
          completed_by: 'alice',
        }),
      );
    }
    const inv = mkInv({ investigation_id: 'i1', case_id: 'C1', steps });
    const out = summariseInvestigationSteps(inv);
    expect(out.recent_completions).toHaveLength(5);
    // First entry should be the newest (s7).
    expect(out.recent_completions[0]!.step_id).toBe('s7');
    expect(out.recent_completions[4]!.step_id).toBe('s3');
  });
});

// ─── listInvestigationStepBacklog — pure ─────────────────────────────

describe('M9.9 — backlog empty', () => {
  test('zero investigations → zero envelope', () => {
    const out = listInvestigationStepBacklog([]);
    expect(out.total_investigations).toBe(0);
    expect(out.open_investigations).toBe(0);
    expect(out.entries).toEqual([]);
  });
});

describe('M9.9 — backlog aggregation', () => {
  test('per-step counts accumulate across investigations', () => {
    const a = mkInv({
      investigation_id: 'a',
      case_id: 'C1',
      status: 'triage',
      steps: [
        mkStep({ step_id: 's1', completed: true }),
        mkStep({ step_id: 's2' }),
      ],
    });
    const b = mkInv({
      investigation_id: 'b',
      case_id: 'C2',
      status: 'review',
      steps: [
        mkStep({ step_id: 's1' }),
        mkStep({ step_id: 's2', completed: true }),
      ],
    });
    const out = listInvestigationStepBacklog([a, b]);
    expect(out.total_investigations).toBe(2);
    expect(out.open_investigations).toBe(2);
    const s1 = out.entries.find((e) => e.step_id === 's1')!;
    const s2 = out.entries.find((e) => e.step_id === 's2')!;
    expect(s1.completed_count).toBe(1);
    expect(s1.pending_count).toBe(1);
    expect(s1.cases_with_step).toBe(2);
    expect(s1.open_pending_count).toBe(1);
    expect(s2.completed_count).toBe(1);
    expect(s2.pending_count).toBe(1);
  });
});

describe('M9.9 — backlog excludes closed-case pending from open_pending_count', () => {
  test('closed case with pending step → counted in pending_count but NOT open_pending_count', () => {
    const a = mkInv({
      investigation_id: 'a',
      case_id: 'C1',
      status: 'closed',
      steps: [mkStep({ step_id: 's1' })],
    });
    const b = mkInv({
      investigation_id: 'b',
      case_id: 'C2',
      status: 'triage',
      steps: [mkStep({ step_id: 's1' })],
    });
    const out = listInvestigationStepBacklog([a, b]);
    expect(out.open_investigations).toBe(1);
    const s1 = out.entries[0]!;
    expect(s1.pending_count).toBe(2);
    expect(s1.open_pending_count).toBe(1);
  });
});

describe('M9.9 — backlog sort', () => {
  test('entries sorted by open_pending_count desc then step_id asc', () => {
    // Create investigations such that step 'high' has more open pending than 'low'.
    const high1 = mkInv({ investigation_id: 'h1', case_id: 'C1', status: 'triage', steps: [mkStep({ step_id: 'high' })] });
    const high2 = mkInv({ investigation_id: 'h2', case_id: 'C2', status: 'triage', steps: [mkStep({ step_id: 'high' })] });
    const low = mkInv({ investigation_id: 'l1', case_id: 'C3', status: 'triage', steps: [mkStep({ step_id: 'low' })] });
    const out = listInvestigationStepBacklog([high1, high2, low]);
    expect(out.entries.map((e) => e.step_id)).toEqual(['high', 'low']);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

function makeProgressApp(role = 'admin') {
  const caseInvestigationStore = new InMemoryCaseInvestigationStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseInvestigationStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, caseInvestigationStore };
}

describe('M9.9 — GET /v1/investigations/:id/step-progress', () => {
  test('happy path: surfaces step progress for an existing investigation', async () => {
    const { app, caseInvestigationStore } = makeProgressApp('admin');
    const inv = caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      NOW,
    );
    const r = await request(app)
      .get(`/v1/investigations/${inv.investigation_id}/step-progress`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_steps).toBeGreaterThan(0);
    expect(r.body.body.completed_count).toBe(0);
    expect(r.body.body.oldest_pending_step).not.toBeNull();
  });

  test('unknown investigation → 404', async () => {
    const { app } = makeProgressApp('admin');
    const r = await request(app)
      .get('/v1/investigations/not-a-real-investigation/step-progress')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeProgressApp('readonly');
    const r = await request(app)
      .get('/v1/investigations/whatever/step-progress')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('M9.9 — GET /v1/investigations/step-backlog', () => {
  test('admin → 200 with per-step backlog', async () => {
    const { app, caseInvestigationStore } = makeProgressApp('admin');
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      NOW,
    );
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'C2', customer_id: 'cust-2' },
      'alice',
      NOW,
    );
    const r = await request(app).get('/v1/investigations/step-backlog').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_investigations).toBe(2);
    expect(r.body.body.open_investigations).toBe(2);
    expect(r.body.body.entries.length).toBeGreaterThan(0);
    // Every step in the BIL §17 checklist should have 2 pending cases.
    for (const e of r.body.body.entries) {
      expect(e.pending_count).toBe(2);
      expect(e.open_pending_count).toBe(2);
    }
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeProgressApp('readonly');
    const r = await request(app).get('/v1/investigations/step-backlog').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL invisible to BANK_DEMO', async () => {
    const { app, caseInvestigationStore } = makeProgressApp('admin');
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      NOW,
    );
    const r = await request(app)
      .get('/v1/investigations/step-backlog')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_investigations).toBe(0);
  });
});
