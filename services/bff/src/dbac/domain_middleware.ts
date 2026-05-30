// services/bff/src/dbac/domain_middleware.ts
//
// requireDomain('banking' | 'insurance') — Express middleware that
// gates a route on the user's effective DBAC domain.
//
// COMPOSABLE with the existing requireRole + requireTenant +
// requireModulePermission middlewares. Use it on Banking-only routes
// (e.g. /v1/banking/sma/*) and Insurance-only routes (/v1/insurance/*)
// to block cross-domain access at the HTTP layer.
//
// Resolution: pulls the user's domain pin from x-apex-user-domain
// header (test convention) or req.user.domain (JWT) — falls back to
// req.tenant.vertical. Super-admins bypass via the same 'admin' /
// 'super_admin' fast-path the permission matrix uses.

import type { NextFunction, Request, Response } from 'express';
import { wrapError, extractCtx, type ErrorPayload } from '../envelope';
import {
  isDbacDomain,
  resolveEffectiveDomain,
  canAccessDomain,
  type DbacDomain,
} from './domain_resolver';

export interface RequireDomainDeps {
  /** Pull the caller's user pin from the request. */
  getUserDomain?: (req: Request) => string | undefined;
  /** Pull the caller's role from the request — defaults to x-apex-role. */
  getRole?: (req: Request) => string | string[] | undefined;
  now?: () => Date;
}

function readUserDomain(req: Request): string | undefined {
  const h = req.header('x-apex-user-domain');
  if (h) return h.trim();
  const u = (req as Request & { user?: { domain?: string } }).user;
  return u?.domain;
}

function readRole(req: Request): string | string[] | undefined {
  const h = req.header('x-apex-role');
  if (h) return h;
  const u = (req as Request & { user?: { role?: string; roles?: string[] } }).user;
  return u?.role ?? u?.roles;
}

export function requireDomain(target: DbacDomain, deps: RequireDomainDeps = {}) {
  if (!isDbacDomain(target)) {
    throw new Error(`requireDomain: invalid target "${target}"`);
  }
  const getUserDomain = deps.getUserDomain ?? readUserDomain;
  const getRole = deps.getRole ?? readRole;
  const now = deps.now ?? (() => new Date());

  return (req: Request, res: Response, next: NextFunction) => {
    const userPin = getUserDomain(req);
    const role = getRole(req);
    const tenantVertical = req.tenant?.vertical;
    const effective = resolveEffectiveDomain(
      { domain: isDbacDomain(userPin) ? userPin : undefined, role },
      { vertical: tenantVertical as DbacDomain | 'both' | undefined },
    );

    if (canAccessDomain(effective, target)) return next();

    const err: ErrorPayload = {
      code: 'EWS_403_wrong_domain',
      message: `This route is restricted to ${target} users`,
      severity: 'MEDIUM',
      detail: { required_domain: target, effective_domain: effective ?? 'unknown' },
    };
    return res.status(403).json(wrapError(err, extractCtx(req, now)));
  };
}
