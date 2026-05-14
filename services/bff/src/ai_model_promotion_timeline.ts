// services/bff/src/ai_model_promotion_timeline.ts
//
// T6 M7.10 — AI model promotion request timeline per model.
//
// M7.2 ships the promotion workflow (request → approve/reject)
// with `list` filterable by status/model_id/requested_by, but the
// SPA's per-model risk-management view wants the FULL history
// for one model_id in chronological order plus aggregate counts
// (how many approvals vs rejections, current effective status,
// when the last decision happened). M7.10 ships that timeline.
//
// Pure rollup. Two surfaces:
//   - per-model timeline (single model — drills into one record)
//   - tenant-wide overview (every model with ≥ 1 request +
//     models with 0 requests surfaced separately)
//
// Companion to M7.9 retirement-candidates (staleness lens) +
// M7.7 outliers (telemetry lens) — M7.10 is the audit-trail lens.

import type { ModelVersion, AiModelRegistry } from './ai_model_registry';
import type { PromotionEngine, PromotionRequest, PromotionRequestStatus } from './ai_model_promotion';

// ─── Public types ─────────────────────────────────────────────────────

export interface PromotionTimelineEntry {
  request_id: string;
  status: PromotionRequestStatus;
  from_status: ModelVersion['status'];
  to_status: ModelVersion['status'];
  requested_by: string;
  requested_at: string;
  request_notes: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  decision_notes: string | null;
  /** ms from requested_at to reviewed_at; null while pending or
   *  cancelled without a review timestamp. */
  decision_latency_ms: number | null;
}

export interface ModelPromotionTimeline {
  model_id: string;
  /** From the M7.1 registry. null when the model_id is unknown to
   *  the registry — surfaces orphan promotion requests (e.g. a model
   *  that was retired-then-deleted but its requests lingered). */
  model_name: string | null;
  /** Current model status from the registry; null when unknown. */
  current_model_status: ModelVersion['status'] | null;
  /** Total promotion requests filed. */
  total_requests: number;
  approved_count: number;
  rejected_count: number;
  cancelled_count: number;
  pending_count: number;
  /** Most-recent reviewed_at timestamp across approved/rejected
   *  requests. null when none decided yet. */
  latest_decision_at: string | null;
  /** Oldest pending request (lowest requested_at). null when no
   *  pending requests exist. */
  oldest_pending_at: string | null;
  /** Full audit chain, oldest-first. */
  timeline: PromotionTimelineEntry[];
}

export interface PromotionFleetOverview {
  tenant_id: string;
  generated_at: string;
  total_models: number;
  models_with_requests: number;
  models_without_requests: number;
  total_requests: number;
  /** Per-model summaries, sorted by total_requests desc with model_id
   *  asc tie-break — busiest models first. */
  models: ModelPromotionTimeline[];
}

// ─── Pure helpers ─────────────────────────────────────────────────────

function toEntry(req: PromotionRequest): PromotionTimelineEntry {
  let decision_latency_ms: number | null = null;
  if (req.reviewed_at) {
    const requested = Date.parse(req.requested_at);
    const reviewed = Date.parse(req.reviewed_at);
    if (Number.isFinite(requested) && Number.isFinite(reviewed) && reviewed >= requested) {
      decision_latency_ms = reviewed - requested;
    }
  }
  return {
    request_id: req.request_id,
    status: req.status,
    from_status: req.from_status,
    to_status: req.to_status,
    requested_by: req.requested_by,
    requested_at: req.requested_at,
    request_notes: req.request_notes,
    reviewed_by: req.reviewed_by,
    reviewed_at: req.reviewed_at,
    decision_notes: req.decision_notes,
    decision_latency_ms,
  };
}

