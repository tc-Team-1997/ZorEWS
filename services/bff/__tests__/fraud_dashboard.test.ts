// services/bff/__tests__/fraud_dashboard.test.ts
//
// Phase C.3 — Fraud Monitoring dashboard tests.

import request from 'supertest';
import {
  buildFraudDashboard,
  countFraudIndicatorSignals,
  filterFraudAlerts,
  FRAUD_ALERT_SAMPLE_CAP,
  FRAUD_INDICATOR_CATALOG,
  FRAUD_OPEN_INVESTIGATION_CAP,
  FRAUD_SEED_RULE_IDS,
  projectFraudInvestigations,
  type FraudAlertSample,
  type FraudInvestigationSample,
} from '../src/fraud/fraud_dashboard';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryCaseInvestigationStore } from '../src/case_investigation';
import type { CanonicalAlert } from '../src/types';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeFraudApp(role: string = 'admin', overrides: {
  source?: StaticSource;
  caseInvestigationStore?: InMemoryCaseInvestigationStore;
} = {}) {
  const { app } = makeApp({
    source: overrides.source ?? new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    caseInvestigationStore: overrides.caseInvestigationStore ?? new InMemoryCaseInvestigationStore(),
  });
  return app;
}

const fraudAlert = (over: Partial<CanonicalAlert> = {}): CanonicalAlert => ({
  alert_id: 'a-001',
  raised_at: NOW.toISOString(),
  customer_id: 'CUST_001',
  severity: 'HIGH',
  rule_id: 'RULE-031',
  indicators_fired: ['FRD-001'],
  ...over,
});

// ─── 1. Constants ────────────────────────────────────────────────────

describe('fraud_dashboard constants', () => {
  test('FRAUD_SEED_RULE_IDS includes RULE-031..033', () => {
    expect(FRAUD_SEED_RULE_IDS).toEqual(['RULE-031', 'RULE-032', 'RULE-033']);
  });
  test('FRAUD_INDICATOR_CATALOG covers 4 FRD-NNN ids', () => {
    expect(FRAUD_INDICATOR_CATALOG.length).toBe(4);
    expect(FRAUD_INDICATOR_CATALOG.map((i) => i.indicator_id)).toEqual([
      'FRD-001', 'FRD-002', 'FRD-003', 'FRD-004',
    ]);
  });
});

// ─── 2. filterFraudAlerts ────────────────────────────────────────────

describe('filterFraudAlerts', () => {
  test('keeps alerts tagged with FRD- indicator', () => {
    const out = filterFraudAlerts(
      [fraudAlert({ indicators_fired: ['FRD-002'], rule_id: 'RULE-XYZ' })],
      [],
    );
    expect(out.length).toBe(1);
    expect(out[0].indicator_id).toBe('FRD-002');
  });

  test('keeps alerts whose rule_id is in fraud_rule_ids', () => {
    const out = filterFraudAlerts(
      [fraudAlert({ indicators_fired: ['FIN-001'], rule_id: 'RULE-031' })],
      ['RULE-031'],
    );
    expect(out.length).toBe(1);
    expect(out[0].indicator_id).toBeNull(); // no FRD-* indicator
  });

  test('drops alerts with neither FRD-* nor matching rule_id', () => {
    const out = filterFraudAlerts(
      [fraudAlert({ indicators_fired: ['FIN-001'], rule_id: 'RULE-XYZ' })],
      ['RULE-031'],
    );
    expect(out.length).toBe(0);
  });

  test('lowercases severity', () => {
    const out = filterFraudAlerts(
      [fraudAlert({ severity: 'CRITICAL' as never })],
      [],
    );
    expect(out[0].severity).toBe('critical');
  });

  test('drops unknown severity values', () => {
    const out = filterFraudAlerts(
      [fraudAlert({ severity: 'INFO' as never })],
      [],
    );
    expect(out.length).toBe(0);
  });

  test('reads raised_at + falls back to created_at', () => {
    const out = filterFraudAlerts(
      [
        fraudAlert({ alert_id: 'a-1', raised_at: undefined as unknown as string, indicators_fired: ['FRD-001'] }),
      ],
      [],
    );
    // raised_at undefined + created_at undefined → fallback epoch.
    expect(out[0].created_at).toBe(new Date(0).toISOString());
  });

  test('primary indicator picks first FRD-* in array', () => {
    const out = filterFraudAlerts(
      [fraudAlert({ indicators_fired: ['FIN-001', 'FRD-002', 'FRD-003'] })],
      [],
    );
    expect(out[0].indicator_id).toBe('FRD-002');
  });
});

