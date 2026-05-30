// services/bff/__tests__/custom_dashboard_recovery.test.ts
//
// Phase 9 T3 — Recovery Center adopter for custom_dashboard.
// Verifies the store-level restore method (called by the recovery adapter
// at runtime) keeps the same boolean-return contract as the existing
// webhook_subscription / saved_scenario adopters: true on clean re-insert,
// false on dashboard_id collision.

import {
  InMemoryCustomDashboardStore,
  type CustomDashboard,
} from '../src/custom_dashboards';

const NOW = new Date('2026-05-30T10:00:00Z');

function makeDashboard(tenant_id: string, dashboard_id: string): CustomDashboard {
  return {
    dashboard_id,
    tenant_id,
    name: `Dashboard ${dashboard_id}`,
    description: 'Phase 9 T3 round-trip fixture',
    widgets: [
      {
        widget_type: 'alerts_by_class',
        position: { row: 0, col: 0 },
        span: { rows: 4, cols: 6 },
        config: {},
      },
    ],
    created_by: 'alice.admin',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    version: 1,
  };
}

describe('InMemoryCustomDashboardStore.restore (Phase 9 T3 recovery adapter)', () => {
  it('re-inserts a payload after delete + returns true', () => {
    const store = new InMemoryCustomDashboardStore();
    const created = store.create(
      'BANK_DEMO',
      { name: 'My board', description: '', widgets: [
        { widget_type: 'alerts_by_class', position: { row: 0, col: 0 }, span: { rows: 4, cols: 6 }, config: {} },
      ] },
      'alice.admin',
      NOW,
    );
    // Snapshot before delete (the route does the same just before
    // calling recoveryStore.archive).
    const snapshot: CustomDashboard = JSON.parse(JSON.stringify(created));

    expect(store.delete('BANK_DEMO', created.dashboard_id)).toBe(true);
    expect(store.list('BANK_DEMO')).toHaveLength(0);

    expect(store.restore(snapshot)).toBe(true);
    const after = store.list('BANK_DEMO');
    expect(after).toHaveLength(1);
    expect(after[0]!.dashboard_id).toBe(created.dashboard_id);
    expect(after[0]!.name).toBe(created.name);
  });

  it('returns false when the same dashboard_id is already live (collision)', () => {
    const store = new InMemoryCustomDashboardStore();
    const dup = makeDashboard('BANK_DEMO', 'dsh-fixed-001');
    // First insert via restore (simulates a recovery-only path).
    expect(store.restore(dup)).toBe(true);
    // Second insert with the same id MUST fail — adapter will map to 409.
    expect(store.restore(dup)).toBe(false);
  });

  it('keeps tenant scoping: BIL restore does NOT collide with BANK_DEMO', () => {
    const store = new InMemoryCustomDashboardStore();
    expect(store.restore(makeDashboard('BANK_DEMO', 'dsh-shared'))).toBe(true);
    expect(store.restore(makeDashboard('BIL', 'dsh-shared'))).toBe(true); // different tenant
    expect(store.list('BANK_DEMO')).toHaveLength(1);
    expect(store.list('BIL')).toHaveLength(1);
  });

  it('deep-copies the payload on restore (caller mutation is safe)', () => {
    const store = new InMemoryCustomDashboardStore();
    const payload = makeDashboard('BANK_DEMO', 'dsh-mut');
    expect(store.restore(payload)).toBe(true);
    // Mutate the caller's payload AFTER restore — the stored copy must
    // be unaffected (clone() defensive copy contract).
    payload.name = 'caller-mutated';
    payload.widgets[0]!.config = { 'evil-key': 'evil-value' } as never;
    const stored = store.get('BANK_DEMO', 'dsh-mut');
    expect(stored!.name).toBe('Dashboard dsh-mut'); // original name
    expect(stored!.widgets[0]!.config).toEqual({});  // original config
  });
});
