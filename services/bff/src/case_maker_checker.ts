// services/bff/src/case_maker_checker.ts
//
// T6 M9.3 — Case maker-checker workflow.
//
// BIL ops + compliance need 4-eyes approval on sensitive case actions:
// closing a case, escalating to head-of-risk, overriding an automated
// decision. RBI's operational risk framework calls this out explicitly,
// and M13.1 already exposes `features.maker_checker_enabled` as a
// per-tenant toggle.
//
// M9.3 ships the workflow:
//   - Maker submits a sensitive action with payload + rationale
//   - Status starts as 'pending'
//   - A different user (checker) approves OR rejects with notes
//   - Self-approval is refused — RBI explicitly mandates segregation
//   - Both signatures are recorded for the audit trail
//
// The engine is decoupled from the case investigation store (M9.1) and
// case action sink (T3): production wiring would call the corresponding
// downstream after approval. M9.3 is the workflow tracker; future M9.4
// will close the loop by applying approved actions to the relevant
// downstream stores.

import { randomUUID } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type MakerCheckerStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type SensitiveActionType =
  | 'case.close'
  | 'case.escalate'
  | 'case.override_decision';

export interface SubmitActionInput {
  case_id: string;
  action_type: SensitiveActionType;
  payload: Record<string, unknown>;
  /** Maker's rationale for the action. Required. */
  rationale: string;
}

export interface MakerCheckerAction {
  action_id: string;
  tenant_id: string;
  case_id: string;
  action_type: SensitiveActionType;
  payload: Record<string, unknown>;
  status: MakerCheckerStatus;
  maker_username: string;
  maker_at: string;
  rationale: string;
  /** null while pending. Set on approve/reject. */
  checker_username: string | null;
  checker_at: string | null;
  /** Checker's rationale. null while pending. */
  decision_notes: string | null;
}

export interface ListFilters {
  status?: MakerCheckerStatus;
  action_type?: SensitiveActionType;
  case_id?: string;
  maker_username?: string;
  page?: number;
  page_size?: number;
}

export interface ActionPage {
  items: MakerCheckerAction[];
  page: number;
  page_size: number;
  total: number;
}

export class MakerCheckerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MakerCheckerError';
  }
}

const VALID_ACTION_TYPES: SensitiveActionType[] = [
  'case.close',
  'case.escalate',
  'case.override_decision',
];
const VALID_STATUSES: MakerCheckerStatus[] = ['pending', 'approved', 'rejected', 'cancelled'];

export function isSensitiveActionType(s: unknown): s is SensitiveActionType {
  return typeof s === 'string' && VALID_ACTION_TYPES.includes(s as SensitiveActionType);
}
export function isMakerCheckerStatus(s: unknown): s is MakerCheckerStatus {
  return typeof s === 'string' && VALID_STATUSES.includes(s as MakerCheckerStatus);
}

// ─── Validation ────────────────────────────────────────────────────────

export function validateSubmit(input: unknown): SubmitActionInput {
  if (!input || typeof input !== 'object') {
    throw new MakerCheckerError('invalid_input', 'request body required');
  }
  const i = input as Partial<SubmitActionInput>;
  if (typeof i.case_id !== 'string' || !i.case_id.trim()) {
    throw new MakerCheckerError('invalid_input', 'case_id is required');
  }
  if (!isSensitiveActionType(i.action_type)) {
    throw new MakerCheckerError(
      'invalid_action_type',
      `action_type must be one of ${VALID_ACTION_TYPES.join(',')}`,
    );
  }
  if (typeof i.rationale !== 'string' || !i.rationale.trim()) {
    throw new MakerCheckerError('invalid_input', 'rationale is required');
  }
  if (i.rationale.length > 4000) {
    throw new MakerCheckerError('invalid_input', 'rationale must be ≤ 4000 chars');
  }
  if (!i.payload || typeof i.payload !== 'object' || Array.isArray(i.payload)) {
    throw new MakerCheckerError('invalid_input', 'payload must be a JSON object');
  }
  return {
    case_id: i.case_id,
    action_type: i.action_type,
    payload: i.payload as Record<string, unknown>,
    rationale: i.rationale,
  };
}

// ─── Engine + store ────────────────────────────────────────────────────

export interface MakerCheckerEngine {
  submit(
    tenant_id: string,
    input: unknown,
    maker_username: string,
    now: Date,
  ): MakerCheckerAction;
  list(tenant_id: string, filters: ListFilters): ActionPage;
  get(tenant_id: string, action_id: string): MakerCheckerAction | null;
  approve(
    tenant_id: string,
    action_id: string,
    checker_username: string,
    decision_notes: string | null,
    now: Date,
  ): MakerCheckerAction;
  reject(
    tenant_id: string,
    action_id: string,
    checker_username: string,
    decision_notes: string | null,
    now: Date,
  ): MakerCheckerAction;
}

