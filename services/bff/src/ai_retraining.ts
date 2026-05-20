// services/bff/src/ai_retraining.ts
//
// T5.1.1 — Retraining schedule + outcome ledger.
//
// Closes the "no training scheduler is wired" gap of T5.1 — pair with the
// already-shipped auto-promotion gate (`ai_auto_promotion_gate.ts`, 2026-
// 05-09) so the full continuous-learning loop is operable:
//
//   schedule → external trainer fires → POST outcome → fleet status view
//
// The actual model training is OUT OF SCOPE here — the `train_pd.py`
// pipeline runs externally (Airflow / manual / future cron). When it
// finishes, the runner POSTs the outcome (new_version, metrics, optionally
// the auto-promotion-gate decision) to the BFF ledger. Ops gets a
// "are we current on retraining?" + "what did the last retrain do?" view
// without coupling the BFF to Python execution.

export type RetrainingCadence =
  | 'monthly'
  | 'quarterly'
  | 'biannual'
  | 'annual'
  | 'drift_triggered';

export const ALL_RETRAINING_CADENCES: ReadonlyArray<RetrainingCadence> = [
  'monthly',
  'quarterly',
  'biannual',
  'annual',
  'drift_triggered',
];

export type RetrainingOutcomeStatus = 'success' | 'failure' | 'rolled_back' | 'in_progress';

export const ALL_RETRAINING_OUTCOME_STATUSES: ReadonlyArray<RetrainingOutcomeStatus> = [
  'success',
  'failure',
  'rolled_back',
  'in_progress',
];

/** Optional auto-promotion target — tracks where the new version
 *  landed once the M7.2 promotion-gate decision was applied. Null
 *  when no auto-promotion happened (manual review required). */
export type RetrainingPromotedTo = 'staging' | 'shadow' | 'production' | null;

export interface RetrainingScheduleInput {
  model_id: string;
  cadence: RetrainingCadence;
  /** Optional override of the cadence-derived next_retrain_at — useful
   *  when ops wants to pin the first retrain to a specific date. */
  next_retrain_at?: string;
  /** For drift_triggered cadence: PSI / KS threshold above which a
   *  retrain is required. 0.1 = mild drift; 0.25 = significant.
   *  Ignored for time-based cadences. */
  drift_trigger_threshold?: number;
  enabled?: boolean;
  notes?: string;
}

