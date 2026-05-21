// services/bff/src/integrations/cbs_sync.ts
//
// PHASE T3.1 — CBS Integration Deepening.
//
// Layered on top of the existing M3.1 ingestion connector registry +
// M14.9 adapter fleet + integrations/health.ts probes. Adds:
//
//   - Bidirectional SYNC JOB ledger (queued retries, back-off, status
//     transitions) over the existing CBS connector lifecycle.
//   - Per-job RECONCILIATION receipts (rows offered vs rows accepted vs
//     rows rejected) for the dataops audit trail.
//   - Pure-function MONITORING summary the SPA + Grafana exporter can
//     pull for one-shot CBS-health dashboards.
//
// Additive only:
//   - No changes to M3.1 IngestionRegistry, M14.9 runFleetHealth, or
//     the integrations/cbs OpenAPI mock.
//   - Pure-data + in-memory ledger; pg-backed swap is a future ticket
//     via the ICbsSyncStore interface.
//   - RBAC: audit:read admin-only.
//
// Why a separate module (not extending M3.1)?
//   M3.1 is the platform-wide connector registry — it tracks ALL
//   connectors uniformly. CBS deserves deeper semantics: per-row
//   reconciliation, bidirectional flow direction (inbound + outbound),
//   exponential back-off for retries. Building it as a sibling keeps
//   M3.1's contract stable while letting CBS evolve.

/** Closed enum — direction of the sync. CBS is bidirectional:
 *  - inbound  = CBS → ZorEWS (loan + repayment + txn pulls)
 *  - outbound = ZorEWS → CBS (case-action callbacks, e.g. acceptance) */
export const ALL_CBS_SYNC_DIRECTIONS = ['inbound', 'outbound'] as const;
export type CbsSyncDirection = (typeof ALL_CBS_SYNC_DIRECTIONS)[number];

export function isCbsSyncDirection(v: unknown): v is CbsSyncDirection {
  return (
    typeof v === 'string' &&
    (ALL_CBS_SYNC_DIRECTIONS as readonly string[]).includes(v)
  );
}

/** Closed enum — what the job is moving. Bound to the CBS OpenAPI mock
 *  contract under integrations/cbs/openapi.yaml. */
export const ALL_CBS_ENTITIES = [
  'loan',
  'repayment',
  'transaction',
  'account_profile',
  'case_action',
] as const;
export type CbsEntity = (typeof ALL_CBS_ENTITIES)[number];

export function isCbsEntity(v: unknown): v is CbsEntity {
  return (
    typeof v === 'string' &&
    (ALL_CBS_ENTITIES as readonly string[]).includes(v)
  );
}

/** Closed enum — job lifecycle. */
export const ALL_CBS_SYNC_STATUSES = [
  'queued',
  'in_progress',
  'succeeded',
  'failed',
  'retry_scheduled',
  'cancelled',
] as const;
export type CbsSyncStatus = (typeof ALL_CBS_SYNC_STATUSES)[number];

export function isCbsSyncStatus(v: unknown): v is CbsSyncStatus {
  return (
    typeof v === 'string' &&
    (ALL_CBS_SYNC_STATUSES as readonly string[]).includes(v)
  );
}

/** Per-job reconciliation receipt. */
export interface CbsReconciliationReceipt {
  rows_offered: number;
  rows_accepted: number;
  rows_rejected: number;
  /** Free-text reasons by error class — capped at 5 entries for SPA
   *  rendering, longer tails captured in error_message. */
  rejection_reasons: ReadonlyArray<{ reason: string; count: number }>;
  /** Wall-clock duration of the actual transfer (ms). */
  duration_ms: number;
  /** Optional CBS-side cursor for resumable pulls. */
  cursor: string | null;
}

