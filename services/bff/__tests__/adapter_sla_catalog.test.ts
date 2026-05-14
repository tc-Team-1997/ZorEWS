// services/bff/__tests__/adapter_sla_catalog.test.ts
//
// T6 M14.23 — Adapter SLA target catalog.

import request from 'supertest';
import {
  listAdapterSlaCatalog,
  getAdapterSlaTargets,
} from '../src/adapter_sla_catalog';
import { listFleetAdapters } from '../src/adapter_health';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── listAdapterSlaCatalog — pure ────────────────────────────────────

describe('M14.23 — full catalog', () => {
  test('emits one entry per adapter', () => {
    const r = listAdapterSlaCatalog();
    expect(r.total_adapters).toBe(8);
    expect(r.adapters).toHaveLength(8);
  });

  test('every adapter in adapter_health.listFleetAdapters is covered', () => {
    const fleet = listFleetAdapters();
    const ids = new Set(listAdapterSlaCatalog().adapters.map((a) => a.adapter_id));
    for (const a of fleet) {
      expect(ids.has(a.adapter_id)).toBe(true);
    }
  });

  test('adapters sorted by adapter_id asc', () => {
    const r = listAdapterSlaCatalog();
    const ids = r.adapters.map((a) => a.adapter_id);
    expect(ids).toEqual([...ids].sort());
  });

  test('every entry carries the full SLA shape', () => {
    const r = listAdapterSlaCatalog();
    for (const a of r.adapters) {
      expect(typeof a.label).toBe('string');
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.base_path.startsWith('/v1/integrations/')).toBe(true);
      expect(typeof a.expected_latency_ms_p95).toBe('number');
      expect(a.expected_latency_ms_p95).toBeGreaterThan(0);
      expect(typeof a.expected_freshness_minutes).toBe('number');
      expect(a.expected_freshness_minutes).toBeGreaterThan(0);
      expect(typeof a.rate_limit_per_minute).toBe('number');
      expect(a.rate_limit_per_minute).toBeGreaterThan(0);
      expect(a.sla_target_uptime).toBeGreaterThan(0);
      expect(a.sla_target_uptime).toBeLessThanOrEqual(1);
      expect(typeof a.rationale).toBe('string');
      expect(a.rationale.length).toBeGreaterThan(0);
    }
  });

  test('sla_target_uptime in [0, 1] for every adapter', () => {
    const r = listAdapterSlaCatalog();
    for (const a of r.adapters) {
      expect(a.sla_target_uptime).toBeGreaterThanOrEqual(0);
      expect(a.sla_target_uptime).toBeLessThanOrEqual(1);
    }
  });
});

describe('M14.23 — getAdapterSlaTargets', () => {
  test('known adapter id → entry returned', () => {
    const a = getAdapterSlaTargets('aml');
    expect(a).not.toBeNull();
    expect(a!.adapter_id).toBe('aml');
    expect(a!.expected_latency_ms_p95).toBe(500);
  });

  test('bureau is the slowest-latency entry (1500ms)', () => {
    const a = getAdapterSlaTargets('bureau')!;
    const others = listAdapterSlaCatalog()
      .adapters.filter((x) => x.adapter_id !== 'bureau')
      .map((x) => x.expected_latency_ms_p95);
    for (const lat of others) {
      expect(lat).toBeLessThan(a.expected_latency_ms_p95);
    }
  });
});

// ─── GET /v1/integrations/adapters/sla-catalog ───────────────────────

function makeSlaApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M14.23 — GET /v1/integrations/adapters/sla-catalog', () => {
  test('admin → 200 with full catalog', async () => {
    const { app } = makeSlaApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/sla-catalog').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_adapters).toBe(8);
    expect(r.body.body.adapters).toHaveLength(8);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSlaApp('case_owner');
    const r = await request(app).get('/v1/integrations/adapters/sla-catalog').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same response across tenants', async () => {
    const { app } = makeSlaApp('admin');
    const bil = await request(app).get('/v1/integrations/adapters/sla-catalog').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/adapters/sla-catalog')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M14.9 existing /v1/integrations/adapters route still works', async () => {
    const { app } = makeSlaApp('admin');
    const r = await request(app).get('/v1/integrations/adapters').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
