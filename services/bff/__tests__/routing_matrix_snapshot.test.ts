// services/bff/__tests__/routing_matrix_snapshot.test.ts
//
// T6 M8.8 — Alert routing matrix snapshot + fingerprint.

import request from 'supertest';
import {
  computeRoutingMatrixFingerprint,
  listRoutingMatrix,
} from '../src/routing_matrix_snapshot';
import {
  InMemoryAlertRoutingEngine,
  DEFAULT_RULES,
  type RoutingRule,
} from '../src/alert_routing';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── computeRoutingMatrixFingerprint — pure ──────────────────────────

describe('M8.8 — computeRoutingMatrixFingerprint', () => {
  test('returns a 64-char SHA-256 hex', () => {
    const fp = computeRoutingMatrixFingerprint(DEFAULT_RULES);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  test('deterministic: same matrix → same fingerprint', () => {
    const fp1 = computeRoutingMatrixFingerprint(DEFAULT_RULES);
    const fp2 = computeRoutingMatrixFingerprint(DEFAULT_RULES);
    expect(fp1).toBe(fp2);
  });

  test('any change flips the fingerprint', () => {
    const fp0 = computeRoutingMatrixFingerprint(DEFAULT_RULES);
    const modified = {
      ...DEFAULT_RULES,
      red: { ...DEFAULT_RULES.red, sla_hours: 2 },
    };
    const fp1 = computeRoutingMatrixFingerprint(modified);
    expect(fp1).not.toBe(fp0);
  });

  test('channel-order change flips fingerprint', () => {
    const fp0 = computeRoutingMatrixFingerprint(DEFAULT_RULES);
    const reordered = {
      ...DEFAULT_RULES,
      red: { ...DEFAULT_RULES.red, channels: ['sms', 'email'] as RoutingRule['channels'] },
    };
    const fp1 = computeRoutingMatrixFingerprint(reordered);
    expect(fp1).not.toBe(fp0);
  });
});

// ─── listRoutingMatrix — pure (with engine) ──────────────────────────

describe('M8.8 — listRoutingMatrix — defaults', () => {
  test('untouched tenant → 4 rows all sourced platform_default', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const snapshot = listRoutingMatrix(engine, 'BIL');
    expect(snapshot.tenant_id).toBe('BIL');
    expect(snapshot.rows).toHaveLength(4);
    expect(snapshot.rows.map((r) => r.class)).toEqual(['red', 'orange', 'yellow', 'green']);
    for (const row of snapshot.rows) {
      expect(row.source).toBe('platform_default');
    }
    expect(snapshot.override_count).toBe(0);
    expect(snapshot.fingerprint).toBe(computeRoutingMatrixFingerprint(DEFAULT_RULES));
  });
});

describe('M8.8 — listRoutingMatrix — with overrides', () => {
  test('override flips one row source + bumps override_count + changes fingerprint', () => {
    const engine = new InMemoryAlertRoutingEngine();
    engine.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    const snapshot = listRoutingMatrix(engine, 'BIL');
    expect(snapshot.override_count).toBe(1);
    const redRow = snapshot.rows.find((r) => r.class === 'red')!;
    expect(redRow.source).toBe('tenant_override');
    expect(redRow.rule.sla_hours).toBe(2);
    const orangeRow = snapshot.rows.find((r) => r.class === 'orange')!;
    expect(orangeRow.source).toBe('platform_default');
    // Fingerprint differs from defaults
    expect(snapshot.fingerprint).not.toBe(computeRoutingMatrixFingerprint(DEFAULT_RULES));
  });

  test('cross-tenant isolation: BIL override invisible to BANK_DEMO', () => {
    const engine = new InMemoryAlertRoutingEngine();
    engine.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    const bil = listRoutingMatrix(engine, 'BIL');
    const bank = listRoutingMatrix(engine, 'BANK_DEMO');
    expect(bil.override_count).toBe(1);
    expect(bank.override_count).toBe(0);
    expect(bil.fingerprint).not.toBe(bank.fingerprint);
  });
});

// ─── GET /v1/alerts/routing/matrix ───────────────────────────────────

function makeMatrixApp(role = 'admin') {
  const alertRoutingEngine = new InMemoryAlertRoutingEngine();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    alertRoutingEngine,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, alertRoutingEngine };
}

describe('M8.8 — GET /v1/alerts/routing/matrix', () => {
  test('untouched tenant → 200 with 4 default rows', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app).get('/v1/alerts/routing/matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toHaveLength(4);
    expect(r.body.body.override_count).toBe(0);
    expect(r.body.body.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('after override, fingerprint changes', async () => {
    const { app, alertRoutingEngine } = makeMatrixApp('admin');
    const r1 = await request(app).get('/v1/alerts/routing/matrix').set(TH_BIL);
    alertRoutingEngine.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    const r2 = await request(app).get('/v1/alerts/routing/matrix').set(TH_BIL);
    expect(r1.body.body.fingerprint).not.toBe(r2.body.body.fingerprint);
    expect(r2.body.body.override_count).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMatrixApp('case_owner');
    const r = await request(app).get('/v1/alerts/routing/matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL override invisible to BANK_DEMO', async () => {
    const { app, alertRoutingEngine } = makeMatrixApp('admin');
    alertRoutingEngine.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    const r = await request(app)
      .get('/v1/alerts/routing/matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.override_count).toBe(0);
  });

  test('M8.2 /routing/rules still works (route ordering)', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app).get('/v1/alerts/routing/rules').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
