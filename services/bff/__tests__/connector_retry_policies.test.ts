// services/bff/__tests__/connector_retry_policies.test.ts
//
// T6 M3.10 — Connector retry policy catalog.

import request from 'supertest';
import {
  listConnectorRetryPolicies,
  getConnectorRetryPolicy,
} from '../src/connector_retry_policies';
import { SEED_CONNECTORS } from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── listConnectorRetryPolicies — pure ───────────────────────────────

describe('M3.10 — catalog', () => {
  test('every seed connector has a policy', () => {
    const r = listConnectorRetryPolicies();
    expect(r.total_connectors).toBe(SEED_CONNECTORS.length);
    const ids = new Set(r.policies.map((p) => p.connector_id));
    for (const c of SEED_CONNECTORS) {
      expect(ids.has(c.id)).toBe(true);
    }
  });

  test('policies sorted by connector_id asc', () => {
    const r = listConnectorRetryPolicies();
    const ids = r.policies.map((p) => p.connector_id);
    expect(ids).toEqual([...ids].sort());
  });

  test('every policy has the full shape', () => {
    const r = listConnectorRetryPolicies();
    for (const p of r.policies) {
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
      expect(typeof p.max_retries).toBe('number');
      expect(p.max_retries).toBeGreaterThanOrEqual(0);
      expect(['linear', 'exponential', 'none']).toContain(p.backoff_strategy);
      expect(p.initial_backoff_seconds).toBeGreaterThanOrEqual(0);
      expect(p.max_backoff_seconds).toBeGreaterThanOrEqual(p.initial_backoff_seconds);
      expect(Array.isArray(p.retryable_error_codes)).toBe(true);
      expect(typeof p.dead_letter_enabled).toBe('boolean');
    }
  });

  test('kafka_stream connectors share the same policy', () => {
    const r = listConnectorRetryPolicies();
    const kafka = r.policies.filter((p) => p.type === 'kafka_stream');
    expect(kafka.length).toBeGreaterThan(0);
    const first = kafka[0]!;
    for (const p of kafka) {
      expect(p.max_retries).toBe(first.max_retries);
      expect(p.backoff_strategy).toBe(first.backoff_strategy);
    }
  });

  test('rest_api policy uses exponential backoff', () => {
    const r = listConnectorRetryPolicies();
    const rest = r.policies.find((p) => p.type === 'rest_api')!;
    expect(rest.backoff_strategy).toBe('exponential');
    expect(rest.retryable_error_codes).toContain('429_rate_limit');
  });

  test('deep copies: mutating returned arrays does not pollute singleton', () => {
    const r1 = listConnectorRetryPolicies();
    r1.policies[0]!.retryable_error_codes.push('injected_code');
    const r2 = listConnectorRetryPolicies();
    expect(r2.policies[0]!.retryable_error_codes).not.toContain('injected_code');
  });
});

describe('M3.10 — getConnectorRetryPolicy', () => {
  test('known id → policy', () => {
    const p = getConnectorRetryPolicy('cbs_loan_book')!;
    expect(p.connector_id).toBe('cbs_loan_book');
    expect(p.type).toBe('kafka_stream');
  });

  test('unknown id → null', () => {
    expect(getConnectorRetryPolicy('not-a-real-connector')).toBeNull();
  });
});

// ─── GET /v1/ingestion/retry-policies ────────────────────────────────

function makeRetryApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M3.10 — GET /v1/ingestion/retry-policies', () => {
  test('admin → 200 with full catalog', async () => {
    const { app } = makeRetryApp('admin');
    const r = await request(app).get('/v1/ingestion/retry-policies').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_connectors).toBe(SEED_CONNECTORS.length);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRetryApp('case_owner');
    const r = await request(app).get('/v1/ingestion/retry-policies').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same across tenants', async () => {
    const { app } = makeRetryApp('admin');
    const bil = await request(app).get('/v1/ingestion/retry-policies').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/ingestion/retry-policies')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });
});
