// services/bff/__tests__/envelope.test.ts
//
// Unit coverage for the bank-grade envelope + tenant middleware (T4.19).

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import {
  EnterpriseError,
  readRequestId,
  wrapError,
  wrapResponse,
} from '../src/envelope';
import { defaultTenantLookup, requireTenant } from '../src/tenant';

describe('wrapResponse', () => {
  test('emits SUCCESS envelope with defaults', () => {
    const env = wrapResponse({ ok: true });
    expect(env.header.status).toBe('SUCCESS');
    expect(env.header.code).toBe('EWS_200');
    expect(env.header.message).toBe('Processed Successfully');
    expect(typeof env.header.requestId).toBe('string');
    expect(env.header.requestId.length).toBeGreaterThan(10);
    expect(typeof env.header.timestamp).toBe('string');
    expect(env.body).toEqual({ ok: true });
  });

  test('echoes a caller-supplied requestId + timestamp', () => {
    const env = wrapResponse(
      { ok: true },
      { requestId: 'abc-123', timestamp: '2026-05-03T00:00:00.000Z' },
      { code: 'EWS_201', message: 'Created' },
    );
    expect(env.header.requestId).toBe('abc-123');
    expect(env.header.timestamp).toBe('2026-05-03T00:00:00.000Z');
    expect(env.header.code).toBe('EWS_201');
    expect(env.header.message).toBe('Created');
  });
});

describe('wrapError', () => {
  test('emits §11-shaped error envelope with FAILURE status', () => {
    const env = wrapError(
      { code: 'EWS_400', message: 'bad input', severity: 'MEDIUM' },
      { requestId: 'req-1' },
    );
    expect(env.header.status).toBe('FAILURE');
    expect(env.header.requestId).toBe('req-1');
    expect(env.error.code).toBe('EWS_400');
    expect(env.error.message).toBe('bad input');
    expect(env.error.severity).toBe('MEDIUM');
  });
});

describe('readRequestId', () => {
  test('reads requestId out of a request envelope', () => {
    const id = readRequestId({ header: { requestId: 'echo-me' }, body: {} });
    expect(id).toBe('echo-me');
  });
  test('returns undefined for a bare body', () => {
    expect(readRequestId({ customer_id: 'c-1' })).toBeUndefined();
  });
  test('returns undefined for non-objects', () => {
    expect(readRequestId(null)).toBeUndefined();
    expect(readRequestId(undefined)).toBeUndefined();
    expect(readRequestId('string')).toBeUndefined();
  });
});

describe('EnterpriseError', () => {
  test('carries an http status + payload', () => {
    const e = new EnterpriseError(404, {
      code: 'EWS_404',
      message: 'not found',
      severity: 'LOW',
    });
    expect(e.status).toBe(404);
    expect(e.payload.code).toBe('EWS_404');
    expect(e.message).toBe('not found');
  });
});

describe('requireTenant middleware', () => {
  function appWithTenant() {
    const app = express();
    app.use(express.json());
    app.post(
      '/protected',
      requireTenant(defaultTenantLookup()),
      (req: Request, res: Response) => {
        res.json({
          tenant_id: req.tenant?.tenant_id,
          channel: req.channel,
        });
      },
    );
    // Trailing error handler so any thrown error is shaped consistently
    // (matches what the real BFF does at app-error level).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: err.message });
    });
    return app;
  }

  test('happy path tags req.tenant + req.channel', async () => {
    const r = await request(appWithTenant())
      .post('/protected')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' })
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.channel).toBe('API');
  });

  test('rejects with 400 envelope when X-Tenant-ID missing', async () => {
    const r = await request(appWithTenant())
      .post('/protected')
      .set({ 'X-Channel': 'API' })
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.header.status).toBe('FAILURE');
    expect(r.body.error.code).toBe('EWS_400');
    expect(r.body.error.message).toMatch(/X-Tenant-ID/);
  });

  test('rejects with 403 when tenant inactive / unknown', async () => {
    const r = await request(appWithTenant())
      .post('/protected')
      .set({ 'X-Tenant-ID': 'GHOST', 'X-Channel': 'API' })
      .send({});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EWS_403');
  });

  test('rejects with 403 when channel not in tenant whitelist', async () => {
    // BIL allows ['BRANCH','AGENT_PORTAL','API'] — LOS is bank-only.
    const r = await request(appWithTenant())
      .post('/protected')
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'LOS' })
      .send({});
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/channel 'LOS' not permitted/);
  });

  test('async lookup is awaited', async () => {
    const lookup = async (id: string) =>
      id === 'ASYNC'
        ? {
            tenant_id: 'ASYNC',
            name: 'Async Co',
            vertical: 'banking' as const,
            channels_allowed: ['API'],
            active: true,
          }
        : undefined;
    const app = express();
    app.use(express.json());
    app.post('/async', requireTenant(lookup), (req: Request, res: Response) =>
      res.json({ ok: true, tenant: req.tenant?.tenant_id }),
    );
    const r = await request(app)
      .post('/async')
      .set({ 'X-Tenant-ID': 'ASYNC', 'X-Channel': 'API' })
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.tenant).toBe('ASYNC');
  });

  // T4.24 Phase 3 — JWT tenant must match X-Tenant-ID header.
  // The middleware decodes (without verifying) the Authorization Bearer
  // JWT and refuses if its `tenant_id` claim contradicts the header.
  describe('JWT tenant binding', () => {
    function makeJwt(payload: Record<string, unknown>): string {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
        .toString('base64')
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      const body = Buffer.from(JSON.stringify(payload))
        .toString('base64')
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      return `${header}.${body}.fake-signature`;
    }

    test('JWT tenant_id matching X-Tenant-ID is allowed through', async () => {
      const r = await request(appWithTenant())
        .post('/protected')
        .set({
          'X-Tenant-ID': 'BANK_DEMO',
          'X-Channel': 'API',
          Authorization: `Bearer ${makeJwt({ sub: 'u-001', tenant_id: 'BANK_DEMO', role: 'admin' })}`,
        })
        .send({});
      expect(r.status).toBe(200);
      expect(r.body.tenant_id).toBe('BANK_DEMO');
    });

    test('JWT tenant_id different from X-Tenant-ID returns 403 CRITICAL', async () => {
      const r = await request(appWithTenant())
        .post('/protected')
        .set({
          'X-Tenant-ID': 'BIL',
          'X-Channel': 'API',
          Authorization: `Bearer ${makeJwt({ sub: 'u-001', tenant_id: 'BANK_DEMO', role: 'admin' })}`,
        })
        .send({});
      expect(r.status).toBe(403);
      expect(r.body.error.severity).toBe('CRITICAL');
      expect(r.body.error.message).toMatch(/tenant mismatch/);
    });

    test('JWT without tenant_id claim falls through to header-only check', async () => {
      // Old-style token before Phase 3 — no tenant_id claim. Should pass.
      const r = await request(appWithTenant())
        .post('/protected')
        .set({
          'X-Tenant-ID': 'BANK_DEMO',
          'X-Channel': 'API',
          Authorization: `Bearer ${makeJwt({ sub: 'u-001', role: 'admin' })}`,
        })
        .send({});
      expect(r.status).toBe(200);
    });

    test('malformed Authorization header is ignored, not fatal', async () => {
      const r = await request(appWithTenant())
        .post('/protected')
        .set({
          'X-Tenant-ID': 'BANK_DEMO',
          'X-Channel': 'API',
          Authorization: 'Bearer not-a-jwt',
        })
        .send({});
      expect(r.status).toBe(200);
    });
  });
});
