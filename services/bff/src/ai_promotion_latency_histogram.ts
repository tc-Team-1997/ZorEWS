// services/bff/src/ai_promotion_latency_histogram.ts
//
// T6 M7.15 — AI promotion request approval-latency histogram.
//
// M7.2 ships the promotion request workflow (request → approve/reject).
// M7.10 ships the per-model promotion timeline + fleet overview — each
// request carries `decision_latency_ms` (reviewed_at − requested_at)
// computed per-row.
//
// M7.15 lands the FLEET-WIDE LATENCY DISTRIBUTION view: across ALL
// decided promotion requests in the tenant, bucket the wall-clock
// approval latency into 5 canonical bands (under_1h / 1_to_24h /
// 1_to_7d / 7_to_30d / 30d_plus) plus a `still_pending` bucket for
// active requests and a `cancelled` bucket for cancelled-without-review
// rows.
//
// Mirror of M8.12 alert ack-time histogram + M9.11 case age buckets
// pattern. Per-bucket carries count + samples (cap 3, oldest decisions
// first for completed buckets, oldest-pending first for still_pending,
// newest cancellations first for cancelled). Envelope carries
// mean_decided_ms / median_decided_ms / p95_decided_ms over DECIDED
// rows only (approved + rejected), peak_bucket (canonical-order
// tie-break), and per-status totals.
//
// Drives the BIL ops "what's our typical promotion turnaround?" view +
// "any pending requests sitting > 7 days?" supervisor escalation panel.
// Distinct from M7.10 (per-model timeline focus) by being aggregate
// histogram across the entire fleet.
//
// Pure resolver — no I/O.

import type { PromotionEngine, PromotionRequest } from './ai_model_promotion';

// ─── Canonical buckets ─────────────────────────────────────────────────

export type LatencyBucket =
  | 'under_1h'
  | '1_to_24h'
  | '1_to_7d'
  | '7_to_30d'
  | '30d_plus'
  | 'still_pending'
  | 'cancelled';

export const ALL_LATENCY_BUCKETS: readonly LatencyBucket[] = [
  'under_1h',
  '1_to_24h',
  '1_to_7d',
  '7_to_30d',
  '30d_plus',
  'still_pending',
  'cancelled',
] as const;

