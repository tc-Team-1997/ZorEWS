// services/bff/__tests__/ai_promotion_daily_volume.test.ts
//
// T6 M7.17 — Promotion request daily volume timeline.

import request from 'supertest';
import {
  buildPromotionDailyVolume,
  PromotionDailyVolumeError,
  DEFAULT_PROMOTION_DAILY_WINDOW,
  MAX_PROMOTION_DAILY_WINDOW,
} from '../src/ai_promotion_daily_volume';
import type {
  PromotionEngine,
  PromotionFilters,
  PromotionPage,
  PromotionRequest,
  PromotionRequestStatus,
} from '../src/ai_model_promotion';
import { InMemoryPromotionEngine } from '../src/ai_model_promotion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeTestApp(role: string = 'admin', promotionEngine?: PromotionEngine) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    promotionEngine,
  });
}

// Stub engine so we control request_at + status exactly.
class StubPromotionEngine implements PromotionEngine {
  private requests: PromotionRequest[] = [];

  add(r: PromotionRequest): void {
    this.requests.push(r);
  }

  list(tenant_id: string, filters: PromotionFilters): PromotionPage {
    const page = filters.page ?? 1;
    const page_size = filters.page_size ?? 50;
    const filtered = this.requests
      .filter((r) => r.tenant_id === tenant_id)
      .sort(
        (a, b) =>
          new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime(),
      );
    const start = (page - 1) * page_size;
    return {
      items: filtered.slice(start, start + page_size),
      total: filtered.length,
      page,
      page_size,
    };
  }

  get(_t: string, _i: string): PromotionRequest | null {
    return null;
  }

  requestPromotion(): never {
    throw new Error('not implemented in stub');
  }

  approve(): never {
    throw new Error('not implemented in stub');
  }

  reject(): never {
    throw new Error('not implemented in stub');
  }
}