// ─── 3. countFraudIndicatorSignals ──────────────────────────────────

describe('countFraudIndicatorSignals', () => {
  test('counts fires per indicator across 24h + 7d windows', () => {
    const minus2h = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const minus3d = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const minus10d = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const signals = countFraudIndicatorSignals(
      [
        { indicators_fired: ['FRD-001'], raised_at: minus2h },
        { indicators_fired: ['FRD-001'], raised_at: minus3d },
        { indicators_fired: ['FRD-001'], raised_at: minus10d },
        { indicators_fired: ['FRD-002'], raised_at: minus2h },
      ],
      NOW,
    );
    const frd1 = signals.find((s) => s.indicator_id === 'FRD-001')!;
    expect(frd1.fires_24h).toBe(1);
    expect(frd1.fires_7d).toBe(2);
    const frd2 = signals.find((s) => s.indicator_id === 'FRD-002')!;
    expect(frd2.fires_24h).toBe(1);
    expect(frd2.fires_7d).toBe(1);
    const frd3 = signals.find((s) => s.indicator_id === 'FRD-003')!;
    expect(frd3.fires_24h).toBe(0);
  });

  test('alerts without indicators_fired don\'t blow up', () => {
    const signals = countFraudIndicatorSignals(
      [{ raised_at: NOW.toISOString() }],
      NOW,
    );
    expect(signals.length).toBe(4);
    expect(signals.every((s) => s.fires_24h === 0)).toBe(true);
  });

  test('returns all 4 catalog entries even when zero fires', () => {
    const signals = countFraudIndicatorSignals([], NOW);
    expect(signals.length).toBe(4);
    expect(signals.map((s) => s.indicator_id).sort()).toEqual([
      'FRD-001', 'FRD-002', 'FRD-003', 'FRD-004',
    ]);
  });
});

// ─── 4. projectFraudInvestigations ──────────────────────────────────

describe('projectFraudInvestigations', () => {
  function mkInv(over: Partial<{ investigation_id: string; case_id: string; status: string; decision: string | null; opened_at: string }> = {}) {
    return {
      investigation_id: 'inv-1',
      case_id: 'case-1',
      status: 'triage',
      decision: null as string | null,
      opened_at: NOW.toISOString(),
      ...over,
    };
  }

  test('includes still-open investigations regardless of decision', () => {
    const out = projectFraudInvestigations([mkInv()], NOW);
    expect(out.length).toBe(1);
    expect(out[0].status).toBe('triage');
  });

  test('includes closed investigations whose decision is fraud-related', () => {
    const out = projectFraudInvestigations(
      [
        mkInv({ status: 'closed', decision: 'fraud_confirmed' }),
        mkInv({ investigation_id: 'inv-2', status: 'closed', decision: 'partial_fraud' }),
        mkInv({ investigation_id: 'inv-3', status: 'closed', decision: 'data_quality' }),
        mkInv({ investigation_id: 'inv-4', status: 'closed', decision: 'fraud_unsubstantiated' }),
      ],
      NOW,
    );
    expect(out.length).toBe(4);
  });

  test('excludes closed-with-null-decision', () => {
    const out = projectFraudInvestigations(
      [mkInv({ status: 'closed', decision: null })],
      NOW,
    );
    expect(out.length).toBe(0);
  });

  test('age_hours computed from opened_at', () => {
    const past = new Date(NOW.getTime() - 5 * 3_600_000).toISOString();
    const out = projectFraudInvestigations(
      [mkInv({ opened_at: past })],
      NOW,
    );
    expect(out[0].age_hours).toBeCloseTo(5.0, 1);
  });
});

