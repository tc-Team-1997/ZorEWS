// services/bff/src/alert_ack.ts
//
// T6 M8.3 — Alert acknowledgment workflow.
//
// M8.1 ships the BIL Red/Orange/Yellow classification; M8.2 ships
// the auto-routing matrix (severity → channel + SLA). M8.3 closes
// the loop on the operator side: an analyst sees an alert, marks
// it acknowledged with optional notes, and that ack appears on
// the dashboard so other analysts know it's been seen.
//
// Key design choices:
//  - Per-alert state is just `open | acknowledged`. The full
//    investigation lifecycle lives in M9.1 (case investigations);
//    this is the lighter "I've seen this" affordance the BIL §11
//    SLA timer needs to satisfy ("orange: respond within 24h").
//  - Unacknowledge requires a `reason` (analysts have to say WHY
//    they're un-acking). RBI logs this as part of the case audit
//    trail; M13.2 wires that for case-level events but ack
//    history is per-alert and lives here.
//  - Every transition is recorded in `history[]` so the SPA can
//    render the "who did what when" timeline next to the alert.
//  - Tenant-isolated storage (Map<tenant_id, Map<alert_id, state>>).
//
// Routes (registered by server.ts):
//   POST /v1/alerts/:alert_id/ack        body { notes? }
//   POST /v1/alerts/:alert_id/unack      body { reason }
//   GET  /v1/alerts/:alert_id/ack
//   GET  /v1/alerts/:alert_id/ack/history

// ─── Public types ──────────────────────────────────────────────────────

export type AlertAckStatus = 'open' | 'acknowledged';

export type AlertAckAction = 'acknowledged' | 'unacknowledged';

export interface AlertAckHistoryEntry {
  ts: string;
  action: AlertAckAction;
  actor_username: string;
  /** Notes (on ack) or reason (on unack). Always present in history
   *  even when null on the live state. */
  notes: string | null;
}

export interface AlertAckState {
  alert_id: string;
  tenant_id: string;
  status: AlertAckStatus;
  /** Username from the latest `acknowledged` transition. null when
   *  status='open' (either never acked, or unacked since). */
  acked_by: string | null;
  acked_at: string | null;
  /** Notes from the latest ack. null on unack/open. */
  ack_notes: string | null;
  history: AlertAckHistoryEntry[];
}

export class AlertAckError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AlertAckError';
  }
}

// ─── Validation ────────────────────────────────────────────────────────

const NOTES_CAP = 2000;
const ALERT_ID_CAP = 64;

function checkAlertId(alert_id: unknown): asserts alert_id is string {
  if (typeof alert_id !== 'string' || !alert_id.trim()) {
    throw new AlertAckError('invalid_alert_id', 'alert_id is required');
  }
  if (alert_id.length > ALERT_ID_CAP) {
    throw new AlertAckError('invalid_alert_id', `alert_id ≤ ${ALERT_ID_CAP} chars`);
  }
}

function checkActor(actor_username: unknown): asserts actor_username is string {
  if (typeof actor_username !== 'string' || !actor_username.trim()) {
    throw new AlertAckError('invalid_input', 'actor_username is required');
  }
}

function normaliseNotes(input: unknown, field: string, required: boolean): string | null {
  if (input === undefined || input === null) {
    if (required) {
      throw new AlertAckError('invalid_input', `${field} is required`);
    }
    return null;
  }
  if (typeof input !== 'string') {
    throw new AlertAckError('invalid_input', `${field} must be a string`);
  }
  const trimmed = input.trim();
  if (required && trimmed.length === 0) {
    throw new AlertAckError('invalid_input', `${field} is required`);
  }
  if (trimmed.length > NOTES_CAP) {
    throw new AlertAckError('invalid_input', `${field} ≤ ${NOTES_CAP} chars`);
  }
  return trimmed.length === 0 ? null : trimmed;
}

// ─── Store interface ──────────────────────────────────────────────────

export interface AlertAckStore {
  /** Always returns a state — defaults to status='open' for an
   *  alert that has never been touched. */
  get(tenant_id: string, alert_id: string): AlertAckState;
  acknowledge(
    tenant_id: string,
    alert_id: string,
    actor_username: string,
    notes: string | null | undefined,
    now: Date,
  ): AlertAckState;
  unacknowledge(
    tenant_id: string,
    alert_id: string,
    actor_username: string,
    reason: string,
    now: Date,
  ): AlertAckState;
}

// ─── In-memory implementation ─────────────────────────────────────────

function emptyState(tenant_id: string, alert_id: string): AlertAckState {
  return {
    alert_id,
    tenant_id,
    status: 'open',
    acked_by: null,
    acked_at: null,
    ack_notes: null,
    history: [],
  };
}

export class InMemoryAlertAckStore implements AlertAckStore {
  /** tenant_id → alert_id → state. */
  private readonly states = new Map<string, Map<string, AlertAckState>>();

  private bucket(tenant_id: string): Map<string, AlertAckState> {
    let m = this.states.get(tenant_id);
    if (!m) {
      m = new Map();
      this.states.set(tenant_id, m);
    }
    return m;
  }

  get(tenant_id: string, alert_id: string): AlertAckState {
    checkAlertId(alert_id);
    const existing = this.states.get(tenant_id)?.get(alert_id);
    if (existing) {
      // Defensive copy so callers can't mutate the live state.
      return {
        ...existing,
        history: existing.history.map((h) => ({ ...h })),
      };
    }
    return emptyState(tenant_id, alert_id);
  }

  acknowledge(
    tenant_id: string,
    alert_id: string,
    actor_username: string,
    notes: string | null | undefined,
    now: Date,
  ): AlertAckState {
    checkAlertId(alert_id);
    checkActor(actor_username);
    const cleanNotes = normaliseNotes(notes, 'notes', false);

    const bucket = this.bucket(tenant_id);
    const cur = bucket.get(alert_id) ?? emptyState(tenant_id, alert_id);
    if (cur.status === 'acknowledged') {
      throw new AlertAckError(
        'already_acknowledged',
        `alert ${alert_id} is already acknowledged by ${cur.acked_by}`,
      );
    }
    const ts = now.toISOString();
    const next: AlertAckState = {
      ...cur,
      status: 'acknowledged',
      acked_by: actor_username,
      acked_at: ts,
      ack_notes: cleanNotes,
      history: [
        ...cur.history,
        { ts, action: 'acknowledged', actor_username, notes: cleanNotes },
      ],
    };
    bucket.set(alert_id, next);
    return this.get(tenant_id, alert_id);
  }

  unacknowledge(
    tenant_id: string,
    alert_id: string,
    actor_username: string,
    reason: string,
    now: Date,
  ): AlertAckState {
    checkAlertId(alert_id);
    checkActor(actor_username);
    const cleanReason = normaliseNotes(reason, 'reason', true);

    const bucket = this.bucket(tenant_id);
    const cur = bucket.get(alert_id) ?? emptyState(tenant_id, alert_id);
    if (cur.status !== 'acknowledged') {
      throw new AlertAckError(
        'not_acknowledged',
        `alert ${alert_id} is not acknowledged — nothing to revert`,
      );
    }
    const ts = now.toISOString();
    const next: AlertAckState = {
      ...cur,
      status: 'open',
      acked_by: null,
      acked_at: null,
      ack_notes: null,
      history: [
        ...cur.history,
        { ts, action: 'unacknowledged', actor_username, notes: cleanReason },
      ],
    };
    bucket.set(alert_id, next);
    return this.get(tenant_id, alert_id);
  }
}

export const defaultAlertAckStore: AlertAckStore = new InMemoryAlertAckStore();
