// services/bff/src/admin/role_access.ts
//
// Role → module-permission map for the override resolver.
//
// The user manual (BAC §3.1.7.1) describes a `role_menu_mapping` table.
// In this codebase the role→op mapping lives at infra/rbac/matrix.json
// and the SPA derives menu visibility from those ops. To keep the
// override resolver pure (no JSON-file IO at call time) we transcribe
// the role→module mapping here as a typed constant.
//
// When/if a real role_menu_mapping table lands, swap getRoleAccess()
// for a SELECT-driven implementation; the resolver doesn't change.

import type {
  EffectiveAccessRow,
  ModulePath,
  PermissionType,
} from './types';

/** Roles known to the system today (mirrors infra/rbac/matrix.json). */
export type Role =
  | 'admin'
  | 'supervisor'
  | 'risk_analyst'
  | 'collection_officer'
  | 'field_officer';

type RoleAcl = Partial<Record<ModulePath, PermissionType[]>>;

const ADMIN_ACL: RoleAcl = {
  'dashboard': ['VIEW'],
  'alerts': ['VIEW', 'EDIT', 'APPROVE'],
  'alerts.detail': ['VIEW', 'EDIT'],
  'customers': ['VIEW'],
  'customers.detail': ['VIEW'],
  'rules': ['VIEW', 'EDIT', 'APPROVE', 'FULL'],
  'rules.detail': ['VIEW', 'EDIT', 'APPROVE', 'FULL'],
  'rules.builder': ['VIEW', 'EDIT', 'APPROVE'],
  'rules.ews': ['VIEW', 'EDIT', 'APPROVE'],
  'cases': ['VIEW', 'EDIT', 'APPROVE'],
  'cases.detail': ['VIEW', 'EDIT', 'APPROVE'],
  'cases.cms': ['VIEW', 'EDIT', 'APPROVE'],
  'cases.cms.detail': ['VIEW', 'EDIT', 'APPROVE'],
  'scenarios': ['VIEW', 'EDIT'],
  'scenarios.detail': ['VIEW', 'EDIT'],
  'reports': ['VIEW'],
  'reports.snapshot': ['VIEW'],
  'reports.alerts': ['VIEW'],
  'reports.cases': ['VIEW'],
  'reports.rbi': ['VIEW'],
  'integrations.health': ['VIEW'],
  'admin.users': ['VIEW', 'EDIT', 'FULL'],
  'admin.audit-log': ['VIEW'],
  'admin.integrations': ['VIEW', 'EDIT'],
  'admin.webhooks': ['VIEW', 'EDIT', 'FULL'],
  'admin.tenants': ['VIEW', 'EDIT', 'FULL'],
  'admin.user-access-override': ['VIEW', 'EDIT', 'APPROVE', 'FULL'],
  'profile.sessions': ['VIEW', 'EDIT'],
  'profile.activity': ['VIEW'],
};

const SUPERVISOR_ACL: RoleAcl = {
  'dashboard': ['VIEW'],
  'alerts': ['VIEW', 'EDIT', 'APPROVE'],
  'alerts.detail': ['VIEW', 'EDIT'],
  'customers': ['VIEW'],
  'customers.detail': ['VIEW'],
  'rules': ['VIEW', 'APPROVE'],
  'rules.detail': ['VIEW', 'APPROVE'],
  'cases': ['VIEW', 'EDIT', 'APPROVE'],
  'cases.detail': ['VIEW', 'EDIT', 'APPROVE'],
  'cases.cms': ['VIEW', 'EDIT', 'APPROVE'],
  'cases.cms.detail': ['VIEW', 'EDIT', 'APPROVE'],
  'scenarios': ['VIEW'],
  'scenarios.detail': ['VIEW'],
  'reports': ['VIEW'],
  'reports.snapshot': ['VIEW'],
  'reports.alerts': ['VIEW'],
  'reports.cases': ['VIEW'],
  'integrations.health': ['VIEW'],
  'admin.audit-log': ['VIEW'],
  'admin.user-access-override': ['VIEW'],
  'profile.sessions': ['VIEW', 'EDIT'],
  'profile.activity': ['VIEW'],
};

