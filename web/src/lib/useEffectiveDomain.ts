// web/src/lib/useEffectiveDomain.ts
//
// Domain Based Access Control (DBAC) — useEffectiveDomain() hook.
//
// Reads /v1/dbac/me (cached via react-query) and returns the BFF-resolved
// effective domain: 'banking' | 'insurance' | 'both' | null.
//
// COMPOSITION:
//   • Existing useDomain() (web/src/lib/useOnboardingContext.ts) reads
//     from the login form / store and drives the sidebar today. It is
//     UNTOUCHED — the new hook is OPT-IN for pages/components that want
//     the canonical BFF answer (e.g. when the user has been pinned via
//     app_iam.users.domain that overrides their tenant's vertical).
//   • Existing RequireDomain route guard reads useDomain() — also
//     UNTOUCHED. This hook is for components, not router-level checks.
//
// Convenience helpers:
//   useCanSeeDomain(target)   → boolean for a single banking/insurance
//   useIsSuperAdminDomain()   → effective === 'both'

import { useQuery } from '@tanstack/react-query';
import { api, type DbacEffectiveDomain, type DbacMeResponse } from './api';
import { useAuth } from '@/store/auth';

const BYPASS_ROLES = new Set(['admin', 'super_admin']);

/** Returns the BFF-resolved effective domain or null while loading.
 *  Admins (admin / super_admin) short-circuit to 'both' without
 *  hitting the network — matches the BFF middleware bypass. */
export function useEffectiveDomain(): DbacEffectiveDomain {
  const me = useAuth((s) => s.user);
  const roles = me?.roles ?? [];
  const isAdmin = roles.some((r) => BYPASS_ROLES.has(r));

  const q = useQuery({
    queryKey: ['dbac-me'],
    queryFn: () => api.dbacMe(),
    enabled: !!me && !isAdmin,
    staleTime: 60_000,
  });

  if (isAdmin) return 'both';
  if (!me) return null;
  if (!q.data) return null;
  return q.data.effective_domain;
}

/** True iff the caller may see a target domain. Composes with the
 *  super-admin bypass. */
export function useCanSeeDomain(target: 'banking' | 'insurance'): boolean {
  const effective = useEffectiveDomain();
  if (effective === 'both') return true;
  if (effective === null) return false;
  return effective === target;
}

/** Returns true iff the BFF resolved to 'both' (super-admin / multi-vertical
 *  tenant). Useful for rendering a "switch domain" picker in the header. */
export function useIsSuperAdminDomain(): boolean {
  return useEffectiveDomain() === 'both';
}

/** Full DBAC response when the caller wants to inspect inputs as well
 *  (e.g. an admin debug panel). */
export function useDbacContext(): DbacMeResponse | null {
  const me = useAuth((s) => s.user);
  const q = useQuery({
    queryKey: ['dbac-me'],
    queryFn: () => api.dbacMe(),
    enabled: !!me,
    staleTime: 60_000,
  });
  return q.data ?? null;
}
