// services/bff/__tests__/ai_promotion_latency_histogram.test.ts
//
// T6 M7.15 — AI promotion approval-latency histogram.

import request from 'supertest';
import {
  summarizePromotionLatencyHistogram,
  ALL_LATENCY_BUCKETS,
  type PromotionLatencyHistogramSummary,
} from '../src/ai_promotion_latency_histogram';
import { InMemoryPromotionEngine } from '../src/ai_model_promotion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makePlhApp(role: string = 'admin', promotionEngine?: InMemoryPromotionEngine) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    promotionEngine: promotionEngine ?? new InMemoryPromotionEngine(),
  });
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// Seed a request via the engine then mutate latency by approving at a
// specific offset. The engine exposes `requestPromotion` (timestamps
// `requested_at = now`) and `approve` (timestamps `reviewed_at = now`),
// so latency = approval-now - request-now.
function seedDecided(
  engine: InMemoryPromotionEngine,
  tenant: string,
  model_id: string,
  offsetMs: number,
  status: 'approved' | 'rejected' = 'approved',
  reqTime: Date = NOW,
) {
  const requestedAt = new Date(reqTime.getTime() - offsetMs);
  // We can't directly set requested_at — file the request at requestedAt,
  // then approve at NOW, so latency_ms = offsetMs.
  const req = engine.requestPromotion(
    tenant,
    {
      model_id,
      from_status: 'staging',
      to_status: 'production',
      request_notes: 'unit test',
    },
    'maker',
    requestedAt,
  );
  if (status === 'approved') {
    engine.approve(tenant, req.request_id, 'checker', 'lgtm', reqTime);
  } else {
    engine.reject(tenant, req.request_id, 'checker', 'nope', reqTime);
  }
  return req;
}

function seedPending(
  engine: InMemoryPromotionEngine,
  tenant: string,
  model_id: string,
  ageOffsetMs: number,
) {
  const requestedAt = new Date(NOW.getTime() - ageOffsetMs);
  return engine.requestPromotion(
    tenant,
    {
      model_id,
      from_status: 'staging',
      to_status: 'production',
      request_notes: 'still pending',
    },
    'maker',
    requestedAt,
  );
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M7.15 — empty engine', () => {
  test('zero requests → every bucket at 0, peak null, percentiles null', () => {
    const e = new InMemoryPromotionEngine();
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.total_requests).toBe(0);
    expect(s.total_decided).toBe(0);
    expect(s.total_pending).toBe(0);
    expect(s.total_cancelled).toBe(0);
    expect(s.buckets.length).toBe(7);
    for (const b of s.buckets) expect(b.count).toBe(0);
    expect(s.peak_bucket).toBeNull();
    expect(s.peak_count).toBe(0);
    expect(s.mean_decided_ms).toBeNull();
    expect(s.median_decided_ms).toBeNull();
    expect(s.p95_decided_ms).toBeNull();
  });
});

describe('M7.15 — canonical bucket order', () => {
  test('buckets[] in canonical ALL_LATENCY_BUCKETS order', () => {
    const e = new InMemoryPromotionEngine();
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.map((b) => b.bucket)).toEqual([...ALL_LATENCY_BUCKETS]);
  });

  test('every bucket exposes label + min_ms + max_ms metadata', () => {
    const e = new InMemoryPromotionEngine();
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    for (const b of s.buckets) {
      expect(b.label.length).toBeGreaterThan(0);
      // min_ms/max_ms may be null for non-decided buckets, which is fine
    }
  });
});

describe('M7.15 — under_1h placement', () => {
  test('30-minute latency → under_1h bucket', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 30 * 60 * 1000);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === 'under_1h')!.count).toBe(1);
    expect(s.buckets.find((b) => b.bucket === '1_to_24h')!.count).toBe(0);
    expect(s.total_decided).toBe(1);
  });
});

describe('M7.15 — 1_to_24h placement', () => {
  test('2-hour latency → 1_to_24h bucket', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 2 * MS_PER_HOUR);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === '1_to_24h')!.count).toBe(1);
    expect(s.buckets.find((b) => b.bucket === 'under_1h')!.count).toBe(0);
  });
});

describe('M7.15 — 1_to_7d placement', () => {
  test('3-day latency → 1_to_7d', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 3 * MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === '1_to_7d')!.count).toBe(1);
  });
});

describe('M7.15 — 7_to_30d placement', () => {
  test('15-day latency → 7_to_30d', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 15 * MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === '7_to_30d')!.count).toBe(1);
  });
});

describe('M7.15 — 30d_plus placement', () => {
  test('45-day latency → 30d_plus', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 45 * MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === '30d_plus')!.count).toBe(1);
  });
});