export interface CbsSyncJob {
  job_id: string;
  tenant_id: string;
  direction: CbsSyncDirection;
  entity: CbsEntity;
  /** Caller-supplied idempotency key — when set, duplicate
   *  `enqueue()` calls with the same key return the existing job. */
  idempotency_key: string | null;
  status: CbsSyncStatus;
  /** 0-based retry attempt counter. attempt=0 means "first try". */
  attempt: number;
  /** Max retries before the job permanently fails. Default 5. */
  max_attempts: number;
  /** ISO timestamp at which the next retry runs (only set when
   *  status='retry_scheduled'). */
  next_retry_at: string | null;
  /** Last error message, set on status='failed' or
   *  status='retry_scheduled'. */
  error_message: string | null;
  /** Reconciliation receipt — null until the job has completed (or
   *  partially completed) at least once. */
  reconciliation: CbsReconciliationReceipt | null;
  /** Free-text trace id for cross-system correlation (request id +
   *  CBS server's correlation id, etc). */
  trace_id: string | null;
  /** Operator notes — captured at enqueue + every status transition. */
  notes: string | null;
  enqueued_at: string;
  enqueued_by: string;
  started_at: string | null;
  completed_at: string | null;
  /** Audit envelope. */
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface CbsSyncEnqueueInput {
  /** Caller-supplied stable id when set; otherwise auto-generated. */
  job_id?: string;
  direction: CbsSyncDirection;
  entity: CbsEntity;
  idempotency_key?: string | null;
  max_attempts?: number;
  trace_id?: string | null;
  notes?: string | null;
}

export interface CbsSyncTransitionInput {
  status: CbsSyncStatus;
  /** Required when transitioning to 'succeeded' or 'failed' or
   *  'retry_scheduled' (the latter typically auto-computed). */
  reconciliation?: CbsReconciliationReceipt | null;
  error_message?: string | null;
  next_retry_at?: string | null;
  notes?: string | null;
}

export class CbsSyncError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_direction'
      | 'invalid_entity'
      | 'invalid_status'
      | 'invalid_max_attempts'
      | 'invalid_reconciliation'
      | 'invalid_transition'
      | 'unknown_job'
      | 'duplicate_idempotency_key'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CbsSyncError';
  }
}

/** Per-tenant cap. CBS sync jobs accumulate quickly (one per hour per
 *  entity); 10k headroom covers a year+ of operations. */
export const CBS_SYNC_CAP_PER_TENANT = 10_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const MAX_ATTEMPTS_CEILING = 20;
/** Exponential back-off base (ms). attempt 0 → 1m, 1 → 2m, 2 → 4m,
 *  3 → 8m, 4 → 16m, 5 → 32m. */
const BACKOFF_BASE_MS = 60_000;

const JOB_ID_RE = /^csj_[a-z0-9_-]{1,60}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Compute the next-retry timestamp. Pure helper — exposed so the
 *  scheduler can reuse it without coupling to the store. */
export function computeBackoff(attempt: number, now: Date): Date {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new CbsSyncError('invalid_input', 'attempt must be a non-negative integer');
  }
  // 2^attempt × 60 s, capped at 1h.
  const ms = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), 60 * 60 * 1000);
  return new Date(now.getTime() + ms);
}

/** Legal-transition table. Mirrors the M9.1 case workflow style. */
const ALLOWED_TRANSITIONS: Record<CbsSyncStatus, CbsSyncStatus[]> = {
  queued: ['in_progress', 'cancelled'],
  in_progress: ['succeeded', 'failed', 'retry_scheduled', 'cancelled'],
  retry_scheduled: ['in_progress', 'cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

function validateReconciliation(r: unknown): asserts r is CbsReconciliationReceipt {
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    throw new CbsSyncError('invalid_reconciliation', 'reconciliation must be an object');
  }
  const rec = r as Record<string, unknown>;
  for (const k of ['rows_offered', 'rows_accepted', 'rows_rejected', 'duration_ms'] as const) {
    const v = rec[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new CbsSyncError(
        'invalid_reconciliation',
        `reconciliation.${k} must be a non-negative integer`,
      );
    }
  }
  if (rec.cursor !== null && rec.cursor !== undefined && typeof rec.cursor !== 'string') {
    throw new CbsSyncError(
      'invalid_reconciliation',
      'reconciliation.cursor must be a string or null',
    );
  }
  if (rec.rejection_reasons === undefined) {
    throw new CbsSyncError(
      'invalid_reconciliation',
      'reconciliation.rejection_reasons is required',
    );
  }
  if (!Array.isArray(rec.rejection_reasons) || rec.rejection_reasons.length > 5) {
    throw new CbsSyncError(
      'invalid_reconciliation',
      'reconciliation.rejection_reasons must be an array of ≤5 entries',
    );
  }
  for (const e of rec.rejection_reasons) {
    if (!e || typeof e !== 'object' || typeof (e as never)['reason'] !== 'string') {
      throw new CbsSyncError(
        'invalid_reconciliation',
        'each rejection_reason needs {reason, count}',
      );
    }
    const count = (e as never)['count'];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw new CbsSyncError(
        'invalid_reconciliation',
        'rejection_reasons[].count must be a non-negative integer',
      );
    }
  }
  // Belt + braces invariant: accepted + rejected ≤ offered.
  const off = (rec as { rows_offered: number }).rows_offered;
  const acc = (rec as { rows_accepted: number }).rows_accepted;
  const rej = (rec as { rows_rejected: number }).rows_rejected;
  if (acc + rej > off) {
    throw new CbsSyncError(
      'invalid_reconciliation',
      'reconciliation: rows_accepted + rows_rejected must not exceed rows_offered',
    );
  }
}

