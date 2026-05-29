// services/bff/src/ai_prediction_logs.ts
//
// T7 Module 8 — Prediction Audit Logs (ENHANCEMENT of the existing prediction
// surface). ai_predictions.ts already persists the prediction itself (request,
// result, model_version, confidence, SHAP). The spec's Module 8 + the
// ai_prediction_logs table demand a SEPARATE, compliance-grade AUDIT-ACTION
// trail on top of it: every user action (acknowledge / override / escalate /
// dismiss / view) and every system event (alert triggered, feedback recorded)
// against a prediction, with actor + timestamp. This is the "who did what to
// this model decision, and what did it trigger?" log regulators ask for.
//
// Append-only. In-memory; the additive pg swap target is
// data/schema/043_ai_prediction_logs.sql.

// ─── closed enum ───────────────────────────────────────────────────────────

export type PredictionLogAction =
  | 'created' // system: the prediction was produced
  | 'viewed' // user opened the prediction
  | 'acknowledged' // user acknowledged the decision
  | 'overridden' // user overrode the model output
  | 'escalated' // user escalated to a case / supervisor
  | 'dismissed' // user dismissed as not actionable
  | 'alert_triggered' // system: prediction crossed a threshold → alert raised
  | 'feedback_recorded'; // user/system: model feedback captured

export const ALL_PREDICTION_LOG_ACTIONS: PredictionLogAction[] = [
  'created',
  'viewed',
  'acknowledged',
  'overridden',
  'escalated',
  'dismissed',
  'alert_triggered',
  'feedback_recorded',
];

/** Actions a human operator records (vs system-emitted events). */
export const USER_PREDICTION_LOG_ACTIONS: PredictionLogAction[] = [
  'viewed',
  'acknowledged',
  'overridden',
  'escalated',
  'dismissed',
];

export function isPredictionLogAction(v: unknown): v is PredictionLogAction {
  return typeof v === 'string' && (ALL_PREDICTION_LOG_ACTIONS as string[]).includes(v);
}

// ─── shapes ──────────────────────────────────────────────────────────────

