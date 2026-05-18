// Unit tests for InMemoryRecoveryStore + adapter registry.
//
// PgRecoveryStore is exercised via the integration suite (gated on
// BFF_PG_URL) at recovery_store_pg.test.ts.

import { describe, expect, it, beforeEach } from '@jest/globals';
import {
  InMemoryRecoveryStore,
} from '../src/recovery/store';
import {
  registerRecoveryAdapter,
  getRecoveryAdapter,
  listRecoveryAdapters,
  invokeRestore,
  _resetRecoveryAdapters,
} from '../src/recovery/adapters';
import { RecoveryError, RestoreConflictError, type DeletedRecord } from '../src/recovery/types';

describe('InMemoryRecoveryStore.archive', () => {
  let store: InMemoryRecoveryStore;
  beforeEach(() => {
    store = new InMemoryRecoveryStore();
  });

  it('returns a recovery_id and persists the row', async () => {
    const id = await store.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-1',
      original_table: 'app_bff.webhook_subscriptions',
      payload: { id: 'wh-1', name: 'test' },
      deleted_by: 'alice.admin',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(10);
    const rec = await store.get('BANK_DEMO', id);
    expect(rec).toBeDefined();
    expect(rec!.entity_type).toBe('webhook_subscription');
    expect(rec!.original_id).toBe('wh-1');
    expect(rec!.deleted_by).toBe('alice.admin');
    expect(rec!.status).toBe('archived');
  });

  it('rejects missing required fields', async () => {
    await expect(
      store.archive({
        tenant_id: '',
        module: 'bff',
        entity_type: 'x',
        original_id: 'y',
        original_table: 'z',
        payload: {},
        deleted_by: 'who',
      }),
    ).rejects.toThrow(RecoveryError);
  });

  it('multiple archive calls for the same original_id are allowed (delete → restore → delete again)', async () => {
    const id1 = await store.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-1',
      original_table: 'app_bff.webhook_subscriptions',
      payload: { id: 'wh-1', v: 1 },
      deleted_by: 'alice',
    });
    const id2 = await store.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-1',
      original_table: 'app_bff.webhook_subscriptions',
      payload: { id: 'wh-1', v: 2 },
      deleted_by: 'alice',
    });
    expect(id1).not.toBe(id2);
    const r1 = await store.get('BANK_DEMO', id1);
    const r2 = await store.get('BANK_DEMO', id2);
    expect((r1!.payload as { v: number }).v).toBe(1);
    expect((r2!.payload as { v: number }).v).toBe(2);
  });
});

describe('InMemoryRecoveryStore.list', () => {
  let store: InMemoryRecoveryStore;
  beforeEach(async () => {
    store = new InMemoryRecoveryStore();
    await store.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-1',
      original_table: 'app_bff.webhook_subscriptions',
      payload: {},
      deleted_by: 'alice',
    });
    await store.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'saved_scenario',
      original_id: 's-1',
      original_table: 'app_scenario.saved_scenarios',
      payload: {},
      deleted_by: 'ravi',
    });
    await store.archive({
      tenant_id: 'BIL',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-2',
      original_table: 'app_bff.webhook_subscriptions',
      payload: {},
      deleted_by: 'bob',
    });
  });

  it('defaults to status=archived', async () => {
    const out = await store.list({ tenant_id: 'BANK_DEMO' });
    expect(out.total).toBe(2);
    expect(out.items.every((r) => r.status === 'archived')).toBe(true);
  });

  it('is tenant-scoped', async () => {
    const bank = await store.list({ tenant_id: 'BANK_DEMO' });
    const bil = await store.list({ tenant_id: 'BIL' });
    expect(bank.total).toBe(2);
    expect(bil.total).toBe(1);
    expect(bil.items[0].original_id).toBe('wh-2');
  });

  it('filters by module + entity_type', async () => {
    const out = await store.list({
      tenant_id: 'BANK_DEMO',
      entity_type: 'webhook_subscription',
    });
    expect(out.total).toBe(1);
    expect(out.items[0].original_id).toBe('wh-1');
  });

  it('sorts newest-first', async () => {
    const out = await store.list({ tenant_id: 'BANK_DEMO' });
    expect(out.items[0].deleted_at >= out.items[1].deleted_at).toBe(true);
  });

  it('paginates', async () => {
    const p1 = await store.list({ tenant_id: 'BANK_DEMO', page: 1, page_size: 1 });
    const p2 = await store.list({ tenant_id: 'BANK_DEMO', page: 2, page_size: 1 });
    expect(p1.items).toHaveLength(1);
    expect(p2.items).toHaveLength(1);
    expect(p1.items[0].recovery_id).not.toBe(p2.items[0].recovery_id);
  });
});