function validateEnqueue(input: CbsSyncEnqueueInput): void {
  if (!input || typeof input !== 'object') {
    throw new CbsSyncError('invalid_input', 'input must be an object');
  }
  if (input.job_id !== undefined && (typeof input.job_id !== 'string' || !JOB_ID_RE.test(input.job_id))) {
    throw new CbsSyncError(
      'invalid_input',
      'job_id must match ^csj_[a-z0-9_-]{1,60}$ when supplied',
    );
  }
  if (!isCbsSyncDirection(input.direction)) {
    throw new CbsSyncError(
      'invalid_direction',
      `direction must be one of: ${ALL_CBS_SYNC_DIRECTIONS.join(', ')}`,
    );
  }
  if (!isCbsEntity(input.entity)) {
    throw new CbsSyncError(
      'invalid_entity',
      `entity must be one of: ${ALL_CBS_ENTITIES.join(', ')}`,
    );
  }
  if (input.max_attempts !== undefined) {
    if (
      typeof input.max_attempts !== 'number' ||
      !Number.isInteger(input.max_attempts) ||
      input.max_attempts < 1 ||
      input.max_attempts > MAX_ATTEMPTS_CEILING
    ) {
      throw new CbsSyncError(
        'invalid_max_attempts',
        `max_attempts must be an integer in [1, ${MAX_ATTEMPTS_CEILING}]`,
      );
    }
  }
  if (input.idempotency_key !== undefined && input.idempotency_key !== null) {
    if (
      typeof input.idempotency_key !== 'string' ||
      input.idempotency_key.length === 0 ||
      input.idempotency_key.length > 200
    ) {
      throw new CbsSyncError(
        'invalid_input',
        'idempotency_key must be a non-empty string ≤ 200 chars',
      );
    }
  }
  if (input.trace_id !== undefined && input.trace_id !== null) {
    if (typeof input.trace_id !== 'string' || input.trace_id.length > 200) {
      throw new CbsSyncError(
        'invalid_input',
        'trace_id must be a string ≤ 200 chars',
      );
    }
  }
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== 'string' || input.notes.length > 2000) {
      throw new CbsSyncError('invalid_input', 'notes must be a string ≤ 2000 chars');
    }
  }
}

function validateTransition(input: CbsSyncTransitionInput): void {
  if (!input || typeof input !== 'object') {
    throw new CbsSyncError('invalid_input', 'transition input must be an object');
  }
  if (!isCbsSyncStatus(input.status)) {
    throw new CbsSyncError(
      'invalid_status',
      `status must be one of: ${ALL_CBS_SYNC_STATUSES.join(', ')}`,
    );
  }
  if (input.next_retry_at !== undefined && input.next_retry_at !== null) {
    if (typeof input.next_retry_at !== 'string' || !ISO_DT_RE.test(input.next_retry_at)) {
      throw new CbsSyncError('invalid_input', 'next_retry_at must be ISO-8601');
    }
  }
  if (input.reconciliation !== undefined && input.reconciliation !== null) {
    validateReconciliation(input.reconciliation);
  }
  if (input.error_message !== undefined && input.error_message !== null) {
    if (typeof input.error_message !== 'string' || input.error_message.length > 4000) {
      throw new CbsSyncError(
        'invalid_input',
        'error_message must be a string ≤ 4000 chars',
      );
    }
  }
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== 'string' || input.notes.length > 2000) {
      throw new CbsSyncError('invalid_input', 'notes must be a string ≤ 2000 chars');
    }
  }
}

