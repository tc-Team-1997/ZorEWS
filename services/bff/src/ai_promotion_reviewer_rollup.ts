// services/bff/src/ai_promotion_reviewer_rollup.ts
//
// T6 M7.16 — AI promotion by-reviewer activity rollup.
//
// M7.2 ships the promotion request workflow with approve/reject (per
// RBI's model risk management framework — 4-eyes principle requires a
// distinct reviewer from the requester). M7.10 ships per-model
// timeline + fleet overview. M7.15 ships the fleet-wide latency
// histogram.
//
// M7.16 lands the PER-REVIEWER pivot — who's been approving/rejecting?
// Per reviewer: distinct models reviewed + approved_count +
// rejected_count + decision_rate + most-recent-decision-at.
//
// Mirror of M2.15 / M13.16 / M15.8 / M9.14 / M11.15 per-actor pattern
// for the AI/ML promotion-workflow surface.
//
// Drives BIL AI governance "who has been approving model promotions?"
// quarterly access-review + "is any reviewer rubber-stamping (100%
// approval) all requests?" — useful for cross-checking review quality.
//
// Pure resolver — caller passes drained PromotionRequest list.

import type { PromotionEngine, PromotionRequest } from './ai_model_promotion';

// ─── Public types ──────────────────────────────────────────────────────

export interface PromotionReviewerRow {
  reviewed_by: string;
  /** Total decided requests (approved + rejected) for this reviewer. */
  total_decisions: number;
  approved_count: number;
  rejected_count: number;
  /** approved_count / total_decisions; null when total_decisions=0
   *  (which shouldn't happen since the reviewer wouldn't be in the
   *  pivot unless they've decided ≥ 1 request, but defensive). */
  approval_rate: number | null;
  /** Distinct model_ids this reviewer has decided on (sorted asc). */
  distinct_models: string[];
  /** Newest reviewed_at across this reviewer's decisions; null when
   *  no decisions (defensive). */
  most_recent_at: string | null;
}

export interface PromotionReviewerRollupSummary {
  tenant_id: string;
  generated_at: string;
  total_decisions: number;
  total_reviewers: number;
  reviewers: PromotionReviewerRow[];
  /** Top row by total_decisions; canonical username asc tie-break;
   *  null on empty. */
  most_active_reviewer: string | null;
  /** Subset of reviewers with approval_rate === 1.0 (rubber-stamping
   *  candidates — useful flag for AI governance review). Sorted by
   *  total_decisions desc + reviewed_by asc tie-break. */
  rubber_stamp_reviewers: string[];
}

export const RUBBER_STAMP_MIN_DECISIONS = 3;

// ─── Helpers ───────────────────────────────────────────────────────────

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

export function summarizePromotionReviewerActivity(
  engine: PromotionEngine,
  tenant_id: string,
  now: Date,
): PromotionReviewerRollupSummary {
  const requests = drainAllRequests(engine, tenant_id);

  type Bucket = {
    total_decisions: number;
    approved_count: number;
    rejected_count: number;
    models: Set<string>;
    most_recent_at: string | null;
  };
  const buckets = new Map<string, Bucket>();

  let total_decisions = 0;

  for (const req of requests) {
    // Only count decided requests (approved or rejected); skip pending
    // + cancelled.
    if (req.status !== 'approved' && req.status !== 'rejected') continue;
    const reviewer = req.reviewed_by;
    if (!reviewer) continue;

    let b = buckets.get(reviewer);
    if (!b) {
      b = {
        total_decisions: 0,
        approved_count: 0,
        rejected_count: 0,
        models: new Set<string>(),
        most_recent_at: null,
      };
      buckets.set(reviewer, b);
    }
    b.total_decisions++;
    total_decisions++;
    if (req.status === 'approved') b.approved_count++;
    else b.rejected_count++;
    b.models.add(req.model_id);
    if (
      req.reviewed_at &&
      (!b.most_recent_at || req.reviewed_at > b.most_recent_at)
    ) {
      b.most_recent_at = req.reviewed_at;
    }
  }

  const reviewers: PromotionReviewerRow[] = [...buckets.entries()]
    .map(([reviewer, b]) => ({
      reviewed_by: reviewer,
      total_decisions: b.total_decisions,
      approved_count: b.approved_count,
      rejected_count: b.rejected_count,
      approval_rate:
        b.total_decisions === 0 ? null : b.approved_count / b.total_decisions,
      distinct_models: [...b.models].sort(),
      most_recent_at: b.most_recent_at,
    }))
    .sort((a, b) => {
      if (b.total_decisions !== a.total_decisions) {
        return b.total_decisions - a.total_decisions;
      }
      return a.reviewed_by.localeCompare(b.reviewed_by);
    });

  const most_active_reviewer = reviewers.length > 0
    ? reviewers[0].reviewed_by
    : null;

  // rubber_stamp_reviewers — approval_rate === 1.0 AND decided ≥ MIN
  // (avoid flagging reviewers who've only approved a single request as
  // rubber-stampers). Sorted desc by decisions then email.
  const rubber_stamp_reviewers = reviewers
    .filter(
      (r) =>
        r.approval_rate === 1 &&
        r.total_decisions >= RUBBER_STAMP_MIN_DECISIONS,
    )
    .map((r) => r.reviewed_by);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_decisions,
    total_reviewers: reviewers.length,
    reviewers,
    most_active_reviewer,
    rubber_stamp_reviewers,
  };
}