export interface PredictionLogEntry {
  log_id: string;
  tenant_id: string;
  prediction_id: string;
  model_id: string | null;
  model_version: string | null;
  action: PredictionLogAction;
  actor: string;
  actor_role: string | null;
  /** Confidence snapshot at the time of the action (0..1) — null when n/a. */
  confidence: number | null;
  /** Set when action='alert_triggered' (or any action that spawned an alert). */
  triggered_alert_id: string | null;
  note: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface RecordPredictionLogInput {
  prediction_id: string;
  action: PredictionLogAction;
  actor: string;
  actor_role?: string | null;
  model_id?: string | null;
  model_version?: string | null;
  confidence?: number | null;
  triggered_alert_id?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PredictionLogFilter {
  prediction_id?: string;
  action?: PredictionLogAction;
  actor?: string;
  since?: string;
  until?: string;
  page?: number;
  page_size?: number;
}

export interface PredictionLogSummary {
  tenant_id: string;
  generated_at: string;
  total: number;
  by_action: Record<PredictionLogAction, number>;
  total_alerts_triggered: number;
  total_overrides: number;
  distinct_actors: number;
  distinct_predictions: number;
  most_recent_at: string | null;
}

// ─── errors ──────────────────────────────────────────────────────────────

export class AiPredictionLogError extends Error {
  constructor(public readonly code: 'invalid_input' | 'invalid_action', message: string) {
    super(message);
    this.name = 'AiPredictionLogError';
  }
}

export const PREDICTION_LOG_NOTE_MAX = 4000;
export const PREDICTION_LOG_PAGE_SIZE_DEFAULT = 50;
export const PREDICTION_LOG_PAGE_SIZE_MAX = 200;

function mintLogId(): string {
  const c = require('crypto') as { randomBytes(n: number): Buffer };
  const b = c.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ─── store ───────────────────────────────────────────────────────────────

export interface AiPredictionLogStore {
  /** Append an audit-action entry. Returns the persisted row. */
  record(tenant_id: string, input: RecordPredictionLogInput, now?: Date): PredictionLogEntry;
  /** Chronological (oldest-first) trail for ONE prediction. */
  forPrediction(tenant_id: string, prediction_id: string): PredictionLogEntry[];
  /** Tenant-wide audit query (newest-first, paginated). */
  list(tenant_id: string, filter?: PredictionLogFilter): {
    items: PredictionLogEntry[];
    page: number;
    page_size: number;
    total: number;
  };
  /** Compliance rollup. */
  summary(tenant_id: string, now?: Date): PredictionLogSummary;
}

export class InMemoryAiPredictionLogStore implements AiPredictionLogStore {
  private readonly byTenant = new Map<string, PredictionLogEntry[]>();

  record(tenant_id: string, input: RecordPredictionLogInput, now: Date = new Date()): PredictionLogEntry {
    if (!tenant_id) throw new AiPredictionLogError('invalid_input', 'tenant_id required');
    if (!input || typeof input !== 'object') throw new AiPredictionLogError('invalid_input', 'body required');
    const prediction_id = (input.prediction_id ?? '').trim();
    if (!prediction_id) throw new AiPredictionLogError('invalid_input', 'prediction_id required');
    if (!isPredictionLogAction(input.action)) throw new AiPredictionLogError('invalid_action', `unknown action ${input.action}`);
    const actor = (input.actor ?? '').trim();
    if (!actor) throw new AiPredictionLogError('invalid_input', 'actor required');
    if (input.note != null && String(input.note).length > PREDICTION_LOG_NOTE_MAX) {
      throw new AiPredictionLogError('invalid_input', `note exceeds ${PREDICTION_LOG_NOTE_MAX}`);
    }
    if (input.confidence != null && (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence))) {
      throw new AiPredictionLogError('invalid_input', 'confidence must be a finite number');
    }
    const row: PredictionLogEntry = {
      log_id: mintLogId(),
      tenant_id,
      prediction_id,
      model_id: input.model_id ?? null,
      model_version: input.model_version ?? null,
      action: input.action,
      actor,
      actor_role: input.actor_role ?? null,
      confidence: input.confidence ?? null,
      triggered_alert_id: input.triggered_alert_id != null ? String(input.triggered_alert_id) : null,
      note: input.note != null ? String(input.note).trim() : null,
      metadata: input.metadata ?? null,
      created_at: now.toISOString(),
    };
    let arr = this.byTenant.get(tenant_id);
    if (!arr) {
      arr = [];
      this.byTenant.set(tenant_id, arr);
    }
    arr.push(row); // chronological append
    return structuredClone(row);
  }

  forPrediction(tenant_id: string, prediction_id: string): PredictionLogEntry[] {
    const arr = this.byTenant.get(tenant_id) ?? [];
    return arr.filter((e) => e.prediction_id === prediction_id).map((e) => structuredClone(e));
  }

  list(tenant_id: string, filter: PredictionLogFilter = {}): {
    items: PredictionLogEntry[];
    page: number;
    page_size: number;
    total: number;
  } {
    const arr = this.byTenant.get(tenant_id) ?? [];
    let filtered = arr;
    if (filter.prediction_id) filtered = filtered.filter((e) => e.prediction_id === filter.prediction_id);
    if (filter.action) filtered = filtered.filter((e) => e.action === filter.action);
    if (filter.actor) filtered = filtered.filter((e) => e.actor === filter.actor);
    if (filter.since) filtered = filtered.filter((e) => e.created_at >= filter.since!);
    if (filter.until) filtered = filtered.filter((e) => e.created_at <= filter.until!);
    // newest-first for the query surface
    const ordered = [...filtered].reverse();
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const page_size = Math.min(
      PREDICTION_LOG_PAGE_SIZE_MAX,
      Math.max(1, Math.floor(filter.page_size ?? PREDICTION_LOG_PAGE_SIZE_DEFAULT)),
    );
    const start = (page - 1) * page_size;
    return {
      items: ordered.slice(start, start + page_size).map((e) => structuredClone(e)),
      page,
      page_size,
      total: ordered.length,
    };
  }

  summary(tenant_id: string, now: Date = new Date()): PredictionLogSummary {
    const arr = this.byTenant.get(tenant_id) ?? [];
    const by_action = Object.fromEntries(ALL_PREDICTION_LOG_ACTIONS.map((a) => [a, 0])) as Record<PredictionLogAction, number>;
    const actors = new Set<string>();
    const predictions = new Set<string>();
    let most_recent_at: string | null = null;
    for (const e of arr) {
      by_action[e.action] += 1;
      actors.add(e.actor);
      predictions.add(e.prediction_id);
      if (most_recent_at === null || e.created_at > most_recent_at) most_recent_at = e.created_at;
    }
    return {
      tenant_id,
      generated_at: now.toISOString(),
      total: arr.length,
      by_action,
      total_alerts_triggered: by_action.alert_triggered,
      total_overrides: by_action.overridden,
      distinct_actors: actors.size,
      distinct_predictions: predictions.size,
      most_recent_at,
    };
  }
}

// ─── singleton + reset ─────────────────────────────────────────────────────

export const defaultAiPredictionLogStore: AiPredictionLogStore = new InMemoryAiPredictionLogStore();

export function _resetAiPredictionLogStore(): void {
  const s = defaultAiPredictionLogStore as unknown as { byTenant: Map<string, unknown> };
  s.byTenant.clear();
}
