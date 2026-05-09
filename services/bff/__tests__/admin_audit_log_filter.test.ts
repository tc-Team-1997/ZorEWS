// services/bff/__tests__/admin_audit_log_filter.test.ts
//
// Focused coverage for the entity_type filter on listAuditLog().
// The audit log is now multi-source: user_access_override (UAO),
// report_export (BAC §3.1.8 cases-detail), and ews_rule_version
// (RP-1 revert). The new filter lets admins narrow by source.

import {
  InMemoryUserAccessOverrideStore,
  type ActorContext,
} from '../src/admin/user_access_override_store';
import type { CreateOverrideInput } from '../src/admin/types';

const NOW = new Date('2026-05-09T12:00:00.000Z');
const ACTOR: ActorContext = {
  actor_id: 'u-admin',
  actor_role: 'admin',
};

function makeOverrideInput(over: Partial<CreateOverrideInput> = {}): CreateOverrideInput {
  return {
    user_id: over.user_id ?? 'u-002',
    module_paths: over.module_paths ?? ['admin.audit-log'],
    override_type: over.override_type ?? 'GRANT',
    permission_type: over.permission_type ?? 'VIEW',
    effective_from: over.effective_from ?? '2026-05-01T00:00:00Z',
    effective_till: over.effective_till ?? null,
    reason: over.reason ?? 'Q2 audit support',
    requires_approval: over.requires_approval ?? false,
  };
}

describe('listAuditLog — entity_type filter', () => {
  test('no entity_type filter returns every entry', async () => {
    const store = new InMemoryUserAccessOverrideStore();
    await store.create('BIL', makeOverrideInput(), ACTOR, NOW);
    await store.create('BIL', makeOverrideInput({ user_id: 'u-003' }), ACTOR, NOW);
    const r = await store.listAuditLog('BIL', {});
    expect(r.total).toBe(2);
    expect(r.items.every((i) => i.entity_type === 'user_access_override')).toBe(true);
  });

  test('entity_type=user_access_override matches the existing rows', async () => {
    const store = new InMemoryUserAccessOverrideStore();
    await store.create('BIL', makeOverrideInput(), ACTOR, NOW);
    const r = await store.listAuditLog('BIL', { entity_type: 'user_access_override' });
    expect(r.total).toBe(1);
    expect(r.items[0].entity_type).toBe('user_access_override');
  });

  test('entity_type=ews_rule_version returns empty when no revert rows', async () => {
    const store = new InMemoryUserAccessOverrideStore();
    await store.create('BIL', makeOverrideInput(), ACTOR, NOW);
    const r = await store.listAuditLog('BIL', { entity_type: 'ews_rule_version' });
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });

  test('entity_type=report_export returns empty when no exports recorded', async () => {
    const store = new InMemoryUserAccessOverrideStore();
    await store.create('BIL', makeOverrideInput(), ACTOR, NOW);
    const r = await store.listAuditLog('BIL', { entity_type: 'report_export' });
    expect(r.total).toBe(0);
  });

  test('combines with actor_id + entity_id filters', async () => {
    const store = new InMemoryUserAccessOverrideStore();
    // requires_approval=true → row lands in PENDING_APPROVAL so update() works
    const created = await store.create(
      'BIL',
      makeOverrideInput({ user_id: 'u-002', requires_approval: true }),
      ACTOR,
      NOW,
    );
    const overrideId = created[0].override_id;
    await store.update('BIL', overrideId, { reason: 'extended' }, ACTOR, NOW);
    const r = await store.listAuditLog('BIL', {
      entity_type: 'user_access_override',
      entity_id: overrideId,
      actor_id: 'u-admin',
    });
    // Both create + update for the same override
    expect(r.total).toBeGreaterThanOrEqual(2);
    for (const item of r.items) {
      expect(item.entity_type).toBe('user_access_override');
      expect(item.entity_id).toBe(overrideId);
      expect(item.actor_id).toBe('u-admin');
    }
  });

  test('the AdminAuditEntityType union is the discriminator the route validates against', () => {
    // Compile-time sanity check that the union still has all 3 members.
    // If anyone narrows it back, this assignment fails to compile.
    const types: import('../src/admin/types').AdminAuditEntityType[] = [
      'user_access_override',
      'report_export',
      'ews_rule_version',
    ];
    expect(types).toHaveLength(3);
  });
});
