// services/bff/__tests__/insurance_fraud.test.ts
//
// Coverage for Insurance EWS Module 3 — Fraud Detection. Pure builders
// (dashboard with network graph + rings, high-risk entities, ad-hoc
// analyze) + the 3 BFF routes.

import request from 'supertest';
import {
  buildFraudDashboard,
  listHighRiskEntities,
  analyzeFraud,
  severityFor,
  FRAUD_ENTITY_TYPES,
  FRAUD_TYPES,
  FRAUD_SEVERITIES,
  FraudError,
} from '../src/insurance_fraud';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-28T12:00:00.000Z');

function makeInsApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── severityFor ─────────────────────────────────────────────────────────

describe('severityFor', () => {
  test('boundary mapping', () => {
    expect(severityFor(0.24)).toBe('low');
    expect(severityFor(0.25)).toBe('medium');
    expect(severityFor(0.5)).toBe('high');
    expect(severityFor(0.75)).toBe('critical');
  });
});

// ─── buildFraudDashboard ─────────────────────────────────────────────────

describe('buildFraudDashboard — pure builder', () => {
  test('shape — totals + 4 widgets', () => {
    const d = buildFraudDashboard('BANK_DEMO', NOW);
    expect(d.tenant_id).toBe('BANK_DEMO');
    expect(d.generated_at).toBe(NOW.toISOString());
    expect(d.totals.entities_tracked).toBeGreaterThan(0);
    expect(d.fraud_network_graph).toBeDefined();
    expect(Array.isArray(d.fraud_network_graph.nodes)).toBe(true);
    expect(Array.isArray(d.fraud_network_graph.edges)).toBe(true);
    expect(Array.isArray(d.high_risk_providers)).toBe(true);
    expect(Array.isArray(d.fraud_ring_detection)).toBe(true);
    expect(Array.isArray(d.identity_risk_analysis)).toBe(true);
  });

  test('deterministic — same (tenant, day) identical', () => {
    const a = buildFraudDashboard('BANK_DEMO', NOW);
    const b = buildFraudDashboard('BANK_DEMO', NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('tenant divergence — BIL tracks fewer entities', () => {
    const bank = buildFraudDashboard('BANK_DEMO', NOW);
    const bil = buildFraudDashboard('BIL', NOW);
    expect(bil.totals.entities_tracked).toBeLessThan(bank.totals.entities_tracked);
  });

  test('fraud rings sorted by ring_risk_score desc', () => {
    const d = buildFraudDashboard('BANK_DEMO', NOW);
    for (let i = 1; i < d.fraud_ring_detection.length; i++) {
      expect(d.fraud_ring_detection[i - 1].ring_risk_score).toBeGreaterThanOrEqual(
        d.fraud_ring_detection[i].ring_risk_score,
      );
    }
  });

  test('network graph expands the top ring — edges reference graph nodes', () => {
    const d = buildFraudDashboard('BANK_DEMO', NOW);
    const ids = new Set(d.fraud_network_graph.nodes.map((n) => n.entity_id));
    for (const e of d.fraud_network_graph.edges) {
      expect(ids.has(e.source_entity_id)).toBe(true);
      expect(ids.has(e.target_entity_id)).toBe(true);
      expect(e.source_entity_id).not.toBe(e.target_entity_id); // no self-loops
    }
  });

  test('high_risk_providers — capped 10, ranked 1..n by risk desc, provider-type only', () => {
    const d = buildFraudDashboard('BANK_DEMO', NOW);
    expect(d.high_risk_providers.length).toBeLessThanOrEqual(10);
    d.high_risk_providers.forEach((p, i) => {
      expect(p.rank).toBe(i + 1);
      expect(['provider', 'hospital', 'garage']).toContain(p.entity_type);
    });
    for (let i = 1; i < d.high_risk_providers.length; i++) {
      expect(d.high_risk_providers[i - 1].risk_score).toBeGreaterThanOrEqual(d.high_risk_providers[i].risk_score);
    }
  });

  test('identity_risk_analysis — capped 10, sorted desc, severity matches', () => {
    const d = buildFraudDashboard('BANK_DEMO', NOW);
    expect(d.identity_risk_analysis.length).toBeLessThanOrEqual(10);
    for (const r of d.identity_risk_analysis) {
      expect(r.identity_risk_score).toBeGreaterThanOrEqual(0);
      expect(r.identity_risk_score).toBeLessThanOrEqual(1);
      expect(r.severity).toBe(severityFor(r.identity_risk_score));
    }
    for (let i = 1; i < d.identity_risk_analysis.length; i++) {
      expect(d.identity_risk_analysis[i - 1].identity_risk_score).toBeGreaterThanOrEqual(
        d.identity_risk_analysis[i].identity_risk_score,
      );
    }
  });

  test('open_fraud_cases counts only detected/investigating rings', () => {
    const d = buildFraudDashboard('BANK_DEMO', NOW);
    const open = d.fraud_ring_detection.filter((r) => r.status === 'detected' || r.status === 'investigating').length;
    expect(d.totals.open_fraud_cases).toBe(open);
  });

  test('empty tenant_id throws', () => {
    expect(() => buildFraudDashboard('', NOW)).toThrow(FraudError);
  });
});

// ─── listHighRiskEntities ────────────────────────────────────────────────

describe('listHighRiskEntities — pure builder', () => {
  test('default returns flagged entities, ranked', () => {
    const l = listHighRiskEntities('BANK_DEMO', NOW);
    expect(l.entity_type_filter).toBe('all');
    l.entities.forEach((e, i) => expect(e.rank).toBe(i + 1));
  });

  test('entity_type=provider narrows', () => {
    const l = listHighRiskEntities('BANK_DEMO', NOW, { entity_type: 'provider' });
    for (const e of l.entities) expect(e.entity_type).toBe('provider');
  });

  test('limit caps rows', () => {
    const l = listHighRiskEntities('BANK_DEMO', NOW, { limit: 3 });
    expect(l.entities.length).toBeLessThanOrEqual(3);
  });

  test('invalid entity_type throws', () => {
    expect(() => listHighRiskEntities('BANK_DEMO', NOW, { entity_type: 'nonsense' })).toThrow(FraudError);
  });

  test('sorted by risk_score desc', () => {
    const l = listHighRiskEntities('BANK_DEMO', NOW);
    for (let i = 1; i < l.entities.length; i++) {
      expect(l.entities[i - 1].risk_score).toBeGreaterThanOrEqual(l.entities[i].risk_score);
    }
  });
});

// ─── analyzeFraud ────────────────────────────────────────────────────────

describe('analyzeFraud — ad-hoc scoring', () => {
  test('clean entity scores low', () => {
    const r = analyzeFraud({ customer_id: 'C1' }, NOW);
    expect(r.fraud_probability).toBeLessThan(0.5);
  });

  test('networked entity scores higher than clean', () => {
    const clean = analyzeFraud({ customer_id: 'C1' }, NOW);
    const networked = analyzeFraud(
      {
        customer_id: 'C1',
        shared_bank_accounts: 3,
        co_claim_count: 5,
        address_matches: 3,
        phone_matches: 3,
        provider_referral_count: 6,
        identity_mismatch_score: 0.8,
        prior_confirmed_fraud: true,
      },
      NOW,
    );
    expect(networked.fraud_probability).toBeGreaterThan(clean.fraud_probability);
  });

  test('high relationship signals raise ring likelihood + classify as ring', () => {
    const r = analyzeFraud(
      { customer_id: 'C1', shared_bank_accounts: 4, co_claim_count: 6, address_matches: 3, phone_matches: 3, provider_referral_count: 7 },
      NOW,
    );
    expect(r.ring_membership_likelihood).toBeGreaterThanOrEqual(0.6);
    expect(r.likely_fraud_type).toBe('ring');
  });

  test('identity mismatch classifies as identity fraud', () => {
    const r = analyzeFraud({ customer_id: 'C1', identity_mismatch_score: 0.9 }, NOW);
    expect(r.likely_fraud_type).toBe('identity');
  });

  test('deterministic — same inputs same score', () => {
    const a = analyzeFraud({ customer_id: 'C9', co_claim_count: 3 }, NOW);
    const b = analyzeFraud({ customer_id: 'C9', co_claim_count: 3 }, NOW);
    expect(a.fraud_probability).toBe(b.fraud_probability);
  });

  test('clamped to [0,1] under extreme inputs', () => {
    const r = analyzeFraud(
      { customer_id: 'C1', shared_bank_accounts: 99, co_claim_count: 99, address_matches: 99, phone_matches: 99, provider_referral_count: 99, identity_mismatch_score: 1, prior_confirmed_fraud: true },
      NOW,
    );
    expect(r.fraud_probability).toBeLessThanOrEqual(1);
    expect(r.ring_membership_likelihood).toBeLessThanOrEqual(1);
  });

  test('severity matches severityFor + signals sorted desc', () => {
    const r = analyzeFraud(
      { customer_id: 'C1', shared_bank_accounts: 3, co_claim_count: 4, identity_mismatch_score: 0.5 },
      NOW,
    );
    expect(r.severity).toBe(severityFor(r.fraud_probability));
    for (let i = 1; i < r.signals.length; i++) {
      expect(r.signals[i - 1].contribution).toBeGreaterThanOrEqual(r.signals[i].contribution);
    }
  });

  test('missing customer_id throws', () => {
    expect(() => analyzeFraud({} as never, NOW)).toThrow(FraudError);
  });

  test('identity_mismatch_score out of [0,1] throws', () => {
    expect(() => analyzeFraud({ customer_id: 'C1', identity_mismatch_score: 1.5 }, NOW)).toThrow(FraudError);
  });

  test('negative signal throws', () => {
    expect(() => analyzeFraud({ customer_id: 'C1', co_claim_count: -1 }, NOW)).toThrow(FraudError);
  });

  test('non-finite signal throws', () => {
    expect(() => analyzeFraud({ customer_id: 'C1', shared_bank_accounts: Infinity }, NOW)).toThrow(FraudError);
  });
});

// ─── enum exports ─────────────────────────────────────────────────────────

describe('exports', () => {
  test('FRAUD_ENTITY_TYPES has 6', () => {
    expect(FRAUD_ENTITY_TYPES).toHaveLength(6);
  });
  test('FRAUD_TYPES has 5', () => {
    expect(FRAUD_TYPES).toHaveLength(5);
  });
  test('FRAUD_SEVERITIES canonical', () => {
    expect(FRAUD_SEVERITIES).toEqual(['low', 'medium', 'high', 'critical']);
  });
});

// ─── routes ─────────────────────────────────────────────────────────────

describe('GET /v1/insurance/fraud/dashboard', () => {
  test('admin happy path — enveloped', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/fraud/dashboard').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.fraud_network_graph).toBeDefined();
    expect(r.body.body.fraud_ring_detection).toBeDefined();
  });

  test('field_officer (read) accepted', async () => {
    const r = await request(makeInsApp('field_officer').app).get('/v1/insurance/fraud/dashboard').set(TH);
    expect(r.status).toBe(200);
  });

  test('tenant scoping — BIL diverges', async () => {
    const bank = await request(makeInsApp('admin').app).get('/v1/insurance/fraud/dashboard').set(TH);
    const bil = await request(makeInsApp('admin').app).get('/v1/insurance/fraud/dashboard').set(TH_BIL);
    expect(bil.body.body.totals.entities_tracked).toBeLessThan(bank.body.body.totals.entities_tracked);
  });

  test('missing tenant header → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/fraud/dashboard').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
  });
});

