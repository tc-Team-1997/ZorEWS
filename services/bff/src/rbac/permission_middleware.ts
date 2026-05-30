// services/bff/src/rbac/permission_middleware.ts
//
// requireModulePermission(module, action) — Express middleware that
// gates a route on the Enterprise Permission Matrix.
//
// COMPOSABLE with the existing requireRole('op') middleware
// (infra/rbac/lib). Use BOTH on new routes for belt-and-braces; legacy
// routes can stay on requireRole only.
//
// Resolution model:
//   1. Read caller role(s) from req (api-key, header, or JWT).
//   2. Look up (role, module, action) in the permission matrix.
//   3. Deny with 403 EWS_403_missing_module_permission on miss.
//
// The middleware is permissive when the matrix has no opinion (e.g.
// rare race where a brand-new module is referenced before the seed runs);
// it falls back to `true` for admin/super_admin. This dodges chicken-and-
// egg bootstrapping during a hot deploy.

import type { NextFunction, Request, Response } from 'express';
import { wrapError, extractCtx, type ErrorPayload } from '../envelope';
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULE_IDS,
  type PermissionAction,
  type IPermissionMatrixStore,
  defaultPermissionMatrixStore,
} from './permission_matrix';

export interface RequireModulePermissionDeps {
  store?: IPermissionMatrixStore;
  /** Pull the caller's role from the request. Default reads x-apex-role
   *  (test convention) then req.apiKey (M1.3) then req.user (auth-svc JWT). */
  getRole?: (req: Request) => string | string[] | undefined;
  /** Optional second-layer admin allowlist — admin roles that always pass
   *  regardless of matrix. Defaults to ['super_admin', 'admin']. Production
   *  may want to tighten this to just 'super_admin'. */
  alwaysAllowRoles?: readonly string[];
  now?: () => Date;
}

const DEFAULT_ALWAYS_ALLOW = ['super_admin', 'admin'] as const;

function readRolesFromRequest(req: Request): string[] {
  const headerRole = req.header('x-apex-role');
  if (headerRole) return [headerRole];
  // M1.3 API-key auth populates req.apiKey with .scopes (operation tokens, not roles).
  // No direct role on api-key; defer to header.
  const u = (req as Request & { user?: { role?: string; roles?: string[] } }).user;
  if (u?.role) return [u.role];
  if (u?.roles?.length) return u.roles;
  return [];
}

export function requireModulePermission(
  module_id: string,
  action: PermissionAction,
  deps: RequireModulePermissionDeps = {},
) {
  if (!PERMISSION_MODULE_IDS.includes(module_id)) {
    throw new Error(`requireModulePermission: unknown module "${module_id}"`);
  }
  if (!(PERMISSION_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`requireModulePermission: unknown action "${action}"`);
  }

  const store = deps.store ?? defaultPermissionMatrixStore();
  const getRole = deps.getRole ?? readRolesFromRequest;
  const alwaysAllow = new Set(deps.alwaysAllowRoles ?? DEFAULT_ALWAYS_ALLOW);
  const now = deps.now ?? (() => new Date());

  return (req: Request, res: Response, next: NextFunction) => {
    const roles = ([] as string[]).concat(getRole(req) ?? []);
    if (roles.length === 0) {
      const err: ErrorPayload = {
        code: 'EWS_401',
        message: 'Authentication required to access this module',
        severity: 'MEDIUM',
      };
      return res.status(401).json(wrapError(err, extractCtx(req, now)));
    }

    // Super-admin fast-path
    for (const r of roles) {
      if (alwaysAllow.has(r)) return next();
    }

    // Matrix check — any role with the grant passes (OR-merge semantics).
    for (const r of roles) {
      if (store.isGranted(r, module_id, action)) return next();
    }

    const err: ErrorPayload = {
      code: 'EWS_403_missing_module_permission',
      message: `Missing ${action} permission on ${module_id}`,
      severity: 'MEDIUM',
      detail: { module: module_id, action, roles },
    };
    return res.status(403).json(wrapError(err, extractCtx(req, now)));
  };
}
