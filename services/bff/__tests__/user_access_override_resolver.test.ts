/* eslint-disable @typescript-eslint/no-explicit-any */
// Tests for the pure effective-access resolver.
// Pattern: hand-built `UserAccessOverride` rows + role list → assert
// the merged map. No DB, no IO, no clock.

import { getEffectiveUserAccess } from '../src/admin/user_access_override_resolver';
import type { UserAccessOverride } from '../src/admin/types';

const NOW = new Date('2026-05-07T12:00:00Z');

function override(over: Partial<UserAccessOverride> = {}): UserAccessOverride {
  return {
    override_id: over.override_id ?? 'ov-1',
    tenant_id: over.tenant_id ?? 'BANK_DEMO',
    user_id: over.user_id ?? 'u-002',
    module_path: over.module_path ?? 'admin.audit-log',
    override_type: over.override_type ?? 'GRANT',
    permission_type: over.permission_type ?? 'VIEW',
    effective_from: over.effective_from ?? '2026-05-01T00:00:00Z',
    effective_till: over.effective_till === undefined ? null : over.effective_till,
    reason: over.reason ?? 'audit support for Q2',
    requires_approval: over.requires_approval ?? true,
    status: over.status ?? 'ACTIVE',
    created_by: over.created_by ?? 'alice.admin',
    approved_by: over.approved_by ?? 'sue.super',
    rejected_by: over.rejected_by ?? null,
    revoked_by: over.revoked_by ?? null,
    rejection_reason: over.rejection_reason ?? null,
    revocation_reason: over.revocation_reason ?? null,
    approval_note: over.approval_note ?? null,
    created_at: over.created_at ?? '2026-05-01T08:00:00Z',
    updated_at: over.updated_at ?? '2026-05-01T08:00:00Z',
    approved_at: over.approved_at ?? '2026-05-01T08:30:00Z',
    rejected_at: over.rejected_at ?? null,
    revoked_at: over.revoked_at ?? null,
  };
}