describe('GET /v1/insurance/fraud/high-risk', () => {
  test('happy path', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/fraud/high-risk').set(TH);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.entities)).toBe(true);
  });

  test('?entity_type=provider narrows', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/fraud/high-risk?entity_type=provider').set(TH);
    for (const e of r.body.body.entities) expect(e.entity_type).toBe('provider');
  });

  test('?entity_type=bogus → 400 invalid_entity_type', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/fraud/high-risk?entity_type=bogus').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_entity_type');
  });
});

describe('POST /v1/insurance/fraud/analyze', () => {
  test('analyst happy path', async () => {
    const r = await request(makeInsApp('risk_analyst').app)
      .post('/v1/insurance/fraud/analyze')
      .set(TH)
      .send({ customer_id: 'C100', shared_bank_accounts: 3, co_claim_count: 4, identity_mismatch_score: 0.6 });
    expect(r.status).toBe(200);
    expect(r.body.body.fraud_probability).toBeGreaterThan(0);
    expect(r.body.body.likely_fraud_type).toBeDefined();
  });

  test('enveloped body accepted', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/fraud/analyze')
      .set(TH)
      .send({ header: {}, body: { customer_id: 'C200', co_claim_count: 2 } });
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('C200');
  });

  test('missing customer_id → 400', async () => {
    const r = await request(makeInsApp('admin').app).post('/v1/insurance/fraud/analyze').set(TH).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('field_officer lacks analyze scope → 403', async () => {
    const r = await request(makeInsApp('field_officer').app)
      .post('/v1/insurance/fraud/analyze')
      .set(TH)
      .send({ customer_id: 'C1' });
    expect(r.status).toBe(403);
  });
});
