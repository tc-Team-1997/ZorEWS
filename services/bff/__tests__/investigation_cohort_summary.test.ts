// services/bff/__tests__/investigation_cohort_summary.test.ts
//
// T6 M9.8 — Case investigation cohort summary.

import request from 'supertest';
import { summarizeInvestigationCohort } from '../src/investigation_cohort_summary';
import {
  InMemoryCaseInvestigationStore,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── summarizeInvestigationCohort — pure ─────────────────────────────

describe('M9.8 — empty cohort', () => {
  test('zero investigations → null pointers + zero counts; every status key emitted', () => {
    const out = summarizeInvestigationCohort('BIL', [], NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.sample_size).toBe(0);
    expect(out.open_count).toBe(0);
    expect(out.closed_count).toBe(0);
    expect(out.mean_age_open_hours).toBeNull();
    expect(out.mean_time_to_close_hours).toBeNull();
    expect(out.oldest_open).toBeNull();
    expect(out.newest_closed).toBeNull();
    // All 6 status keys present.
    expect(Object.keys(out.by_status).sort()).toEqual([
      'awaiting_response',
      'closed',
      'decision',
      'gathering_evidence',
      'review',
      'triage',
    ]);
  });
});

describe('M9.8 — open cohort', () => {
  test('single open investigation contributes to open_count + oldest_open + mean_age', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      new Date('2026-05-14T06:00:00.000Z'),
    );
    const list = store.list('BIL', {}).items;
    const out = summarizeInvestigationCohort('BIL', list, NOW);
    expect(out.open_count).toBe(1);
    expect(out.closed_count).toBe(0);
    expect(out.by_status.triage).toBe(1);
    expect(out.mean_age_open_hours).toBeCloseTo(6, 1);
    expect(out.oldest_open?.investigation_id).toBe(inv.investigation_id);
    expect(out.oldest_open?.age_hours).toBeCloseTo(6, 1);
    expect(out.newest_closed).toBeNull();
  });

  test('multiple opens → oldest_open is the one with the earliest opened_at', () => {
    const store = new InMemoryCaseInvestigationStore();
    const earliest = store.open(
      'BIL',
      { case_id: 'C-old', customer_id: 'cust-1' },
      'alice',
      new Date('2026-05-12T00:00:00.000Z'),
    );
    store.open(
      'BIL',
      { case_id: 'C-mid', customer_id: 'cust-2' },
      'alice',
      new Date('2026-05-13T00:00:00.000Z'),
    );
    store.open(
      'BIL',
      { case_id: 'C-new', customer_id: 'cust-3' },
      'alice',
      new Date('2026-05-14T00:00:00.000Z'),
    );
    const out = summarizeInvestigationCohort('BIL', store.list('BIL', {}).items, NOW);
    expect(out.open_count).toBe(3);
    expect(out.oldest_open?.investigation_id).toBe(earliest.investigation_id);
  });
});

describe('M9.8 — closed cohort + decisions', () => {
  test('closed investigations bucket by decision + contribute to mean_time_to_close', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      new Date('2026-05-14T00:00:00.000Z'),
    );
    // Walk to decision then close with fraud_confirmed.
    store.updateStatus('BIL', inv.investigation_id, 'gathering_evidence', null, 'alice', new Date('2026-05-14T01:00:00.000Z'));
    store.updateStatus('BIL', inv.investigation_id, 'review', null, 'alice', new Date('2026-05-14T02:00:00.000Z'));
    store.updateStatus('BIL', inv.investigation_id, 'decision', null, 'alice', new Date('2026-05-14T03:00:00.000Z'));
    store.updateStatus(
      'BIL',
      inv.investigation_id,
      'closed',
      'fraud_confirmed',
      'alice',
      new Date('2026-05-14T06:00:00.000Z'),
    );
    const list = store.list('BIL', {}).items;
    const out = summarizeInvestigationCohort('BIL', list, NOW);
    expect(out.closed_count).toBe(1);
    expect(out.open_count).toBe(0);
    expect(out.by_decision.fraud_confirmed).toBe(1);
    expect(out.by_decision.null).toBe(0);
    expect(out.mean_time_to_close_hours).toBeCloseTo(6, 1);
    expect(out.newest_closed?.investigation_id).toBe(inv.investigation_id);
    expect(out.oldest_open).toBeNull();
  });

  test('multiple closures → newest_closed is the one with latest closed_at', () => {
    const store = new InMemoryCaseInvestigationStore();
    const cases = [
      { caseId: 'C-old', opened: '2026-05-10T00:00:00.000Z', closed: '2026-05-11T00:00:00.000Z' },
      { caseId: 'C-mid', opened: '2026-05-12T00:00:00.000Z', closed: '2026-05-13T00:00:00.000Z' },
      { caseId: 'C-new', opened: '2026-05-13T00:00:00.000Z', closed: '2026-05-14T00:00:00.000Z' },
    ];
    let newestId: string | null = null;
    for (const c of cases) {
      const inv = store.open(
        'BIL',
        { case_id: c.caseId, customer_id: 'cust-x' },
        'alice',
        new Date(c.opened),
      );
      store.updateStatus('BIL', inv.investigation_id, 'gathering_evidence', null, 'alice', new Date(c.opened));
      store.updateStatus('BIL', inv.investigation_id, 'review', null, 'alice', new Date(c.opened));
      store.updateStatus('BIL', inv.investigation_id, 'decision', null, 'alice', new Date(c.opened));
      store.updateStatus(
        'BIL',
        inv.investigation_id,
        'closed',
        'fraud_confirmed',
        'alice',
        new Date(c.closed),
      );
      if (c.caseId === 'C-new') newestId = inv.investigation_id;
    }
    const out = summarizeInvestigationCohort('BIL', store.list('BIL', {}).items, NOW);
    expect(out.closed_count).toBe(3);
    expect(out.newest_closed?.investigation_id).toBe(newestId);
  });
});

