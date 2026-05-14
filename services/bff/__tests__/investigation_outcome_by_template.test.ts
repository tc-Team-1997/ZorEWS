// services/bff/__tests__/investigation_outcome_by_template.test.ts
//
// T6 M9.12 — Investigation outcome breakdown by checklist template.

import request from 'supertest';
import { summarizeOutcomeByTemplate } from '../src/investigation_outcome_by_template';
import {
  InMemoryCaseInvestigationStore,
  type CaseInvestigation,
  type InvestigationDecision,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── summarizeOutcomeByTemplate — pure ───────────────────────────────

function buildInvestigation(
  id: string,
  case_id: string,
  template_id: string,
  status: CaseInvestigation['status'],
  decision: InvestigationDecision,
): CaseInvestigation {
  return {
    investigation_id: id,
    tenant_id: 'BIL',
    case_id,
    customer_id: 'CUST-1',
    status,
    decision,
    opened_at: NOW.toISOString(),
    opened_by: 'alice',
    last_updated_at: NOW.toISOString(),
    last_updated_by: 'alice',
    closed_at: status === 'closed' ? NOW.toISOString() : null,
    steps: [],
    notes_count: 0,
    checklist_template_id: template_id,
  };
}

describe('M9.12 — empty input', () => {
  test('zero investigations → zero rows + null most_effective', () => {
    const summary = summarizeOutcomeByTemplate('BIL', [], NOW);
    expect(summary.tenant_id).toBe('BIL');
    expect(summary.generated_at).toBe(NOW.toISOString());
    expect(summary.total_investigations).toBe(0);
    expect(summary.total_templates).toBe(0);
    expect(summary.rows).toEqual([]);
    expect(summary.most_effective_template).toBeNull();
  });
});

describe('M9.12 — single template, mix of outcomes', () => {
  test('per-decision counts + confirmation_rate', () => {
    const invs = [
      buildInvestigation('i1', 'c1', 'BUILT_IN', 'closed', 'fraud_confirmed'),
      buildInvestigation('i2', 'c2', 'BUILT_IN', 'closed', 'fraud_confirmed'),
      buildInvestigation('i3', 'c3', 'BUILT_IN', 'closed', 'partial_fraud'),
      buildInvestigation('i4', 'c4', 'BUILT_IN', 'closed', 'fraud_unsubstantiated'),
      buildInvestigation('i5', 'c5', 'BUILT_IN', 'closed', 'data_quality'),
      buildInvestigation('i6', 'c6', 'BUILT_IN', 'gathering_evidence', null),
    ];
    const summary = summarizeOutcomeByTemplate('BIL', invs, NOW);
    expect(summary.total_investigations).toBe(6);
    expect(summary.total_templates).toBe(1);
    const row = summary.rows[0]!;
    expect(row.checklist_template_id).toBe('BUILT_IN');
    expect(row.total_count).toBe(6);
    expect(row.open_count).toBe(1);
    expect(row.closed_count).toBe(5);
    expect(row.fraud_confirmed_count).toBe(2);
    expect(row.partial_fraud_count).toBe(1);
    expect(row.fraud_unsubstantiated_count).toBe(1);
    expect(row.data_quality_count).toBe(1);
    expect(row.closed_without_decision_count).toBe(0);
    // 3 of 5 closed-with-decision = 0.6 confirmation
    expect(row.confirmation_rate).toBeCloseTo(0.6);
  });
});

describe('M9.12 — multi-template ordering + tie-break', () => {
  test('rows sorted by total_count desc with template_id asc tie-break', () => {
    const invs = [
      // BUILT_IN: 2 total
      buildInvestigation('i1', 'c1', 'BUILT_IN', 'closed', 'fraud_confirmed'),
      buildInvestigation('i2', 'c2', 'BUILT_IN', 'closed', 'fraud_unsubstantiated'),
      // tpl-kyc: 4 total → should appear first
      buildInvestigation('i3', 'c3', 'tpl-kyc', 'closed', 'fraud_confirmed'),
      buildInvestigation('i4', 'c4', 'tpl-kyc', 'closed', 'fraud_confirmed'),
      buildInvestigation('i5', 'c5', 'tpl-kyc', 'closed', 'fraud_confirmed'),
      buildInvestigation('i6', 'c6', 'tpl-kyc', 'gathering_evidence', null),
      // tpl-aml: 2 total (same as BUILT_IN) → tie-broken by template_id asc (BUILT_IN < tpl-aml)
      buildInvestigation('i7', 'c7', 'tpl-aml', 'closed', 'data_quality'),
      buildInvestigation('i8', 'c8', 'tpl-aml', 'triage', null),
    ];
    const summary = summarizeOutcomeByTemplate('BIL', invs, NOW);
    expect(summary.rows.map((r) => r.checklist_template_id)).toEqual([
      'tpl-kyc',
      'BUILT_IN',
      'tpl-aml',
    ]);
  });
});

describe('M9.12 — most_effective_template', () => {
  test('template with highest confirmation_rate wins', () => {
    const invs = [
      // BUILT_IN: 1 of 2 confirmed = 50%
      buildInvestigation('i1', 'c1', 'BUILT_IN', 'closed', 'fraud_confirmed'),
      buildInvestigation('i2', 'c2', 'BUILT_IN', 'closed', 'fraud_unsubstantiated'),
      // tpl-x: 3 of 3 confirmed = 100%
      buildInvestigation('i3', 'c3', 'tpl-x', 'closed', 'fraud_confirmed'),
      buildInvestigation('i4', 'c4', 'tpl-x', 'closed', 'fraud_confirmed'),
      buildInvestigation('i5', 'c5', 'tpl-x', 'closed', 'fraud_confirmed'),
    ];
    const summary = summarizeOutcomeByTemplate('BIL', invs, NOW);
    expect(summary.most_effective_template).toEqual({
      checklist_template_id: 'tpl-x',
      confirmation_rate: 1.0,
      closed_count: 3,
    });
  });

  test('null when no closed-with-decision investigations exist', () => {
    const invs = [
      buildInvestigation('i1', 'c1', 'BUILT_IN', 'gathering_evidence', null),
      buildInvestigation('i2', 'c2', 'tpl-x', 'closed', null), // closed-without-decision
    ];
    const summary = summarizeOutcomeByTemplate('BIL', invs, NOW);
    expect(summary.most_effective_template).toBeNull();
    // closed-without-decision contributes to closed_count + closed_without_decision_count
    const row = summary.rows.find((r) => r.checklist_template_id === 'tpl-x')!;
    expect(row.closed_count).toBe(1);
    expect(row.closed_without_decision_count).toBe(1);
    expect(row.confirmation_rate).toBeNull();
  });
});

describe('M9.12 — most_effective tie-break by sample size', () => {
  test('on equal confirmation_rate, more samples wins', () => {
    const invs = [
      // tpl-a: 1 of 1 = 100% (1 sample)
      buildInvestigation('i1', 'c1', 'tpl-a', 'closed', 'fraud_confirmed'),
      // tpl-b: 5 of 5 = 100% (5 samples) — should win
      buildInvestigation('i2', 'c2', 'tpl-b', 'closed', 'fraud_confirmed'),
      buildInvestigation('i3', 'c3', 'tpl-b', 'closed', 'fraud_confirmed'),
      buildInvestigation('i4', 'c4', 'tpl-b', 'closed', 'fraud_confirmed'),
      buildInvestigation('i5', 'c5', 'tpl-b', 'closed', 'fraud_confirmed'),
      buildInvestigation('i6', 'c6', 'tpl-b', 'closed', 'fraud_confirmed'),
    ];
    const summary = summarizeOutcomeByTemplate('BIL', invs, NOW);
    expect(summary.most_effective_template!.checklist_template_id).toBe('tpl-b');
    expect(summary.most_effective_template!.closed_count).toBe(5);
  });
});

describe('M9.12 — partial_fraud counts toward confirmation', () => {
  test('confirmation_rate = (fraud_confirmed + partial_fraud) / closed', () => {
    const invs = [
      buildInvestigation('i1', 'c1', 'BUILT_IN', 'closed', 'fraud_confirmed'),
      buildInvestigation('i2', 'c2', 'BUILT_IN', 'closed', 'partial_fraud'),
      buildInvestigation('i3', 'c3', 'BUILT_IN', 'closed', 'fraud_unsubstantiated'),
      buildInvestigation('i4', 'c4', 'BUILT_IN', 'closed', 'data_quality'),
    ];
    const summary = summarizeOutcomeByTemplate('BIL', invs, NOW);
    // 2 of 4 closed = 50%
    expect(summary.rows[0]!.confirmation_rate).toBeCloseTo(0.5);
  });
});

// ─── GET /v1/investigations/outcome-by-template ───────────────────────

function makeOutcomeApp(role = 'admin') {
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

describe('M9.12 — GET /v1/investigations/outcome-by-template', () => {
  test('admin → 200 with empty rollup for fresh tenant', async () => {
    const { app } = makeOutcomeApp('admin');
    const r = await request(app)
      .get('/v1/investigations/outcome-by-template')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_investigations).toBe(0);
    expect(r.body.body.rows).toEqual([]);
  });

  test('admin → 200 with populated rollup', async () => {
    const { app, caseInvestigationStore } = makeOutcomeApp('admin');
    // Open + close 2 investigations under BUILT_IN
    const i1 = caseInvestigationStore.open('BIL', { case_id: 'c1', customer_id: 'CUST-1' }, 'alice', NOW);
    caseInvestigationStore.updateStatus('BIL', i1.investigation_id, 'closed', 'fraud_confirmed', 'alice', NOW);
    const i2 = caseInvestigationStore.open('BIL', { case_id: 'c2', customer_id: 'CUST-2' }, 'alice', NOW);
    caseInvestigationStore.updateStatus('BIL', i2.investigation_id, 'closed', 'fraud_unsubstantiated', 'alice', NOW);
    const r = await request(app)
      .get('/v1/investigations/outcome-by-template')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_investigations).toBe(2);
    expect(r.body.body.rows).toHaveLength(1);
    expect(r.body.body.rows[0].confirmation_rate).toBeCloseTo(0.5);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeOutcomeApp('case_owner');
    const r = await request(app)
      .get('/v1/investigations/outcome-by-template')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL investigations invisible to BANK_DEMO', async () => {
    const { app, caseInvestigationStore } = makeOutcomeApp('admin');
    const i = caseInvestigationStore.open('BIL', { case_id: 'c1', customer_id: 'CUST-1' }, 'alice', NOW);
    caseInvestigationStore.updateStatus('BIL', i.investigation_id, 'closed', 'fraud_confirmed', 'alice', NOW);
    const bank = await request(app)
      .get('/v1/investigations/outcome-by-template')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_investigations).toBe(0);
  });
});