export interface RetrainingScheduleEntry {
  schedule_id: string;
  tenant_id: string;
  model_id: string;
  cadence: RetrainingCadence;
  next_retrain_at: string;
  last_retrained_at: string | null;
  drift_trigger_threshold: number | null;
  enabled: boolean;
  notes: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

export interface RetrainingOutcomeInput {
  /** Schedule the outcome is recorded against; null when this was an
   *  ad-hoc training run not tied to a schedule. */
  schedule_id?: string | null;
  model_id: string;
  status: RetrainingOutcomeStatus;
  started_at: string;
  completed_at?: string | null;
  new_version?: string | null;
  /** Free-form metrics blob — typically {auc, brier, ks, n_train,
   *  n_holdout}. The structure is captured verbatim. */
  metrics?: Record<string, number> | null;
  promoted_to?: RetrainingPromotedTo;
  notes?: string | null;
  /** Optional ai-promotion-gate decision tag (`approved` / `rejected` /
   *  `requires_approval`) when the gate ran post-train. */
  gate_decision?: string | null;
}

export interface RetrainingOutcome {
  outcome_id: string;
  tenant_id: string;
  schedule_id: string | null;
  model_id: string;
  status: RetrainingOutcomeStatus;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  new_version: string | null;
  metrics: Record<string, number> | null;
  promoted_to: RetrainingPromotedTo;
  gate_decision: string | null;
  notes: string | null;
  recorded_at: string;
}

export interface ModelRetrainingStatus {
  model_id: string;
  /** Schedule entry (when one exists) — null for ad-hoc training. */
  schedule: RetrainingScheduleEntry | null;
  /** Newest outcome on this model — null when no retrain has happened. */
  last_outcome: RetrainingOutcome | null;
  /** ms until next_retrain_at; negative if overdue; null when no schedule. */
  ms_until_next: number | null;
  /** Convenience: true iff schedule.enabled AND next_retrain_at < now. */
  is_overdue: boolean;
  /** Days since last successful outcome; null when no successful retrain. */
  days_since_last_success: number | null;
}

export interface RetrainingFleetStatus {
  tenant_id: string;
  generated_at: string;
  total_schedules: number;
  total_enabled: number;
  total_overdue: number;
  total_outcomes_30d: number;
  total_success_30d: number;
  total_failure_30d: number;
  success_rate_30d: number | null;
  models: ModelRetrainingStatus[];
  most_recent_outcome: RetrainingOutcome | null;
  /** True iff every enabled schedule's next_retrain_at >= now — the
   *  "fleet is healthy" indicator the ops dashboard renders. */
  all_schedules_current: boolean;
}

export class RetrainingError extends Error {
  override name = 'RetrainingError';
  constructor(
    public code:
      | 'invalid_input'
      | 'invalid_cadence'
      | 'invalid_status'
      | 'invalid_threshold'
      | 'invalid_date'
      | 'unknown_schedule'
      | 'duplicate_schedule',
    message: string,
  ) {
    super(message);
  }
}

// ─── Cadence math ────────────────────────────────────────────────────

const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIso(s: string, code: 'invalid_date'): number {
  if (typeof s !== 'string' || !ISO_DATETIME_RE.test(s)) {
    throw new RetrainingError(code, `malformed ISO-8601 timestamp: ${s}`);
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new RetrainingError(code, `unparseable timestamp: ${s}`);
  return ms;
}

/** Compute next_retrain_at from a given anchor + cadence.
 *  drift_triggered returns null (no scheduled time — retrain is fired
 *  on a drift event from the agent-ai drift monitor). */
export function computeNextRetrainAt(
  cadence: RetrainingCadence,
  anchor: Date,
): string | null {
  if (cadence === 'drift_triggered') return null;
  const d = new Date(anchor.getTime());
  switch (cadence) {
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'quarterly':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case 'biannual':
      d.setUTCMonth(d.getUTCMonth() + 6);
      break;
    case 'annual':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return d.toISOString();
}

// ─── Validators ──────────────────────────────────────────────────────

export function isRetrainingCadence(v: unknown): v is RetrainingCadence {
  return typeof v === 'string' && (ALL_RETRAINING_CADENCES as readonly string[]).includes(v);
}

export function isRetrainingOutcomeStatus(v: unknown): v is RetrainingOutcomeStatus {
  return (
    typeof v === 'string' && (ALL_RETRAINING_OUTCOME_STATUSES as readonly string[]).includes(v)
  );
}

function validateScheduleInput(input: unknown): asserts input is RetrainingScheduleInput {
  if (!input || typeof input !== 'object') {
    throw new RetrainingError('invalid_input', 'input must be an object');
  }
  const e = input as Record<string, unknown>;
  if (typeof e.model_id !== 'string' || e.model_id.length === 0) {
    throw new RetrainingError('invalid_input', 'model_id required');
  }
  if (!isRetrainingCadence(e.cadence)) {
    throw new RetrainingError('invalid_cadence', `cadence must be one of ${ALL_RETRAINING_CADENCES.join('/')}`);
  }
  if (e.next_retrain_at !== undefined && e.next_retrain_at !== null) {
    if (typeof e.next_retrain_at !== 'string' || !ISO_DATETIME_RE.test(e.next_retrain_at)) {
      throw new RetrainingError('invalid_date', 'next_retrain_at must be ISO-8601');
    }
  }
  if (e.drift_trigger_threshold !== undefined && e.drift_trigger_threshold !== null) {
    const t = e.drift_trigger_threshold;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) {
      throw new RetrainingError('invalid_threshold', 'drift_trigger_threshold must be 0..1');
    }
  }
}

function validateOutcomeInput(input: unknown): asserts input is RetrainingOutcomeInput {
  if (!input || typeof input !== 'object') {
    throw new RetrainingError('invalid_input', 'input must be an object');
  }
  const e = input as Record<string, unknown>;
  if (typeof e.model_id !== 'string' || e.model_id.length === 0) {
    throw new RetrainingError('invalid_input', 'model_id required');
  }
  if (!isRetrainingOutcomeStatus(e.status)) {
    throw new RetrainingError(
      'invalid_status',
      `status must be one of ${ALL_RETRAINING_OUTCOME_STATUSES.join('/')}`,
    );
  }
  parseIso(e.started_at as string, 'invalid_date');
  if (e.completed_at !== undefined && e.completed_at !== null) {
    parseIso(e.completed_at as string, 'invalid_date');
  }
  if (e.promoted_to !== undefined && e.promoted_to !== null) {
    if (!['staging', 'shadow', 'production'].includes(e.promoted_to as string)) {
      throw new RetrainingError('invalid_input', 'promoted_to must be staging|shadow|production|null');
    }
  }
  if (e.metrics !== undefined && e.metrics !== null) {
    if (typeof e.metrics !== 'object' || Array.isArray(e.metrics)) {
      throw new RetrainingError('invalid_input', 'metrics must be a flat object');
    }
    for (const [k, v] of Object.entries(e.metrics as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new RetrainingError('invalid_input', `metrics.${k} must be a finite number`);
      }
    }
  }
}

// ─── Stores ──────────────────────────────────────────────────────────

export interface RetrainingScheduleStore {
  create(input: RetrainingScheduleInput, ctx: { tenant_id: string; now: Date; actor: string }): RetrainingScheduleEntry;
  list(tenant_id: string): RetrainingScheduleEntry[];
  get(tenant_id: string, schedule_id: string): RetrainingScheduleEntry | null;
  getByModel(tenant_id: string, model_id: string): RetrainingScheduleEntry | null;
  update(
    tenant_id: string,
    schedule_id: string,
    patch: Partial<RetrainingScheduleInput>,
    ctx: { now: Date; actor: string },
  ): RetrainingScheduleEntry;
  delete(tenant_id: string, schedule_id: string): boolean;
  clear(tenant_id?: string): void;
}

export interface RetrainingOutcomeStore {
  record(
    input: RetrainingOutcomeInput,
    ctx: { tenant_id: string; now: Date },
  ): RetrainingOutcome;
  list(tenant_id: string, filter?: { model_id?: string; status?: RetrainingOutcomeStatus; since?: string }): RetrainingOutcome[];
  get(tenant_id: string, outcome_id: string): RetrainingOutcome | null;
  clear(tenant_id?: string): void;
}

const SCHEDULES_CAP_PER_TENANT = 50;
const OUTCOMES_CAP_PER_TENANT = 500;

export class InMemoryRetrainingScheduleStore implements RetrainingScheduleStore {
  private byTenant = new Map<string, RetrainingScheduleEntry[]>();
  private seq = 0;

  create(
    input: RetrainingScheduleInput,
    ctx: { tenant_id: string; now: Date; actor: string },
  ): RetrainingScheduleEntry {
    validateScheduleInput(input);
    const arr = this.byTenant.get(ctx.tenant_id) ?? [];
    // Refuse two schedules for the same model — operators can change
    // an existing one but shouldn't accumulate parallel triggers.
    if (arr.some((s) => s.model_id === input.model_id)) {
      throw new RetrainingError(
        'duplicate_schedule',
        `schedule already exists for model_id=${input.model_id}; PATCH the existing one`,
      );
    }
    if (arr.length >= SCHEDULES_CAP_PER_TENANT) {
      throw new RetrainingError('invalid_input', `cap reached: ${SCHEDULES_CAP_PER_TENANT}`);
    }
    this.seq += 1;
    const id = `rts-${ctx.tenant_id}-${ctx.now.getTime()}-${this.seq}`;
    const next =
      input.next_retrain_at ??
      computeNextRetrainAt(input.cadence, ctx.now) ??
      // drift_triggered with no explicit next_retrain_at — use a far-
      // future sentinel so the entry is queryable but never overdue.
      new Date(ctx.now.getTime() + 1000 * 60 * 60 * 24 * 3650).toISOString();
    const row: RetrainingScheduleEntry = {
      schedule_id: id,
      tenant_id: ctx.tenant_id,
      model_id: input.model_id,
      cadence: input.cadence,
      next_retrain_at: next,
      last_retrained_at: null,
      drift_trigger_threshold:
        typeof input.drift_trigger_threshold === 'number' ? input.drift_trigger_threshold : null,
      enabled: input.enabled !== false, // default true
      notes: input.notes ?? null,
      created_at: ctx.now.toISOString(),
      created_by: ctx.actor,
      updated_at: ctx.now.toISOString(),
    };
    arr.push(row);
    this.byTenant.set(ctx.tenant_id, arr);
    return { ...row };
  }

  list(tenant_id: string): RetrainingScheduleEntry[] {
    return (this.byTenant.get(tenant_id) ?? []).map((s) => ({ ...s }));
  }

  get(tenant_id: string, schedule_id: string): RetrainingScheduleEntry | null {
    const row = (this.byTenant.get(tenant_id) ?? []).find((s) => s.schedule_id === schedule_id);
    return row ? { ...row } : null;
  }

  getByModel(tenant_id: string, model_id: string): RetrainingScheduleEntry | null {
    const row = (this.byTenant.get(tenant_id) ?? []).find((s) => s.model_id === model_id);
    return row ? { ...row } : null;
  }

  update(
    tenant_id: string,
    schedule_id: string,
    patch: Partial<RetrainingScheduleInput>,
    ctx: { now: Date; actor: string },
  ): RetrainingScheduleEntry {
    const arr = this.byTenant.get(tenant_id) ?? [];
    const idx = arr.findIndex((s) => s.schedule_id === schedule_id);
    if (idx === -1) throw new RetrainingError('unknown_schedule', schedule_id);
    const cur = arr[idx];
    if (patch.cadence !== undefined && !isRetrainingCadence(patch.cadence)) {
      throw new RetrainingError('invalid_cadence', 'invalid cadence in patch');
    }
    if (patch.next_retrain_at !== undefined && patch.next_retrain_at !== null) {
      if (
        typeof patch.next_retrain_at !== 'string' ||
        !ISO_DATETIME_RE.test(patch.next_retrain_at)
      ) {
        throw new RetrainingError('invalid_date', 'next_retrain_at must be ISO-8601');
      }
    }
    if (patch.drift_trigger_threshold !== undefined && patch.drift_trigger_threshold !== null) {
      const t = patch.drift_trigger_threshold;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) {
        throw new RetrainingError('invalid_threshold', '0..1 required');
      }
    }
    const cadence = patch.cadence ?? cur.cadence;
    const next_retrain_at =
      patch.next_retrain_at !== undefined && patch.next_retrain_at !== null
        ? patch.next_retrain_at
        : cadence !== cur.cadence
          ? (computeNextRetrainAt(cadence, ctx.now) ?? cur.next_retrain_at)
          : cur.next_retrain_at;
    arr[idx] = {
      ...cur,
      cadence,
      next_retrain_at,
      drift_trigger_threshold:
        patch.drift_trigger_threshold !== undefined
          ? (patch.drift_trigger_threshold ?? null)
          : cur.drift_trigger_threshold,
      enabled: patch.enabled !== undefined ? patch.enabled : cur.enabled,
      notes: patch.notes !== undefined ? (patch.notes ?? null) : cur.notes,
      updated_at: ctx.now.toISOString(),
    };
    return { ...arr[idx] };
  }

  delete(tenant_id: string, schedule_id: string): boolean {
    const arr = this.byTenant.get(tenant_id) ?? [];
    const idx = arr.findIndex((s) => s.schedule_id === schedule_id);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    return true;
  }

  /** Internal helper for the outcome ledger — bumps last_retrained_at
   *  + advances next_retrain_at when a successful outcome lands. */
  recordSuccess(tenant_id: string, model_id: string, completed_at: string, now: Date): void {
    const arr = this.byTenant.get(tenant_id) ?? [];
    const idx = arr.findIndex((s) => s.model_id === model_id);
    if (idx === -1) return;
    const cur = arr[idx];
    const next = computeNextRetrainAt(cur.cadence, new Date(parseIso(completed_at, 'invalid_date')));
    arr[idx] = {
      ...cur,
      last_retrained_at: completed_at,
      next_retrain_at: next ?? cur.next_retrain_at,
      updated_at: now.toISOString(),
    };
  }

  clear(tenant_id?: string): void {
    if (tenant_id) this.byTenant.delete(tenant_id);
    else this.byTenant.clear();
  }
}

export class InMemoryRetrainingOutcomeStore implements RetrainingOutcomeStore {
  private byTenant = new Map<string, RetrainingOutcome[]>();
  private seq = 0;

