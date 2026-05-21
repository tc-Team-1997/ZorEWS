// T4.3 — ApiClient + envelope unwrap + header injection + error routing.

import { ApiClient, ApiError } from '../src/api/client';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function makeMockFetch(opts: {
  status?: number;
  body?: unknown;
  captured?: Captured[];
}): typeof fetch {
  const status = opts.status ?? 200;
  const captured = opts.captured;
  return (async (url: string, init?: RequestInit) => {
    if (captured) captured.push({ url, init });
    return {
      status,
      async json() {
        return opts.body;
      },
    } as unknown as Response;
  }) as typeof fetch;
}

function makeClient(overrides: {
  fetchImpl: typeof fetch;
  token?: string | null;
  tenant?: string | null;
  actor?: string | null;
  channel?: string;
  onUnauthorised?: () => Promise<void> | void;
}): ApiClient {
  return new ApiClient({
    baseUrl: 'https://bff.test',
    getAccessToken: async () => overrides.token ?? 'tkn-abc',
    getTenantId: async () => overrides.tenant ?? 'BANK_DEMO',
    getActor: async () => overrides.actor ?? 'alice.field',
    channel: overrides.channel,
    onUnauthorised: overrides.onUnauthorised,
    fetchImpl: overrides.fetchImpl,
  });
}