describe('InMemoryRecoveryStore.markRestored + markPurged', () => {
  let store: InMemoryRecoveryStore;
  let id: string;
  beforeEach(async () => {
    store = new InMemoryRecoveryStore();
    id = await store.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-1',
      original_table: 'app_bff.webhook_subscriptions',
      payload: {},
      deleted_by: 'alice',
    });
  });

  it('marks restored', async () => {
    const r = await store.markRestored('BANK_DEMO', id, 'admin');
    expect(r.status).toBe('restored');
    expect(r.restored_by).toBe('admin');
    expect(r.restored_at).not.toBeNull();
  });

  it('refuses to re-restore an already-restored record', async () => {
    await store.markRestored('BANK_DEMO', id, 'admin');
    await expect(store.markRestored('BANK_DEMO', id, 'admin')).rejects.toThrow(
      /already_restored/,
    );
  });

  it('refuses to purge an already-restored record', async () => {
    await store.markRestored('BANK_DEMO', id, 'admin');
    await expect(store.markPurged('BANK_DEMO', id, 'admin')).rejects.toThrow(
      /invalid_status_transition/,
    );
  });

  it('marks purged', async () => {
    const r = await store.markPurged('BANK_DEMO', id, 'admin');
    expect(r.status).toBe('purged');
    expect(r.purged_by).toBe('admin');
  });

  it('refuses to re-purge', async () => {
    await store.markPurged('BANK_DEMO', id, 'admin');
    await expect(store.markPurged('BANK_DEMO', id, 'admin')).rejects.toThrow(/already_purged/);
  });

  it('cross-tenant lookup throws unknown_record', async () => {
    await expect(store.markRestored('BIL', id, 'admin')).rejects.toThrow(/unknown_record/);
  });
});

describe('InMemoryRecoveryStore.stats', () => {
  it('counts by status / module / entity_type + tracks most_recent_at', async () => {
    const store = new InMemoryRecoveryStore();
    const id1 = await store.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-1',
      original_table: 't',
      payload: {},
      deleted_by: 'alice',
    });
    await store.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'saved_scenario',
      original_id: 's-1',
      original_table: 't',
      payload: {},
      deleted_by: 'ravi',
    });
    await store.markRestored('BANK_DEMO', id1, 'admin');

    const s = await store.stats('BANK_DEMO');
    expect(s.total).toBe(2);
    expect(s.by_status.archived).toBe(1);
    expect(s.by_status.restored).toBe(1);
    expect(s.by_status.purged).toBe(0);
    expect(s.by_module.bff).toBe(2);
    expect(s.by_entity_type.webhook_subscription).toBe(1);
    expect(s.by_entity_type.saved_scenario).toBe(1);
    expect(s.most_recent_at).not.toBeNull();
  });
});