  constructor(private scheduleStore?: InMemoryRetrainingScheduleStore) {}

  record(
    input: RetrainingOutcomeInput,
    ctx: { tenant_id: string; now: Date },
  ): RetrainingOutcome {
    validateOutcomeInput(input);
    const arr = this.byTenant.get(ctx.tenant_id) ?? [];
    if (arr.length >= OUTCOMES_CAP_PER_TENANT) {
      // FIFO eviction — keep the cap deterministic.
      arr.splice(0, arr.length - OUTCOMES_CAP_PER_TENANT + 1);
    }
    this.seq += 1;
    const startedMs = parseIso(input.started_at, 'invalid_date');
    const completedMs =
      input.completed_at !== undefined && input.completed_at !== null
        ? parseIso(input.completed_at, 'invalid_date')
        : null;
    const row: RetrainingOutcome = {
      outcome_id: `rto-${ctx.tenant_id}-${ctx.now.getTime()}-${this.seq}`,
      tenant_id: ctx.tenant_id,
      schedule_id: input.schedule_id ?? null,
      model_id: input.model_id,
      status: input.status,
      started_at: input.started_at,
      completed_at: input.completed_at ?? null,
      duration_ms: completedMs !== null ? Math.max(0, completedMs - startedMs) : null,
      new_version: input.new_version ?? null,
      metrics: input.metrics ?? null,
      promoted_to: input.promoted_to ?? null,
      gate_decision: input.gate_decision ?? null,
      notes: input.notes ?? null,
      recorded_at: ctx.now.toISOString(),
    };
    arr.push(row);
    this.byTenant.set(ctx.tenant_id, arr);
    // Successful retrains advance the schedule.
    if (input.status === 'success' && input.completed_at && this.scheduleStore) {
      this.scheduleStore.recordSuccess(ctx.tenant_id, input.model_id, input.completed_at, ctx.now);
    }
    return { ...row };
  }

