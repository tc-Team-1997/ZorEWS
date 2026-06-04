/**
 * CMS Routes Integration Tests — 500-prevention regression suite.
 *
 * These tests verify that GET /v1/cms/cases, /v1/cms/cases/stats, and
 * /v1/cms/cases/sla-breaches NEVER return HTTP 500 under any realistic
 * input condition, and that error scenarios return appropriate 4xx codes.
 *
 * Background: These three endpoints were reported as returning HTTP 500.
 * All routes have try-catch error boundaries; these tests ensure the
 * boundaries are working and cover edge-cases that could cause exceptions.
 */

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryCmsCaseStore, seedDemoCmsCases } from '../src/cms_store';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const HEADERS = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'x-apex-user': 'alice.admin',
  'x-apex-role': 'admin',
} as const;
const BIL_HEADERS = {
  'X-Tenant-ID': 'BIL',
  'X-Channel': 'API',
  'x-apex-user': 'alice.admin',
  'x-apex-role': 'admin',
} as const;

function makeTestApp(opts: { withSeed?: boolean; role?: string } = {}) {
  const store = new InMemoryCmsCaseStore();
  if (opts.withSeed !== false) seedDemoCmsCases(store, 'BANK_DEMO');
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    cmsCaseStore: store,
    now: () => NOW,
    getRole: () => opts.role ?? 'admin',
  });
  return { ...built, store };
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1: GET /v1/cms/cases — must NEVER return 500
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/cms/cases — 500-prevention regression', () => {
  test('returns 200 with seed data (BANK_DEMO)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(Array.isArray(r.body.body.items)).toBe(true);
    expect(typeof r.body.body.total).toBe('number');
  });

  test('returns 200 with no seed (empty store)', async () => {
    const { app } = makeTestApp({ withSeed: false });
    const r = await request(app).get('/v1/cms/cases').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.items).toEqual([]);
    expect(r.body.body.total).toBe(0);
  });

  test('returns 200 for BIL tenant (different tenant, no cross-leak)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases').set(BIL_HEADERS);
    expect(r.status).toBe(200);
    // BIL should see 0 cases (seed is only for BANK_DEMO)
    expect(r.body.body.total).toBe(0);
  });

  test('returns 200 with ?status=OPEN filter', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases?status=OPEN').set(HEADERS);
    expect(r.status).toBe(200);
    const items: Array<{ status: string }> = r.body.body.items;
    items.forEach(c => expect(c.status).toBe('OPEN'));
  });

  test('returns 200 with ?status=ASSIGNED filter', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases?status=ASSIGNED').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
  });

  test('returns 200 with ?status=CLOSED filter (may be empty)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases?status=CLOSED').set(HEADERS);
    expect(r.status).toBe(200);
  });

  test('returns 200 with ?priority=P1 filter', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases?priority=P1').set(HEADERS);
    expect(r.status).toBe(200);
    const items: Array<{ priority: string }> = r.body.body.items;
    items.forEach(c => expect(c.priority).toBe('P1'));
  });

  test('returns 200 with ?priority=P4 filter', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases?priority=P4').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.items.length).toBeGreaterThanOrEqual(0);
  });

  test('returns 200 with ?q= text search (matching)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases?q=delinquency').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.items.length).toBeGreaterThan(0);
  });

  test('returns 200 with ?q= text search (no match — not an error)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases?q=xyznotfound123').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('returns 200 with ?breached=true (slaMatrixSource absent — graceful)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    // No slaMatrixSource injected → should return unfiltered list (not 500)
    const r = await request(app).get('/v1/cms/cases?breached=true').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });

  test('returns 200 with ?assigned_to filter', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases?assigned_to=carl.collect').set(HEADERS);
    expect(r.status).toBe(200);
  });

  test('returns 200 with ?tags filter', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases?tags=critical,collections').set(HEADERS);
    expect(r.status).toBe(200);
  });

  test('returns 200 with combined filters', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases?status=OPEN&priority=P1').set(HEADERS);
    expect(r.status).toBe(200);
  });

  test('returns 200 with very long ?q= (no crash)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const longQ = 'a'.repeat(500);
    const r = await request(app).get(`/v1/cms/cases?q=${longQ}`).set(HEADERS);
    expect(r.status).toBe(200);
  });

  test('response always uses envelope shape {header, body}', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases').set(HEADERS);
    expect(r.body).toHaveProperty('header');
    expect(r.body).toHaveProperty('body');
    expect(r.body.header).toHaveProperty('status', 'SUCCESS');
    expect(r.body.header).toHaveProperty('code', 'EWS_200');
  });

  // ─── Error cases — must return 4xx NOT 5xx ───────────────────────────────

  test('returns 400 (not 500) for ?status=INVALID_STATUS', async () => {
    const { app } = makeTestApp();
    const r = await request(app).get('/v1/cms/cases?status=INVALID_STATUS').set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.status).not.toBe(500);
  });

  test('returns 400 (not 500) for ?priority=INVALID_PRIORITY', async () => {
    const { app } = makeTestApp();
    const r = await request(app).get('/v1/cms/cases?priority=INVALID_PRIORITY').set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.status).not.toBe(500);
  });

  test('returns 400 (not 500) when X-Tenant-ID is missing', async () => {
    const { app } = makeTestApp();
    const r = await request(app).get('/v1/cms/cases').set({ 'X-Channel': 'API', 'x-apex-role': 'admin' });
    expect(r.status).toBe(400);
    expect(r.status).not.toBe(500);
  });

  test('returns 400 (not 500) when X-Channel is missing', async () => {
    const { app } = makeTestApp();
    const r = await request(app).get('/v1/cms/cases').set({ 'X-Tenant-ID': 'BANK_DEMO', 'x-apex-role': 'admin' });
    expect(r.status).toBe(400);
    expect(r.status).not.toBe(500);
  });

  test('returns 403 (not 500) for role without cases:list', async () => {
    const { app } = makeTestApp({ role: 'unknown_role_xyz' });
    const r = await request(app).get('/v1/cms/cases').set(HEADERS);
    expect(r.status).toBe(403);
    expect(r.status).not.toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2: GET /v1/cms/cases/stats — must NEVER return 500
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/cms/cases/stats — 500-prevention regression', () => {
  test('returns 200 with seed data', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/stats').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
  });

  test('returns 200 with no cases (all zeros)', async () => {
    const { app } = makeTestApp({ withSeed: false });
    const r = await request(app).get('/v1/cms/cases/stats').set(HEADERS);
    expect(r.status).toBe(200);
    const body = r.body.body;
    expect(body.total).toBe(0);
    expect(body.sla_breached_count).toBe(0);
    expect(body.sla_warning_count).toBe(0);
    expect(body.avg_resolution_hours).toBeNull();
  });

  test('returns 200 for BIL tenant (different tenant)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/stats').set(BIL_HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('by_status has all 7 canonical states as keys', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/stats').set(HEADERS);
    const states = ['OPEN','ASSIGNED','INVESTIGATING','PENDING_APPROVAL','ESCALATED','CLOSED','REOPENED'];
    states.forEach(s => expect(r.body.body.by_status).toHaveProperty(s));
  });

  test('by_priority has P1/P2/P3/P4 as keys', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/stats').set(HEADERS);
    ['P1','P2','P3','P4'].forEach(p => expect(r.body.body.by_priority).toHaveProperty(p));
  });

  test('sla_breached_count is always a number (not undefined)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/stats').set(HEADERS);
    expect(typeof r.body.body.sla_breached_count).toBe('number');
  });

  test('sla_warning_count is always a number', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/stats').set(HEADERS);
    expect(typeof r.body.body.sla_warning_count).toBe('number');
  });

  test('avg_resolution_hours is null when no closed cases', async () => {
    const { app } = makeTestApp({ withSeed: false });
    const r = await request(app).get('/v1/cms/cases/stats').set(HEADERS);
    expect(r.body.body.avg_resolution_hours).toBeNull();
  });

  test('total matches sum of all by_status values', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/stats').set(HEADERS);
    const body = r.body.body;
    const statusSum = Object.values(body.by_status as Record<string, number>).reduce((s, v) => s + v, 0);
    expect(statusSum).toBe(body.total);
  });

  test('returns 400 (not 500) when X-Tenant-ID is missing', async () => {
    const { app } = makeTestApp();
    const r = await request(app).get('/v1/cms/cases/stats').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
    expect(r.status).not.toBe(500);
  });

  test('returns 403 (not 500) for role without cases:list', async () => {
    const { app } = makeTestApp({ role: 'unknown_role_xyz' });
    const r = await request(app).get('/v1/cms/cases/stats').set(HEADERS);
    expect(r.status).toBe(403);
    expect(r.status).not.toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3: GET /v1/cms/cases/sla-breaches — must NEVER return 500
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/cms/cases/sla-breaches — 500-prevention regression', () => {
  test('returns 200 with seed data (some may be breached)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
  });

  test('returns 200 with no cases — empty items array', async () => {
    const { app } = makeTestApp({ withSeed: false });
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.items).toEqual([]);
    expect(r.body.body.total).toBe(0);
  });

  test('returns 200 for BIL tenant', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(BIL_HEADERS);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });

  test('each breach item has required fields', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS);
    const items: Array<Record<string, unknown>> = r.body.body.items;
    items.forEach(item => {
      expect(item).toHaveProperty('case_id');
      expect(item).toHaveProperty('case_number');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('priority');
      expect(item).toHaveProperty('status');
      expect(item).toHaveProperty('sla_due_at');
      expect(item).toHaveProperty('overshoot_hours');
      expect(item).toHaveProperty('progress_pct');
    });
  });

  test('overshoot_hours is >= 0 for all breach items', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS);
    const items: Array<{ overshoot_hours: number }> = r.body.body.items;
    items.forEach(item => expect(item.overshoot_hours).toBeGreaterThanOrEqual(0));
  });

  test('progress_pct is >= 100 for all breach items', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS);
    const items: Array<{ progress_pct: number }> = r.body.body.items;
    items.forEach(item => expect(item.progress_pct).toBeGreaterThanOrEqual(100));
  });

  test('CLOSED cases are never in breach list', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS);
    const items: Array<{ status: string }> = r.body.body.items;
    items.forEach(item => expect(item.status).not.toBe('CLOSED'));
  });

  test('items are sorted: highest overshoot_hours first', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS);
    const items: Array<{ overshoot_hours: number }> = r.body.body.items;
    for (let i = 1; i < items.length; i++) {
      expect(items[i].overshoot_hours).toBeLessThanOrEqual(items[i - 1].overshoot_hours);
    }
  });

  test('total field matches items array length', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS);
    expect(r.body.body.total).toBe(r.body.body.items.length);
  });

  test('returns 400 (not 500) when X-Tenant-ID is missing', async () => {
    const { app } = makeTestApp();
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
    expect(r.status).not.toBe(500);
  });

  test('returns 403 (not 500) for role without cases:list', async () => {
    const { app } = makeTestApp({ role: 'unknown_role_xyz' });
    const r = await request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS);
    expect(r.status).toBe(403);
    expect(r.status).not.toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4: Error resilience across all three endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe('CMS error resilience — no 500 under any condition', () => {
  test('all 3 endpoints return non-500 when store has no data', async () => {
    const { app } = makeTestApp({ withSeed: false });
    const [r1, r2, r3] = await Promise.all([
      request(app).get('/v1/cms/cases').set(HEADERS),
      request(app).get('/v1/cms/cases/stats').set(HEADERS),
      request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS),
    ]);
    expect(r1.status).not.toBe(500);
    expect(r2.status).not.toBe(500);
    expect(r3.status).not.toBe(500);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
  });

  test('concurrent requests to all 3 endpoints do not cause crash', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const batch = await Promise.all(
      Array.from({ length: 9 }, (_, i) => {
        const paths = ['/v1/cms/cases', '/v1/cms/cases/stats', '/v1/cms/cases/sla-breaches'];
        return request(app).get(paths[i % 3]).set(HEADERS);
      }),
    );
    batch.forEach(r => {
      expect(r.status).toBe(200);
      expect(r.status).not.toBe(500);
    });
  });

  test('all 3 endpoints return correct envelope shape', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const paths = ['/v1/cms/cases', '/v1/cms/cases/stats', '/v1/cms/cases/sla-breaches'];
    for (const path of paths) {
      const r = await request(app).get(path).set(HEADERS);
      expect(r.body).toHaveProperty('header');
      expect(r.body).toHaveProperty('body');
      expect(r.body.header.status).toBe('SUCCESS');
      expect(r.body.header.code).toBe('EWS_200');
    }
  });

  test('all 3 endpoints return valid JSON (not empty body)', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const paths = ['/v1/cms/cases', '/v1/cms/cases/stats', '/v1/cms/cases/sla-breaches'];
    for (const path of paths) {
      const r = await request(app).get(path).set(HEADERS);
      expect(typeof r.body).toBe('object');
      expect(r.body).not.toBeNull();
    }
  });

  test('response body.total is always 0 or positive integer', async () => {
    const { app } = makeTestApp({ withSeed: false });
    const r1 = await request(app).get('/v1/cms/cases').set(HEADERS);
    const r3 = await request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS);
    expect(r1.body.body.total).toBeGreaterThanOrEqual(0);
    expect(r3.body.body.total).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5: BFF-side integration summary (smoke tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('CMS BFF integration smoke', () => {
  test('GET /v1/cms/cases returns seeded demo cases', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const r = await request(app).get('/v1/cms/cases').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBeGreaterThan(0);
    const items: Array<{ tenant_id: string }> = r.body.body.items;
    // Tenant isolation: all items belong to BANK_DEMO
    items.forEach(c => expect(c.tenant_id).toBe('BANK_DEMO'));
  });

  test('GET /v1/cms/cases/stats total matches list total', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const [rList, rStats] = await Promise.all([
      request(app).get('/v1/cms/cases').set(HEADERS),
      request(app).get('/v1/cms/cases/stats').set(HEADERS),
    ]);
    expect(rList.body.body.total).toBe(rStats.body.body.total);
  });

  test('sla-breaches items are a subset of main cases list', async () => {
    const { app } = makeTestApp({ withSeed: true });
    const [rList, rBreaches] = await Promise.all([
      request(app).get('/v1/cms/cases').set(HEADERS),
      request(app).get('/v1/cms/cases/sla-breaches').set(HEADERS),
    ]);
    const listIds = new Set(rList.body.body.items.map((c: { case_id: string }) => c.case_id));
    rBreaches.body.body.items.forEach((b: { case_id: string }) => {
      expect(listIds.has(b.case_id)).toBe(true);
    });
  });
});