const RISK_ANALYST_ACL: RoleAcl = {
  'dashboard': ['VIEW'],
  'alerts': ['VIEW', 'EDIT'],
  'alerts.detail': ['VIEW', 'EDIT'],
  'customers': ['VIEW'],
  'customers.detail': ['VIEW'],
  'rules': ['VIEW', 'EDIT'],
  'rules.detail': ['VIEW', 'EDIT'],
  'rules.builder': ['VIEW', 'EDIT'],
  'rules.ews': ['VIEW', 'EDIT'],
  'cases': ['VIEW', 'EDIT'],
  'cases.detail': ['VIEW', 'EDIT'],
  'cases.cms': ['VIEW', 'EDIT'],
  'cases.cms.detail': ['VIEW', 'EDIT'],
  'scenarios': ['VIEW', 'EDIT'],
  'scenarios.detail': ['VIEW', 'EDIT'],
  'reports': ['VIEW'],
  'reports.snapshot': ['VIEW'],
  'reports.alerts': ['VIEW'],
  'reports.cases': ['VIEW'],
  'profile.sessions': ['VIEW', 'EDIT'],
  'profile.activity': ['VIEW'],
};

const COLLECTION_OFFICER_ACL: RoleAcl = {
  'dashboard': ['VIEW'],
  'alerts': ['VIEW'],
  'alerts.detail': ['VIEW'],
  'cases': ['VIEW', 'EDIT'],
  'cases.detail': ['VIEW', 'EDIT'],
  'cases.cms': ['VIEW', 'EDIT'],
  'cases.cms.detail': ['VIEW', 'EDIT'],
  'profile.sessions': ['VIEW', 'EDIT'],
  'profile.activity': ['VIEW'],
};

const FIELD_OFFICER_ACL: RoleAcl = {
  'dashboard': ['VIEW'],
  'alerts': ['VIEW'],
  'cases': ['VIEW', 'EDIT'],
  'cases.detail': ['VIEW', 'EDIT'],
  'profile.sessions': ['VIEW', 'EDIT'],
  'profile.activity': ['VIEW'],
};

const ROLE_ACLS: Record<Role, RoleAcl> = {
  admin: ADMIN_ACL,
  supervisor: SUPERVISOR_ACL,
  risk_analyst: RISK_ANALYST_ACL,
  collection_officer: COLLECTION_OFFICER_ACL,
  field_officer: FIELD_OFFICER_ACL,
};

function isRole(s: string): s is Role {
  return s in ROLE_ACLS;
}

/**
 * Pure helper: union the ACLs of all roles a user holds and emit
 * an EffectiveAccessRow per module_path. Permissions inside each row
 * are stable-sorted so equality comparisons in tests are deterministic.
 */
export function getRoleAccess(roles: string[]): {
  modules: EffectiveAccessRow[];
  /** Roles that were unknown to the matrix — surfaced so the SPA
   *  can warn an admin about a stale role assignment. */
  unknown_roles: string[];
} {
  const merged = new Map<ModulePath, Set<PermissionType>>();
  const unknown: string[] = [];
  for (const r of roles) {
    if (!isRole(r)) {
      unknown.push(r);
      continue;
    }
    const acl = ROLE_ACLS[r];
    for (const path of Object.keys(acl) as ModulePath[]) {
      const perms = acl[path] ?? [];
      const cur = merged.get(path) ?? new Set<PermissionType>();
      for (const p of perms) cur.add(p);
      merged.set(path, cur);
    }
  }

  const ORDER: PermissionType[] = ['VIEW', 'EDIT', 'APPROVE', 'FULL'];
  const modules: EffectiveAccessRow[] = [];
  for (const [path, perms] of merged) {
    modules.push({
      module_path: path,
      permissions: ORDER.filter((p) => perms.has(p)),
      source: 'role',
    });
  }
  modules.sort((a, b) => a.module_path.localeCompare(b.module_path));
  return { modules, unknown_roles: unknown };
}
