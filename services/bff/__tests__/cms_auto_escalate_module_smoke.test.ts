// services/bff/__tests__/cms_auto_escalate_module_smoke.test.ts
//
// Module 3.1 — Alerts & Cases smoke (auto-escalate SLA workflow).
//
// Per cross-cutting #1 + the user's explicit "if already exist please
// dont do that again" guard: the 8 spec routes (alerts list + cms cases
// CRUD + assign/escalate/close/transition + sla-breaches + sla-summary)
// were ALL pre-existing. M3.1 lands the missing acceptance criterion —
// "escalation auto-triggers when SLA breaches by configured percentage."
//
// Additions:
//   - AC-2 config key `cases.auto_escalate_at_pct` (default 0.8)
//   - AC-3 pure findAutoEscalationCandidates() over CmsCase[]
//   - AC-4 POST /v1/cms/cases/auto-escalate-sla (dry_run + threshold
//          override + audit fan-out per success)
//   - AC-5 SPA AutoEscalateSlaModal on CmsCaseListPage
//
// SPEC ACCEPTANCE asserted: auto-escalation fires for non-closed cases
// crossing the configured threshold; audit chain records each escalation
// with auto=true + trigger=sla_breach + threshold_pct + progress_pct
// metadata; dry_run mode previews without mutating.

import request from 'supertest';
import { findAutoEscalationCandidates, autoEscalateReason } from '../src/cms_cases';
import type { CmsCase } from '../src/cms_cases';
import { InMemoryCmsCaseStore } from '../src/cms_store';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { defaultAuditTrailStore } from '../src/audit_trail';
import { defaultConfigStore } from '../src/admin_config';

const NOW = new Date('2026-05-24T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const TH = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};

function makeSmokeApp(role = 'admin') {
  const cmsCaseStore = new InMemoryCmsCaseStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    cmsCaseStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, cmsCaseStore };
}

/** Seed a case with explicit created_at backdated relative to NOW so
 *  slaProgressPct yields the desired value. Optionally advance the case
 *  through ASSIGNED / INVESTIGATING / ESCALATED / CLOSED via the store. */
function seedCase(
  store: InMemoryCmsCaseStore,
  tenant_id: string,
  opts: {
    priority: 'P1' | 'P2' | 'P3' | 'P4';
    age_hours: number;
    advance?: 'ASSIGNED' | 'INVESTIGATING' | 'ESCALATED' | 'CLOSED';
    title: string;
  },
): CmsCase {
  const created_at = new Date(NOW.getTime() - opts.age_hours * HOUR_MS);
  const c = store.create(
    tenant_id,
    {
      title: opts.title,
      description: 'Auto-escalate smoke test case',
      priority: opts.priority,
      tags: ['smoke'],
    },
    'seed.user',
    created_at,
  );
  if (opts.advance === 'ASSIGNED') {
    store.assign(tenant_id, c.case_id, { assigned_to: 'alice', reason: 'seed' }, 'seed.user', created_at);
  } else if (opts.advance === 'INVESTIGATING') {
    store.assign(tenant_id, c.case_id, { assigned_to: 'alice', reason: 'seed' }, 'seed.user', created_at);
    store.transition(tenant_id, c.case_id, 'INVESTIGATING', 'seed.user', created_at);
  } else if (opts.advance === 'ESCALATED') {
    store.assign(tenant_id, c.case_id, { assigned_to: 'alice', reason: 'seed' }, 'seed.user', created_at);
    store.escalate(tenant_id, c.case_id, 'seed.user', 'manual', created_at);
  } else if (opts.advance === 'CLOSED') {
    store.assign(tenant_id, c.case_id, { assigned_to: 'alice', reason: 'seed' }, 'seed.user', created_at);
    store.close(
      tenant_id,
      c.case_id,
      { resolution_category: 'false_positive', resolution_notes: 'seed close' },
      'seed.user',
      created_at,
    );
  }
  return c;
}

beforeEach(() => {
  // Wipe audit store so per-tenant queries don't leak across tests.
  (defaultAuditTrailStore as unknown as { reset(): void }).reset();
  // Config: reset to default by ensuring no override on the auto-escalate key.
  try {
    defaultConfigStore.reset('BANK_DEMO', 'cases.auto_escalate_at_pct');
  } catch {
    /* not set */
  }
  try {
    defaultConfigStore.reset('BIL', 'cases.auto_escalate_at_pct');
  } catch {
    /* not set */
  }
});

