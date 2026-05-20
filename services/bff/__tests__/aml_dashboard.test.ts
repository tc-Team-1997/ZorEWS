// services/bff/__tests__/aml_dashboard.test.ts
//
// Phase C.2 — AML Dashboard rollup tests.

import request from 'supertest';
import {
  AML_HIGH_RISK_COUNTRY_CAP,
  AML_PEP_SAMPLE_CAP,
  buildAmlDashboard,
  summariseAmlMatches,
  type AmlAdapterSummary,
} from '../src/aml/aml_dashboard';
import { InMemoryCustomerMasterStore } from '../src/master/customer_master';
import { InMemoryGeographyMasterStore } from '../src/master/geography_master';
import { InMemoryStrReportStore } from '../src/aml/str_reporting';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeAmlApp(role: string = 'admin', overrides: {
  customerMasterStore?: InMemoryCustomerMasterStore;
  geographyMasterStore?: InMemoryGeographyMasterStore;
  strReportStore?: InMemoryStrReportStore;
} = {}) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    customerMasterStore: overrides.customerMasterStore ?? new InMemoryCustomerMasterStore(),
    geographyMasterStore: overrides.geographyMasterStore ?? new InMemoryGeographyMasterStore(),
    strReportStore: overrides.strReportStore ?? new InMemoryStrReportStore(),
  });
  return app;
}

const validCustomer = (over: Record<string, unknown> = {}) => ({
  customer_id: 'CUST_001',
  customer_type: 'retail' as const,
  kyc_status: 'verified' as const,
  pep_flag: false,
  country: 'IN',
  ...over,
});

const validGeography = (over: Record<string, unknown> = {}) => ({
  country_code: 'IN',
  country_name: 'India',
  risk_level: 'medium' as const,
  sanction_flag: false,
  ...over,
});

const validStr = (over: Record<string, unknown> = {}) => ({
  str_id: 'STR-001',
  customer_id: 'CUST_001',
  reasons: ['unusual_pattern' as const],
  total_amount_kes: 1_500_000,
  transaction_count: 5,
  date_range_start: '2026-04-01T00:00:00.000Z',
  date_range_end: '2026-04-30T23:59:59.000Z',
  narrative: 'Multiple structuring deposits below the threshold within 30 days.',
  ...over,
});

// ─── 1. summariseAmlMatches helper ──────────────────────────────────

describe('summariseAmlMatches', () => {
  test('null → null (adapter unavailable signal)', () => {
    expect(summariseAmlMatches(null)).toBeNull();
  });

  test('empty array → zero-counts summary', () => {
    const s = summariseAmlMatches([]);
    expect(s).toEqual({
      total_screens: 0,
      open_matches: 0,
      cleared_matches: 0,
      escalated_matches: 0,
      false_positive_matches: 0,
      high_severity_open: 0,
      most_recent_screen_at: null,
    });
  });

  test('mixed statuses + severities tallied correctly', () => {
    const s = summariseAmlMatches([
      { status: 'open', severity: 'high', screened_at: '2026-05-15T00:00:00.000Z' },
      { status: 'open', severity: 'medium', screened_at: '2026-05-10T00:00:00.000Z' },
      { status: 'cleared', severity: 'low', screened_at: '2026-05-01T00:00:00.000Z' },
      { status: 'escalated', severity: 'high', screened_at: '2026-05-20T00:00:00.000Z' },
      { status: 'false_positive', severity: 'medium', screened_at: '2026-05-12T00:00:00.000Z' },
    ]);
    expect(s).not.toBeNull();
    expect(s!.total_screens).toBe(5);
    expect(s!.open_matches).toBe(2);
    expect(s!.cleared_matches).toBe(1);
    expect(s!.escalated_matches).toBe(1);
    expect(s!.false_positive_matches).toBe(1);
    expect(s!.high_severity_open).toBe(1); // only open+high
    expect(s!.most_recent_screen_at).toBe('2026-05-20T00:00:00.000Z');
  });

  test('last_checked_at takes precedence over screened_at', () => {
    const s = summariseAmlMatches([
      {
        status: 'open',
        severity: 'medium',
        screened_at: '2026-05-01T00:00:00.000Z',
        last_checked_at: '2026-05-18T00:00:00.000Z',
      },
    ]);
    expect(s!.most_recent_screen_at).toBe('2026-05-18T00:00:00.000Z');
  });

  test('unparseable timestamp ignored', () => {
    const s = summariseAmlMatches([
      { status: 'open', severity: 'low', screened_at: 'not-a-date' },
    ]);
    expect(s!.most_recent_screen_at).toBeNull();
  });
});