describe('getEffectiveUserAccess', () => {
  // ── role-only baselines ───────────────────────────────────────────

  it('returns role ACL with no overrides', () => {
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [], NOW);
    expect(eff.role_access.roles).toEqual(['risk_analyst']);
    expect(eff.overrides_applied).toHaveLength(0);
    // risk_analyst has alerts.VIEW + EDIT
    const alerts = eff.effective.find((r) => r.module_path === 'alerts');
    expect(alerts?.permissions).toEqual(['VIEW', 'EDIT']);
    expect(alerts?.source).toBe('role');
  });

  it('unions ACLs across multiple roles', () => {
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst', 'supervisor'], [], NOW);
    // supervisor adds APPROVE on alerts → union
    const alerts = eff.effective.find((r) => r.module_path === 'alerts');
    expect(alerts?.permissions).toEqual(['VIEW', 'EDIT', 'APPROVE']);
  });

  it('output rows are sorted by module_path', () => {
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [], NOW);
    const paths = eff.effective.map((r) => r.module_path);
    expect([...paths].sort()).toEqual(paths);
  });

  it('permissions inside a row are stable-sorted (VIEW < EDIT < APPROVE < FULL)', () => {
    const eff = getEffectiveUserAccess('u-002', ['admin'], [], NOW);
    const rules = eff.effective.find((r) => r.module_path === 'rules');
    expect(rules?.permissions).toEqual(['VIEW', 'EDIT', 'APPROVE', 'FULL']);
  });

  // ── GRANT semantics ───────────────────────────────────────────────

  it('GRANT adds a permission to a path the role already had (source = role+override)', () => {
    const grant = override({
      module_path: 'alerts',
      override_type: 'GRANT',
      permission_type: 'APPROVE',
    });
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [grant], NOW);
    const alerts = eff.effective.find((r) => r.module_path === 'alerts');
    expect(alerts?.permissions).toEqual(['VIEW', 'EDIT', 'APPROVE']);
    expect(alerts?.source).toBe(`role,override:${grant.override_id}`);
  });

  it('GRANT adds an entirely new module path (source = override only)', () => {
    const grant = override({
      module_path: 'admin.audit-log',
      override_type: 'GRANT',
      permission_type: 'VIEW',
    });
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [grant], NOW);
    const audit = eff.effective.find((r) => r.module_path === 'admin.audit-log');
    expect(audit?.permissions).toEqual(['VIEW']);
    expect(audit?.source).toBe(`override:${grant.override_id}`);
  });

  // ── REVOKE semantics ──────────────────────────────────────────────

  it('REVOKE removes a single permission from a role-granted path', () => {
    const rev = override({
      override_id: 'ov-rev',
      module_path: 'alerts',
      override_type: 'REVOKE',
      permission_type: 'EDIT',
    });
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [rev], NOW);
    const alerts = eff.effective.find((r) => r.module_path === 'alerts');
    expect(alerts?.permissions).toEqual(['VIEW']);
  });

  it('REVOKE on FULL clears the entire path', () => {
    const rev = override({
      override_id: 'ov-rev-full',
      module_path: 'admin.users',
      override_type: 'REVOKE',
      permission_type: 'FULL',
    });
    const eff = getEffectiveUserAccess('u-002', ['admin'], [rev], NOW);
    expect(eff.effective.find((r) => r.module_path === 'admin.users')).toBeUndefined();
  });

  // ── temporal ──────────────────────────────────────────────────────

  it('skips overrides whose effective_from is in the future', () => {
    const future = override({
      effective_from: '2030-01-01T00:00:00Z',
      module_path: 'admin.audit-log',
    });
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [future], NOW);
    expect(eff.effective.find((r) => r.module_path === 'admin.audit-log')).toBeUndefined();
    expect(eff.overrides_applied).toHaveLength(0);
  });

  it('skips overrides past their effective_till', () => {
    const expired = override({
      effective_from: '2026-04-01T00:00:00Z',
      effective_till: '2026-04-30T00:00:00Z',
      module_path: 'admin.audit-log',
    });
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [expired], NOW);
    expect(eff.effective.find((r) => r.module_path === 'admin.audit-log')).toBeUndefined();
  });

  it('honours effective_till null (permanent override)', () => {
    const perm = override({
      effective_till: null,
      module_path: 'admin.audit-log',
    });
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [perm], NOW);
    expect(eff.effective.find((r) => r.module_path === 'admin.audit-log')?.permissions).toEqual([
      'VIEW',
    ]);
  });

  // ── status filtering ─────────────────────────────────────────────

  it('only ACTIVE overrides apply (PENDING_APPROVAL ignored)', () => {
    const pending = override({ status: 'PENDING_APPROVAL', approved_by: null, approved_at: null });
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [pending], NOW);
    expect(eff.overrides_applied).toHaveLength(0);
  });

  it.each(['REJECTED', 'REVOKED', 'EXPIRED'] as const)('ignores %s overrides', (status) => {
    const dead = override({ status });
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [dead], NOW);
    expect(eff.overrides_applied).toHaveLength(0);
  });

  // ── ordering ─────────────────────────────────────────────────────

  it('applies overrides in created_at ASC order so a newer GRANT can re-add a REVOKED permission', () => {
    const earlier = override({
      override_id: 'ov-rev',
      created_at: '2026-04-01T00:00:00Z',
      module_path: 'alerts',
      override_type: 'REVOKE',
      permission_type: 'EDIT',
    });
    const later = override({
      override_id: 'ov-grant',
      created_at: '2026-05-01T00:00:00Z',
      module_path: 'alerts',
      override_type: 'GRANT',
      permission_type: 'EDIT',
    });
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst'], [later, earlier], NOW);
    const alerts = eff.effective.find((r) => r.module_path === 'alerts');
    expect(alerts?.permissions).toEqual(['VIEW', 'EDIT']);
    expect(alerts?.source.split(',').sort()).toEqual(
      ['override:ov-grant', 'override:ov-rev', 'role'].sort(),
    );
  });

  // ── unknown roles ────────────────────────────────────────────────

  it('emits unknown_roles in the role_access section but does not crash', () => {
    const eff = getEffectiveUserAccess('u-002', ['risk_analyst', 'totally_not_a_role'], [], NOW);
    expect(eff.role_access.roles).toContain('totally_not_a_role');
    // The known role still produces output
    expect(eff.effective.find((r) => r.module_path === 'alerts')).toBeDefined();
  });

  // ── purity / determinism ─────────────────────────────────────────

  it('is a pure function — same inputs produce identical output', () => {
    const ov = override();
    const a = getEffectiveUserAccess('u-002', ['risk_analyst'], [ov], NOW);
    const b = getEffectiveUserAccess('u-002', ['risk_analyst'], [ov], NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate its input arrays', () => {
    const ov = override();
    const overrides = [ov];
    const overridesSnap = JSON.parse(JSON.stringify(overrides));
    getEffectiveUserAccess('u-002', ['risk_analyst'], overrides, NOW);
    expect(overrides).toEqual(overridesSnap);
  });
});
