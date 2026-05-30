// web/src/lib/useCan.ts
//
// Enterprise Permission Matrix — `useCan(module, action)` hook.
//
// Reads the caller's resolved permission grid from
// `/v1/rbac/me/permissions` (cached via react-query) and returns a
// boolean for the requested (module, action) cell.
//
// COMPOSITION with existing role gates: pages keep their existing
// `me?.roles.includes('admin')` checks; this hook layers richer UI
// gating on top. Admin / super_admin always pass (matches the BFF
// middleware's `alwaysAllowRoles` fast-path) so any page that doesn't
// yet have explicit grants doesn't suddenly blank out on admins.
//
// Usage:
//   const canExport = useCan('reports', 'export');
//   return canExport ? <ExportButton /> : null;

import { useQuery } from '@tanstack/react-query';
import { api, type RbacAction, type RbacRoleGrid } from './api';
import { useAuth } from '@/store/auth';

const ADMIN_BYPASS_ROLES = new Set(['admin', 'super_admin']);

/** Returns true iff the current viewer has (module, action) granted.
 *  While the matrix is loading the hook is conservatively FALSE for
 *  non-admins so destructive buttons don't briefly flash, and TRUE for
 *  admins (no surprise blanking).
 */
export function useCan(module: string, action: RbacAction): boolean {
  const me = useAuth((s) => s.user);
  const roles = me?.roles ?? [];
  const isAdmin = roles.some((r) => ADMIN_BYPASS_ROLES.has(r));

  const q = useQuery({
    queryKey: ['rbac-me'],
    queryFn: () => api.rbacMePermissions(),
    enabled: !!me && !isAdmin, // admins skip the fetch
    staleTime: 60_000,
  });

  if (isAdmin) return true;
  if (!me) return false;
  if (!q.data) return false; // loading → conservative deny
  return q.data.permissions?.[module]?.[action] === true;
}

/** Convenience — read the full grid for the current viewer.
 *  Returns null when not authenticated or while loading. */
export function useMyPermissions(): RbacRoleGrid | null {
  const me = useAuth((s) => s.user);
  const q = useQuery({
    queryKey: ['rbac-me'],
    queryFn: () => api.rbacMePermissions(),
    enabled: !!me,
    staleTime: 60_000,
  });
  return q.data ?? null;
}