function makeRequest(
  request_id: string,
  tenant_id: string,
  model_id: string,
  requested_at: string,
  status: PromotionRequestStatus,
  requested_by = 'alice',
): PromotionRequest {
  return {
    request_id,
    tenant_id,
    model_id,
    from_status: 'staging',
    to_status: 'production',
    status,
    requested_by,
    requested_at,
    request_notes: 'test',
    reviewed_by: status === 'approved' || status === 'rejected' ? 'bob' : null,
    reviewed_at:
      status === 'approved' || status === 'rejected' ? requested_at : null,
    decision_notes: null,
  };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

describe('M7.17 — buildPromotionDailyVolume', () => {
  test('empty engine → 30 zero buckets + null leaderboards', () => {
    const engine = new StubPromotionEngine();
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    expect(s.days).toBe(30);
    expect(s.by_day.length).toBe(30);
    for (const b of s.by_day) {
      expect(b.total).toBe(0);
      expect(b.distinct_models).toBe(0);
      expect(b.distinct_requesters).toBe(0);
    }
    expect(s.total_requests_in_window).toBe(0);
    expect(s.total_requests_observed).toBe(0);
    expect(s.peak_day).toBeNull();
    expect(s.peak_count).toBe(0);
    expect(s.busiest_status).toBeNull();
    expect(s.growth_rate).toBeNull();
  });

  test('default 30-day window spans Apr 20 → May 19', () => {
    const engine = new StubPromotionEngine();
    const s = buildPromotionDailyVolume(
      engine,
      'BIL',
      DEFAULT_PROMOTION_DAILY_WINDOW,
      NOW,
    );
    expect(s.window_end).toBe('2026-05-19');
    expect(s.window_start).toBe('2026-04-20');
  });

  test('days=1 → 1 bucket today', () => {
    const engine = new StubPromotionEngine();
    const s = buildPromotionDailyVolume(engine, 'BIL', 1, NOW);
    expect(s.by_day.length).toBe(1);
    expect(s.by_day[0].date).toBe('2026-05-19');
  });

  test('by_day oldest-first', () => {
    const engine = new StubPromotionEngine();
    const s = buildPromotionDailyVolume(engine, 'BIL', 7, NOW);
    for (let i = 1; i < s.by_day.length; i++) {
      expect(s.by_day[i].date > s.by_day[i - 1].date).toBe(true);
    }
  });

  test('single request placed at correct UTC bucket', () => {
    const engine = new StubPromotionEngine();
    engine.add(
      makeRequest('r1', 'BIL', 'm1', '2026-05-15T08:30:00.000Z', 'pending'),
    );
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    const bucket = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(bucket.total).toBe(1);
    expect(bucket.by_status.pending).toBe(1);
    expect(bucket.distinct_models).toBe(1);
    expect(bucket.distinct_requesters).toBe(1);
    expect(s.total_requests_in_window).toBe(1);
    expect(s.total_requests_observed).toBe(1);
  });

  test('requests outside window in observed only', () => {
    const engine = new StubPromotionEngine();
    engine.add(
      makeRequest('r1', 'BIL', 'm1', '2026-05-10T00:00:00.000Z', 'pending'),
    );
    engine.add(
      makeRequest('r2', 'BIL', 'm1', '2025-12-01T00:00:00.000Z', 'approved'),
    );
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    expect(s.total_requests_in_window).toBe(1);
    expect(s.total_requests_observed).toBe(2);
  });

  test('by_status accumulates across all 4 statuses', () => {
    const engine = new StubPromotionEngine();
    const day = '2026-05-15T08:00:00.000Z';
    engine.add(makeRequest('r1', 'BIL', 'm1', day, 'pending'));
    engine.add(makeRequest('r2', 'BIL', 'm2', day, 'approved'));
    engine.add(makeRequest('r3', 'BIL', 'm3', day, 'rejected'));
    engine.add(makeRequest('r4', 'BIL', 'm4', day, 'cancelled'));
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    const bucket = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(bucket.total).toBe(4);
    expect(bucket.by_status.pending).toBe(1);
    expect(bucket.by_status.approved).toBe(1);
    expect(bucket.by_status.rejected).toBe(1);
    expect(bucket.by_status.cancelled).toBe(1);
  });

  test('distinct_models per-day Set dedup', () => {
    const engine = new StubPromotionEngine();
    const day = '2026-05-15T08:00:00.000Z';
    engine.add(makeRequest('r1', 'BIL', 'mA', day, 'pending'));
    engine.add(makeRequest('r2', 'BIL', 'mA', day, 'approved')); // same model
    engine.add(makeRequest('r3', 'BIL', 'mB', day, 'pending'));
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    const bucket = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(bucket.total).toBe(3);
    expect(bucket.distinct_models).toBe(2);
  });

  test('distinct_requesters per-day Set dedup', () => {
    const engine = new StubPromotionEngine();
    const day = '2026-05-15T08:00:00.000Z';
    engine.add(makeRequest('r1', 'BIL', 'm1', day, 'pending', 'alice'));
    engine.add(makeRequest('r2', 'BIL', 'm2', day, 'approved', 'alice'));
    engine.add(makeRequest('r3', 'BIL', 'm3', day, 'pending', 'bob'));
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    const bucket = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(bucket.distinct_requesters).toBe(2);
  });

  test('peak_day formula + earliest-day-wins tie-break', () => {
    const engine = new StubPromotionEngine();
    engine.add(makeRequest('r1', 'BIL', 'm1', '2026-05-15T08:00:00.000Z', 'pending'));
    engine.add(makeRequest('r2', 'BIL', 'm2', '2026-05-10T08:00:00.000Z', 'pending'));
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    expect(s.peak_day).toBe('2026-05-10');
    expect(s.peak_count).toBe(1);
  });

  test('mean_per_day = round(total/days)', () => {
    const engine = new StubPromotionEngine();
    for (let i = 0; i < 5; i++) {
      engine.add(
        makeRequest(`r${i}`, 'BIL', `m${i}`, '2026-05-15T08:00:00.000Z', 'pending'),
      );
    }
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    expect(s.mean_per_day).toBe(0); // 5/30 = 0.17 → 0
  });

  test('growth_rate positive when second half busier', () => {
    const engine = new StubPromotionEngine();
    engine.add(makeRequest('r1', 'BIL', 'm1', '2026-05-08T08:00:00.000Z', 'pending'));
    engine.add(makeRequest('r2', 'BIL', 'm2', '2026-05-17T08:00:00.000Z', 'pending'));
    engine.add(makeRequest('r3', 'BIL', 'm3', '2026-05-18T08:00:00.000Z', 'pending'));
    engine.add(makeRequest('r4', 'BIL', 'm4', '2026-05-19T08:00:00.000Z', 'pending'));
    const s = buildPromotionDailyVolume(engine, 'BIL', 14, NOW);
    expect(s.growth_rate).not.toBeNull();
    expect(s.growth_rate!).toBeGreaterThan(0);
  });

  test('growth_rate null when first-half=0', () => {
    const engine = new StubPromotionEngine();
    engine.add(makeRequest('r1', 'BIL', 'm1', '2026-05-19T08:00:00.000Z', 'pending'));
    const s = buildPromotionDailyVolume(engine, 'BIL', 14, NOW);
    expect(s.growth_rate).toBeNull();
  });

  test('growth_rate null when days=1', () => {
    const engine = new StubPromotionEngine();
    const s = buildPromotionDailyVolume(engine, 'BIL', 1, NOW);
    expect(s.growth_rate).toBeNull();
  });

  test('busiest_status formula', () => {
    const engine = new StubPromotionEngine();
    const day = '2026-05-15T08:00:00.000Z';
    engine.add(makeRequest('r1', 'BIL', 'm1', day, 'rejected'));
    engine.add(makeRequest('r2', 'BIL', 'm2', day, 'rejected'));
    engine.add(makeRequest('r3', 'BIL', 'm3', day, 'approved'));
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    expect(s.busiest_status).toBe('rejected');
  });

  test('busiest_status canonical tie-break (pending > approved at tied)', () => {
    const engine = new StubPromotionEngine();
    const day = '2026-05-15T08:00:00.000Z';
    engine.add(makeRequest('r1', 'BIL', 'm1', day, 'pending'));
    engine.add(makeRequest('r2', 'BIL', 'm2', day, 'approved'));
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    expect(s.busiest_status).toBe('pending');
  });

  test('busiest_status null on empty', () => {
    const engine = new StubPromotionEngine();
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    expect(s.busiest_status).toBeNull();
  });

  test('tenant scoping (BIL invisible to BANK_DEMO)', () => {
    const engine = new StubPromotionEngine();
    engine.add(makeRequest('r1', 'BIL', 'm1', '2026-05-15T08:00:00.000Z', 'pending'));
    const sBank = buildPromotionDailyVolume(engine, 'BANK_DEMO', 30, NOW);
    expect(sBank.total_requests_in_window).toBe(0);
    const sBil = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    expect(sBil.total_requests_in_window).toBe(1);
  });

  test('Σ by_day.total = total_requests_in_window partition invariant', () => {
    const engine = new StubPromotionEngine();
    engine.add(makeRequest('r1', 'BIL', 'm1', '2026-05-15T08:00:00.000Z', 'pending'));
    engine.add(makeRequest('r2', 'BIL', 'm2', '2026-05-10T08:00:00.000Z', 'approved'));
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    const sum = s.by_day.reduce((a, b) => a + b.total, 0);
    expect(sum).toBe(s.total_requests_in_window);
  });

  test('Σ by_status per bucket = bucket.total partition', () => {
    const engine = new StubPromotionEngine();
    const day = '2026-05-15T08:00:00.000Z';
    engine.add(makeRequest('r1', 'BIL', 'm1', day, 'pending'));
    engine.add(makeRequest('r2', 'BIL', 'm2', day, 'approved'));
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    const bucket = s.by_day.find((b) => b.date === '2026-05-15')!;
    const sum = Object.values(bucket.by_status).reduce((a, n) => a + n, 0);
    expect(sum).toBe(bucket.total);
  });

  test('invalid days throws (0 / MAX+1 / non-integer)', () => {
    const engine = new StubPromotionEngine();
    expect(() => buildPromotionDailyVolume(engine, 'BIL', 0, NOW)).toThrow(
      PromotionDailyVolumeError,
    );
    expect(() =>
      buildPromotionDailyVolume(engine, 'BIL', MAX_PROMOTION_DAILY_WINDOW + 1, NOW),
    ).toThrow(PromotionDailyVolumeError);
    expect(() => buildPromotionDailyVolume(engine, 'BIL', 7.5, NOW)).toThrow(
      PromotionDailyVolumeError,
    );
  });

  test('days=MAX boundary accepted', () => {
    const engine = new StubPromotionEngine();
    const s = buildPromotionDailyVolume(
      engine,
      'BIL',
      MAX_PROMOTION_DAILY_WINDOW,
      NOW,
    );
    expect(s.days).toBe(MAX_PROMOTION_DAILY_WINDOW);
  });

  test('tenant_id + generated_at echo', () => {
    const engine = new StubPromotionEngine();
    const s = buildPromotionDailyVolume(engine, 'BIL', 30, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M7.17 — GET /v1/ai/promotions/daily-volume', () => {
  test('admin → 200 with empty engine', async () => {
    const { app } = makeTestApp('admin', new InMemoryPromotionEngine());
    const r = await request(app)
      .get('/v1/ai/promotions/daily-volume')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(30);
    expect(r.body.body.by_day.length).toBe(30);
  });

  test('?days=7 narrows window', async () => {
    const { app } = makeTestApp('admin', new InMemoryPromotionEngine());
    const r = await request(app)
      .get('/v1/ai/promotions/daily-volume?days=7')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.by_day.length).toBe(7);
  });

  test('populated reflects requests', async () => {
    const engine = new StubPromotionEngine();
    engine.add(makeRequest('r1', 'BIL', 'm1', '2026-05-15T08:00:00.000Z', 'pending'));
    const { app } = makeTestApp('admin', engine);
    const r = await request(app)
      .get('/v1/ai/promotions/daily-volume')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_requests_in_window).toBe(1);
  });

  test('?days=0 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeTestApp('admin', new InMemoryPromotionEngine());
    const r = await request(app)
      .get('/v1/ai/promotions/daily-volume?days=0')
      .set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=400 → 400', async () => {
    const { app } = makeTestApp('admin', new InMemoryPromotionEngine());
    const r = await request(app)
      .get('/v1/ai/promotions/daily-volume?days=400')
      .set(TH);
    expect(r.status).toBe(400);
  });

  test('?days=abc → 400', async () => {
    const { app } = makeTestApp('admin', new InMemoryPromotionEngine());
    const r = await request(app)
      .get('/v1/ai/promotions/daily-volume?days=abc')
      .set(TH);
    expect(r.status).toBe(400);
  });

  test('analyst+ accepted', async () => {
    const { app } = makeTestApp('risk_analyst', new InMemoryPromotionEngine());
    const r = await request(app)
      .get('/v1/ai/promotions/daily-volume')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeTestApp('unknown_role', new InMemoryPromotionEngine());
    const r = await request(app)
      .get('/v1/ai/promotions/daily-volume')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility', async () => {
    const engine = new StubPromotionEngine();
    engine.add(makeRequest('r1', 'BIL', 'm1', '2026-05-15T08:00:00.000Z', 'pending'));
    const { app } = makeTestApp('admin', engine);
    const r = await request(app)
      .get('/v1/ai/promotions/daily-volume')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_requests_in_window).toBe(0);
  });

  test('M7.16 /reviewer-rollup sibling regression still 200', async () => {
    const { app } = makeTestApp('admin', new InMemoryPromotionEngine());
    const r = await request(app)
      .get('/v1/ai/promotions/reviewer-rollup')
      .set(TH);
    expect(r.status).toBe(200);
  });
});
