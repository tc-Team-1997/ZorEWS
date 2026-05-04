import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { pingIntegrations, type Fetcher } from '../src/integrations/health';

const NOW = new Date('2026-04-28T12:00:00.000Z');

function makeIntegrationsApp(fetcher: Fetcher, role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    integrationsFetcher: fetcher,
    now: () => NOW,
    getRole: () => role,
  });
}

describe('pingIntegrations()', () => {
  test('returns up for every probe when fetcher returns 200', async () => {
    const fetcher: Fetcher = async () => ({ status: 200 });
    const r = await pingIntegrations({ fetcher, baseUrl: 'http://test', now: () => NOW });
    expect(r.integrations).toHaveLength(4);
    for (const i of r.integrations) {
      expect(i.status).toBe('up');
      expect(i.http_status).toBe(200);
      expect(i.message).toBeUndefined();
      expect(i.latency_ms).toBeGreaterThanOrEqual(0);
    }
    expect(r.base_url).toBe('http://test');
    expect(r.generated_at).toBe(NOW.toISOString());
  });

  test('marks an upstream down on a 5xx response', async () => {
    const fetcher: Fetcher = async (url) =>
      url.includes('/cbs/') ? ({ status: 503 }) : ({ status: 200 });
    const r = await pingIntegrations({ fetcher, baseUrl: 'http://test', now: () => NOW });
    const cbs = r.integrations.find((i) => i.id === 'cbs')!;
    expect(cbs.status).toBe('down');
    expect(cbs.http_status).toBe(503);
    expect(cbs.message).toMatch(/upstream returned 503/);
    const aml = r.integrations.find((i) => i.id === 'aml')!;
    expect(aml.status).toBe('up');
  });

  test('marks an upstream down on network error and reports the message', async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.includes('/aml/')) throw new Error('ECONNREFUSED');
      return { status: 200 };
    };
    const r = await pingIntegrations({ fetcher, baseUrl: 'http://test', now: () => NOW });
    const aml = r.integrations.find((i) => i.id === 'aml')!;
    expect(aml.status).toBe('down');
    expect(aml.http_status).toBe(0);
    expect(aml.message).toMatch(/ECONNREFUSED/);
  });

  test('all four upstream ids are present in the report', async () => {
    const fetcher: Fetcher = async () => ({ status: 200 });
    const r = await pingIntegrations({ fetcher, baseUrl: 'http://test', now: () => NOW });
    const ids = r.integrations.map((i) => i.id).sort();
    expect(ids).toEqual(['aml', 'cbs', 'collection', 'ifrs9']);
  });
});

describe('GET /v1/integrations/health', () => {
  test('admin can read the report', async () => {
    const fetcher: Fetcher = async () => ({ status: 200 });
    const { app } = makeIntegrationsApp(fetcher, 'admin');
    const r = await request(app)
      .get('/v1/integrations/health')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.integrations).toHaveLength(4);
    expect(r.body.body.generated_at).toBe(NOW.toISOString());
  });

  test('supervisor can read the report (audit:read includes them)', async () => {
    const fetcher: Fetcher = async () => ({ status: 200 });
    const { app } = makeIntegrationsApp(fetcher, 'supervisor');
    const r = await request(app)
      .get('/v1/integrations/health')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
  });

  test('field_officer is forbidden (no audit:read)', async () => {
    const fetcher: Fetcher = async () => ({ status: 200 });
    const { app } = makeIntegrationsApp(fetcher, 'field_officer');
    const r = await request(app)
      .get('/v1/integrations/health')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(403);
  });

  test('mixes up + down statuses in the same report', async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.includes('/ifrs9/')) throw new Error('boom');
      if (url.includes('/aml/')) return { status: 500 };
      return { status: 200 };
    };
    const { app } = makeIntegrationsApp(fetcher, 'admin');
    const r = await request(app)
      .get('/v1/integrations/health')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
    const ifrs9 = r.body.body.integrations.find((i: { id: string }) => i.id === 'ifrs9');
    expect(ifrs9.status).toBe('down');
    const aml = r.body.body.integrations.find((i: { id: string }) => i.id === 'aml');
    expect(aml.status).toBe('down');
    const cbs = r.body.body.integrations.find((i: { id: string }) => i.id === 'cbs');
    expect(cbs.status).toBe('up');
  });
});