// ─── 2. buildAmlDashboard composer ──────────────────────────────────

describe('buildAmlDashboard — pure rollup', () => {
  test('empty state yields zero counts + attention.needs_action=false', () => {
    const r = buildAmlDashboard(
      'BIL',
      new InMemoryCustomerMasterStore(),
      new InMemoryGeographyMasterStore(),
      new InMemoryStrReportStore(),
      null,
      NOW,
    );
    expect(r.tenant_id).toBe('BIL');
    expect(r.str_summary.total_strs).toBe(0);
    expect(r.customer_compliance.pep_customer_count).toBe(0);
    expect(r.geography_risk.sanctioned_country_count).toBe(0);
    expect(r.adapter_activity).toBeNull();
    expect(r.attention.needs_action).toBe(false);
    expect(r.attention.reasons).toEqual([]);
  });

  test('PEP customers counted + sample capped + sorted by id asc', () => {
    const cust = new InMemoryCustomerMasterStore();
    // Insert 15 PEP customers + 5 non-PEP — sample should be top-10 alpha.
    for (let i = 1; i <= 15; i++) {
      cust.create(
        'BIL',
        validCustomer({ customer_id: `PEP_${String(i).padStart(3, '0')}`, pep_flag: true }),
        'a',
        NOW,
      );
    }
    for (let i = 1; i <= 5; i++) {
      cust.create(
        'BIL',
        validCustomer({ customer_id: `STD_${String(i).padStart(3, '0')}`, pep_flag: false }),
        'a',
        NOW,
      );
    }
    const r = buildAmlDashboard(
      'BIL',
      cust,
      new InMemoryGeographyMasterStore(),
      new InMemoryStrReportStore(),
      null,
      NOW,
    );
    expect(r.customer_compliance.pep_customer_count).toBe(15);
    expect(r.customer_compliance.pep_sample.length).toBe(AML_PEP_SAMPLE_CAP);
    expect(r.customer_compliance.pep_sample[0].customer_id).toBe('PEP_001');
    expect(r.customer_compliance.pep_sample[9].customer_id).toBe('PEP_010');
  });

  test('KYC-expiring counts surface correct windows', () => {
    const cust = new InMemoryCustomerMasterStore();
    const within3 = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
    const within15 = new Date(NOW.getTime() + 15 * 86_400_000).toISOString();
    const within60 = new Date(NOW.getTime() + 60 * 86_400_000).toISOString();
    cust.create('BIL', validCustomer({ customer_id: 'A', kyc_expires_at: within3 }), 'a', NOW);
    cust.create('BIL', validCustomer({ customer_id: 'B', kyc_expires_at: within15 }), 'a', NOW);
    cust.create('BIL', validCustomer({ customer_id: 'C', kyc_expires_at: within60 }), 'a', NOW);
    const r = buildAmlDashboard(
      'BIL',
      cust,
      new InMemoryGeographyMasterStore(),
      new InMemoryStrReportStore(),
      null,
      NOW,
    );
    expect(r.customer_compliance.kyc_expiring_count_7d).toBe(1); // only A
    expect(r.customer_compliance.kyc_expiring_count_30d).toBe(2); // A + B
  });

  test('high_risk_override_count counts only risk_category=high overrides', () => {
    const cust = new InMemoryCustomerMasterStore();
    cust.create('BIL', validCustomer({ customer_id: 'H1', risk_category: 'high' }), 'a', NOW);
    cust.create('BIL', validCustomer({ customer_id: 'H2', risk_category: 'high' }), 'a', NOW);
    cust.create('BIL', validCustomer({ customer_id: 'M1', risk_category: 'medium' }), 'a', NOW);
    cust.create('BIL', validCustomer({ customer_id: 'N1', risk_category: null }), 'a', NOW);
    const r = buildAmlDashboard(
      'BIL',
      cust,
      new InMemoryGeographyMasterStore(),
      new InMemoryStrReportStore(),
      null,
      NOW,
    );
    expect(r.customer_compliance.high_risk_override_count).toBe(2);
  });

  test('sanctioned countries surface + high-risk countries cap+sort', () => {
    const geo = new InMemoryGeographyMasterStore();
    // 2 sanctioned (FATF blacklist), 25 high-risk to test cap.
    geo.create('BIL', validGeography({ country_code: 'KP', country_name: 'DPRK', sanction_flag: true, aml_regime: 'fatf_blacklist' }), 'a', NOW);
    geo.create('BIL', validGeography({ country_code: 'IR', country_name: 'Iran', sanction_flag: true, aml_regime: 'fatf_blacklist' }), 'a', NOW);
    for (let i = 0; i < 25; i++) {
      const cc1 = String.fromCharCode(65 + Math.floor(i / 26));
      const cc2 = String.fromCharCode(65 + (i % 26));
      geo.create(
        'BIL',
        validGeography({
          country_code: `${cc1}${cc2}`,
          country_name: `Country_${String(i).padStart(2, '0')}`,
          risk_level: 'high',
        }),
        'a',
        NOW,
      );
    }
    const r = buildAmlDashboard(
      'BIL',
      new InMemoryCustomerMasterStore(),
      geo,
      new InMemoryStrReportStore(),
      null,
      NOW,
    );
    expect(r.geography_risk.sanctioned_country_count).toBe(2);
    expect(r.geography_risk.sanctioned_countries.map((s) => s.country_code).sort()).toEqual(['IR', 'KP']);
    expect(r.geography_risk.high_risk_country_count).toBe(25);
    expect(r.geography_risk.high_risk_countries.length).toBe(AML_HIGH_RISK_COUNTRY_CAP);
    // Sorted by name asc.
    expect(r.geography_risk.high_risk_countries[0].country_name).toBe('Country_00');
    expect(r.geography_risk.high_risk_countries[19].country_name).toBe('Country_19');
  });

  test('attention.needs_action true when STR pending review > 0', () => {
    const str = new InMemoryStrReportStore();
    str.create('BIL', validStr({ str_id: 'STR-A' }), 'alice', NOW);
    str.transition('BIL', 'STR-A', { to: 'ready_for_review' }, 'alice', NOW);
    const r = buildAmlDashboard(
      'BIL',
      new InMemoryCustomerMasterStore(),
      new InMemoryGeographyMasterStore(),
      str,
      null,
      NOW,
    );
    expect(r.attention.needs_action).toBe(true);
    expect(r.attention.reasons.length).toBeGreaterThan(0);
    expect(r.attention.reasons[0]).toMatch(/pending checker review/);
  });

  test('attention.needs_action true when submitted STR awaits FIU-IND ack', () => {
    const str = new InMemoryStrReportStore();
    str.create('BIL', validStr({ str_id: 'STR-A' }), 'alice', NOW);
    str.transition('BIL', 'STR-A', { to: 'ready_for_review' }, 'alice', NOW);
    str.transition(
      'BIL',
      'STR-A',
      { to: 'submitted', checker_username: 'bob.checker' },
      'bob.checker',
      NOW,
    );
    const r = buildAmlDashboard(
      'BIL',
      new InMemoryCustomerMasterStore(),
      new InMemoryGeographyMasterStore(),
      str,
      null,
      NOW,
    );
    expect(r.attention.needs_action).toBe(true);
    expect(r.attention.reasons.some((s) => /awaiting FIU-IND ack/.test(s))).toBe(true);
  });

  test('attention.needs_action true when KYC expiring within 7 days', () => {
    const cust = new InMemoryCustomerMasterStore();
    const within3 = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
    cust.create('BIL', validCustomer({ kyc_expires_at: within3 }), 'a', NOW);
    const r = buildAmlDashboard(
      'BIL',
      cust,
      new InMemoryGeographyMasterStore(),
      new InMemoryStrReportStore(),
      null,
      NOW,
    );
    expect(r.attention.needs_action).toBe(true);
    expect(r.attention.reasons.some((s) => /expiring within 7 days/.test(s))).toBe(true);
  });

  test('attention.needs_action true when adapter high_severity_open > 0', () => {
    const adapterSummary: AmlAdapterSummary = {
      total_screens: 5,
      open_matches: 2,
      cleared_matches: 1,
      escalated_matches: 1,
      false_positive_matches: 1,
      high_severity_open: 1,
      most_recent_screen_at: '2026-05-15T00:00:00.000Z',
    };
    const r = buildAmlDashboard(
      'BIL',
      new InMemoryCustomerMasterStore(),
      new InMemoryGeographyMasterStore(),
      new InMemoryStrReportStore(),
      adapterSummary,
      NOW,
    );
    expect(r.adapter_activity).toEqual(adapterSummary);
    expect(r.attention.needs_action).toBe(true);
    expect(r.attention.reasons.some((s) => /high-severity AML match/.test(s))).toBe(true);
  });

  test('tenant scoping — BIL rollup excludes BANK_DEMO data', () => {
    const cust = new InMemoryCustomerMasterStore();
    cust.create('BIL', validCustomer({ customer_id: 'BIL_PEP', pep_flag: true }), 'a', NOW);
    cust.create('BANK_DEMO', validCustomer({ customer_id: 'BANK_PEP', pep_flag: true }), 'a', NOW);
    const r = buildAmlDashboard(
      'BIL',
      cust,
      new InMemoryGeographyMasterStore(),
      new InMemoryStrReportStore(),
      null,
      NOW,
    );
    expect(r.customer_compliance.pep_customer_count).toBe(1);
    expect(r.customer_compliance.pep_sample[0].customer_id).toBe('BIL_PEP');
  });

  test('generated_at echoes injected now', () => {
    const r = buildAmlDashboard(
      'BIL',
      new InMemoryCustomerMasterStore(),
      new InMemoryGeographyMasterStore(),
      new InMemoryStrReportStore(),
      null,
      NOW,
    );
    expect(r.generated_at).toBe(NOW.toISOString());
  });
});

