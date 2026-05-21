// mobile/__tests__/offline_queue.test.ts
//
// T4.3 — Mobile offline-sync queue tests.

import {
  AsyncStorageOfflineQueue,
  InMemoryOfflineQueue,
  PermanentSyncError,
  SyncRunner,
  buildIdempotencyKey,
  type AsyncStorageLike,
  type QueuedAction,
  type SyncDispatcher,
} from '../src/sync/offline_queue';

const NOW = new Date('2026-05-21T12:00:00.000Z');

function baseAction(
  overrides: Partial<Pick<QueuedAction, 'idempotency_key' | 'kind' | 'payload' | 'resource_id' | 'actor' | 'tenant_id'>> = {},
) {
  return {
    idempotency_key: overrides.idempotency_key ?? 'idem-1',
    kind: overrides.kind ?? ('alert.ack' as const),
    payload: overrides.payload ?? { notes: 'seen' },
    resource_id: overrides.resource_id ?? 'a-001',
    actor: overrides.actor ?? 'ravi.field',
    tenant_id: overrides.tenant_id ?? 'BIL',
  };
}

// ─── InMemoryOfflineQueue ────────────────────────────────────────────

describe('InMemoryOfflineQueue', () => {
  test('enqueue creates pending action with retry_count=0', async () => {
    const q = new InMemoryOfflineQueue(() => NOW);
    const action = await q.enqueue(baseAction());
    expect(action.status).toBe('pending');
    expect(action.retry_count).toBe(0);
    expect(action.last_attempt_at).toBeNull();
    expect(action.enqueued_at).toBe(NOW.toISOString());
  });

  test('idempotent: same idempotency_key returns existing', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'k' }));
    await q.enqueue(baseAction({ idempotency_key: 'k', actor: 'someone-else' }));
    const list = await q.list();
    expect(list).toHaveLength(1);
    // First-write wins.
    expect(list[0].actor).toBe('ravi.field');
  });

  test('list FIFO order by enqueued_at asc', async () => {
    let t = new Date('2026-05-21T10:00:00Z').getTime();
    const q = new InMemoryOfflineQueue(() => new Date(t));
    await q.enqueue(baseAction({ idempotency_key: 'b' }));
    t += 1000;
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    t += 1000;
    await q.enqueue(baseAction({ idempotency_key: 'c' }));
    const list = await q.list();
    expect(list.map((a) => a.idempotency_key)).toEqual(['b', 'a', 'c']);
  });

  test('list filter by status', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    await q.enqueue(baseAction({ idempotency_key: 'b' }));
    await q.update('a', { status: 'succeeded' });
    const pending = await q.list({ status: 'pending' });
    expect(pending.map((a) => a.idempotency_key)).toEqual(['b']);
  });

  test('update patches existing action', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'k' }));
    const updated = await q.update('k', { retry_count: 3, last_error: 'timeout' });
    expect(updated?.retry_count).toBe(3);
    expect(updated?.last_error).toBe('timeout');
  });

  test('update returns null for unknown key', async () => {
    const q = new InMemoryOfflineQueue();
    expect(await q.update('nope', { retry_count: 1 })).toBeNull();
  });

  test('remove deletes + returns boolean', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'k' }));
    expect(await q.remove('k')).toBe(true);
    expect(await q.remove('k')).toBe(false);
    expect(await q.list()).toHaveLength(0);
  });

  test('count returns per-status snapshot', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    await q.enqueue(baseAction({ idempotency_key: 'b' }));
    await q.enqueue(baseAction({ idempotency_key: 'c' }));
    await q.update('a', { status: 'succeeded' });
    await q.update('b', { status: 'failed_permanent' });
    const counts = await q.count();
    expect(counts).toEqual({
      pending: 1,
      in_flight: 0,
      succeeded: 1,
      failed_permanent: 1,
    });
  });

  test('clear wipes the queue', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    await q.enqueue(baseAction({ idempotency_key: 'b' }));
    await q.clear();
    expect(await q.list()).toHaveLength(0);
  });

  test('defensive copy: mutating returned action does not pollute store', async () => {
    const q = new InMemoryOfflineQueue();
    const a = await q.enqueue(baseAction({ idempotency_key: 'k' }));
    a.status = 'succeeded';
    a.retry_count = 99;
    const list = await q.list();
    expect(list[0].status).toBe('pending');
    expect(list[0].retry_count).toBe(0);
  });
});

// ─── AsyncStorageOfflineQueue ────────────────────────────────────────

