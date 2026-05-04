import request from 'supertest';
import { makeApp } from '../src/server';

describe('OWASP security headers', () => {
  test('every response carries HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, CSP', async () => {
    const { app } = makeApp();
    const r = await request(app).get('/healthz');
    expect(r.status).toBe(200);
    expect(r.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(r.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(r.headers['permissions-policy']).toMatch(/camera=\(\)/);
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  test('X-Powered-By header is suppressed', async () => {
    const { app } = makeApp();
    const r = await request(app).get('/healthz');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  test('headers are present on JSON 404 responses too', async () => {
    const { app } = makeApp();
    const r = await request(app).get('/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBeTruthy();
  });
});
