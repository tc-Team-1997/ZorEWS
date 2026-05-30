// services/bff/src/governance/access_middleware.ts
//
// Branch governance — Express middleware enforcing branch-scoped access.
//
// COMPOSABLE with the existing stack:
//   requireTenant → requireRole → requireDomain → requireBranchAccess
//
// Resolves the user's branch pin from:
//   1. x-apex-user-branch header (test convention)
//   2. req.user.branch_id  (auth-svc JWT, when available)
// Falls back to "no branch pin" → middleware passes (no enforcement)
// unless `strict: true` is passed.
//
// Target branch extraction is route-defined — pass a function that
// pulls the branch_id from req.params or req.body. Super-admins
// (admin / super_admin) bypass the gate.

import type { NextFunction, Request, Response } from 'express';
import { wrapError, extractCtx, type ErrorPayload } from '../envelope';

const SUPER_ADMIN_ROLES = new Set(['admin', 'super_admin']);

export interface RequireBranchAccessDeps {
  /** Where the target branch_id lives on the request. */
  extractBranch: (req: Request) => string | undefined;
  /** When true, missing-pin denies. When false (default), missing-pin passes. */
  strict?: boolean;
  /** Test seam for the user pin. */
  getUserBranch?: (req: Request) => string | undefined;
  /** Test seam for the role check. */
  getRole?: (req: Request) => string | string[] | undefined;
  now?: () => Date;
}

function readUserBranch(req: Request): string | undefined {
  const h = req.header('x-apex-user-branch');
  if (h?.trim()) return h.trim();
  const u = (req as Request & { user?: { branch_id?: string } }).user;
  return u?.branch_id ?? undefined;
}

function readRole(req: Request): string | string[] | undefined {
  const h = req.header('x-apex-role');
  if (h) return h;
  const u = (req as Request & { user?: { role?: string; roles?: string[] } }).user;
  return u?.role ?? u?.roles;
}

function rolesIncludeSuperAdmin(role: string | string[] | undefined): boolean {
  if (!role) return false;
  const list = Array.isArray(role) ? role : [role];
  return list.some((r) => SUPER_ADMIN_ROLES.has(r));
}

export function requireBranchAccess(deps: RequireBranchAccessDeps) {
  if (typeof deps.extractBranch !== 'function') {
    throw new Error('requireBranchAccess: extractBranch is required');
  }
  const strict = deps.strict === true;
  const getUserBranch = deps.getUserBranch ?? readUserBranch;
  const getRole = deps.getRole ?? readRole;
  const now = deps.now ?? (() => new Date());

  return (req: Request, res: Response, next: NextFunction) => {
    const role = getRole(req);
    if (rolesIncludeSuperAdmin(role)) return next();

    const userBranch = getUserBranch(req);
    const targetBranch = deps.extractBranch(req);

    // Permissive default: routes pass when neither side has scope info.
    if (!userBranch && !strict) return next();

    if (strict && !userBranch) {
      const err: ErrorPayload = {
        code: 'EWS_403_branch_not_pinned',
        message: 'User is not pinned to a branch; access denied',
        severity: 'MEDIUM',
      };
      return res.status(403).json(wrapError(err, extractCtx(req, now)));
    }

    if (targetBranch && userBranch && targetBranch !== userBranch) {
      const err: ErrorPayload = {
        code: 'EWS_403_wrong_branch',
        message: 'This resource belongs to a different branch',
        severity: 'MEDIUM',
        detail: { user_branch: userBranch, target_branch: targetBranch },
      };
      return res.status(403).json(wrapError(err, extractCtx(req, now)));
    }
    return next();
  };
}

/** Convenience extractors for common cases. */
export const extractBranchFromParam = (paramName: string) => (req: Request) =>
  (req.params as Record<string, string | undefined>)[paramName];
export const extractBranchFromQuery = (queryName: string) => (req: Request) =>
  (req.query as Record<string, string | undefined>)[queryName];
export const extractBranchFromBody = (bodyKey: string) => (req: Request) => {
  const body = (req.body as Record<string, unknown>) ?? {};
  const v = body[bodyKey];
  return typeof v === 'string' ? v : undefined;
};