/** In-memory AsyncStorage stand-in for tests. */
class FakeAsyncStorage implements AsyncStorageLike {
  private kv = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.kv.delete(key);
  }

  // Test helper.
  raw(): Record<string, string> {
    return Object.fromEntries(this.kv.entries());
  }
}

describe('AsyncStorageOfflineQueue', () => {
  test('round-trips actions through storage', async () => {
    const storage = new FakeAsyncStorage();
    const q = new AsyncStorageOfflineQueue(storage, () => NOW);
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    await q.enqueue(baseAction({ idempotency_key: 'b' }));
    // New instance reading the same storage sees the same data.
    const q2 = new AsyncStorageOfflineQueue(storage);
    const list = await q2.list();
    expect(list.map((a) => a.idempotency_key).sort()).toEqual(['a', 'b']);
  });

  test('idempotent enqueue same key', async () => {
    const q = new AsyncStorageOfflineQueue(new FakeAsyncStorage());
    await q.enqueue(baseAction({ idempotency_key: 'k', actor: 'first' }));
    await q.enqueue(baseAction({ idempotency_key: 'k', actor: 'second' }));
    const list = await q.list();
    expect(list).toHaveLength(1);
    expect(list[0].actor).toBe('first');
  });

  test('corrupted blob is defensively wiped on read', async () => {
    const storage = new FakeAsyncStorage();
    await storage.setItem('apex.ews.offline_queue', '{not json');
    const q = new AsyncStorageOfflineQueue(storage);
    expect(await q.list()).toHaveLength(0);
    // After defensive wipe, fresh writes work.
    await q.enqueue(baseAction({ idempotency_key: 'k' }));
    expect(await q.list()).toHaveLength(1);
  });

  test('honors custom storageKey', async () => {
    const storage = new FakeAsyncStorage();
    const q = new AsyncStorageOfflineQueue(storage, () => NOW, 'custom.key');
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    expect(Object.keys(storage.raw())).toContain('custom.key');
  });

  test('count matches per-status truth', async () => {
    const q = new AsyncStorageOfflineQueue(new FakeAsyncStorage());
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    await q.enqueue(baseAction({ idempotency_key: 'b' }));
    await q.update('a', { status: 'in_flight' });
    expect(await q.count()).toEqual({
      pending: 1,
      in_flight: 1,
      succeeded: 0,
      failed_permanent: 0,
    });
  });

  test('clear() removes the storage key entirely', async () => {
    const storage = new FakeAsyncStorage();
    const q = new AsyncStorageOfflineQueue(storage);
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    await q.clear();
    expect(Object.keys(storage.raw())).toHaveLength(0);
  });
});

// ─── SyncRunner ──────────────────────────────────────────────────────