// ─── 5. buildFraudDashboard ─────────────────────────────────────────

describe('buildFraudDashboard pure rollup', () => {
  test('empty input → zero counts + attention because no active rules', () => {
    const r = buildFraudDashboard(
      {
        tenant_id: 'BIL',
        fraud_indicator_signals: [],
        fraud_alerts: [],
        fraud_investigations: [],
        active_fraud_rule_ids: [],
      },
      NOW,
    );
    expect(r.totals.fraud_alerts_24h).toBe(0);
    expect(r.outcome_breakdown.fraud_confirmed).toBe(0);
    // Zero active rules → ops red flag.
    expect(r.attention.needs_action).toBe(true);
    expect(r.attention.reasons[0]).toMatch(/fraud monitoring is OFF/);
  });

  test('rules present → no "fraud monitoring is OFF" reason', () => {
    const r = buildFraudDashboard(
      {
        tenant_id: 'BIL',
        fraud_indicator_signals: [],
        fraud_alerts: [],
        fraud_investigations: [],
        active_fraud_rule_ids: ['RULE-031'],
      },
      NOW,
    );
    expect(r.attention.needs_action).toBe(false);
    expect(r.active_fraud_rules.count).toBe(1);
  });

  test('alerts capped at FRAUD_ALERT_SAMPLE_CAP + sorted newest-first', () => {
    const alerts: FraudAlertSample[] = Array.from({ length: 15 }, (_, i) => ({
      alert_id: `a-${String(i).padStart(3, '0')}`,
      customer_id: 'C1',
      rule_id: 'RULE-031',
      severity: 'high' as const,
      created_at: new Date(NOW.getTime() - i * 60_000).toISOString(),
      indicator_id: 'FRD-001',
    }));
    const r = buildFraudDashboard(
      {
        tenant_id: 'BIL',
        fraud_indicator_signals: [],
        fraud_alerts: alerts,
        fraud_investigations: [],
        active_fraud_rule_ids: ['RULE-031'],
      },
      NOW,
    );
    expect(r.recent_alerts.length).toBe(FRAUD_ALERT_SAMPLE_CAP);
    // Newest first — a-000 was created at NOW, a-001 a minute earlier...
    expect(r.recent_alerts[0].alert_id).toBe('a-000');
    expect(r.recent_alerts[9].alert_id).toBe('a-009');
  });

  test('fraud_alerts_24h vs fraud_alerts_7d window counts', () => {
    const minus2h = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const minus3d = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const minus10d = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const alerts: FraudAlertSample[] = [
      { alert_id: 'a-recent', customer_id: 'C', rule_id: 'RULE-031', severity: 'high', created_at: minus2h, indicator_id: 'FRD-001' },
      { alert_id: 'a-3d', customer_id: 'C', rule_id: 'RULE-031', severity: 'high', created_at: minus3d, indicator_id: 'FRD-001' },
      { alert_id: 'a-10d', customer_id: 'C', rule_id: 'RULE-031', severity: 'high', created_at: minus10d, indicator_id: 'FRD-001' },
    ];
    const r = buildFraudDashboard(
      {
        tenant_id: 'BIL',
        fraud_indicator_signals: [],
        fraud_alerts: alerts,
        fraud_investigations: [],
        active_fraud_rule_ids: ['RULE-031'],
      },
      NOW,
    );
    expect(r.totals.fraud_alerts_24h).toBe(1);
    expect(r.totals.fraud_alerts_7d).toBe(2);
    expect(r.attention.needs_action).toBe(true);
    expect(r.attention.reasons.some((s) => /fraud alert.*last 24h/.test(s))).toBe(true);
  });

  test('outcome breakdown counts by decision', () => {
    const investigations: FraudInvestigationSample[] = [
      { investigation_id: 'i-1', case_id: 'c-1', status: 'closed', decision: 'fraud_confirmed', opened_at: NOW.toISOString(), age_hours: 24 },
      { investigation_id: 'i-2', case_id: 'c-2', status: 'closed', decision: 'fraud_confirmed', opened_at: NOW.toISOString(), age_hours: 24 },
      { investigation_id: 'i-3', case_id: 'c-3', status: 'closed', decision: 'partial_fraud', opened_at: NOW.toISOString(), age_hours: 24 },
      { investigation_id: 'i-4', case_id: 'c-4', status: 'closed', decision: 'fraud_unsubstantiated', opened_at: NOW.toISOString(), age_hours: 24 },
      { investigation_id: 'i-5', case_id: 'c-5', status: 'closed', decision: 'data_quality', opened_at: NOW.toISOString(), age_hours: 24 },
      { investigation_id: 'i-6', case_id: 'c-6', status: 'triage', decision: null, opened_at: NOW.toISOString(), age_hours: 1 },
    ];
    const r = buildFraudDashboard(
      {
        tenant_id: 'BIL',
        fraud_indicator_signals: [],
        fraud_alerts: [],
        fraud_investigations: investigations,
        active_fraud_rule_ids: ['RULE-031'],
      },
      NOW,
    );
    expect(r.outcome_breakdown.fraud_confirmed).toBe(2);
    expect(r.outcome_breakdown.partial_fraud).toBe(1);
    expect(r.outcome_breakdown.fraud_unsubstantiated).toBe(1);
    expect(r.outcome_breakdown.data_quality).toBe(1);
    expect(r.outcome_breakdown.unresolved).toBe(1);
    expect(r.totals.open_investigations).toBe(1);
    expect(r.totals.confirmed_fraud_count).toBe(2);
    expect(r.attention.reasons.some((s) => /confirmed-fraud investigation/.test(s))).toBe(true);
  });

  test('oldest_open_investigations sorted by opened_at asc, capped', () => {
    const investigations: FraudInvestigationSample[] = Array.from({ length: 15 }, (_, i) => ({
      investigation_id: `inv-${String(i).padStart(3, '0')}`,
      case_id: `c-${i}`,
      status: 'triage',
      decision: null,
      opened_at: new Date(NOW.getTime() - (15 - i) * 3_600_000).toISOString(),
      age_hours: 15 - i,
    }));
    const r = buildFraudDashboard(
      {
        tenant_id: 'BIL',
        fraud_indicator_signals: [],
        fraud_alerts: [],
        fraud_investigations: investigations,
        active_fraud_rule_ids: ['RULE-031'],
      },
      NOW,
    );
    expect(r.oldest_open_investigations.length).toBe(FRAUD_OPEN_INVESTIGATION_CAP);
    // Oldest first — inv-000 was opened 15h ago, inv-001 14h ago, etc.
    expect(r.oldest_open_investigations[0].investigation_id).toBe('inv-000');
  });

  test('throws on empty tenant_id', () => {
    expect(() =>
      buildFraudDashboard(
        {
          tenant_id: '',
          fraud_indicator_signals: [],
          fraud_alerts: [],
          fraud_investigations: [],
          active_fraud_rule_ids: ['RULE-031'],
        },
        NOW,
      ),
    ).toThrow();
  });

  test('generated_at echoes NOW', () => {
    const r = buildFraudDashboard(
      {
        tenant_id: 'BIL',
        fraud_indicator_signals: [],
        fraud_alerts: [],
        fraud_investigations: [],
        active_fraud_rule_ids: ['RULE-031'],
      },
      NOW,
    );
    expect(r.generated_at).toBe(NOW.toISOString());
  });
});