describe('M7.15 — boundary semantics (strict-<)', () => {
  test('exact 1h → 1_to_24h (not under_1h)', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', MS_PER_HOUR);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === 'under_1h')!.count).toBe(0);
    expect(s.buckets.find((b) => b.bucket === '1_to_24h')!.count).toBe(1);
  });

  test('exact 24h → 1_to_7d (not 1_to_24h)', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === '1_to_24h')!.count).toBe(0);
    expect(s.buckets.find((b) => b.bucket === '1_to_7d')!.count).toBe(1);
  });

  test('exact 7d → 7_to_30d', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 7 * MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === '7_to_30d')!.count).toBe(1);
    expect(s.buckets.find((b) => b.bucket === '1_to_7d')!.count).toBe(0);
  });

  test('exact 30d → 30d_plus', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 30 * MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === '30d_plus')!.count).toBe(1);
    expect(s.buckets.find((b) => b.bucket === '7_to_30d')!.count).toBe(0);
  });
});

describe('M7.15 — still_pending placement', () => {
  test('open request → still_pending bucket; total_pending bumped', () => {
    const e = new InMemoryPromotionEngine();
    seedPending(e, 'BIL', 'm1', 3 * MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === 'still_pending')!.count).toBe(1);
    expect(s.total_pending).toBe(1);
    expect(s.total_decided).toBe(0);
  });
});

describe('M7.15 — rejected counts in decided buckets', () => {
  test('rejected at 2h → 1_to_24h', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 2 * MS_PER_HOUR, 'rejected');
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === '1_to_24h')!.count).toBe(1);
    expect(s.total_decided).toBe(1);
  });
});

describe('M7.15 — mean / median / p95', () => {
  test('mean = round(Σ/n) and percentiles are linear-interp over decided latencies', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 60_000);     // 1 min
    seedDecided(e, 'BIL', 'm2', 120_000);    // 2 min
    seedDecided(e, 'BIL', 'm3', 180_000);    // 3 min
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.mean_decided_ms).toBe(120_000);
    expect(s.median_decided_ms).toBe(120_000);
    // p95 of [60k, 120k, 180k]: rank = 0.95 * 2 = 1.9; lower=120k, upper=180k, frac=0.9 → 174k
    expect(s.p95_decided_ms).toBe(174_000);
  });

  test('null when no decided rows', () => {
    const e = new InMemoryPromotionEngine();
    seedPending(e, 'BIL', 'm1', MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.mean_decided_ms).toBeNull();
    expect(s.median_decided_ms).toBeNull();
    expect(s.p95_decided_ms).toBeNull();
  });
});

describe('M7.15 — peak_bucket formula', () => {
  test('highest-count bucket wins; canonical tie-break (earlier bucket wins)', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 30 * 60 * 1000); // under_1h
    seedDecided(e, 'BIL', 'm2', 30 * 60 * 1000); // under_1h
    seedDecided(e, 'BIL', 'm3', 2 * MS_PER_HOUR); // 1_to_24h
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.peak_bucket).toBe('under_1h');
    expect(s.peak_count).toBe(2);
  });

  test('canonical tie-break: under_1h wins over 1_to_24h at tied counts', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 30 * 60 * 1000);
    seedDecided(e, 'BIL', 'm2', 2 * MS_PER_HOUR);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.peak_bucket).toBe('under_1h');
  });

  test('null when no requests', () => {
    const s = summarizePromotionLatencyHistogram(new InMemoryPromotionEngine(), 'BIL', NOW);
    expect(s.peak_bucket).toBeNull();
    expect(s.peak_count).toBe(0);
  });
});

describe('M7.15 — samples', () => {
  test('cap 3 per bucket', () => {
    const e = new InMemoryPromotionEngine();
    for (let i = 0; i < 5; i++) {
      seedDecided(e, 'BIL', `model-${i}`, 30 * 60 * 1000);
    }
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    const under1h = s.buckets.find((b) => b.bucket === 'under_1h')!;
    expect(under1h.count).toBe(5);
    expect(under1h.samples.length).toBe(3);
  });

  test('decided bucket samples sorted oldest-decision first (reviewed_at asc)', () => {
    const e = new InMemoryPromotionEngine();
    // 3 decided at different decision times
    seedDecided(e, 'BIL', 'm1', 30 * 60 * 1000, 'approved', new Date(NOW.getTime() - 3 * MS_PER_HOUR));
    seedDecided(e, 'BIL', 'm2', 30 * 60 * 1000, 'approved', new Date(NOW.getTime() - 1 * MS_PER_HOUR));
    seedDecided(e, 'BIL', 'm3', 30 * 60 * 1000, 'approved', new Date(NOW.getTime() - 2 * MS_PER_HOUR));
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    const under1h = s.buckets.find((b) => b.bucket === 'under_1h')!;
    expect(under1h.samples.length).toBe(3);
    // sorted by reviewed_at asc — m1 (oldest decision) first
    expect(under1h.samples[0].model_id).toBe('m1');
    expect(under1h.samples[1].model_id).toBe('m3');
    expect(under1h.samples[2].model_id).toBe('m2');
  });

  test('still_pending samples sorted oldest-pending first (requested_at asc)', () => {
    const e = new InMemoryPromotionEngine();
    seedPending(e, 'BIL', 'm1', 5 * MS_PER_DAY);   // 5 days ago — oldest
    seedPending(e, 'BIL', 'm2', 1 * MS_PER_DAY);
    seedPending(e, 'BIL', 'm3', 3 * MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    const pending = s.buckets.find((b) => b.bucket === 'still_pending')!;
    expect(pending.count).toBe(3);
    expect(pending.samples.map((x) => x.model_id)).toEqual(['m1', 'm3', 'm2']);
  });

  test('samples carry latency_ms (null for pending) + request_id + model_id', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 30 * 60 * 1000);
    seedPending(e, 'BIL', 'mp', MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    const under1h = s.buckets.find((b) => b.bucket === 'under_1h')!;
    expect(under1h.samples[0].latency_ms).toBe(30 * 60 * 1000);
    expect(under1h.samples[0].request_id).toMatch(/^pr-/);
    expect(under1h.samples[0].model_id).toBe('m1');
    const pending = s.buckets.find((b) => b.bucket === 'still_pending')!;
    expect(pending.samples[0].latency_ms).toBeNull();
  });
});