describe('InMemoryRecoveryStore.purgeExpired', () => {
  it('removes only purged rows older than the cutoff', async () => {
    const store = new InMemoryRecoveryStore();
    const now = new Date('2026-05-20T12:00:00Z');
    const old = new Date('2026-04-01T00:00:00Z'); // 49 days back — past 30-day cutoff
    const recent = new Date('2026-05-15T00:00:00Z'); // 5 days back — inside cutoff
    // 3 records: archived (untouched), purged-old (should reclaim),
    // purged-recent (should stay).
    await store.archive(
      { tenant_id: 'BANK_DEMO', module: 'bff', entity_type: 'webhook_subscription', original_id: 'a', original_table: 't', payload: {}, deleted_by: 'alice' },
      old,
    );
    const purgeOldId = await store.archive(
      { tenant_id: 'BANK_DEMO', module: 'bff', entity_type: 'webhook_subscription', original_id: 'b', original_table: 't', payload: {}, deleted_by: 'alice' },
      old,
    );
    await store.markPurged('BANK_DEMO', purgeOldId, 'admin', old);
    const purgeRecentId = await store.archive(
      { tenant_id: 'BANK_DEMO', module: 'bff', entity_type: 'webhook_subscription', original_id: 'c', original_table: 't', payload: {}, deleted_by: 'alice' },
      recent,
    );
    await store.markPurged('BANK_DEMO', purgeRecentId, 'admin', recent);

    const result = await store.purgeExpired({ days: 30, now });
    expect(result.removed).toBe(1);
    expect(typeof result.cutoff).toBe('string');

    // The two survivors: archived + recently-purged
    const after = await store.list({ tenant_id: 'BANK_DEMO' });
    expect(after.items).toHaveLength(1); // only archived shows up under default 'archived' filter
    const purged = await store.list({ tenant_id: 'BANK_DEMO', status: 'purged' });
    expect(purged.items).toHaveLength(1); // only the recently-purged one survives
    expect(purged.items[0].original_id).toBe('c');
  });

  it('returns 0 when nothing qualifies', async () => {
    const store = new InMemoryRecoveryStore();
    const now = new Date('2026-05-20T12:00:00Z');
    await store.archive(
      { tenant_id: 'BANK_DEMO', module: 'bff', entity_type: 'webhook_subscription', original_id: 'a', original_table: 't', payload: {}, deleted_by: 'alice' },
      now,
    );
    const out = await store.purgeExpired({ days: 30, now });
    expect(out.removed).toBe(0);
  });

  it('honours tenant_id filter — does not reclaim other tenants', async () => {
    const store = new InMemoryRecoveryStore();
    const now = new Date('2026-05-20T12:00:00Z');
    const old = new Date('2026-04-01T00:00:00Z');
    const bankId = await store.archive(
      { tenant_id: 'BANK_DEMO', module: 'bff', entity_type: 'webhook_subscription', original_id: 'b1', original_table: 't', payload: {}, deleted_by: 'alice' },
      old,
    );
    const bilId = await store.archive(
      { tenant_id: 'BIL', module: 'bff', entity_type: 'webhook_subscription', original_id: 'b2', original_table: 't', payload: {}, deleted_by: 'bob' },
      old,
    );
    await store.markPurged('BANK_DEMO', bankId, 'admin', old);
    await store.markPurged('BIL', bilId, 'admin', old);

    const result = await store.purgeExpired({ tenant_id: 'BANK_DEMO', days: 30, now });
    expect(result.removed).toBe(1);
    // BIL's purged row is still around
    const bilPurged = await store.list({ tenant_id: 'BIL', status: 'purged' });
    expect(bilPurged.items).toHaveLength(1);
  });

  it('does not reclaim non-purged rows even if they\'re old', async () => {
    const store = new InMemoryRecoveryStore();
    const old = new Date('2026-04-01T00:00:00Z');
    const now = new Date('2026-05-20T12:00:00Z');
    // 49-day-old archived row (NEVER purged)
    await store.archive(
      { tenant_id: 'BANK_DEMO', module: 'bff', entity_type: 'webhook_subscription', original_id: 'a', original_table: 't', payload: {}, deleted_by: 'alice' },
      old,
    );
    const out = await store.purgeExpired({ days: 30, now });
    expect(out.removed).toBe(0);
  });

  it('days=0 means purge everything that\'s currently purged', async () => {
    const store = new InMemoryRecoveryStore();
    const now = new Date('2026-05-20T12:00:00Z');
    const id = await store.archive(
      { tenant_id: 'BANK_DEMO', module: 'bff', entity_type: 'webhook_subscription', original_id: 'a', original_table: 't', payload: {}, deleted_by: 'alice' },
      now,
    );
    await store.markPurged('BANK_DEMO', id, 'admin', now);
    const out = await store.purgeExpired({ days: 0, now });
    expect(out.removed).toBe(1);
  });
});

describe('recovery adapter registry', () => {
  beforeEach(() => _resetRecoveryAdapters());

  it('register + get + list', () => {
    registerRecoveryAdapter({
      entity_type: 'webhook_subscription',
      display_name: 'Webhook subscription',
      module: 'bff',
      original_table: 'app_bff.webhook_subscriptions',
      restore: () => {},
    });
    expect(getRecoveryAdapter('webhook_subscription')).toBeDefined();
    expect(listRecoveryAdapters()).toHaveLength(1);
  });

  it('throws on duplicate registration', () => {
    const a = {
      entity_type: 'x',
      display_name: 'x',
      module: 'bff' as const,
      original_table: 't',
      restore: () => {},
    };
    registerRecoveryAdapter(a);
    expect(() => registerRecoveryAdapter(a)).toThrow(/duplicate/);
  });

  it('invokeRestore dispatches to the registered adapter', async () => {
    let called = false;
    registerRecoveryAdapter({
      entity_type: 'webhook_subscription',
      display_name: 'x',
      module: 'bff',
      original_table: 't',
      restore: () => {
        called = true;
      },
    });
    await invokeRestore({ entity_type: 'webhook_subscription' } as DeletedRecord);
    expect(called).toBe(true);
  });

  it('invokeRestore surfaces no_adapter when entity_type is unknown', async () => {
    await expect(
      invokeRestore({ entity_type: 'unknown_thing' } as DeletedRecord),
    ).rejects.toThrow(/no_adapter/);
  });

  it('adapter that throws RestoreConflictError propagates correctly', async () => {
    registerRecoveryAdapter({
      entity_type: 'webhook_subscription',
      display_name: 'x',
      module: 'bff',
      original_table: 't',
      restore: () => {
        throw new RestoreConflictError('webhook_subscription', 'wh-1');
      },
    });
    await expect(
      invokeRestore({
        entity_type: 'webhook_subscription',
        original_id: 'wh-1',
      } as DeletedRecord),
    ).rejects.toThrow(/already exists/);
  });
});