describe('M3.1 Pure findAutoEscalationCandidates', () => {
  it('AC-pure: rejects out-of-range threshold_fraction', () => {
    expect(() => findAutoEscalationCandidates([], -0.1, NOW)).toThrow(/threshold/);
    expect(() => findAutoEscalationCandidates([], 1.1, NOW)).toThrow(/threshold/);
    expect(() => findAutoEscalationCandidates([], Number.NaN, NOW)).toThrow(/threshold/);
  });

  it('AC-pure: categorises each non-eligible state with the right skip reason', () => {
    const store = new InMemoryCmsCaseStore();
    const open = seedCase(store, 'BANK_DEMO', { priority: 'P2', age_hours: 22, title: 'open' });
    const assignedAt92 = seedCase(store, 'BANK_DEMO', { priority: 'P2', age_hours: 22, advance: 'ASSIGNED', title: 'cand' });
    const escalated = seedCase(store, 'BANK_DEMO', { priority: 'P2', age_hours: 22, advance: 'ESCALATED', title: 'esc' });
    const closed = seedCase(store, 'BANK_DEMO', { priority: 'P2', age_hours: 22, advance: 'CLOSED', title: 'cl' });
    const belowThr = seedCase(store, 'BANK_DEMO', { priority: 'P2', age_hours: 2, advance: 'ASSIGNED', title: 'low' });
    const cases = store.list('BANK_DEMO', {});

    const plan = findAutoEscalationCandidates(cases, 0.8, NOW);
    const reasonByCase = new Map(plan.skipped.map((s) => [s.case_id, s.reason]));
    expect(reasonByCase.get(open.case_id)).toBe('unassigned_open');
    expect(reasonByCase.get(escalated.case_id)).toBe('already_escalated');
    expect(reasonByCase.get(closed.case_id)).toBe('closed');
    expect(reasonByCase.get(belowThr.case_id)).toBe('below_threshold');
    // The 22h-old ASSIGNED case is the only candidate
    expect(plan.candidates.map((c) => c.case_id)).toEqual([assignedAt92.case_id]);
    expect(plan.candidates[0].breach_severity).toBe('imminent');
    expect(plan.threshold_pct).toBe(80);
  });

  it('AC-pure: candidates sorted worst-first (highest progress + oldest tie-break)', () => {
    const store = new InMemoryCmsCaseStore();
    const newer = seedCase(store, 'BANK_DEMO', { priority: 'P2', age_hours: 22, advance: 'ASSIGNED', title: 'newer-90%' });
    const older = seedCase(store, 'BANK_DEMO', { priority: 'P2', age_hours: 28, advance: 'ASSIGNED', title: 'older-breached' });
    const tied = seedCase(store, 'BANK_DEMO', { priority: 'P2', age_hours: 28, advance: 'ASSIGNED', title: 'tied-older' });
    // 'older' created BEFORE 'tied' (run in declared order, NOW-anchored)
    // — store stamps created_at with the supplied Date — but since
    // we pass the same age_hours we actually get identical timestamps.
    // The sort still must place breached (>100%) before imminent.
    const plan = findAutoEscalationCandidates(store.list('BANK_DEMO', {}), 0.8, NOW);
    expect(plan.candidates).toHaveLength(3);
    // first two are breached (28h on a 24h SLA), last is imminent (22h)
    expect(plan.candidates[0].breach_severity).toBe('breached');
    expect(plan.candidates[2].case_id).toBe(newer.case_id);
    expect(plan.candidates[0].current_progress_pct).toBeGreaterThanOrEqual(
      plan.candidates[1].current_progress_pct,
    );
    expect(plan.candidates[1].current_progress_pct).toBeGreaterThanOrEqual(
      plan.candidates[2].current_progress_pct,
    );
    // referenced to suppress unused-var lints — both are bucketed as breached
    expect([older.case_id, tied.case_id]).toContain(plan.candidates[0].case_id);
  });
});