export interface CbsSyncStore {
  list(
    tenant_id: string,
    opts?: {
      direction?: CbsSyncDirection;
      entity?: CbsEntity;
      status?: CbsSyncStatus;
      include_deleted?: boolean;
      limit?: number;
    },
  ): CbsSyncJob[];
  get(tenant_id: string, job_id: string): CbsSyncJob | null;
  /** Idempotency-key lookup. Returns the existing job if one already
   *  exists under the same (tenant, idempotency_key) pair; null otherwise. */
  getByIdempotencyKey(tenant_id: string, key: string): CbsSyncJob | null;
  enqueue(
    tenant_id: string,
    input: CbsSyncEnqueueInput,
    actor: string,
    now: Date,
  ): CbsSyncJob;
  /** Drive the lifecycle: queued → in_progress → succeeded/failed/
   *  retry_scheduled. */
  transition(
    tenant_id: string,
    job_id: string,
    input: CbsSyncTransitionInput,
    actor: string,
    now: Date,
  ): CbsSyncJob;
  softDelete(
    tenant_id: string,
    job_id: string,
    actor: string,
    now: Date,
  ): CbsSyncJob;
  restore(payload: CbsSyncJob): boolean;
  /** Convenience aggregate for the monitoring dashboard. */
  summary(tenant_id: string): CbsSyncSummary;
}

export interface CbsSyncSummary {
  total_jobs: number;
  /** Counts per status — every key present at 0 when absent. */
  by_status: Record<CbsSyncStatus, number>;
  /** Counts per (direction, entity) — keys present only when ≥ 1 job exists. */
  by_direction: Record<CbsSyncDirection, number>;
  by_entity: Record<CbsEntity, number>;
  /** Number of in-flight retry-scheduled jobs whose `next_retry_at` is in
   *  the past — drives the SPA's "stale retries" alert. */
  overdue_retries: number;
  /** Reconciliation rollup over jobs with a non-null receipt. */
  total_rows_offered: number;
  total_rows_accepted: number;
  total_rows_rejected: number;
  /** Most-recently-updated job per status for the SPA's "last activity" tiles. */
  most_recent_per_status: Partial<Record<CbsSyncStatus, { job_id: string; updated_at: string }>>;
}

export class InMemoryCbsSyncStore implements CbsSyncStore {
  private byTenant = new Map<string, Map<string, CbsSyncJob>>();
  /** Per-tenant index of idempotency_key → job_id for O(1) dedup. */
  private idemByTenant = new Map<string, Map<string, string>>();
  /** Monotonic counter for auto-generated job_ids. */
  private idCounter = 0;

  private bucket(tenant_id: string): Map<string, CbsSyncJob> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  private idemBucket(tenant_id: string): Map<string, string> {
    let b = this.idemByTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.idemByTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: {
      direction?: CbsSyncDirection;
      entity?: CbsEntity;
      status?: CbsSyncStatus;
      include_deleted?: boolean;
      limit?: number;
    } = {},
  ): CbsSyncJob[] {
    const out: CbsSyncJob[] = [];
    const b = this.byTenant.get(tenant_id);
    if (!b) return out;
    for (const j of b.values()) {
      if (!opts.include_deleted && j.deleted_at) continue;
      if (opts.direction !== undefined && j.direction !== opts.direction) continue;
      if (opts.entity !== undefined && j.entity !== opts.entity) continue;
      if (opts.status !== undefined && j.status !== opts.status) continue;
      out.push({ ...j, reconciliation: j.reconciliation ? { ...j.reconciliation, rejection_reasons: [...j.reconciliation.rejection_reasons] } : null });
    }
    // Newest-first by enqueued_at; tie-break by job_id desc.
    out.sort((a, b) => {
      if (a.enqueued_at !== b.enqueued_at) return b.enqueued_at.localeCompare(a.enqueued_at);
      return b.job_id.localeCompare(a.job_id);
    });
    const limit = opts.limit ?? 200;
    return out.slice(0, Math.min(Math.max(limit, 1), 500));
  }

  get(tenant_id: string, job_id: string): CbsSyncJob | null {
    const j = this.byTenant.get(tenant_id)?.get(job_id);
    if (!j || j.deleted_at) return null;
    return {
      ...j,
      reconciliation: j.reconciliation
        ? { ...j.reconciliation, rejection_reasons: [...j.reconciliation.rejection_reasons] }
        : null,
    };
  }

  getByIdempotencyKey(tenant_id: string, key: string): CbsSyncJob | null {
    const id = this.idemByTenant.get(tenant_id)?.get(key);
    if (!id) return null;
    return this.get(tenant_id, id);
  }