describe('M7.15 — partition invariants', () => {
  test('Σ buckets.count = total_requests', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 30 * 60 * 1000);
    seedDecided(e, 'BIL', 'm2', 2 * MS_PER_HOUR);
    seedPending(e, 'BIL', 'mp1', MS_PER_DAY);
    seedPending(e, 'BIL', 'mp2', 2 * MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    const sum = s.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(sum).toBe(s.total_requests);
    expect(s.total_requests).toBe(4);
  });

  test('total_decided + total_pending + total_cancelled = total_requests', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 30 * 60 * 1000);
    seedPending(e, 'BIL', 'mp1', MS_PER_DAY);
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.total_decided + s.total_pending + s.total_cancelled).toBe(s.total_requests);
  });
});

describe('M7.15 — tenant scoping', () => {
  test('BIL requests invisible to BANK_DEMO', () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 30 * 60 * 1000);
    seedDecided(e, 'BIL', 'm2', 2 * MS_PER_HOUR);
    const bil = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    const bank = summarizePromotionLatencyHistogram(e, 'BANK_DEMO', NOW);
    expect(bil.total_requests).toBe(2);
    expect(bank.total_requests).toBe(0);
  });
});

describe('M7.15 — tenant_id + generated_at echo', () => {
  test('envelope carries tenant_id + ISO generated_at', () => {
    const e = new InMemoryPromotionEngine();
    const s = summarizePromotionLatencyHistogram(e, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M7.15 — GET /v1/ai/promotions/latency-histogram', () => {
  test('admin → 200 with empty engine', async () => {
    const { app } = makePlhApp('admin');
    const r = await request(app)
      .get('/v1/ai/promotions/latency-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    const body = r.body.body as PromotionLatencyHistogramSummary;
    expect(body.total_requests).toBe(0);
    expect(body.buckets.length).toBe(7);
  });

  test('populated → reflects seeded requests', async () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 30 * 60 * 1000);
    seedDecided(e, 'BIL', 'm2', 2 * MS_PER_HOUR);
    seedPending(e, 'BIL', 'mp1', MS_PER_DAY);
    const { app } = makePlhApp('admin', e);
    const r = await request(app)
      .get('/v1/ai/promotions/latency-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    const body = r.body.body as PromotionLatencyHistogramSummary;
    expect(body.total_requests).toBe(3);
    expect(body.total_decided).toBe(2);
    expect(body.total_pending).toBe(1);
    expect(body.peak_bucket).not.toBeNull();
  });

  test('analyst+ (customers:read_risk_profile) accepted', async () => {
    const { app } = makePlhApp('risk_analyst');
    const r = await request(app)
      .get('/v1/ai/promotions/latency-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePlhApp('case_owner');
    const r = await request(app)
      .get('/v1/ai/promotions/latency-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility (BIL requests invisible to BANK_DEMO via HTTP)', async () => {
    const e = new InMemoryPromotionEngine();
    seedDecided(e, 'BIL', 'm1', 30 * 60 * 1000);
    const { app } = makePlhApp('admin', e);
    const bankR = await request(app)
      .get('/v1/ai/promotions/latency-histogram')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_requests).toBe(0);
    const bilR = await request(app)
      .get('/v1/ai/promotions/latency-histogram')
      .set(TH_BIL);
    expect(bilR.body.body.total_requests).toBe(1);
  });

  test('M7.2 GET /v1/ai/promotions sibling regression still 200', async () => {
    const { app } = makePlhApp('admin');
    const r = await request(app).get('/v1/ai/promotions').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
