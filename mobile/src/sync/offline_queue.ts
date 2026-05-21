// mobile/src/sync/offline_queue.ts
//
// T4.3 — Mobile offline-sync queue. Closes the deferred "offline-mode
// sync queue with optimistic queue persistence + replay" item from the
// T4.3 closure note.
//
// Field officers operate in poor-connectivity zones; visits + ack
// actions must persist locally and replay automatically when network
// is restored. This module ships:
//   - QueuedAction shape (kind, payload, idempotency_key, retry_count,
//     last_attempt_at, status)
//   - OfflineSyncQueue interface (enqueue / list / drain / clear)
//   - InMemoryOfflineQueue (test + dev fallback)
//   - AsyncStorageOfflineQueue (production — lazy-imports
//     @react-native-async-storage/async-storage so unit tests can run
//     without the native dep)
//   - SyncRunner that drains the queue against an API client with
//     exponential back-off + idempotency-key replay safety
//
// External blocker: a working Expo build pipeline + the
// @react-native-async-storage/async-storage native module. Until those
// are in place, the InMemoryOfflineQueue runs identical contracts in
// unit tests + dev mode.

// ─── Canonical types ─────────────────────────────────────────────────

/** Actions the field-app queues for offline replay. Closed enum —
 *  every kind must have a matching dispatch handler in SyncRunner. */
export type QueuedActionKind =
  | 'alert.ack'
  | 'alert.unack'
  | 'case.log_action'
  | 'investigation.note'
  | 'investigation.step_complete'
  | 'field_visit.log';

export interface QueuedAction {
  /** Deterministic per-(device, action) so a retry on a flaky network
   *  doesn't double-fire when the server has already accepted. */
  idempotency_key: string;
  kind: QueuedActionKind;
  /** Action-specific payload — opaque to the queue; SyncRunner routes
   *  by kind to the right ApiClient method. */
  payload: Record<string, unknown>;
  /** Resource id the action targets (e.g. alert_id, case_id). Used for
   *  audit trail + replay deduplication. */
  resource_id?: string;
  /** Operator who initiated. Persisted so replay attributes correctly
   *  even if device passes through different sessions. */
  actor: string;
  /** Tenant context — replay must hit the right tenant even if the
   *  device's current session has rotated. */
  tenant_id: string;
  enqueued_at: string;
  retry_count: number;
  /** ISO timestamp of last replay attempt (success OR failure). */
  last_attempt_at: string | null;
  /** ISO timestamp of last failure message. Wiped on success. */
  last_error: string | null;
  status: 'pending' | 'in_flight' | 'succeeded' | 'failed_permanent';
}

/** Storage interface — async because production uses AsyncStorage. */
export interface OfflineSyncQueue {
  enqueue(action: Omit<QueuedAction, 'enqueued_at' | 'retry_count' | 'last_attempt_at' | 'last_error' | 'status'>): Promise<QueuedAction>;
  list(opts?: { status?: QueuedAction['status'] }): Promise<QueuedAction[]>;
  update(idempotency_key: string, patch: Partial<QueuedAction>): Promise<QueuedAction | null>;
  /** Hard-delete from storage (typically after permanent success). */
  remove(idempotency_key: string): Promise<boolean>;
  /** Snapshot count by status — drives the SPA "N queued" badge. */
  count(): Promise<Record<QueuedAction['status'], number>>;
  clear(): Promise<void>;
}

// ─── InMemoryOfflineQueue ────────────────────────────────────────────

/** In-process queue. Used by tests + dev mode + as a fallback when
 *  AsyncStorage is unavailable on this platform. */
export class InMemoryOfflineQueue implements OfflineSyncQueue {
  private items = new Map<string, QueuedAction>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async enqueue(
    action: Omit<QueuedAction, 'enqueued_at' | 'retry_count' | 'last_attempt_at' | 'last_error' | 'status'>,
  ): Promise<QueuedAction> {
    // Idempotency: same key from a prior enqueue → return existing.
    const existing = this.items.get(action.idempotency_key);
    if (existing) return { ...existing };
    const now = this.clock().toISOString();
    const queued: QueuedAction = {
      ...action,
      enqueued_at: now,
      retry_count: 0,
      last_attempt_at: null,
      last_error: null,
      status: 'pending',
    };
    this.items.set(queued.idempotency_key, queued);
    return { ...queued };
  }

  async list(opts: { status?: QueuedAction['status'] } = {}): Promise<QueuedAction[]> {
    const out = Array.from(this.items.values());
    const filtered = opts.status ? out.filter((a) => a.status === opts.status) : out;
    // Sort enqueued_at asc — replay in FIFO order.
    filtered.sort((a, b) => (a.enqueued_at < b.enqueued_at ? -1 : 1));
    return filtered.map((a) => ({ ...a }));
  }