// ─── 3. Route ────────────────────────────────────────────────────────

describe('GET /v1/aml/dashboard', () => {
  test('admin happy returns enveloped rollup', async () => {
    const app = makeAmlApp('admin');
    const r = await request(app).get('/v1/aml/dashboard').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.str_summary.total_strs).toBe(0);
    expect(r.body.body.attention.needs_action).toBe(false);
    expect(r.body.body.adapter_activity).toBeNull();
  });

  test('reflects state across all 3 stores', async () => {
    const cust = new InMemoryCustomerMasterStore();
    const geo = new InMemoryGeographyMasterStore();
    const str = new InMemoryStrReportStore();

    cust.create('BIL', validCustomer({ pep_flag: true }), 'a', NOW);
    geo.create('BIL', validGeography({ country_code: 'KP', country_name: 'DPRK', sanction_flag: true }), 'a', NOW);
    str.create('BIL', validStr(), 'alice', NOW);
    str.transition('BIL', 'STR-001', { to: 'ready_for_review' }, 'alice', NOW);

    const app = makeAmlApp('admin', {
      customerMasterStore: cust,
      geographyMasterStore: geo,
      strReportStore: str,
    });
    const r = await request(app).get('/v1/aml/dashboard').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.str_summary.pending_review_count).toBe(1);
    expect(r.body.body.customer_compliance.pep_customer_count).toBe(1);
    expect(r.body.body.geography_risk.sanctioned_country_count).toBe(1);
    expect(r.body.body.attention.needs_action).toBe(true);
  });

  test('non-admin → 403', async () => {
    const app = makeAmlApp('field_officer');
    const r = await request(app).get('/v1/aml/dashboard').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('tenant scoping via HTTP — BANK_DEMO sees empty rollup when BIL has data', async () => {
    const cust = new InMemoryCustomerMasterStore();
    cust.create('BIL', validCustomer({ pep_flag: true }), 'a', NOW);
    const app = makeAmlApp('admin', { customerMasterStore: cust });
    const r = await request(app).get('/v1/aml/dashboard').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.customer_compliance.pep_customer_count).toBe(0);
  });

  test('missing tenant header → 400 envelope', async () => {
    const app = makeAmlApp('admin');
    const r = await request(app).get('/v1/aml/dashboard');
    expect(r.status).toBe(400);
  });
});
