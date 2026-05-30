// web/src/lib/useGovernance.ts
//
// Enterprise Tenant Governance — `useGovernance()` hook.
//
// Reads /v1/governance/me (cached via react-query) and returns the
// caller's full country / tenant / branch context. Composes with the
// existing useDomain() (login-store) + useEffectiveDomain() (BFF-DBAC)
// hooks without replacing them.

import { useQuery } from '@tanstack/react-query';
import { api, type GovernanceMeResponse } from './api';
import { useAuth } from '@/store/auth';

/** Full governance context for the current viewer. null while loading
 *  or unauthenticated. */
export function useGovernance(): GovernanceMeResponse | null {
  const me = useAuth((s) => s.user);
  const q = useQuery({
    queryKey: ['governance-me'],
    queryFn: () => api.governanceMe(),
    enabled: !!me,
    staleTime: 60_000,
  });
  return q.data ?? null;
}

/** True iff the user is pinned to a specific branch. Drives the
 *  "you must select a branch first" UX prompt + the branch-scoped
 *  data-filter chip on every list view. */
export function useBranchPin(): string | null {
  const gov = useGovernance();
  return gov?.branch_id ?? null;
}

/** True iff the caller may view a resource owned by `target_branch`.
 *  Super-admins (admin / super_admin role) always true.
 *  Branch-pinned users → only their pinned branch. Unpinned → true
 *  (permissive default mirrors the BFF requireBranchAccess
 *  non-strict mode). */
export function useCanAccessBranch(target_branch: string | null | undefined): boolean {
  const me = useAuth((s) => s.user);
  const roles = me?.roles ?? [];
  // Note: super_admin not yet in the SPA's backend Role union; admin
  // alone matches the existing convention used by useEffectiveDomain.
  const isAdmin = roles.some((r) => r === 'admin');
  const gov = useGovernance();
  if (isAdmin) return true;
  if (!gov?.branch_id) return true; // permissive default
  if (!target_branch) return true;
  return gov.branch_id === target_branch;
}