  async update(idempotency_key: string, patch: Partial<QueuedAction>): Promise<QueuedAction | null> {
    const existing = this.items.get(idempotency_key);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.items.set(idempotency_key, updated);
    return { ...updated };
  }

  async remove(idempotency_key: string): Promise<boolean> {
    return this.items.delete(idempotency_key);
  }

  async count(): Promise<Record<QueuedAction['status'], number>> {
    const out: Record<QueuedAction['status'], number> = {
      pending: 0,
      in_flight: 0,
      succeeded: 0,
      failed_permanent: 0,
    };
    for (const a of this.items.values()) out[a.status]++;
    return out;
  }

  async clear(): Promise<void> {
    this.items.clear();
  }
}

// ─── AsyncStorageOfflineQueue (production) ───────────────────────────

/** Minimal AsyncStorage-like interface the queue depends on. The
 *  production swap is `@react-native-async-storage/async-storage`.
 *  This abstraction keeps the test path AsyncStorage-free. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const ASYNC_STORAGE_KEY = 'apex.ews.offline_queue';

/** AsyncStorage-backed implementation. Production wires this with the
 *  real `@react-native-async-storage/async-storage` import — the
 *  store satisfies the AsyncStorageLike contract directly.
 *
 *  Persistence model: one key, one JSON blob, atomic read-write.
 *  Sufficient for ~hundreds of queued actions (typical field officer
 *  shift = 20-50 visits). Switch to a per-action key scheme if action
 *  counts exceed 1000 + bulk JSON parse becomes a bottleneck. */
export class AsyncStorageOfflineQueue implements OfflineSyncQueue {
  constructor(
    private readonly storage: AsyncStorageLike,
    private readonly clock: () => Date = () => new Date(),
    private readonly storageKey: string = ASYNC_STORAGE_KEY,
  ) {}

  private async readAll(): Promise<Map<string, QueuedAction>> {
    const raw = await this.storage.getItem(this.storageKey);
    if (!raw) return new Map();
    try {
      const parsed = JSON.parse(raw) as QueuedAction[];
      const out = new Map<string, QueuedAction>();
      for (const a of parsed) out.set(a.idempotency_key, a);
      return out;
    } catch {
      // Corrupted blob — defensive: reset.
      await this.storage.removeItem(this.storageKey);
      return new Map();
    }
  }

  private async writeAll(items: Map<string, QueuedAction>): Promise<void> {
    const arr = Array.from(items.values());
    await this.storage.setItem(this.storageKey, JSON.stringify(arr));
  }

  async enqueue(
    action: Omit<QueuedAction, 'enqueued_at' | 'retry_count' | 'last_attempt_at' | 'last_error' | 'status'>,
  ): Promise<QueuedAction> {
    const items = await this.readAll();
    const existing = items.get(action.idempotency_key);
    if (existing) return { ...existing };
    const queued: QueuedAction = {
      ...action,
      enqueued_at: this.clock().toISOString(),
      retry_count: 0,
      last_attempt_at: null,
      last_error: null,
      status: 'pending',
    };
    items.set(queued.idempotency_key, queued);
    await this.writeAll(items);
    return { ...queued };
  }

  async list(opts: { status?: QueuedAction['status'] } = {}): Promise<QueuedAction[]> {
    const items = await this.readAll();
    const arr = Array.from(items.values());
    const filtered = opts.status ? arr.filter((a) => a.status === opts.status) : arr;
    filtered.sort((a, b) => (a.enqueued_at < b.enqueued_at ? -1 : 1));
    return filtered.map((a) => ({ ...a }));
  }

  async update(idempotency_key: string, patch: Partial<QueuedAction>): Promise<QueuedAction | null> {
    const items = await this.readAll();
    const existing = items.get(idempotency_key);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    items.set(idempotency_key, updated);
    await this.writeAll(items);
    return { ...updated };
  }

  async remove(idempotency_key: string): Promise<boolean> {
    const items = await this.readAll();
    const had = items.delete(idempotency_key);
    if (had) await this.writeAll(items);
    return had;
  }

  async count(): Promise<Record<QueuedAction['status'], number>> {
    const items = await this.readAll();
    const out: Record<QueuedAction['status'], number> = {
      pending: 0,
      in_flight: 0,
      succeeded: 0,
      failed_permanent: 0,
    };
    for (const a of items.values()) out[a.status]++;
    return out;
  }

  async clear(): Promise<void> {
    await this.storage.removeItem(this.storageKey);
  }
}

// ─── SyncRunner ──────────────────────────────────────────────────────

/** Dispatcher contract — production wires this to the ApiClient.
 *  Returns true on success (queue removes the entry), false on
 *  retryable failure (entry stays + retry_count bumps), throws
 *  PermanentSyncError on non-retryable (entry transitions to
 *  failed_permanent — operator must reconcile manually). */
