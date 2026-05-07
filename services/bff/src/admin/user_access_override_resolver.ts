// services/bff/src/admin/user_access_override_resolver.ts
//
// Pure resolver: given a user's roles + the set of overrides currently
// in force, compute the effective access map.
//
// Pure function — no IO. The PG fetch happens in the route handler;
// this file just merges role ACL with the override list. Tests pass
// hand-built inputs and assert against the merged output.

import { getRoleAccess } from './role_access';
import type {
  EffectiveAccess,
  EffectiveAccessRow,
  ModulePath,
  PermissionType,
  UserAccessOverride,
} from './types';

const PERMISSION_ORDER: PermissionType[] = ['VIEW', 'EDIT', 'APPROVE', 'FULL'];

/**
 * `getEffectiveUserAccess` — the merge function the user manual calls
 * for in §3.1.7.1.1: role-based access UNION grants MINUS revokes.
 *
 * Inputs:
 *   - userId: subject of the access check
 *   - roles: the user's role memberships (from app_iam.users.roles)
 *   - overrides: ALL overrides for the user (any status); the resolver
 *                filters to ones in force at `asOf`
 *   - asOf: time-travel point; default = now()
 *
 * Output: see EffectiveAccess in types.ts. The resolver also returns
 * `role_access` and `overrides_applied` so the SPA can render an
 * audit-style diff (this came from role X, this came from override Y).
 *
 * Determinism: output rows are sorted by module_path, permissions
 * inside each row are stable-sorted in the canonical order
 * (VIEW < EDIT < APPROVE < FULL). The resolver is a pure function of
 * its inputs.
 */
export function getEffectiveUserAccess(
  userId: string,
  roles: string[],
  overrides: UserAccessOverride[],
  asOf: Date = new Date(),
): EffectiveAccess {
  const roleAcl = getRoleAccess(roles);

  // Index role ACL by module_path for fast merge.
  const merged = new Map<ModulePath, Set<PermissionType>>();
  const sources = new Map<ModulePath, Set<string>>();

  for (const row of roleAcl.modules) {
    merged.set(row.module_path, new Set(row.permissions));
    sources.set(row.module_path, new Set(['role']));
  }

  // Filter to overrides that are currently in force at `asOf`.
  // Status === ACTIVE AND effective_from <= asOf < (effective_till ?? +∞)
  const asOfMs = asOf.getTime();
  const inForce: UserAccessOverride[] = [];
  for (const o of overrides) {
    if (o.status !== 'ACTIVE') continue;
    const fromMs = Date.parse(o.effective_from);
    if (!Number.isFinite(fromMs) || fromMs > asOfMs) continue;
    if (o.effective_till !== null) {
      const tillMs = Date.parse(o.effective_till);
      if (Number.isFinite(tillMs) && tillMs <= asOfMs) continue;
    }
    inForce.push(o);
  }

  // Apply overrides in deterministic order: by created_at asc so a
  // newer GRANT wins after an older REVOKE. (Same instant ties are
  // broken by override_id for stability across calls.)
  inForce.sort((a, b) => {
    const t = a.created_at.localeCompare(b.created_at);
    return t !== 0 ? t : a.override_id.localeCompare(b.override_id);
  });

  for (const o of inForce) {
    const cur = merged.get(o.module_path) ?? new Set<PermissionType>();
    const src = sources.get(o.module_path) ?? new Set<string>();
    if (o.override_type === 'GRANT') {
      cur.add(o.permission_type);
      src.add(`override:${o.override_id}`);
    } else {
      // REVOKE — remove the specific permission. If permission_type is
      // 'FULL' the override revokes everything for that module path.
      if (o.permission_type === 'FULL') {
        cur.clear();
      } else {
        cur.delete(o.permission_type);
      }
      src.add(`override:${o.override_id}`);
    }
    if (cur.size === 0) {
      merged.delete(o.module_path);
      sources.delete(o.module_path);
    } else {
      merged.set(o.module_path, cur);
      sources.set(o.module_path, src);
    }
  }

  const effective: EffectiveAccessRow[] = [];
  for (const [path, perms] of merged) {
    effective.push({
      module_path: path,
      permissions: PERMISSION_ORDER.filter((p) => perms.has(p)),
      // Source is 'role' if the path was untouched by any override;
      // 'role+override:id1,id2,...' if blended; 'override:id' if added
      // entirely by an override on a path the role didn't have.
      source: formatSource(sources.get(path) ?? new Set(['role'])),
    });
  }
  effective.sort((a, b) => a.module_path.localeCompare(b.module_path));

  return {
    user_id: userId,
    computed_at: asOf.toISOString(),
    role_access: { roles, modules: roleAcl.modules },
    overrides_applied: inForce,
    effective,
  };
}

function formatSource(srcs: Set<string>): string {
  if (srcs.size === 0) return 'role';
  if (srcs.size === 1) return [...srcs][0];
  // Stable order: 'role' first, then override:id ascending
  const arr = [...srcs].sort((a, b) => {
    if (a === 'role') return -1;
    if (b === 'role') return 1;
    return a.localeCompare(b);
  });
  return arr.join(',');
}
