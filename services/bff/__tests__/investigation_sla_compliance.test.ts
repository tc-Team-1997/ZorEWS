// @ts-nocheck
// services/bff/__tests__/investigation_sla_compliance.test.ts
// T6 M9.26 — Investigation SLA compliance tracker tests

import { buildInvestigationSlaCompliance, SLA_BY_STATUS } from '../src/investigation_sla_compliance';
import { InMemoryCaseInvestigationStore } from '../src/case_investigation';

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('buildInvestigationSlaCompliance — pure resolver', () => {
  test('empty store → all counts 0, compliance_rate=1', () => {
    const store = new InMemoryCaseInvestigationStore();
    const r = buildInvestigationSlaCompliance(store, 'BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.total_open).toBe(0);
    expect(r.compliant_count).toBe(0);
    expect(r.breached_count).toBe(0);
    expect(r.overall_compliance_rate).toBe(1);
    expect(r.investigations).toEqual([]);
  });

  test('fresh triage investigation (<4h) → sla_met=true', () => {
    const store = new InMemoryCaseInvestigationStore();
    const oneHourAgo = new Date(NOW.getTime() - 1 * 3600000);
    store.open('BANK_DEMO', { case_id: 'CASE-001', customer_id: 'c-1' }, 'alice', oneHourAgo);
    const r = buildInvestigationSlaCompliance(store, 'BANK_DEMO', NOW);
    expect(r.total_open).toBe(1);
    const inv = r.investigations[0];
    expect(inv.status).toBe('triage');
    expect(inv.sla_hours).toBe(SLA_BY_STATUS['triage']); // 4
    expect(inv.sla_met).toBe(true);
  });

  test('old triage investigation (>4h) → sla_met=false (breached)', () => {
    const store = new InMemoryCaseInvestigationStore();
    const fiveHoursAgo = new Date(NOW.getTime() - 5 * 3600000);
    store.open('BANK_DEMO', { case_id: 'CASE-002', customer_id: 'c-2' }, 'alice', fiveHoursAgo);
    const r = buildInvestigationSlaCompliance(store, 'BANK_DEMO', NOW);
    const inv = r.investigations[0];
    expect(inv.sla_met).toBe(false);
    expect(inv.sla_remaining_hours).toBeLessThan(0);
    expect(r.breached_count).toBe(1);
  });

  test('closed investigations excluded', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BANK_DEMO', { case_id: 'CASE-003', customer_id: 'c-3' }, 'alice', NOW);
    // Walk through valid transitions: triage → gathering_evidence → awaiting_response → review → decision → closed
    store.updateStatus('BANK_DEMO', inv.investigation_id, 'gathering_evidence', null, 'alice', NOW);
    store.updateStatus('BANK_DEMO', inv.investigation_id, 'review', null, 'alice', NOW);
    store.updateStatus('BANK_DEMO', inv.investigation_id, 'decision', null, 'alice', NOW);
    store.updateStatus('BANK_DEMO', inv.investigation_id, 'closed', 'fraud_confirmed', 'alice', NOW);
    const r = buildInvestigationSlaCompliance(store, 'BANK_DEMO', NOW);
    expect(r.total_open).toBe(0);
  });

  test('SLA_BY_STATUS exported and has expected values', () => {
    expect(SLA_BY_STATUS['triage']).toBe(4);
    expect(SLA_BY_STATUS['gathering_evidence']).toBe(24);
    expect(SLA_BY_STATUS['review']).toBe(48);
    expect(SLA_BY_STATUS['decision']).toBe(24);
  });

  test('investigations sorted breach-first (most-negative sla_remaining first)', () => {
    const store = new InMemoryCaseInvestigationStore();
    // One barely-breached and one severely-breached
    const t1 = new Date(NOW.getTime() - 5 * 3600000);  // 1h over triage SLA
    const t2 = new Date(NOW.getTime() - 100 * 3600000); // very old
    store.open('BANK_DEMO', { case_id: 'CASE-A', customer_id: 'c-a' }, 'alice', t1);
    store.open('BANK_DEMO', { case_id: 'CASE-B', customer_id: 'c-b' }, 'alice', t2);
    const r = buildInvestigationSlaCompliance(store, 'BANK_DEMO', NOW);
    expect(r.investigations[0].sla_remaining_hours).toBeLessThanOrEqual(
      r.investigations[1].sla_remaining_hours,
    );
  });

  test('overall_compliance_rate = compliant / total', () => {
    const store = new InMemoryCaseInvestigationStore();
    const fresh = new Date(NOW.getTime() - 1 * 3600000);
    const old = new Date(NOW.getTime() - 100 * 3600000);
    store.open('BANK_DEMO', { case_id: 'CASE-X', customer_id: 'c-x' }, 'alice', fresh);
    store.open('BANK_DEMO', { case_id: 'CASE-Y', customer_id: 'c-y' }, 'alice', old);
    const r = buildInvestigationSlaCompliance(store, 'BANK_DEMO', NOW);
    const expected = r.compliant_count / r.total_open;
    expect(r.overall_compliance_rate).toBeCloseTo(expected, 2);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryCaseInvestigationStore();
    expect(() => buildInvestigationSlaCompliance(store, '', NOW)).toThrow();
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BIL',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/investigations/sla-compliance', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/investigations/sla-compliance')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(typeof r.body.body.total_open).toBe('number');
  });

  test('403 for field_officer', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/investigations/sla-compliance')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/investigations/sla-compliance')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });
});
