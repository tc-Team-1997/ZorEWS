// T4.3 — CasesApi method wrappers.

import { ApiClient } from '../src/api/client';
import { CasesApi } from '../src/api/cases';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function setup(body?: unknown, status: number = 200) {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    captured.push({ url, init });
    return {
      status,
      async json() {
        return (
          body ?? {
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
  return { client, captured, api: new CasesApi(client) };
}

describe('CasesApi.list', () => {
  test('GETs /api/cases without filters', async () => {
    const { api, captured } = setup();
    await api.list();
    expect(captured[0].url).toBe('https://bff.test/api/cases');
  });

  test('forwards state + assignee + customer_id + sla + limit', async () => {
    const { api, captured } = setup();
    await api.list({
      state: 'in_action',
      assignee: 'bob',
      customer_id: 'CUST-9',
      sla: 'breached',
      limit: 25,
    });
    const url = new URL(captured[0].url);
    expect(url.searchParams.get('state')).toBe('in_action');
    expect(url.searchParams.get('assignee')).toBe('bob');
    expect(url.searchParams.get('customer_id')).toBe('CUST-9');
    expect(url.searchParams.get('sla')).toBe('breached');
    expect(url.searchParams.get('limit')).toBe('25');
  });
});

describe('CasesApi.get', () => {
  test('encodes case id', async () => {
    const { api, captured } = setup({
      header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
      body: {
        id: 'case 7',
        customer: { id: 'CUST-1', name: 'C' },
        state: 'open',
        outcome: null,
        assignee: null,
        created_at: 'now',
        origin_alert_id: null,
        loan_id: null,
      },
    });
    await api.get('case 7');
    expect(captured[0].url).toBe('https://bff.test/api/cases/case%207');
  });
});

describe('CasesApi.logAction', () => {
  test('POSTs /v1/action with full body', async () => {
    const { api, captured } = setup({
      header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
      body: { ok: true, case_state: 'in_action' },
    });
    await api.logAction({
      case_id: 'c-1',
      kind: 'call',
      officer_id: 'alice',
      outcome_note: 'left voicemail',
    });
    expect(captured[0].url).toBe('https://bff.test/v1/action');
    expect(captured[0].init?.method).toBe('POST');
    const body = JSON.parse(captured[0].init?.body as string);
    expect(body).toEqual({
      case_id: 'c-1',
      kind: 'call',
      officer_id: 'alice',
      outcome_note: 'left voicemail',
    });
  });
});

describe('CasesApi.logVisit', () => {
  test('builds geotagged visit action', async () => {
    const { api, captured } = setup({
      header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
      body: { ok: true, case_state: 'in_action' },
    });
    await api.logVisit('c-1', 'alice', 'door unattended', {
      lat: -1.286,
      lng: 36.817,
      accuracy_m: 12,
    });
    const body = JSON.parse(captured[0].init?.body as string);
    expect(body.kind).toBe('visit');
    expect(body.gps).toEqual({ lat: -1.286, lng: 36.817, accuracy_m: 12 });
    expect(body.outcome_note).toBe('door unattended');
  });
});