describe('ApiClient.get', () => {
  test('unwraps envelope body on 200', async () => {
    const fetchImpl = makeMockFetch({
      status: 200,
      body: { header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' }, body: { hello: 'world' } },
    });
    const c = makeClient({ fetchImpl });
    const out = await c.get<{ hello: string }>('/v1/test');
    expect(out).toEqual({ hello: 'world' });
  });

  test('injects Authorization + X-Tenant-ID + X-Channel + X-APEX-USER headers', async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeMockFetch({
      status: 200,
      body: { header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' }, body: {} },
      captured,
    });
    const c = makeClient({ fetchImpl, token: 'jwt-xyz', tenant: 'BIL', actor: 'bob.ops' });
    await c.get('/v1/alerts');
    const headers = captured[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-xyz');
    expect(headers['X-Tenant-ID']).toBe('BIL');
    expect(headers['X-Channel']).toBe('MOBILE');
    expect(headers['X-APEX-USER']).toBe('bob.ops');
    expect(headers.Accept).toBe('application/json');
  });

  test('omits Authorization when token resolver returns null', async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeMockFetch({
      status: 200,
      body: { header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' }, body: {} },
      captured,
    });
    // Build directly to honour the null token (the test helper's ?? would mask it).
    const c = new ApiClient({
      baseUrl: 'https://bff.test',
      getAccessToken: async () => null,
      getTenantId: async () => 'BANK_DEMO',
      getActor: async () => 'alice',
      fetchImpl,
    });
    await c.get('/v1/whoami');
    const headers = captured[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test('appends query params, skipping undefined / null / empty', async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeMockFetch({
      status: 200,
      body: { header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' }, body: {} },
      captured,
    });
    const c = makeClient({ fetchImpl });
    await c.get('/v1/alerts', { severity: 'high', status: undefined, customer_id: '' });
    const url = captured[0].url;
    expect(url).toBe('https://bff.test/v1/alerts?severity=high');
  });

  test('uses custom channel when provided', async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeMockFetch({
      status: 200,
      body: { header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' }, body: {} },
      captured,
    });
    const c = makeClient({ fetchImpl, channel: 'FIELD_APP' });
    await c.get('/v1/x');
    expect((captured[0].init?.headers as Record<string, string>)['X-Channel']).toBe('FIELD_APP');
  });

  test('strips trailing slash on baseUrl', async () => {
    const captured: Captured[] = [];
    const c = new ApiClient({
      baseUrl: 'https://bff.test/',
      getAccessToken: async () => null,
      getTenantId: async () => null,
      getActor: async () => null,
      fetchImpl: makeMockFetch({
        status: 200,
        body: { header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' }, body: {} },
        captured,
      }),
    });
    await c.get('/v1/x');
    expect(captured[0].url).toBe('https://bff.test/v1/x');
  });
});

describe('ApiClient.post', () => {
  test('serialises body + sets Content-Type', async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeMockFetch({
      status: 201,
      body: { header: { status: 'SUCCESS', code: 'EWS_201', message: 'created', timestamp: 'now' }, body: { id: 'r-1' } },
      captured,
    });
    const c = makeClient({ fetchImpl });
    const out = await c.post<{ id: string }>('/v1/scenarios', { name: 'baseline' });
    expect(out).toEqual({ id: 'r-1' });
    expect(captured[0].init?.method).toBe('POST');
    expect(captured[0].init?.body).toBe(JSON.stringify({ name: 'baseline' }));
    expect((captured[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  test('omits body when undefined', async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeMockFetch({
      status: 200,
      body: { header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' }, body: {} },
      captured,
    });
    const c = makeClient({ fetchImpl });
    await c.post('/v1/cmd');
    expect(captured[0].init?.body).toBeUndefined();
  });
});

describe('ApiClient.patch', () => {
  test('PATCH method + body', async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeMockFetch({
      status: 200,
      body: { header: { status: 'SUCCESS', code: 'EWS_200', message: 'ok', timestamp: 'now' }, body: { id: 'x' } },
      captured,
    });
    const c = makeClient({ fetchImpl });
    await c.patch('/v1/r/1', { active: false });
    expect(captured[0].init?.method).toBe('PATCH');
    expect(captured[0].init?.body).toBe(JSON.stringify({ active: false }));
  });
});

describe('ApiClient.delete', () => {
  test('204 resolves to void', async () => {
    const fetchImpl = makeMockFetch({ status: 204, body: undefined });
    const c = makeClient({ fetchImpl });
    await expect(c.delete('/v1/r/1')).resolves.toBeUndefined();
  });

  test('error envelope still routed to ApiError', async () => {
    const fetchImpl = makeMockFetch({
      status: 404,
      body: { header: { status: 'ERROR', code: 'EWS_404', message: 'missing', timestamp: 'now' }, error: { code: 'EWS_404_unknown_x', message: 'missing', severity: 'MEDIUM' } },
    });
    const c = makeClient({ fetchImpl });
    await expect(c.delete('/v1/r/missing')).rejects.toThrow(ApiError);
  });
});

describe('ApiClient error routing', () => {
  test('401 calls onUnauthorised and throws ApiError(EWS_401)', async () => {
    let unauthCalls = 0;
    const fetchImpl = makeMockFetch({
      status: 401,
      body: { header: { status: 'ERROR', code: 'EWS_401', message: 'unauthorised', timestamp: 'now' } },
    });
    const c = makeClient({ fetchImpl, onUnauthorised: () => { unauthCalls += 1; } });
    await expect(c.get('/v1/x')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'EWS_401',
      status: 401,
      severity: 'HIGH',
    });
    expect(unauthCalls).toBe(1);
  });

  test('400 error envelope surfaces code + severity + detail', async () => {
    const fetchImpl = makeMockFetch({
      status: 400,
      body: {
        header: { status: 'ERROR', code: 'EWS_400', message: 'bad input', timestamp: 'now' },
        error: { code: 'EWS_400_invalid_status', message: 'unknown status', severity: 'MEDIUM', detail: { field: 'status' } },
      },
    });
    const c = makeClient({ fetchImpl });
    try {
      await c.get('/v1/x');
      fail('expected ApiError');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.code).toBe('EWS_400_invalid_status');
      expect(err.status).toBe(400);
      expect(err.severity).toBe('MEDIUM');
      expect(err.detail).toEqual({ field: 'status' });
    }
  });

  test('500 with envelope routes severity HIGH by default', async () => {
    const fetchImpl = makeMockFetch({
      status: 500,
      body: {
        header: { status: 'ERROR', code: 'EWS_500', message: 'boom', timestamp: 'now' },
        error: { code: 'EWS_500', message: 'internal' },
      },
    });
    const c = makeClient({ fetchImpl });
    try {
      await c.get('/v1/x');
      fail('expected ApiError');
    } catch (e) {
      const err = e as ApiError;
      expect(err.status).toBe(500);
      expect(err.severity).toBe('HIGH');
    }
  });

  test('500 without error block still throws ApiError', async () => {
    const fetchImpl = makeMockFetch({
      status: 500,
      body: { header: { status: 'ERROR', code: 'EWS_500', message: 'boom', timestamp: 'now' } },
    });
    const c = makeClient({ fetchImpl });
    await expect(c.get('/v1/x')).rejects.toThrow(ApiError);
  });

  test('non-JSON response surfaces EWS_500', async () => {
    const fetchImpl = (async () => {
      return {
        status: 502,
        async json() {
          throw new Error('not json');
        },
      } as unknown as Response;
    }) as typeof fetch;
    const c = makeClient({ fetchImpl });
    try {
      await c.get('/v1/x');
      fail('expected ApiError');
    } catch (e) {
      const err = e as ApiError;
      expect(err.code).toBe('EWS_500');
      expect(err.status).toBe(502);
    }
  });
});