  list(
    tenant_id: string,
    filter?: { model_id?: string; status?: RetrainingOutcomeStatus; since?: string },
  ): RetrainingOutcome[] {
    let arr = (this.byTenant.get(tenant_id) ?? []).slice();
    if (filter?.model_id) arr = arr.filter((o) => o.model_id === filter.model_id);
    if (filter?.status) arr = arr.filter((o) => o.status === filter.status);
    if (filter?.since) {
      const cutoff = parseIso(filter.since, 'invalid_date');
      arr = arr.filter((o) => parseIso(o.recorded_at, 'invalid_date') >= cutoff);
    }
    // Newest-first.
    arr.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
    return arr.map((o) => ({ ...o }));
  }

  get(tenant_id: string, outcome_id: string): RetrainingOutcome | null {
    const row = (this.byTenant.get(tenant_id) ?? []).find((o) => o.outcome_id === outcome_id);
    return row ? { ...row } : null;
  }

  clear(tenant_id?: string): void {
    if (tenant_id) this.byTenant.delete(tenant_id);
    else this.byTenant.clear();
  }
}

// ─── Fleet status ────────────────────────────────────────────────────

export function buildFleetRetrainingStatus(
  tenant_id: string,
  schedules: RetrainingScheduleEntry[],
  outcomes: RetrainingOutcome[],
  now: Date,
): RetrainingFleetStatus {
  const generated_at = now.toISOString();
  const nowMs = now.getTime();
  const cutoff30dMs = nowMs - 30 * 24 * 60 * 60 * 1000;

  // Index outcomes by model_id newest-first.
  const sortedOutcomes = [...outcomes].sort((a, b) =>
    b.recorded_at.localeCompare(a.recorded_at),
  );
  const byModel = new Map<string, RetrainingOutcome[]>();
  for (const o of sortedOutcomes) {
    const arr = byModel.get(o.model_id);
    if (arr) arr.push(o);
    else byModel.set(o.model_id, [o]);
  }

  // Union of model_ids appearing in either schedules or outcomes.
  const modelIds = new Set<string>();
  for (const s of schedules) modelIds.add(s.model_id);
  for (const o of outcomes) modelIds.add(o.model_id);

  const scheduleByModel = new Map<string, RetrainingScheduleEntry>();
  for (const s of schedules) scheduleByModel.set(s.model_id, s);

  const models: ModelRetrainingStatus[] = [];
  for (const model_id of [...modelIds].sort()) {
    const schedule = scheduleByModel.get(model_id) ?? null;
    const outs = byModel.get(model_id) ?? [];
    const last_outcome = outs[0] ?? null;
    const ms_until_next = schedule
      ? parseIso(schedule.next_retrain_at, 'invalid_date') - nowMs
      : null;
    const is_overdue = !!schedule && schedule.enabled && (ms_until_next ?? 0) < 0;
    // Days since last SUCCESS specifically — failures/in_progress don't
    // count as "we've retrained".
    const lastSuccess = outs.find((o) => o.status === 'success' && o.completed_at);
    const days_since_last_success = lastSuccess
      ? Math.floor(
          (nowMs - parseIso(lastSuccess.completed_at!, 'invalid_date')) /
            (24 * 60 * 60 * 1000),
        )
      : null;
    models.push({
      model_id,
      schedule,
      last_outcome,
      ms_until_next,
      is_overdue,
      days_since_last_success,
    });
  }

  const outcomes30d = sortedOutcomes.filter(
    (o) => parseIso(o.recorded_at, 'invalid_date') >= cutoff30dMs,
  );
  const success30d = outcomes30d.filter((o) => o.status === 'success').length;
  const failure30d = outcomes30d.filter((o) => o.status === 'failure').length;
  const total_outcomes_30d = outcomes30d.length;
  const success_rate_30d =
    total_outcomes_30d === 0
      ? null
      : Math.round((success30d / total_outcomes_30d) * 10_000) / 10_000;

  const total_enabled = schedules.filter((s) => s.enabled).length;
  const total_overdue = models.filter((m) => m.is_overdue).length;
  const all_schedules_current = total_overdue === 0;

  return {
    tenant_id,
    generated_at,
    total_schedules: schedules.length,
    total_enabled,
    total_overdue,
    total_outcomes_30d,
    total_success_30d: success30d,
    total_failure_30d: failure30d,
    success_rate_30d,
    models,
    most_recent_outcome: sortedOutcomes[0] ?? null,
    all_schedules_current,
  };
}

// ─── Defaults ────────────────────────────────────────────────────────

let _defaultScheduleStore: InMemoryRetrainingScheduleStore | null = null;
let _defaultOutcomeStore: InMemoryRetrainingOutcomeStore | null = null;

export function defaultRetrainingScheduleStore(): InMemoryRetrainingScheduleStore {
  if (!_defaultScheduleStore) _defaultScheduleStore = new InMemoryRetrainingScheduleStore();
  return _defaultScheduleStore;
}

export function defaultRetrainingOutcomeStore(): InMemoryRetrainingOutcomeStore {
  if (!_defaultOutcomeStore) {
    _defaultOutcomeStore = new InMemoryRetrainingOutcomeStore(defaultRetrainingScheduleStore());
  }
  return _defaultOutcomeStore;
}

export function _resetDefaultRetrainingStores(): void {
  _defaultScheduleStore = null;
  _defaultOutcomeStore = null;
}