describe('M3.1 POST /v1/cms/cases/auto-escalate-sla', () => {
  it('AC-1 dry-run: returns plan without mutating any case', async () => {
    const { app, cmsCaseStore } = makeSmokeApp('admin');
    const cand = seedCase(cmsCaseStore, 'BANK_DEMO', {
      priority: 'P2',
      age_hours: 22,
      advance: 'ASSIGNED',
      title: 'imminent cand',
    });
    const r = await request(app).post('/v1/cms/cases/auto-escalate-sla').set(TH).send({ dry_run: true });
    expect(r.status).toBe(200);
    expect(r.body.body.dry_run).toBe(true);
    expect(r.body.body.would_escalate).toBe(1);
    expect(r.body.body.escalated).toEqual([]);
    expect(r.body.body.candidates[0].case_id).toBe(cand.case_id);
    expect(r.body.body.threshold_pct).toBe(80); // default

    // case should still be ASSIGNED (not mutated)
    const after = cmsCaseStore.get('BANK_DEMO', cand.case_id);
    expect(after?.status).toBe('ASSIGNED');
  });

  it('AC-2 full run: escalates candidates + writes audit events with auto=true + trigger=sla_breach', async () => {
    const { app, cmsCaseStore } = makeSmokeApp('admin');
    const c1 = seedCase(cmsCaseStore, 'BANK_DEMO', { priority: 'P2', age_hours: 22, advance: 'ASSIGNED', title: 'a' });
    const c2 = seedCase(cmsCaseStore, 'BANK_DEMO', { priority: 'P2', age_hours: 28, advance: 'ASSIGNED', title: 'b' });
    const low = seedCase(cmsCaseStore, 'BANK_DEMO', { priority: 'P2', age_hours: 2, advance: 'ASSIGNED', title: 'low' });

    const r = await request(app).post('/v1/cms/cases/auto-escalate-sla').set(TH).send({});
    expect(r.status).toBe(200);
    const body = r.body.body;
    expect(body.dry_run).toBe(false);
    expect(body.escalated).toHaveLength(2);
    expect(body.escalated.map((e: { case_id: string }) => e.case_id).sort()).toEqual(
      [c1.case_id, c2.case_id].sort(),
    );
    expect(body.skipped.find((s: { case_id: string }) => s.case_id === low.case_id)?.reason).toBe(
      'below_threshold',
    );
    expect(body.errors).toEqual([]);

    // Stores reflect mutation
    expect(cmsCaseStore.get('BANK_DEMO', c1.case_id)?.status).toBe('ESCALATED');
    expect(cmsCaseStore.get('BANK_DEMO', c2.case_id)?.status).toBe('ESCALATED');
    expect(cmsCaseStore.get('BANK_DEMO', low.case_id)?.status).toBe('ASSIGNED');

    // M15.1 audit fan-out — `case.escalate` with auto=true
    const audit = defaultAuditTrailStore.list('BANK_DEMO', { action: 'case.escalate' });
    const autoEscalates = audit.items.filter((e) => e.metadata?.auto === true);
    expect(autoEscalates).toHaveLength(2);
    expect(autoEscalates[0].metadata).toMatchObject({
      auto: true,
      trigger: 'sla_breach',
      threshold_pct: 80,
    });
    expect(autoEscalates[0].metadata).toHaveProperty('progress_pct');
    expect(autoEscalates[0].metadata).toHaveProperty('reason');
    expect(autoEscalates[0].actor_username).toBe('alice.admin');
  });

  it('AC-3 threshold_pct_override: lower threshold catches more cases', async () => {
    const { app, cmsCaseStore } = makeSmokeApp('admin');
    seedCase(cmsCaseStore, 'BANK_DEMO', { priority: 'P2', age_hours: 12, advance: 'ASSIGNED', title: 'at-50' });
    seedCase(cmsCaseStore, 'BANK_DEMO', { priority: 'P2', age_hours: 22, advance: 'ASSIGNED', title: 'at-92' });

    // Default 80% — only the 92% case escalates
    const def = await request(app).post('/v1/cms/cases/auto-escalate-sla').set(TH).send({ dry_run: true });
    expect(def.body.body.would_escalate).toBe(1);

    // Override to 40% — both escalate
    const lo = await request(app)
      .post('/v1/cms/cases/auto-escalate-sla')
      .set(TH)
      .send({ dry_run: true, threshold_pct_override: 0.4 });
    expect(lo.body.body.threshold_pct).toBe(40);
    expect(lo.body.body.would_escalate).toBe(2);
  });

  it('AC-4 config-driven threshold: M13.1 override flows through', async () => {
    const { app, cmsCaseStore } = makeSmokeApp('admin');
    seedCase(cmsCaseStore, 'BANK_DEMO', { priority: 'P2', age_hours: 12, advance: 'ASSIGNED', title: 'at-50' });

    // No config override, 50% case → not a candidate at default 80%
    const def = await request(app).post('/v1/cms/cases/auto-escalate-sla').set(TH).send({ dry_run: true });
    expect(def.body.body.threshold_pct).toBe(80);
    expect(def.body.body.would_escalate).toBe(0);

    // Set tenant override to 0.4 — now the 50% case becomes a candidate
    defaultConfigStore.set('BANK_DEMO', 'cases.auto_escalate_at_pct', 0.4, 'alice.admin', NOW);
    const tight = await request(app).post('/v1/cms/cases/auto-escalate-sla').set(TH).send({ dry_run: true });
    expect(tight.body.body.threshold_pct).toBe(40);
    expect(tight.body.body.would_escalate).toBe(1);
  });

  it('AC-5 RBAC: unknown role rejected (fail-closed)', async () => {
    const { app, cmsCaseStore } = makeSmokeApp('viewer');
    seedCase(cmsCaseStore, 'BANK_DEMO', { priority: 'P2', age_hours: 22, advance: 'ASSIGNED', title: 'cand' });
    const r = await request(app).post('/v1/cms/cases/auto-escalate-sla').set(TH).send({});
    expect(r.status).toBe(403);
  });

  it('AC-6 tenant gate + cross-tenant isolation: BIL escalations invisible to BANK_DEMO', async () => {
    const { app, cmsCaseStore } = makeSmokeApp('admin');
    seedCase(cmsCaseStore, 'BIL', { priority: 'P2', age_hours: 22, advance: 'ASSIGNED', title: 'BIL cand' });

    // Missing X-Tenant-ID → 400
    const noTenant = await request(app)
      .post('/v1/cms/cases/auto-escalate-sla')
      .set({ 'x-channel': 'API', 'x-apex-role': 'admin' })
      .send({});
    expect(noTenant.status).toBe(400);

    // BIL runs against its case → 1 escalation
    const bilRun = await request(app)
      .post('/v1/cms/cases/auto-escalate-sla')
      .set({ ...TH, 'x-tenant-id': 'BIL' })
      .send({});
    expect(bilRun.body.body.escalated).toHaveLength(1);

    // BANK_DEMO sees zero (no cases seeded there)
    const bdRun = await request(app).post('/v1/cms/cases/auto-escalate-sla').set(TH).send({});
    expect(bdRun.body.body.total_considered).toBe(0);
    expect(bdRun.body.body.escalated).toEqual([]);
  });

  it('AC-7 invalid threshold_pct_override → 400 EWS_400_invalid_input', async () => {
    const { app } = makeSmokeApp('admin');

    const tooHigh = await request(app)
      .post('/v1/cms/cases/auto-escalate-sla')
      .set(TH)
      .send({ threshold_pct_override: 1.5 });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.error.code).toBe('EWS_400_invalid_input');

    const negative = await request(app)
      .post('/v1/cms/cases/auto-escalate-sla')
      .set(TH)
      .send({ threshold_pct_override: -0.1 });
    expect(negative.status).toBe(400);

    const notNumber = await request(app)
      .post('/v1/cms/cases/auto-escalate-sla')
      .set(TH)
      .send({ threshold_pct_override: 'eighty' });
    expect(notNumber.status).toBe(400);
  });
});

describe('M3.1 autoEscalateReason helper', () => {
  it('returns a self-describing audit reason string', () => {
    expect(autoEscalateReason(80, 92)).toBe('auto_sla_breach@80%: progress=92%');
    expect(autoEscalateReason(50, 105)).toBe('auto_sla_breach@50%: progress=105%');
  });
});