describe('SyncRunner', () => {
  test('drains successful actions + removes them from queue', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    await q.enqueue(baseAction({ idempotency_key: 'b' }));
    const dispatcher: SyncDispatcher = async () => true;
    const runner = new SyncRunner({ queue: q, dispatcher });
    const report = await runner.drain();
    expect(report.total_succeeded).toBe(2);
    expect(report.remaining_pending).toBe(0);
    expect(await q.list()).toHaveLength(0);
  });

  test('retryable failure bumps retry_count + leaves entry pending', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    const dispatcher: SyncDispatcher = async () => false; // retryable
    const runner = new SyncRunner({ queue: q, dispatcher, maxRetries: 3 });
    const report = await runner.drain();
    expect(report.total_retried).toBe(1);
    expect(report.total_succeeded).toBe(0);
    const remaining = await q.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].retry_count).toBe(1);
    expect(remaining[0].status).toBe('pending');
    expect(remaining[0].last_error).toBe('retryable_failure');
  });

  test('max retries → failed_permanent', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    const dispatcher: SyncDispatcher = async () => false;
    const runner = new SyncRunner({ queue: q, dispatcher, maxRetries: 2 });
    await runner.drain();
    await runner.drain();
    const all = await q.list();
    expect(all[0].status).toBe('failed_permanent');
    expect(all[0].last_error).toBe('max_retries_exceeded');
  });

  test('PermanentSyncError immediately marks failed_permanent', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    const dispatcher: SyncDispatcher = async () => {
      throw new PermanentSyncError('rejected by server');
    };
    const runner = new SyncRunner({ queue: q, dispatcher });
    const report = await runner.drain();
    expect(report.total_failed_permanent).toBe(1);
    const all = await q.list();
    expect(all[0].status).toBe('failed_permanent');
    expect(all[0].last_error).toBe('rejected by server');
  });

  test('non-permanent thrown error treated as retryable', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    const dispatcher: SyncDispatcher = async () => {
      throw new Error('network down');
    };
    const runner = new SyncRunner({ queue: q, dispatcher });
    const report = await runner.drain();
    expect(report.total_retried).toBe(1);
    const all = await q.list();
    expect(all[0].status).toBe('pending');
    expect(all[0].last_error).toBe('network down');
    expect(all[0].retry_count).toBe(1);
  });

  test('FIFO drain order', async () => {
    let t = new Date('2026-05-21T10:00:00Z').getTime();
    const q = new InMemoryOfflineQueue(() => new Date(t));
    await q.enqueue(baseAction({ idempotency_key: '1' }));
    t += 1000;
    await q.enqueue(baseAction({ idempotency_key: '2' }));
    t += 1000;
    await q.enqueue(baseAction({ idempotency_key: '3' }));
    const seen: string[] = [];
    const dispatcher: SyncDispatcher = async (a) => {
      seen.push(a.idempotency_key);
      return true;
    };
    const runner = new SyncRunner({ queue: q, dispatcher });
    await runner.drain();
    expect(seen).toEqual(['1', '2', '3']);
  });

  test('onAttempt hook fires per action with outcome', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    await q.enqueue(baseAction({ idempotency_key: 'b' }));
    const observed: { key: string; outcome: string }[] = [];
    const dispatcher: SyncDispatcher = async (a) => a.idempotency_key === 'a';
    const runner = new SyncRunner({
      queue: q,
      dispatcher,
      onAttempt: (action, outcome) => {
        observed.push({ key: action.idempotency_key, outcome });
      },
    });
    await runner.drain();
    expect(observed).toEqual([
      { key: 'a', outcome: 'success' },
      { key: 'b', outcome: 'retry' },
    ]);
  });

  test('backoffMs grows exponentially with retry_count', () => {
    const runner = new SyncRunner({
      queue: new InMemoryOfflineQueue(),
      dispatcher: async () => true,
      baseDelayMs: 1000,
    });
    expect(runner.backoffMs(0)).toBe(1000);
    expect(runner.backoffMs(1)).toBe(2000);
    expect(runner.backoffMs(2)).toBe(4000);
    expect(runner.backoffMs(3)).toBe(8000);
  });

  test('only drains pending — succeeded + failed_permanent skipped', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    await q.enqueue(baseAction({ idempotency_key: 'b' }));
    await q.enqueue(baseAction({ idempotency_key: 'c' }));
    await q.update('a', { status: 'succeeded' });
    await q.update('b', { status: 'failed_permanent' });
    let count = 0;
    const dispatcher: SyncDispatcher = async () => {
      count++;
      return true;
    };
    const runner = new SyncRunner({ queue: q, dispatcher });
    const report = await runner.drain();
    expect(count).toBe(1);
    expect(report.total_attempted).toBe(1);
  });

  test('last_attempt_at stamped on each attempt', async () => {
    const q = new InMemoryOfflineQueue();
    await q.enqueue(baseAction({ idempotency_key: 'a' }));
    const fixedTime = new Date('2026-05-21T18:00:00.000Z');
    const dispatcher: SyncDispatcher = async () => false;
    const runner = new SyncRunner({
      queue: q,
      dispatcher,
      clock: () => fixedTime,
    });
    await runner.drain();
    const all = await q.list();
    expect(all[0].last_attempt_at).toBe(fixedTime.toISOString());
  });
});

// ─── buildIdempotencyKey ─────────────────────────────────────────────

describe('buildIdempotencyKey', () => {
  test('deterministic across calls with same inputs', () => {
    const k1 = buildIdempotencyKey('alert.ack', 'a-1', 'ravi', '2026-05-21T12:00:00Z');
    const k2 = buildIdempotencyKey('alert.ack', 'a-1', 'ravi', '2026-05-21T12:00:00Z');
    expect(k1).toBe(k2);
  });

  test('different actions yield different keys', () => {
    const k1 = buildIdempotencyKey('alert.ack', 'a-1', 'ravi', '2026-05-21T12:00:00Z');
    const k2 = buildIdempotencyKey('alert.unack', 'a-1', 'ravi', '2026-05-21T12:00:00Z');
    expect(k1).not.toBe(k2);
  });

  test('truncated to 64 chars max', () => {
    const k = buildIdempotencyKey(
      'investigation.note',
      'really-long-investigation-id-that-runs-on',
      'operator.username.long',
      '2026-05-21T12:00:00.000Z',
    );
    expect(k.length).toBeLessThanOrEqual(64);
  });
});
