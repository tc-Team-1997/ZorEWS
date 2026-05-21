// T4.3 — InvestigationsApi method wrappers.

import { ApiClient } from '../src/api/client';
import { InvestigationsApi } from '../src/api/investigations';

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
  return { client, captured, api: new InvestigationsApi(client) };
}

describe('InvestigationsApi.listByCase', () => {
  test('GETs /v1/investigations with case_id', async () => {
    const { api, captured } = setup({
      header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
      body: { total: 1, items: [] },
    });
    await api.listByCase('c-1');
    expect(captured[0].url).toBe('https://bff.test/v1/investigations?case_id=c-1');
  });
});

describe('InvestigationsApi.get', () => {
  test('encodes investigation id', async () => {
    const { api, captured } = setup({
      header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
      body: {
        investigation_id: 'inv/9',
        case_id: 'c-1',
        status: 'triage',
        decision: null,
        opened_at: 'now',
        closed_at: null,
        steps: [],
      },
    });
    await api.get('inv/9');
    expect(captured[0].url).toBe('https://bff.test/v1/investigations/inv%2F9');
  });
});

describe('InvestigationsApi.completeStep', () => {
  test('POSTs to /steps/:step_id/complete with evidence_link', async () => {
    const { api, captured } = setup({
      header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
      body: {
        investigation_id: 'inv-1',
        case_id: 'c-1',
        status: 'gathering_evidence',
        decision: null,
        opened_at: 'now',
        closed_at: null,
        steps: [],
      },
    });
    await api.completeStep('inv-1', 'verify_identity', 'https://dms/doc-1');
    expect(captured[0].url).toBe(
      'https://bff.test/v1/investigations/inv-1/steps/verify_identity/complete',
    );
    expect(captured[0].init?.method).toBe('POST');
    expect(captured[0].init?.body).toBe(
      JSON.stringify({ evidence_link: 'https://dms/doc-1' }),
    );
  });

  test('completeStep without evidence_link still POSTs body with undefined', async () => {
    const { api, captured } = setup({
      header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
      body: {
        investigation_id: 'inv-1',
        case_id: 'c-1',
        status: 'gathering_evidence',
        decision: null,
        opened_at: 'now',
        closed_at: null,
        steps: [],
      },
    });
    await api.completeStep('inv-1', 'verify_identity');
    expect(captured[0].init?.body).toBe(JSON.stringify({}));
  });
});

describe('InvestigationsApi.addNote', () => {
  test('POSTs note body', async () => {
    const { api, captured } = setup({
      header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' },
      body: { note_id: 'n-1' },
    });
    const out = await api.addNote('inv-1', 'site visit confirmed');
    expect(captured[0].url).toBe('https://bff.test/v1/investigations/inv-1/notes');
    expect(captured[0].init?.body).toBe(JSON.stringify({ body: 'site visit confirmed' }));
    expect(out.note_id).toBe('n-1');
  });
});
