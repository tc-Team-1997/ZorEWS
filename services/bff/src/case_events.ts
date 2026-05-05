// services/bff/src/case_events.ts
//
// T6 M9.4 — Case event journal.
//
// M9.1 ships the 6-state investigation tracker, M9.2 the BIL §17
// checklist + custom-checklist store, M9.3 the RBI 4-eyes
// maker-checker. M9.4 layers an explicit downstream-pollable
// journal: every case-related event a caller wants to fan out to
// downstream systems lands here with a monotonic, per-tenant
// sequence_no that consumers cursor through.
//
// Design:
//  - Append-only. No edit/delete from the surface — the case
//    transitions themselves are the truth, the journal is a
//    derived stream. Mistaken events stay; corrections come from
//    a follow-up event with `action: 'note_added'`.
//  - sequence_no is per-tenant monotonic, derived from "last
//    sequence + 1" rather than `arr.length` so numbers stay
//    stable across FIFO eviction at the 1000-cap.
//  - Existing M9.x routes are NOT modified — this slice is
//    additive. Callers explicitly POST events when they want to
//    publish a transition. Production wiring of the existing
//    case routes into this journal can come in a later sub-phase.

import { randomUUID } from 'node:crypto';

// ─── Public types ─────────────────────────────────────────────────────

export const CASE_EVENT_ACTIONS = [
  'opened',
  'state_change',
  'closed',
  'escalated',
  'override_requested',
  'override_approved',
  'override_rejected',
  'note_added',
  'checklist_updated',
] as const;

export type CaseEventAction = (typeof CASE_EVENT_ACTIONS)[number];

export function isCaseEventAction(s: unknown): s is CaseEventAction {
  return typeof s === 'string' && (CASE_EVENT_ACTIONS as readonly string[]).includes(s);
}

export interface CaseEventInput {
  case_id: string;
  action: CaseEventAction;
  actor: string;
  /** Free-form action-specific context (e.g. {from:'open',to:'investigating'}). */
  payload?: Record<string, unknown>;
}

export interface CaseEvent {
  event_id: string;
  /** Per-tenant monotonic. Stable across FIFO eviction. */
  sequence_no: number;
  tenant_id: string;
  case_id: string;
  action: CaseEventAction;
  actor: string;
  payload: Record<string, unknown>;
  recorded_at: string;
}

export interface CaseEventCursorPage {
  items: CaseEvent[];
  total: number;
  next_cursor: number | null;
  /** Highest sequence_no in this tenant's journal (NOT the page's). */
  high_water_mark: number | null;
}

export class CaseEventError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CaseEventError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

const ID_CAP = 64;
const ACTOR_CAP = 64;

function checkId(name: string, v: unknown, cap = ID_CAP): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new CaseEventError('invalid_input', `${name} is required`);
  }
  if (v.length > cap) {
    throw new CaseEventError('invalid_input', `${name} ≤ ${cap} chars`);
  }
  return v.trim();
}

function checkPayload(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new CaseEventError('invalid_input', 'payload must be a JSON object');
  }
  return { ...(v as Record<string, unknown>) };
}

function validate(input: unknown): CaseEventInput {
  if (!input || typeof input !== 'object') {
    throw new CaseEventError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  const case_id = checkId('case_id', i.case_id);
  if (!isCaseEventAction(i.action)) {
    throw new CaseEventError(
      'invalid_input',
      `action must be one of ${CASE_EVENT_ACTIONS.join(', ')}`,
    );
  }
  const actor = checkId('actor', i.actor, ACTOR_CAP);
  const payload = checkPayload(i.payload);
  return { case_id, action: i.action, actor, payload };
}

// ─── Store ────────────────────────────────────────────────────────────

const CAP_PER_TENANT = 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface CaseEventStore {
  record(tenant_id: string, input: unknown, now: Date): CaseEvent;
  /** Cursor-paginated fetch. since_seq is EXCLUSIVE (returns events with sequence_no > since_seq). */
  fetchSince(
    tenant_id: string,
    since_seq: number,
    limit: number,
  ): CaseEventCursorPage;
  get(tenant_id: string, event_id: string): CaseEvent | null;
  forCase(tenant_id: string, case_id: string): CaseEvent[];
}

export class InMemoryCaseEventStore implements CaseEventStore {
  private readonly perTenant = new Map<string, CaseEvent[]>();
  private readonly seqByTenant = new Map<string, number>();

  private bucket(tenant_id: string): CaseEvent[] {
    let arr = this.perTenant.get(tenant_id);
    if (!arr) {
      arr = [];
      this.perTenant.set(tenant_id, arr);
    }
    return arr;
  }

  record(tenant_id: string, input: unknown, now: Date): CaseEvent {
    const valid = validate(input);
    const arr = this.bucket(tenant_id);
    const nextSeq = (this.seqByTenant.get(tenant_id) ?? 0) + 1;
    this.seqByTenant.set(tenant_id, nextSeq);
    const event: CaseEvent = {
      event_id: `evt-${randomUUID()}`,
      sequence_no: nextSeq,
      tenant_id,
      case_id: valid.case_id,
      action: valid.action,
      actor: valid.actor,
      payload: valid.payload ?? {},
      recorded_at: now.toISOString(),
    };
    arr.push(event);
    if (arr.length > CAP_PER_TENANT) {
      arr.splice(0, arr.length - CAP_PER_TENANT);
    }
    return { ...event, payload: { ...event.payload } };
  }

  fetchSince(
    tenant_id: string,
    since_seq: number,
    limit: number,
  ): CaseEventCursorPage {
    if (!Number.isInteger(since_seq) || since_seq < 0) {
      throw new CaseEventError('invalid_input', 'since_seq must be a non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CaseEventError('invalid_input', 'limit must be a positive integer');
    }
    const cap = Math.min(limit, MAX_LIMIT);
    const arr = this.perTenant.get(tenant_id) ?? [];
    const filtered = arr.filter((e) => e.sequence_no > since_seq);
    // arr is insertion-ordered, sequence_no is monotonic per tenant —
    // so filtered is already ascending by sequence_no.
    const slice = filtered.slice(0, cap);
    const next_cursor = filtered.length > cap ? slice[slice.length - 1]!.sequence_no : null;
    const hwm = arr.length > 0 ? arr[arr.length - 1]!.sequence_no : null;
    return {
      items: slice.map((e) => ({ ...e, payload: { ...e.payload } })),
      total: filtered.length,
      next_cursor,
      high_water_mark: hwm,
    };
  }

  get(tenant_id: string, event_id: string): CaseEvent | null {
    const e = this.perTenant.get(tenant_id)?.find((x) => x.event_id === event_id);
    return e ? { ...e, payload: { ...e.payload } } : null;
  }

  forCase(tenant_id: string, case_id: string): CaseEvent[] {
    const arr = this.perTenant.get(tenant_id) ?? [];
    return arr
      .filter((e) => e.case_id === case_id)
      .map((e) => ({ ...e, payload: { ...e.payload } }));
  }
}

export const defaultCaseEventStore: CaseEventStore = new InMemoryCaseEventStore();

/** Re-exports for tests / route handlers. */
export {
  CAP_PER_TENANT as CASE_EVENT_CAP_PER_TENANT,
  DEFAULT_LIMIT as CASE_EVENT_DEFAULT_LIMIT,
  MAX_LIMIT as CASE_EVENT_MAX_LIMIT,
};