describe('M9.8 — mixed cohort', () => {
  test('mix of open + closed cohabit; counts and means are independent', () => {
    const store = new InMemoryCaseInvestigationStore();
    // Open
    store.open(
      'BIL',
      { case_id: 'C-open-1', customer_id: 'cust-1' },
      'alice',
      new Date('2026-05-14T08:00:00.000Z'),
    );
    // Closed
    const c2 = store.open(
      'BIL',
      { case_id: 'C-closed-1', customer_id: 'cust-2' },
      'alice',
      new Date('2026-05-14T00:00:00.000Z'),
    );
    store.updateStatus('BIL', c2.investigation_id, 'gathering_evidence', null, 'alice', new Date('2026-05-14T00:30:00.000Z'));
    store.updateStatus('BIL', c2.investigation_id, 'review', null, 'alice', new Date('2026-05-14T01:00:00.000Z'));
    store.updateStatus('BIL', c2.investigation_id, 'decision', null, 'alice', new Date('2026-05-14T02:00:00.000Z'));
    store.updateStatus(
      'BIL',
      c2.investigation_id,
      'closed',
      'data_quality',
      'alice',
      new Date('2026-05-14T04:00:00.000Z'),
    );
    const out = summarizeInvestigationCohort('BIL', store.list('BIL', {}).items, NOW);
    expect(out.sample_size).toBe(2);
    expect(out.open_count).toBe(1);
    expect(out.closed_count).toBe(1);
    expect(out.mean_age_open_hours).toBeCloseTo(4, 1);
    expect(out.mean_time_to_close_hours).toBeCloseTo(4, 1);
    expect(out.by_decision.data_quality).toBe(1);
  });
});

// ─── GET /v1/investigations/summary ────────────────────────────

function makeSummaryApp(role = 'admin') {
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

describe('M9.8 — GET /v1/investigations/summary', () => {
  test('empty tenant → 200 zero envelope', async () => {
    const { app } = makeSummaryApp('admin');
    const r = await request(app).get('/v1/investigations/summary').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.sample_size).toBe(0);
    expect(r.body.body.open_count).toBe(0);
  });

  test('populated tenant surfaces in the summary', async () => {
    const { app, caseInvestigationStore } = makeSummaryApp('admin');
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      new Date('2026-05-14T06:00:00.000Z'),
    );
    const r = await request(app).get('/v1/investigations/summary').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.open_count).toBe(1);
    expect(r.body.body.by_status.triage).toBe(1);
    expect(r.body.body.oldest_open).not.toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSummaryApp('readonly');
    const r = await request(app).get('/v1/investigations/summary').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL investigation invisible to BANK_DEMO', async () => {
    const { app, caseInvestigationStore } = makeSummaryApp('admin');
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      new Date('2026-05-14T06:00:00.000Z'),
    );
    const r = await request(app)
      .get('/v1/investigations/summary')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.sample_size).toBe(0);
  });

  test('M9.1 /v1/investigations still works (route ordering)', async () => {
    const { app } = makeSummaryApp('admin');
    const r = await request(app).get('/v1/investigations').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
