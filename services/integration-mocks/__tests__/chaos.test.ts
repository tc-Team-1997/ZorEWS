import express from 'express';
import request from 'supertest';
import { chaos, profileFor } from '../src/chaos';

// chaos.test.ts overrides MOCK_CHAOS_DISABLED to "0" so the middleware
// actually fires. Other tests in this suite leave it as "1" for speed.

beforeEach(() => {
  delete process.env.MOCK_CHAOS_DISABLED;
});

afterAll(() => {
  process.env.MOCK_CHAOS_DISABLED = '1';
});

function appWithChaos(upstream: string, rng: () => number) {
  const app = express();
  app.use(express.json());
  app.get('/x', chaos(upstream, rng), (_req, res) => res.json({ ok: true }));
  return app;
}

describe('chaos middleware', () => {
  test('returns 429 when rng < rateLimitRate', async () => {
    process.env.MOCK_CBS_RATELIMIT_RATE = '1.0';
    const app = appWithChaos('cbs', () => 0.0);
    const res = await request(app).get('/x');
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(res.headers['retry-after']).toBeDefined();
    delete process.env.MOCK_CBS_RATELIMIT_RATE;
  });

  test('returns 500 when rng < errorRate (and rate-limit not triggered)', async () => {
    process.env.MOCK_CBS_RATELIMIT_RATE = '0';
    process.env.MOCK_CBS_ERROR_RATE = '1.0';
    const app = appWithChaos('cbs', () => 0.5);
    const res = await request(app).get('/x');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('upstream_error');
    delete process.env.MOCK_CBS_ERROR_RATE;
    delete process.env.MOCK_CBS_RATELIMIT_RATE;
  });

  test('passes through when rng > both thresholds (no chaos)', async () => {
    process.env.MOCK_CBS_RATELIMIT_RATE = '0.1';
    process.env.MOCK_CBS_ERROR_RATE = '0.1';
    process.env.MOCK_CBS_LATENCY_MIN_MS = '0';
    process.env.MOCK_CBS_LATENCY_MAX_MS = '0';
    const app = appWithChaos('cbs', () => 0.99);
    const res = await request(app).get('/x');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    delete process.env.MOCK_CBS_RATELIMIT_RATE;
    delete process.env.MOCK_CBS_ERROR_RATE;
    delete process.env.MOCK_CBS_LATENCY_MIN_MS;
    delete process.env.MOCK_CBS_LATENCY_MAX_MS;
  });

  test('respects MOCK_CHAOS_DISABLED=1 — bypasses everything', async () => {
    process.env.MOCK_CHAOS_DISABLED = '1';
    process.env.MOCK_CBS_ERROR_RATE = '1.0';
    const app = appWithChaos('cbs', () => 0.0);
    const res = await request(app).get('/x');
    expect(res.status).toBe(200);
    delete process.env.MOCK_CBS_ERROR_RATE;
  });

  test('profileFor returns env overrides', () => {
    process.env.MOCK_AML_LATENCY_MIN_MS = '500';
    process.env.MOCK_AML_LATENCY_MAX_MS = '900';
    const p = profileFor('aml');
    expect(p.latencyMinMs).toBe(500);
    expect(p.latencyMaxMs).toBe(900);
    delete process.env.MOCK_AML_LATENCY_MIN_MS;
    delete process.env.MOCK_AML_LATENCY_MAX_MS;
  });

  test('profileFor returns sensible defaults', () => {
    const p = profileFor('cbs');
    expect(p.latencyMinMs).toBeGreaterThan(0);
    expect(p.latencyMaxMs).toBeGreaterThan(p.latencyMinMs);
    expect(p.errorRate).toBe(0);
  });
});
