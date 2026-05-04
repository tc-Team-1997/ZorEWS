// services/bff/__tests__/exec_watchlist.test.ts
//
// T6 M11.5 — BIL Executive Watchlist.

import request from 'supertest';
import { buildExecutiveWatchlist, type WatchlistItem } from '../src/bil_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeWlApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure builder ──────────────────────────────────────────────────────

describe('buildExecutiveWatchlist — shape', () => {
  test('returns tenant_id + as_of + totals + items[] + by_source', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    expect(w.tenant_id).toBe('BIL');
    expect(w.as_of).toBe(NOW.toISOString());
    expect(typeof w.totals.total_items).toBe('number');
    expect(typeof w.totals.critical).toBe('number');
    expect(typeof w.totals.high).toBe('number');
    expect(typeof w.totals.medium).toBe('number');
    expect(Array.isArray(w.items)).toBe(true);
    expect(w.by_source.claims).toBeDefined();
    expect(w.by_source.underwriting).toBeDefined();
    expect(w.by_source.agent).toBeDefined();
    expect(w.by_source.operational).toBeDefined();
  });

  test('totals.total_items equals items.length', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    expect(w.totals.total_items).toBe(w.items.length);
  });

  test('per-severity totals sum to total_items', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    expect(w.totals.critical + w.totals.high + w.totals.medium).toBe(w.totals.total_items);
  });

  test('by_source counts sum to total_items', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    const sum =
      w.by_source.claims +
      w.by_source.underwriting +
      w.by_source.agent +
      w.by_source.operational;
    expect(sum).toBe(w.totals.total_items);
  });
});

describe('buildExecutiveWatchlist — sourcing', () => {
  test('every item carries a valid source + severity', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    expect(w.items.length).toBeGreaterThan(0);
    for (const it of w.items) {
      expect(['claims', 'underwriting', 'agent', 'operational']).toContain(it.source);
      expect(['critical', 'high', 'medium']).toContain(it.severity);
      expect(typeof it.headline).toBe('string');
      expect(it.headline.length).toBeGreaterThan(0);
      expect(typeof it.id).toBe('string');
      expect(it.id.startsWith(`${it.source}:`)).toBe(true);
    }
  });

  test('items are sorted critical → high → medium', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    const sevRank = (s: WatchlistItem['severity']) =>
      s === 'critical' ? 0 : s === 'high' ? 1 : 2;
    for (let i = 1; i < w.items.length; i++) {
      expect(sevRank(w.items[i - 1]!.severity)).toBeLessThanOrEqual(
        sevRank(w.items[i]!.severity),
      );
    }
  });

  test('item ids are unique within the watchlist', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    const ids = w.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('claims rollup includes top-3 flagged_hospitals (provider rank 1-3)', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    const claimsItems = w.items.filter((i) => i.source === 'claims');
    const providerItems = claimsItems.filter((i) => i.id.startsWith('claims:PRV-'));
    expect(providerItems.length).toBeGreaterThanOrEqual(3);
    for (const it of providerItems) {
      expect(it.severity).toBe('high');
      expect(it.amount_kes).toBeGreaterThan(0);
    }
  });

  test('underwriting rollup includes top-3 high_risk_proposals', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    const uwItems = w.items.filter((i) => i.source === 'underwriting');
    expect(uwItems.length).toBe(3);
    for (const it of uwItems) {
      expect(it.id).toMatch(/^underwriting:PROP-/);
      expect(it.amount_kes).toBeGreaterThan(0);
    }
  });

  test('agent rollup includes top-3 risk_contribution agents', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    const agentItems = w.items.filter((i) => i.source === 'agent');
    expect(agentItems.length).toBe(3);
    for (const it of agentItems) {
      expect(it.id).toMatch(/^agent:AGT-/);
      expect(it.severity).toBe('high');
      expect(it.amount_kes).toBeNull();
    }
  });

  test('operational items (when present) all have severity=critical', () => {
    const w = buildExecutiveWatchlist('BIL', NOW);
    const opsItems = w.items.filter((i) => i.source === 'operational');
    for (const it of opsItems) {
      expect(it.severity).toBe('critical');
      expect(it.amount_kes).toBeNull();
    }
  });
});

describe('buildExecutiveWatchlist — determinism + tenant divergence', () => {
  test('deterministic — same (tenant, day) → same payload', () => {
    const a = buildExecutiveWatchlist('BIL', NOW);
    const b = buildExecutiveWatchlist('BIL', NOW);
    expect(a).toEqual(b);
  });

  test('different tenants → different items', () => {
    const bil = buildExecutiveWatchlist('BIL', NOW);
    const bank = buildExecutiveWatchlist('BANK_DEMO', NOW);
    // Ids embed the dashboard row ids which are tenant-divergent.
    const bilIds = bil.items.map((i) => i.id).join('|');
    const bankIds = bank.items.map((i) => i.id).join('|');
    expect(bilIds).not.toBe(bankIds);
  });

  test('different day → different items', () => {
    const today = buildExecutiveWatchlist('BIL', NOW);
    const tomorrow = buildExecutiveWatchlist('BIL', new Date('2026-05-05T12:00:00.000Z'));
    expect(today.items).not.toEqual(tomorrow.items);
  });
});

// ─── Route ─────────────────────────────────────────────────────────────

describe('GET /v1/dashboards/bil/executive', () => {
  test('admin: 200 with the enveloped watchlist', async () => {
    const { app } = makeWlApp('admin');
    const r = await request(app).get('/v1/dashboards/bil/executive').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(Array.isArray(r.body.body.items)).toBe(true);
    expect(typeof r.body.body.totals.total_items).toBe('number');
  });

  test('non-admin → 403', async () => {
    const { app } = makeWlApp('risk_analyst');
    const r = await request(app).get('/v1/dashboards/bil/executive').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('different tenants get different payloads', async () => {
    const { app } = makeWlApp('admin');
    const bil = await request(app).get('/v1/dashboards/bil/executive').set(TH_BIL);
    const bank = await request(app).get('/v1/dashboards/bil/executive').set(TH_BANK);
    expect(bil.body.body.tenant_id).toBe('BIL');
    expect(bank.body.body.tenant_id).toBe('BANK_DEMO');
    const bilIds = (bil.body.body.items as WatchlistItem[]).map((i) => i.id).join('|');
    const bankIds = (bank.body.body.items as WatchlistItem[]).map((i) => i.id).join('|');
    expect(bilIds).not.toBe(bankIds);
  });

  test('payload is enveloped (header + body) per T4.24 contract', async () => {
    const { app } = makeWlApp('admin');
    const r = await request(app).get('/v1/dashboards/bil/executive').set(TH_BIL);
    expect(r.body.header).toBeDefined();
    expect(r.body.header.status ?? r.body.header.requestId).toBeDefined();
    expect(r.body.body).toBeDefined();
  });
});