  enqueue(
    tenant_id: string,
    input: CbsSyncEnqueueInput,
    actor: string,
    now: Date,
  ): CbsSyncJob {
    validateEnqueue(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new CbsSyncError('invalid_input', 'actor (enqueued_by) required');
    }
    const b = this.bucket(tenant_id);
    const idem = this.idemBucket(tenant_id);
    // Idempotency-key short-circuit — return the existing job.
    if (input.idempotency_key) {
      const existingId = idem.get(input.idempotency_key);
      if (existingId) {
        const existing = b.get(existingId);
        if (existing && !existing.deleted_at) {
          // Per spec: silently return the existing job. The SPA can
          // detect this via the `enqueued_at !== now` mismatch.
          return {
            ...existing,
            reconciliation: existing.reconciliation
              ? { ...existing.reconciliation, rejection_reasons: [...existing.reconciliation.rejection_reasons] }
              : null,
          };
        }
      }
    }
    // Cap check on live (non-deleted) rows.
    const live = [...b.values()].filter((j) => !j.deleted_at).length;
    if (live >= CBS_SYNC_CAP_PER_TENANT) {
      throw new CbsSyncError(
        'cap_reached',
        `CBS sync job cap (${CBS_SYNC_CAP_PER_TENANT}) reached`,
      );
    }
    // Generate job_id when not supplied; ensure uniqueness even when supplied.
    let job_id = input.job_id;
    if (!job_id) {
      this.idCounter++;
      job_id = `csj_auto_${now.getTime().toString(36)}_${this.idCounter}`;
    }
    if (b.has(job_id) && !b.get(job_id)!.deleted_at) {
      // Treat as duplicate when caller passed an explicit job_id that
      // collides — caller bug.
      throw new CbsSyncError(
        'duplicate_idempotency_key',
        `job_id ${job_id} already exists; pass an idempotency_key for natural dedup`,
        { job_id },
      );
    }
    const ts = now.toISOString();
    const entry: CbsSyncJob = {
      job_id,
      tenant_id,
      direction: input.direction,
      entity: input.entity,
      idempotency_key: input.idempotency_key ?? null,
      status: 'queued',
      attempt: 0,
      max_attempts: input.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
      next_retry_at: null,
      error_message: null,
      reconciliation: null,
      trace_id: input.trace_id ?? null,
      notes: input.notes?.trim() || null,
      enqueued_at: ts,
      enqueued_by: actor,
      started_at: null,
      completed_at: null,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.job_id, entry);
    if (entry.idempotency_key) {
      idem.set(entry.idempotency_key, entry.job_id);
    }
    return {
      ...entry,
      reconciliation: null,
    };
  }