function buildTimelineFromRequests(
  model_id: string,
  modelMeta: ModelVersion | null,
  requests: readonly PromotionRequest[],
): ModelPromotionTimeline {
  const sorted = [...requests].sort((a, b) => {
    if (a.requested_at !== b.requested_at) {
      return a.requested_at < b.requested_at ? -1 : 1;
    }
    // Stable tie-break for same-timestamp inputs.
    return a.request_id.localeCompare(b.request_id);
  });

  let approved_count = 0;
  let rejected_count = 0;
  let cancelled_count = 0;
  let pending_count = 0;
  let latest_decision_at: string | null = null;
  let oldest_pending_at: string | null = null;

  for (const r of sorted) {
    if (r.status === 'approved') approved_count++;
    else if (r.status === 'rejected') rejected_count++;
    else if (r.status === 'cancelled') cancelled_count++;
    else pending_count++;

    if (r.status === 'approved' || r.status === 'rejected') {
      if (r.reviewed_at && (!latest_decision_at || r.reviewed_at > latest_decision_at)) {
        latest_decision_at = r.reviewed_at;
      }
    }
    if (r.status === 'pending') {
      if (!oldest_pending_at || r.requested_at < oldest_pending_at) {
        oldest_pending_at = r.requested_at;
      }
    }
  }

  return {
    model_id,
    model_name: modelMeta?.name ?? null,
    current_model_status: modelMeta?.status ?? null,
    total_requests: sorted.length,
    approved_count,
    rejected_count,
    cancelled_count,
    pending_count,
    latest_decision_at,
    oldest_pending_at,
    timeline: sorted.map(toEntry),
  };
}

// ─── Pure resolvers ───────────────────────────────────────────────────

/** Per-model: drain every promotion request for `model_id` from the
 *  engine and produce the chronological timeline. Returns a timeline
 *  with 0 requests when none filed yet (NOT null — the model is
 *  total over model_id, so an empty timeline is meaningful). */
export function buildModelPromotionTimeline(
  engine: PromotionEngine,
  registry: AiModelRegistry,
  tenant_id: string,
  model_id: string,
): ModelPromotionTimeline {
  const all = drainAllRequests(engine, tenant_id, { model_id });
  const meta = registry.get(model_id);
  return buildTimelineFromRequests(model_id, meta, all);
}

/** Fleet-wide: walk the M7.1 registry, build a timeline per model.
 *  Models without requests still surfaced (total_requests=0). Sorted
 *  by total_requests desc with model_id asc tie-break. */
export function buildPromotionFleetOverview(
  engine: PromotionEngine,
  registry: AiModelRegistry,
  tenant_id: string,
  now: Date,
): PromotionFleetOverview {
  // Drain the engine once and bucket by model_id for O(N).
  const allRequests = drainAllRequests(engine, tenant_id, {});
  const byModel = new Map<string, PromotionRequest[]>();
  for (const r of allRequests) {
    let arr = byModel.get(r.model_id);
    if (!arr) {
      arr = [];
      byModel.set(r.model_id, arr);
    }
    arr.push(r);
  }

  const registryModels = registry.list({});
  const seen = new Set<string>();
  const models: ModelPromotionTimeline[] = [];

  for (const m of registryModels) {
    seen.add(m.model_id);
    models.push(
      buildTimelineFromRequests(m.model_id, m, byModel.get(m.model_id) ?? []),
    );
  }
  // Orphan model_ids in requests but absent from the registry.
  for (const [model_id, reqs] of byModel.entries()) {
    if (seen.has(model_id)) continue;
    models.push(buildTimelineFromRequests(model_id, null, reqs));
  }

  models.sort((a, b) => {
    if (b.total_requests !== a.total_requests) return b.total_requests - a.total_requests;
    return a.model_id.localeCompare(b.model_id);
  });

  const total_requests = models.reduce((sum, m) => sum + m.total_requests, 0);
  const models_with_requests = models.filter((m) => m.total_requests > 0).length;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_models: models.length,
    models_with_requests,
    models_without_requests: models.length - models_with_requests,
    total_requests,
    models,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

const DRAIN_PAGE_SIZE = 500;
const DRAIN_PAGE_CAP = 200;

interface DrainFilters {
  model_id?: string;
}

function drainAllRequests(
  engine: PromotionEngine,
  tenant_id: string,
  filters: DrainFilters,
): PromotionRequest[] {
  const out: PromotionRequest[] = [];
  for (let page = 1; page <= DRAIN_PAGE_CAP; page++) {
    const result = engine.list(tenant_id, {
      ...filters,
      page,
      page_size: DRAIN_PAGE_SIZE,
    });
    out.push(...result.items);
    if (result.items.length < DRAIN_PAGE_SIZE) break;
    if (out.length >= result.total) break;
  }
  return out;
}