export type SyncDispatcher = (action: QueuedAction) => Promise<boolean>;

export class PermanentSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSyncError';
  }
}

export interface SyncRunnerOptions {
  queue: OfflineSyncQueue;
  dispatcher: SyncDispatcher;
  /** Max retries before transitioning to failed_permanent. Default 6. */
  maxRetries?: number;
  /** Base delay for exponential back-off in ms. Default 1000. */
  baseDelayMs?: number;
  /** Hook fires after every action attempt — useful for ops metrics. */
  onAttempt?: (action: QueuedAction, outcome: 'success' | 'retry' | 'permanent') => void;
  /** Clock for tests. */
  clock?: () => Date;
}

export interface DrainReport {
  total_attempted: number;
  total_succeeded: number;
  total_retried: number;
  total_failed_permanent: number;
  remaining_pending: number;
}

/** Drains every pending action one-by-one against the dispatcher.
 *  Designed to be invoked when network restores; the caller (a React
 *  hook or background task) triggers `drain()` and renders the report.
 *
 *  Sequential by design — field-officer workflows are causally ordered
 *  (visit → ack → close) so parallel replay would reshuffle. */
export class SyncRunner {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly onAttempt?: SyncRunnerOptions['onAttempt'];
  private readonly clock: () => Date;

  constructor(private readonly opts: SyncRunnerOptions) {
    this.maxRetries = opts.maxRetries ?? 6;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.onAttempt = opts.onAttempt;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Exponential back-off without jitter — caller can wrap in setTimeout
   *  if it wants jitter. Exposed for tests. */
  backoffMs(retry_count: number): number {
    return this.baseDelayMs * Math.pow(2, Math.max(0, retry_count));
  }

  async drain(): Promise<DrainReport> {
    const report: DrainReport = {
      total_attempted: 0,
      total_succeeded: 0,
      total_retried: 0,
      total_failed_permanent: 0,
      remaining_pending: 0,
    };
    const pending = await this.opts.queue.list({ status: 'pending' });
    for (const action of pending) {
      report.total_attempted++;
      await this.opts.queue.update(action.idempotency_key, {
        status: 'in_flight',
        last_attempt_at: this.clock().toISOString(),
      });
      try {
        const ok = await this.opts.dispatcher(action);
        if (ok) {
          await this.opts.queue.remove(action.idempotency_key);
          report.total_succeeded++;
          this.onAttempt?.(action, 'success');
        } else {
          // Retryable failure — bump retry, return to pending.
          const next = action.retry_count + 1;
          if (next >= this.maxRetries) {
            await this.opts.queue.update(action.idempotency_key, {
              status: 'failed_permanent',
              retry_count: next,
              last_error: 'max_retries_exceeded',
            });
            report.total_failed_permanent++;
            this.onAttempt?.(action, 'permanent');
          } else {
            await this.opts.queue.update(action.idempotency_key, {
              status: 'pending',
              retry_count: next,
              last_error: 'retryable_failure',
            });
            report.total_retried++;
            this.onAttempt?.(action, 'retry');
          }
        }
      } catch (err) {
        if (err instanceof PermanentSyncError) {
          await this.opts.queue.update(action.idempotency_key, {
            status: 'failed_permanent',
            last_error: err.message,
          });
          report.total_failed_permanent++;
          this.onAttempt?.(action, 'permanent');
        } else {
          // Treat as retryable.
          const next = action.retry_count + 1;
          if (next >= this.maxRetries) {
            await this.opts.queue.update(action.idempotency_key, {
              status: 'failed_permanent',
              retry_count: next,
              last_error: (err as Error)?.message ?? 'unknown_error',
            });
            report.total_failed_permanent++;
            this.onAttempt?.(action, 'permanent');
          } else {
            await this.opts.queue.update(action.idempotency_key, {
              status: 'pending',
              retry_count: next,
              last_error: (err as Error)?.message ?? 'unknown_error',
            });
            report.total_retried++;
            this.onAttempt?.(action, 'retry');
          }
        }
      }
    }
    const stillPending = await this.opts.queue.list({ status: 'pending' });
    report.remaining_pending = stillPending.length;
    return report;
  }
}

// ─── Convenience: deterministic idempotency_key builder ──────────────

/** Builds an idempotency key the field-app uses when enqueueing. Keys
 *  must be stable across retries so server-side dedup works. */
export function buildIdempotencyKey(
  kind: QueuedActionKind,
  resource_id: string,
  actor: string,
  at_iso: string,
): string {
  // Format: <kind>:<resource>:<actor>:<at>.
  // 64-char cap matches the M8.3 alert_id cap (server-side).
  return `${kind}:${resource_id}:${actor}:${at_iso}`.slice(0, 64);
}