  transition(
    tenant_id: string,
    job_id: string,
    input: CbsSyncTransitionInput,
    actor: string,
    now: Date,
  ): CbsSyncJob {
    validateTransition(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new CbsSyncError('invalid_input', 'actor (updated_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(job_id);
    if (!cur || cur.deleted_at) {
      throw new CbsSyncError('unknown_job', `job ${job_id} not found`);
    }
    if (!ALLOWED_TRANSITIONS[cur.status].includes(input.status)) {
      throw new CbsSyncError(
        'invalid_transition',
        `cannot transition from ${cur.status} to ${input.status}`,
        { from: cur.status, to: input.status },
      );
    }
    const ts = now.toISOString();
    let next_retry_at = cur.next_retry_at;
    let attempt = cur.attempt;
    let error_message = cur.error_message;
    let started_at = cur.started_at;
    let completed_at = cur.completed_at;
    let reconciliation = cur.reconciliation;

    if (input.status === 'in_progress') {
      // Auto-bump started_at on first transition into in_progress.
      if (!started_at) started_at = ts;
      next_retry_at = null;
      error_message = null;
    } else if (input.status === 'succeeded') {
      if (!input.reconciliation) {
        throw new CbsSyncError(
          'invalid_reconciliation',
          'reconciliation receipt required when transitioning to succeeded',
        );
      }
      reconciliation = input.reconciliation;
      completed_at = ts;
      next_retry_at = null;
      error_message = null;
    } else if (input.status === 'failed') {
      // Failed is terminal — no more retries.
      completed_at = ts;
      next_retry_at = null;
      if (input.reconciliation) reconciliation = input.reconciliation;
      if (input.error_message) error_message = input.error_message;
    } else if (input.status === 'retry_scheduled') {
      attempt = cur.attempt + 1;
      if (attempt >= cur.max_attempts) {
        // Out of retries — terminal fail.
        throw new CbsSyncError(
          'invalid_transition',
          `attempt ${attempt} exceeds max_attempts ${cur.max_attempts}; transition to failed instead`,
          { attempt, max_attempts: cur.max_attempts },
        );
      }
      next_retry_at = (input.next_retry_at ?? computeBackoff(attempt, now).toISOString());
      if (input.error_message) error_message = input.error_message;
    } else if (input.status === 'cancelled') {
      completed_at = ts;
      next_retry_at = null;
    }

    const merged: CbsSyncJob = {
      ...cur,
      status: input.status,
      attempt,
      next_retry_at,
      error_message,
      reconciliation: reconciliation
        ? { ...reconciliation, rejection_reasons: [...reconciliation.rejection_reasons] }
        : null,
      started_at,
      completed_at,
      notes:
        input.notes !== undefined ? input.notes?.trim() || null : cur.notes,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(job_id, merged);
    return {
      ...merged,
      reconciliation: merged.reconciliation
        ? { ...merged.reconciliation, rejection_reasons: [...merged.reconciliation.rejection_reasons] }
        : null,
    };
  }

  softDelete(
    tenant_id: string,
    job_id: string,
    actor: string,
    now: Date,
  ): CbsSyncJob {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new CbsSyncError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(job_id);
    if (!cur || cur.deleted_at) {
      throw new CbsSyncError('unknown_job', `job ${job_id} not found`);
    }
    const ts = now.toISOString();
    const tombstoned: CbsSyncJob = {
      ...cur,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(job_id, tombstoned);
    return {
      ...tombstoned,
      reconciliation: tombstoned.reconciliation
        ? { ...tombstoned.reconciliation, rejection_reasons: [...tombstoned.reconciliation.rejection_reasons] }
        : null,
    };
  }

  restore(payload: CbsSyncJob): boolean {
    const b = this.bucket(payload.tenant_id);
    const cur = b.get(payload.job_id);
    if (cur && !cur.deleted_at) return false;
    const restored: CbsSyncJob = {
      ...payload,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(restored.job_id, restored);
    if (restored.idempotency_key) {
      this.idemBucket(restored.tenant_id).set(restored.idempotency_key, restored.job_id);
    }
    return true;
  }

  summary(tenant_id: string): CbsSyncSummary {
    const by_status = Object.fromEntries(
      ALL_CBS_SYNC_STATUSES.map((s) => [s, 0]),
    ) as Record<CbsSyncStatus, number>;
    const by_direction: Record<CbsSyncDirection, number> = { inbound: 0, outbound: 0 };
    const by_entity: Record<CbsEntity, number> = {
      loan: 0,
      repayment: 0,
      transaction: 0,
      account_profile: 0,
      case_action: 0,
    };
    let total = 0;
    let overdue = 0;
    let total_offered = 0;
    let total_accepted = 0;
    let total_rejected = 0;
    const most_recent: Partial<Record<CbsSyncStatus, { job_id: string; updated_at: string }>> = {};
    const nowMs = Date.now();
    const b = this.byTenant.get(tenant_id);
    if (b) {
      for (const j of b.values()) {
        if (j.deleted_at) continue;
        total++;
        by_status[j.status]++;
        by_direction[j.direction]++;
        by_entity[j.entity]++;
        if (j.status === 'retry_scheduled' && j.next_retry_at) {
          if (new Date(j.next_retry_at).getTime() < nowMs) overdue++;
        }
        if (j.reconciliation) {
          total_offered += j.reconciliation.rows_offered;
          total_accepted += j.reconciliation.rows_accepted;
          total_rejected += j.reconciliation.rows_rejected;
        }
        const prev = most_recent[j.status];
        if (!prev || j.updated_at > prev.updated_at) {
          most_recent[j.status] = { job_id: j.job_id, updated_at: j.updated_at };
        }
      }
    }
    return {
      total_jobs: total,
      by_status,
      by_direction,
      by_entity,
      overdue_retries: overdue,
      total_rows_offered: total_offered,
      total_rows_accepted: total_accepted,
      total_rows_rejected: total_rejected,
      most_recent_per_status: most_recent,
    };
  }
}

export const defaultCbsSyncStore: CbsSyncStore = new InMemoryCbsSyncStore();
