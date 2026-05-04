// services/bff/src/ai_model_promotion.ts
//
// T6 M7.2 — AI/ML model promotion workflow.
//
// M7.1 ships the model registry (read-only catalogue of platform-
// declared models). M7.2 lands the workflow that BIL ops + risk
// committees actually need: a tracked path for promoting a model from
// experimental → staging → shadow → production (or retiring it).
//
// Per RBI's model risk management framework (and the BIL pitch §6),
// every promotion needs:
//   - a recorded requester (who proposed)
//   - a recorded reviewer (who approved/rejected)
//   - a decision rationale (free-text notes)
//   - an explicit state transition from one declared status to another
//
// This module is the workflow tracker. It does NOT mutate the
// registry's `SEED_MODELS` (those stay read-only); the registry's
// `getProductionByType` reflects only the declared state. A future
// M7.3 will let the platform consume an "applied" promotion and update
// the live status — for M7.2, the workflow records the decision; the
// declaration mirror stays manual.

import { randomUUID } from 'node:crypto';
import type { ModelStatus } from './ai_model_registry';

// ─── Public types ──────────────────────────────────────────────────────

export type PromotionRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface PromotionRequest {
  request_id: string;
  tenant_id: string;
  model_id: string;
  /** The CURRENT registry status when the request was filed. */
  from_status: ModelStatus;
  /** The proposed target status. */
  to_status: ModelStatus;
  /** Workflow status (NOT the model's status — those are different). */
  status: PromotionRequestStatus;
  requested_by: string;
  requested_at: string;
  /** Free-text rationale on the request itself. */
  request_notes: string;
  /** Set on approve/reject. null while pending/cancelled-by-requester. */
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** Reviewer's rationale. null while pending. */
  decision_notes: string | null;
}

export interface RequestPromotionInput {
  model_id: string;
  from_status: ModelStatus;
  to_status: ModelStatus;
  request_notes: string;
}

export interface PromotionFilters {
  status?: PromotionRequestStatus;
  model_id?: string;
  requested_by?: string;
  page?: number;
  page_size?: number;
}

export interface PromotionPage {
  items: PromotionRequest[];
  page: number;
  page_size: number;
  total: number;
}

export class PromotionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PromotionError';
  }
}

// ─── State machine ─────────────────────────────────────────────────────
//
// Allowed transitions across the model lifecycle. These mirror the
// shipping practice for ML model risk management:
//   experimental — researcher's sandbox; can graduate to staging or
//                  be killed.
//   staging      — feature-frozen; can promote to shadow (run against
//                  prod traffic without serving) or production directly.
//                  Can retire if the experiment didn't pan out.
//   shadow       — running against prod traffic, scored side-by-side
//                  with the live production model. Can promote when
//                  metrics confirm; can retire if it underperforms.
//   production   — serving live decisions. Can only be retired (a
//                  replacement runs through experimental→staging→
//                  shadow→production explicitly; you never "downgrade"
//                  a model in place).
//   retired      — terminal. No further transitions.

const TRANSITIONS: Record<ModelStatus, ModelStatus[]> = {
  experimental: ['staging', 'retired'],
  staging: ['shadow', 'production', 'retired'],
  shadow: ['production', 'retired'],
  production: ['retired'],
  retired: [], // terminal
};

export function canTransition(from: ModelStatus, to: ModelStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

const VALID_REQUEST_STATUSES: PromotionRequestStatus[] = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
];

export function isPromotionRequestStatus(s: unknown): s is PromotionRequestStatus {
  return typeof s === 'string' && VALID_REQUEST_STATUSES.includes(s as PromotionRequestStatus);
}

// ─── Validation ────────────────────────────────────────────────────────

const VALID_MODEL_STATUSES: ModelStatus[] = [
  'experimental',
  'staging',
  'production',
  'shadow',
  'retired',
];

function isModelStatus(s: unknown): s is ModelStatus {
  return typeof s === 'string' && VALID_MODEL_STATUSES.includes(s as ModelStatus);
}

export function validateRequestInput(input: unknown): RequestPromotionInput {
  if (!input || typeof input !== 'object') {
    throw new PromotionError('invalid_input', 'request body required');
  }
  const i = input as Partial<RequestPromotionInput>;
  if (typeof i.model_id !== 'string' || !i.model_id.trim()) {
    throw new PromotionError('invalid_input', 'model_id is required');
  }
  if (!isModelStatus(i.from_status)) {
    throw new PromotionError('invalid_input', `from_status must be one of ${VALID_MODEL_STATUSES.join(',')}`);
  }
  if (!isModelStatus(i.to_status)) {
    throw new PromotionError('invalid_input', `to_status must be one of ${VALID_MODEL_STATUSES.join(',')}`);
  }
  if (!canTransition(i.from_status, i.to_status)) {
    throw new PromotionError(
      'invalid_transition',
      `cannot transition from ${i.from_status} to ${i.to_status}`,
    );
  }
  if (typeof i.request_notes !== 'string') {
    throw new PromotionError('invalid_input', 'request_notes is required');
  }
  if (i.request_notes.length > 4000) {
    throw new PromotionError('invalid_input', 'request_notes must be ≤ 4000 chars');
  }
  return {
    model_id: i.model_id,
    from_status: i.from_status,
    to_status: i.to_status,
    request_notes: i.request_notes,
  };
}