export class InMemoryMakerCheckerEngine implements MakerCheckerEngine {
  /** tenant_id → action_id → MakerCheckerAction. */
  private readonly state = new Map<string, Map<string, MakerCheckerAction>>();

  submit(
    tenant_id: string,
    input: unknown,
    maker_username: string,
    now: Date,
  ): MakerCheckerAction {
    const validated = validateSubmit(input);
    if (!maker_username || typeof maker_username !== 'string') {
      throw new MakerCheckerError('invalid_input', 'maker_username is required');
    }
    const ts = this.tState(tenant_id);
    // Refuse a 2nd active submission for the same case + action_type —
    // keeps the audit trail unambiguous. The pending one must be
    // approved or rejected first.
    for (const existing of ts.values()) {
      if (
        existing.case_id === validated.case_id &&
        existing.action_type === validated.action_type &&
        existing.status === 'pending'
      ) {
        throw new MakerCheckerError(
          'submission_already_pending',
          `case ${validated.case_id} already has a pending ${validated.action_type}: ${existing.action_id}`,
        );
      }
    }
    const action: MakerCheckerAction = {
      action_id: `mc-${randomUUID()}`,
      tenant_id,
      case_id: validated.case_id,
      action_type: validated.action_type,
      payload: validated.payload,
      status: 'pending',
      maker_username,
      maker_at: now.toISOString(),
      rationale: validated.rationale,
      checker_username: null,
      checker_at: null,
      decision_notes: null,
    };
    ts.set(action.action_id, action);
    return action;
  }

  list(tenant_id: string, filters: ListFilters): ActionPage {
    const ts = this.state.get(tenant_id);
    const all = ts ? [...ts.values()] : [];
    const filtered = all.filter((a) => {
      if (filters.status !== undefined && a.status !== filters.status) return false;
      if (filters.action_type !== undefined && a.action_type !== filters.action_type) return false;
      if (filters.case_id !== undefined && a.case_id !== filters.case_id) return false;
      if (filters.maker_username !== undefined && a.maker_username !== filters.maker_username) return false;
      return true;
    });
    // newest-first
    filtered.sort((a, b) => b.maker_at.localeCompare(a.maker_at));
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

  get(tenant_id: string, action_id: string): MakerCheckerAction | null {
    return this.state.get(tenant_id)?.get(action_id) ?? null;
  }

  approve(
    tenant_id: string,
    action_id: string,
    checker_username: string,
    decision_notes: string | null,
    now: Date,
  ): MakerCheckerAction {
    return this.applyDecision(tenant_id, action_id, 'approved', checker_username, decision_notes, now);
  }

  reject(
    tenant_id: string,
    action_id: string,
    checker_username: string,
    decision_notes: string | null,
    now: Date,
  ): MakerCheckerAction {
    return this.applyDecision(tenant_id, action_id, 'rejected', checker_username, decision_notes, now);
  }

  /** Test helper. */
  reset(): void {
    this.state.clear();
  }

  private tState(tenant_id: string): Map<string, MakerCheckerAction> {
    let ts = this.state.get(tenant_id);
    if (!ts) {
      ts = new Map();
      this.state.set(tenant_id, ts);
    }
    return ts;
  }

  private applyDecision(
    tenant_id: string,
    action_id: string,
    next: 'approved' | 'rejected',
    checker_username: string,
    decision_notes: string | null,
    now: Date,
  ): MakerCheckerAction {
    if (!checker_username || typeof checker_username !== 'string') {
      throw new MakerCheckerError('invalid_input', 'checker_username is required');
    }
    if (decision_notes !== null && typeof decision_notes !== 'string') {
      throw new MakerCheckerError('invalid_input', 'decision_notes must be a string or null');
    }
    if (decision_notes !== null && decision_notes.length > 4000) {
      throw new MakerCheckerError('invalid_input', 'decision_notes must be ≤ 4000 chars');
    }
    const existing = this.state.get(tenant_id)?.get(action_id);
    if (!existing) {
      throw new MakerCheckerError('unknown_action', `unknown maker-checker action: ${action_id}`);
    }
    if (existing.status !== 'pending') {
      throw new MakerCheckerError(
        'already_decided',
        `action ${action_id} is already ${existing.status} — cannot be ${next}`,
      );
    }
    // Self-approval refused per RBI segregation. Maker and checker MUST
    // be different users.
    if (existing.maker_username === checker_username) {
      throw new MakerCheckerError(
        'self_approval_forbidden',
        `${checker_username} cannot ${next.replace('d', '')} their own submission`,
      );
    }
    const updated: MakerCheckerAction = {
      ...existing,
      status: next,
      checker_username,
      checker_at: now.toISOString(),
      decision_notes: decision_notes ?? null,
    };
    this.state.get(tenant_id)!.set(action_id, updated);
    return updated;
  }
}

/** Module-level singleton. */
export const defaultMakerCheckerEngine: MakerCheckerEngine = new InMemoryMakerCheckerEngine();
