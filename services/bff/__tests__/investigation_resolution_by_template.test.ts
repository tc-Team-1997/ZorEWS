// @ts-nocheck
// services/bff/__tests__/investigation_resolution_by_template.test.ts
// T6 M9.22 — Investigation resolution time by checklist template.

import request from 'supertest';
import { buildResolutionByTemplate } from '../src/investigation_resolution_by_template';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  defaultCaseInvestigationStore,
  type CaseInvestigation,
} from '../src/case_investigation';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    getRole: () => role,
    now: () => NOW,
  });
}

function makeInv(overrides = {}): CaseInvestigation {
  return {
    investigation_id: `inv-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'BIL',
    case_id: 'case-1',
    customer_id: 'cust-1',
    status: 'triage',
    decision: null,
    opened_at: '2026-05-10T10:00:00.000Z',
    opened_by: 'alice',
    last_updated_at: '2026-05-10T10:00:00.000Z',
    last_updated_by: 'alice',
    closed_at: null,
    steps: [],
    notes_count: 0,
    checklist_template_id: 'BUILT_IN',
    ...overrides,
  };
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M9.22 — buildResolutionByTemplate — empty', () => {
  test('empty investigations → no templates', () => {
    const out = buildResolutionByTemplate('BIL', [], NOW);
    expect(out.templates).toHaveLength(0);
    expect(out.fastest_template).toBeNull();
    expect(out.highest_fraud_rate_template).toBeNull();
  });
});

describe('M9.22 — resolution days', () => {
  test('closed investigation → avg_resolution_days computed', () => {
    const inv = makeInv({
      status: 'closed',
      opened_at: '2026-05-10T00:00:00.000Z',
      closed_at: '2026-05-15T00:00:00.000Z',
      decision: 'fraud_confirmed',
    });
    const out = buildResolutionByTemplate('BIL', [inv], NOW);
    expect(out.templates[0].avg_resolution_days).toBe(5);
    expect(out.templates[0].closed_count).toBe(1);
  });
});

describe('M9.22 — fraud rate', () => {
  test('fraud_confirmed → fraud_rate=1.0', () => {
    const inv = makeInv({
      status: 'closed', decision: 'fraud_confirmed',
      opened_at: '2026-05-10T00:00:00.000Z', closed_at: '2026-05-12T00:00:00.000Z',
    });
    const out = buildResolutionByTemplate('BIL', [inv], NOW);
    expect(out.templates[0].fraud_rate).toBe(1);
  });

  test('fraud_unsubstantiated → fraud_rate=0', () => {
    const inv = makeInv({
      status: 'closed', decision: 'fraud_unsubstantiated',
      opened_at: '2026-05-10T00:00:00.000Z', closed_at: '2026-05-12T00:00:00.000Z',
    });
    const out = buildResolutionByTemplate('BIL', [inv], NOW);
    expect(out.templates[0].fraud_rate).toBe(0);
  });
});

describe('M9.22 — template grouping', () => {
  test('different templates stay separate', () => {
    const inv1 = makeInv({ status: 'closed', decision: null, checklist_template_id: 'BUILT_IN',
      opened_at: '2026-05-10T00:00:00.000Z', closed_at: '2026-05-12T00:00:00.000Z' });
    const inv2 = makeInv({ status: 'closed', decision: 'fraud_confirmed', checklist_template_id: 'CUSTOM',
      opened_at: '2026-05-10T00:00:00.000Z', closed_at: '2026-05-11T00:00:00.000Z' });
    const out = buildResolutionByTemplate('BIL', [inv1, inv2], NOW);
    expect(out.templates).toHaveLength(2);
  });
});

describe('M9.22 — sort order', () => {
  test('sorted avg_resolution_days asc', () => {
    const slow = makeInv({ status: 'closed', decision: null,
      opened_at: '2026-05-01T00:00:00.000Z', closed_at: '2026-05-11T00:00:00.000Z',
      checklist_template_id: 'SLOW' });
    const fast = makeInv({ status: 'closed', decision: null,
      opened_at: '2026-05-10T00:00:00.000Z', closed_at: '2026-05-11T00:00:00.000Z',
      checklist_template_id: 'FAST' });
    const out = buildResolutionByTemplate('BIL', [slow, fast], NOW);
    expect(out.templates[0].template_id).toBe('FAST');
    expect(out.fastest_template.template_id).toBe('FAST');
  });
});

describe('M9.22 — tenant isolation', () => {
  test('BANK_DEMO investigations not counted for BIL', () => {
    const inv = makeInv({ tenant_id: 'BANK_DEMO', status: 'closed', decision: null,
      opened_at: '2026-05-10T00:00:00.000Z', closed_at: '2026-05-12T00:00:00.000Z' });
    const out = buildResolutionByTemplate('BIL', [inv], NOW);
    expect(out.templates).toHaveLength(0);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M9.22 — route', () => {
  test('GET /v1/investigations/resolution-by-template → 200', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/investigations/resolution-by-template')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.templates)).toBe(true);
  });

  test('403 for unknown role', async () => {
    const { app } = fakeApp('viewer');
    const res = await request(app)
      .get('/v1/investigations/resolution-by-template')
      .set(TH_BIL)
      .set('x-apex-role', 'viewer');
    expect(res.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/investigations/resolution-by-template')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