interface BucketDef {
  bucket: LatencyBucket;
  label: string;
  min_ms: number | null;
  max_ms: number | null;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const BUCKET_DEFS: Record<LatencyBucket, BucketDef> = {
  under_1h: { bucket: 'under_1h', label: '< 1 hour', min_ms: 0, max_ms: MS_PER_HOUR },
  '1_to_24h': {
    bucket: '1_to_24h',
    label: '1 – 24 hours',
    min_ms: MS_PER_HOUR,
    max_ms: MS_PER_DAY,
  },
  '1_to_7d': {
    bucket: '1_to_7d',
    label: '1 – 7 days',
    min_ms: MS_PER_DAY,
    max_ms: 7 * MS_PER_DAY,
  },
  '7_to_30d': {
    bucket: '7_to_30d',
    label: '7 – 30 days',
    min_ms: 7 * MS_PER_DAY,
    max_ms: 30 * MS_PER_DAY,
  },
  '30d_plus': {
    bucket: '30d_plus',
    label: '> 30 days',
    min_ms: 30 * MS_PER_DAY,
    max_ms: null,
  },
  still_pending: {
    bucket: 'still_pending',
    label: 'Still pending',
    min_ms: null,
    max_ms: null,
  },
  cancelled: {
    bucket: 'cancelled',
    label: 'Cancelled (no decision)',
    min_ms: null,
    max_ms: null,
  },
};

// ─── Public types ──────────────────────────────────────────────────────

export interface PromotionLatencySample {
  request_id: string;
  model_id: string;
  status: PromotionRequest['status'];
  requested_at: string;
  reviewed_at: string | null;
  latency_ms: number | null;
}

export interface PromotionLatencyBucket {
  bucket: LatencyBucket;
  label: string;
  min_ms: number | null;
  max_ms: number | null;
  count: number;
  samples: PromotionLatencySample[];
}

export interface PromotionLatencyHistogramSummary {
  tenant_id: string;
  generated_at: string;
  total_requests: number;
  total_decided: number;
  total_pending: number;
  total_cancelled: number;
  mean_decided_ms: number | null;
  median_decided_ms: number | null;
  p95_decided_ms: number | null;
  peak_bucket: LatencyBucket | null;
  peak_count: number;
  buckets: PromotionLatencyBucket[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function classifyLatency(latency_ms: number): LatencyBucket {
  if (latency_ms < MS_PER_HOUR) return 'under_1h';
  if (latency_ms < MS_PER_DAY) return '1_to_24h';
  if (latency_ms < 7 * MS_PER_DAY) return '1_to_7d';
  if (latency_ms < 30 * MS_PER_DAY) return '7_to_30d';
  return '30d_plus';
}

function latencyMsFor(req: PromotionRequest): number | null {
  if (!req.reviewed_at) return null;
  const reqTs = new Date(req.requested_at).getTime();
  const revTs = new Date(req.reviewed_at).getTime();
  if (!Number.isFinite(reqTs) || !Number.isFinite(revTs)) return null;
  return Math.max(0, revTs - reqTs);
}

function toSample(
  req: PromotionRequest,
  latency_ms: number | null,
): PromotionLatencySample {
  return {
    request_id: req.request_id,
    model_id: req.model_id,
    status: req.status,
    requested_at: req.requested_at,
    reviewed_at: req.reviewed_at,
    latency_ms,
  };
}

/** Linear-interpolation percentile (Excel/R type 7); same shape as M3.5. */
function percentile(sortedAsc: readonly number[], pct: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const rank = (pct / 100) * (n - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAsc[lower];
  const frac = rank - lower;
  return sortedAsc[lower] + frac * (sortedAsc[upper] - sortedAsc[lower]);
}

function drainAllRequests(
  engine: PromotionEngine,
  tenant_id: string,
): PromotionRequest[] {
  const PAGE = 500;
  const out: PromotionRequest[] = [];
  for (let page = 1; page <= 200; page++) {
    const result = engine.list(tenant_id, { page, page_size: PAGE });
    out.push(...result.items);
    if (result.items.length < PAGE) break;
  }
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizePromotionLatencyHistogram(
  engine: PromotionEngine,
  tenant_id: string,
  now: Date,
): PromotionLatencyHistogramSummary {
  const requests = drainAllRequests(engine, tenant_id);

  // Build per-bucket structures.
  const buckets: Record<LatencyBucket, PromotionLatencyBucket> = Object.fromEntries(
    ALL_LATENCY_BUCKETS.map((b) => [
      b,
      {
        bucket: b,
        label: BUCKET_DEFS[b].label,
        min_ms: BUCKET_DEFS[b].min_ms,
        max_ms: BUCKET_DEFS[b].max_ms,
        count: 0,
        samples: [] as PromotionLatencySample[],
      },
    ]),
  ) as Record<LatencyBucket, PromotionLatencyBucket>;

  // Per-bucket candidate pool (for stable sorting + cap 3 sampling).
  type Cand = { req: PromotionRequest; latency_ms: number | null };
  const candidates: Record<LatencyBucket, Cand[]> = Object.fromEntries(
    ALL_LATENCY_BUCKETS.map((b) => [b, [] as Cand[]]),
  ) as Record<LatencyBucket, Cand[]>;

  const decidedLatencies: number[] = [];

  let total_decided = 0;
  let total_pending = 0;
  let total_cancelled = 0;

  for (const req of requests) {
    if (req.status === 'pending') {
      total_pending++;
      buckets.still_pending.count++;
      candidates.still_pending.push({ req, latency_ms: null });
      continue;
    }
    if (req.status === 'cancelled') {
      total_cancelled++;
      buckets.cancelled.count++;
      candidates.cancelled.push({ req, latency_ms: null });
      continue;
    }
    // approved or rejected — both contribute to decided latency stats
    const latency_ms = latencyMsFor(req);
    if (latency_ms === null) continue; // defensive; review without ts
    total_decided++;
    decidedLatencies.push(latency_ms);
    const b = classifyLatency(latency_ms);
    buckets[b].count++;
    candidates[b].push({ req, latency_ms });
  }

  // Finalise per-bucket samples — cap 3 with appropriate sort:
  //   completed buckets → oldest-decided first (reviewed_at asc)
  //   still_pending → oldest-pending first (requested_at asc)
  //   cancelled → newest first (requested_at desc) — recent cancellations
  //               are usually the most actionable for "what got dropped?"
  for (const b of ALL_LATENCY_BUCKETS) {
    const cands = candidates[b];
    if (b === 'still_pending') {
      cands.sort((a, b2) =>
        a.req.requested_at.localeCompare(b2.req.requested_at),
      );
    } else if (b === 'cancelled') {
      cands.sort((a, b2) =>
        b2.req.requested_at.localeCompare(a.req.requested_at),
      );
    } else {
      cands.sort((a, b2) => {
        const ar = a.req.reviewed_at ?? '';
        const br = b2.req.reviewed_at ?? '';
        return ar.localeCompare(br);
      });
    }
    buckets[b].samples = cands.slice(0, 3).map((c) => toSample(c.req, c.latency_ms));
  }

  // mean / median / p95 across decided latencies only
  const sorted = [...decidedLatencies].sort((a, b) => a - b);
  const mean_decided_ms = sorted.length === 0
    ? null
    : Math.round(sorted.reduce((acc, x) => acc + x, 0) / sorted.length);
  const median_decided_ms = sorted.length === 0
    ? null
    : Math.round(percentile(sorted, 50) ?? 0);
  const p95_decided_ms = sorted.length === 0
    ? null
    : Math.round(percentile(sorted, 95) ?? 0);

  // peak_bucket — highest count; canonical-order tie-break via iteration order
  let peak_bucket: LatencyBucket | null = null;
  let peak_count = 0;
  for (const b of ALL_LATENCY_BUCKETS) {
    const c = buckets[b].count;
    if (c > peak_count) {
      peak_count = c;
      peak_bucket = b;
    }
  }
  if (peak_count === 0) peak_bucket = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_requests: requests.length,
    total_decided,
    total_pending,
    total_cancelled,
    mean_decided_ms,
    median_decided_ms,
    p95_decided_ms,
    peak_bucket,
    peak_count,
    buckets: ALL_LATENCY_BUCKETS.map((b) => buckets[b]),
  };
}
