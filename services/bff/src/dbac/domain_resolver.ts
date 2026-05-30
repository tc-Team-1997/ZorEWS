// services/bff/src/dbac/domain_resolver.ts
//
// Domain Based Access Control (DBAC) — pure resolver.
//
// Resolves a user's effective domain ('banking' | 'insurance' | null)
// using a 3-tier precedence:
//   1. user.domain explicit  → wins (per-user pin from 050 schema)
//   2. tenant.vertical        → fallback (T4.24 Phase 1)
//   3. null                   → operator hasn't been scoped yet
//
// Super-admins (role 'admin' or 'super_admin') are returned a SPECIAL
// 'both' sentinel so SPA + middleware can render / accept everything.
//
// 100% pure — no I/O, no req/res, no env. Composable with the
// existing tenant middleware + RBAC matrix.

export type DomainScope = 'banking' | 'insurance' | 'both' | null;

/** Canonical closed enum used by the DBAC layer. */
export const DBAC_DOMAINS = ['banking', 'insurance'] as const;
export type DbacDomain = (typeof DBAC_DOMAINS)[number];

/** Super-admin role ids that bypass the domain gate.
 *  Mirrors the alwaysAllow set in permission_middleware.ts. */
export const DBAC_SUPER_ADMIN_ROLES = new Set<string>(['admin', 'super_admin']);

export interface DbacUserInput {
  /** Per-user pin (NULL means "inherit from tenant"). */
  domain?: DomainScope;
  /** Backing app_iam.users.role value. */
  role?: string | string[];
}

export interface DbacTenantInput {
  /** app_iam.tenants.vertical — 'banking' | 'insurance'. */
  vertical?: DbacDomain | 'both' | null;
}

export function isDbacDomain(s: unknown): s is DbacDomain {
  return s === 'banking' || s === 'insurance';
}

/** True for the super-admin bypass roles. */
export function isSuperAdminRole(role: string | string[] | undefined): boolean {
  if (!role) return false;
  const list = Array.isArray(role) ? role : [role];
  return list.some((r) => DBAC_SUPER_ADMIN_ROLES.has(r));
}

/** Pure resolver — see file header for precedence rules. */
export function resolveEffectiveDomain(
  user: DbacUserInput | null | undefined,
  tenant: DbacTenantInput | null | undefined,
): DomainScope {
  if (user && isSuperAdminRole(user.role)) return 'both';

  // 1. User pin wins.
  if (user?.domain && (user.domain === 'banking' || user.domain === 'insurance' || user.domain === 'both')) {
    return user.domain;
  }

  // 2. Fall back to tenant vertical.
  const v = tenant?.vertical;
  if (v === 'banking' || v === 'insurance') return v;
  if (v === 'both') return 'both';

  return null;
}

/** True iff the user is permitted to access a route gated to `target` domain. */
export function canAccessDomain(effective: DomainScope, target: DbacDomain): boolean {
  if (effective === 'both') return true;
  if (effective === null) return false;
  return effective === target;
}