// ─── 6. Route ────────────────────────────────────────────────────────

describe('GET /v1/fraud/dashboard', () => {
  test('admin happy returns enveloped rollup', async () => {
    const app = makeFraudApp('admin');
    const r = await request(app).get('/v1/fraud/dashboard').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.active_fraud_rules.count).toBe(3); // seed RULE-031..033
    expect(r.body.body.indicator_signals.length).toBe(4);
  });

  test('source-fed fraud alerts surface in recent_alerts', async () => {
    const src = new StaticSource([
      fraudAlert({ alert_id: 'frd-a', indicators_fired: ['FRD-002'] }),
      fraudAlert({
        alert_id: 'std-a',
        rule_id: 'RULE-005',
        indicators_fired: ['FIN-001'],
      }),
    ]);
    const app = makeFraudApp('admin', { source: src });
    const r = await request(app).get('/v1/fraud/dashboard').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.recent_alerts.length).toBe(1);
    expect(r.body.body.recent_alerts[0].alert_id).toBe('frd-a');
    expect(r.body.body.totals.fraud_alerts_24h).toBeGreaterThanOrEqual(1);
  });

  test('indicator_signals counts per FRD-* indicator', async () => {
    const src = new StaticSource([
      fraudAlert({ alert_id: 'a1', indicators_fired: ['FRD-001'] }),
      fraudAlert({ alert_id: 'a2', indicators_fired: ['FRD-001'] }),
      fraudAlert({ alert_id: 'a3', indicators_fired: ['FRD-003'] }),
    ]);
    const app = makeFraudApp('admin', { source: src });
    const r = await request(app).get('/v1/fraud/dashboard').set(TH_BIL);
    const frd1 = r.body.body.indicator_signals.find((s: { indicator_id: string }) => s.indicator_id === 'FRD-001');
    expect(frd1.fires_24h).toBe(2);
    const frd3 = r.body.body.indicator_signals.find((s: { indicator_id: string }) => s.indicator_id === 'FRD-003');
    expect(frd3.fires_24h).toBe(1);
    const frd2 = r.body.body.indicator_signals.find((s: { indicator_id: string }) => s.indicator_id === 'FRD-002');
    expect(frd2.fires_24h).toBe(0);
  });

  test('investigations surface in outcome_breakdown', async () => {
    const invStore = new InMemoryCaseInvestigationStore();
    // Open + confirm-close one investigation.
    const inv1 = invStore.open(
      'BIL',
      { case_id: 'case-1', customer_id: 'C1' },
      'alice',
      NOW,
    );
    invStore.updateStatus(
      'BIL',
      inv1.investigation_id,
      'closed',
      'fraud_confirmed',
      'alice',
      NOW,
    );
    const app = makeFraudApp('admin', { caseInvestigationStore: invStore });
    const r = await request(app).get('/v1/fraud/dashboard').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.outcome_breakdown.fraud_confirmed).toBe(1);
    expect(r.body.body.totals.confirmed_fraud_count).toBe(1);
    expect(r.body.body.attention.needs_action).toBe(true);
  });

  test('non-admin → 403', async () => {
    const app = makeFraudApp('field_officer');
    const r = await request(app).get('/v1/fraud/dashboard').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('tenant scoping — BANK_DEMO sees its own investigations', async () => {
    const invStore = new InMemoryCaseInvestigationStore();
    invStore.open(
      'BIL',
      { case_id: 'case-bil', customer_id: 'C_BIL' },
      'alice',
      NOW,
    );
    const app = makeFraudApp('admin', { caseInvestigationStore: invStore });
    const r = await request(app).get('/v1/fraud/dashboard').set(TH_BANK);
    expect(r.body.body.totals.open_investigations).toBe(0);
  });

  test('missing tenant header → 400', async () => {
    const app = makeFraudApp('admin');
    const r = await request(app).get('/v1/fraud/dashboard');
    expect(r.status).toBe(400);
  });
});