// ─── Engine + store ────────────────────────────────────────────────────

export interface PromotionEngine {
  requestPromotion(
    tenant_id: string,
    input: unknown,
    requested_by: string,
    now: Date,
  ): PromotionRequest;
  list(tenant_id: string, filters: PromotionFilters): PromotionPage;
  get(tenant_id: string, request_id: string): PromotionRequest | null;
  approve(
    tenant_id: string,
    request_id: string,
    reviewed_by: string,
    decision_notes: string | null,
    now: Date,
  ): PromotionRequest;
  reject(
    tenant_id: string,
    request_id: string,
    reviewed_by: string,
    decision_notes: string | null,
    now: Date,
  ): PromotionRequest;
}

export class InMemoryPromotionEngine implements PromotionEngine {
  /** tenant_id → request_id → PromotionRequest. */
  private readonly state = new Map<string, Map<string, PromotionRequest>>();

  requestPromotion(
    tenant_id: string,
    input: unknown,
    requested_by: string,
    now: Date,
  ): PromotionRequest {
    const validated = validateRequestInput(input);
    const ts = this.tState(tenant_id);
    // Refuse a 2nd active request for the same model — keeps the audit
    // trail unambiguous. Caller must reject/cancel the existing one
    // first.
    for (const existing of ts.values()) {
      if (existing.model_id === validated.model_id && existing.status === 'pending') {
        throw new PromotionError(
          'request_already_pending',
          `model ${validated.model_id} already has a pending promotion request: ${existing.request_id}`,
        );
      }
    }
    const req: PromotionRequest = {
      request_id: `pr-${randomUUID()}`,
      tenant_id,
      model_id: validated.model_id,
      from_status: validated.from_status,
      to_status: validated.to_status,
      status: 'pending',
      requested_by,
      requested_at: now.toISOString(),
      request_notes: validated.request_notes,
      reviewed_by: null,
      reviewed_at: null,
      decision_notes: null,
    };
    ts.set(req.request_id, req);
    return req;
  }

  list(tenant_id: string, filters: PromotionFilters): PromotionPage {
    const ts = this.state.get(tenant_id);
    const all = ts ? [...ts.values()] : [];
    const filtered = all.filter((r) => {
      if (filters.status !== undefined && r.status !== filters.status) return false;
      if (filters.model_id !== undefined && r.model_id !== filters.model_id) return false;
      if (filters.requested_by !== undefined && r.requested_by !== filters.requested_by) return false;
      return true;
    });
    // newest-first by requested_at
    filtered.sort((a, b) => b.requested_at.localeCompare(a.requested_at));
    const page = Math.max(1, filters.page ?? 1);
    const page_size = Math.max(1, Math.min(200, filters.page_size ?? 50));
    const start = (page - 1) * page_size;
    return {
      items: filtered.slice(start, start + page_size),
      page,
      page_size,
      total: filtered.length,
    };
  }

  get(tenant_id: string, request_id: string): PromotionRequest | null {
    return this.state.get(tenant_id)?.get(request_id) ?? null;
  }

  approve(
    tenant_id: string,
    request_id: string,
    reviewed_by: string,
    decision_notes: string | null,
    now: Date,
  ): PromotionRequest {
    return this.applyDecision(tenant_id, request_id, 'approved', reviewed_by, decision_notes, now);
  }

  reject(
    tenant_id: string,
    request_id: string,
    reviewed_by: string,
    decision_notes: string | null,
    now: Date,
  ): PromotionRequest {
    return this.applyDecision(tenant_id, request_id, 'rejected', reviewed_by, decision_notes, now);
  }

  /** Test helper. */
  reset(): void {
    this.state.clear();
  }

  private tState(tenant_id: string): Map<string, PromotionRequest> {
    let ts = this.state.get(tenant_id);
    if (!ts) {
      ts = new Map();
      this.state.set(tenant_id, ts);
    }
    return ts;
  }

  private applyDecision(
    tenant_id: string,
    request_id: string,
    next: 'approved' | 'rejected',
    reviewed_by: string,
    decision_notes: string | null,
    now: Date,
  ): PromotionRequest {
    const existing = this.state.get(tenant_id)?.get(request_id);
    if (!existing) {
      throw new PromotionError('unknown_request', `unknown promotion request: ${request_id}`);
    }
    if (existing.status !== 'pending') {
      throw new PromotionError(
        'already_decided',
        `request ${request_id} is already ${existing.status} — cannot be ${next}`,
      );
    }
    if (decision_notes !== null && typeof decision_notes !== 'string') {
      throw new PromotionError('invalid_input', 'decision_notes must be a string or null');
    }
    if (decision_notes !== null && decision_notes.length > 4000) {
      throw new PromotionError('invalid_input', 'decision_notes must be ≤ 4000 chars');
    }
    const updated: PromotionRequest = {
      ...existing,
      status: next,
      reviewed_by,
      reviewed_at: now.toISOString(),
      decision_notes: decision_notes ?? null,
    };
    this.state.get(tenant_id)!.set(request_id, updated);
    return updated;
  }
}

/** Module-level singleton. */
export const defaultPromotionEngine: PromotionEngine = new InMemoryPromotionEngine();
