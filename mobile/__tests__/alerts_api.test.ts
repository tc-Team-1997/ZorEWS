// T4.3 — AlertsApi method wrappers.

import { ApiClient } from '../src/api/client';
import { AlertsApi } from '../src/api/alerts';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function setup(opts: { status?: number; body?: unknown } = {}) {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    captured.push({ url, init });
    return {
      status: opts.status ?? 200,
      async json() {
        return (
          opts.body ?? {
            header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
            body: { total: 0, items: [] },
          }
        );
      },
    } as unknown as Response;
  }) as typeof fetch;
  const client = new ApiClient({
    baseUrl: 'https://bff.test',
    getAccessToken: async () => 'tkn',
    getTenantId: async () => 'BANK_DEMO',
    getActor: async () => 'alice',
    fetchImpl,
  });
  return { client, captured, api: new AlertsApi(client) };
}

describe('AlertsApi.list', () => {
  test('GETs /v1/alerts with default sort=criticality', async () => {
    const { api, captured } = setup({
      body: {
        header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
        body: { total: 2, items: [] },
      },
    });
    const out = await api.list();
    expect(captured[0].url).toBe('https://bff.test/v1/alerts?sort=criticality');
    expect(out.total).toBe(2);
  });

  test('passes severity + status + customer_id + dedup query params', async () => {
    const { api, captured } = setup();
    await api.list({
      severity: 'high',
      status: 'open',
      customer_id: 'CUST-1',
      sort: 'age',
      dedup: true,
      limit: 50,
    });
    const url = new URL(captured[0].url);
    expect(url.searchParams.get('severity')).toBe('high');
    expect(url.searchParams.get('status')).toBe('open');
    expect(url.searchParams.get('customer_id')).toBe('CUST-1');
    expect(url.searchParams.get('sort')).toBe('age');
    expect(url.searchParams.get('dedup')).toBe('true');
    expect(url.searchParams.get('limit')).toBe('50');
  });
});

describe('AlertsApi.getAckState', () => {
  test('encodes alert_id', async () => {
    const { api, captured } = setup({
      body: {
        header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
        body: { alert_id: 'a/1', status: 'open', acked_by: null, acked_at: null, ack_notes: null },
      },
    });
    await api.getAckState('a/1');
    expect(captured[0].url).toBe('https://bff.test/v1/alerts/a%2F1/ack');
  });
});

describe('AlertsApi.acknowledge', () => {
  test('POSTs notes', async () => {
    const { api, captured } = setup({
      body: {
        header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
        body: { alert_id: 'a-1', status: 'acknowledged', acked_by: 'alice', acked_at: '2026-05-21T00:00:00Z', ack_notes: 'seen' },
      },
    });
    const out = await api.acknowledge('a-1', 'seen');
    expect(captured[0].init?.method).toBe('POST');
    expect(captured[0].init?.body).toBe(JSON.stringify({ notes: 'seen' }));
    expect(out.status).toBe('acknowledged');
  });
});

describe('AlertsApi.unacknowledge', () => {
  test('POSTs reason', async () => {
    const { api, captured } = setup({
      body: {
        header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
        body: { alert_id: 'a-1', status: 'open', acked_by: null, acked_at: null, ack_notes: null },
      },
    });
    await api.unacknowledge('a-1', 'mis-click');
    expect(captured[0].url).toBe('https://bff.test/v1/alerts/a-1/unack');
    expect(captured[0].init?.body).toBe(JSON.stringify({ reason: 'mis-click' }));
  });
});
