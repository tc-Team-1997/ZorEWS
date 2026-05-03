// services/bff/src/tenant.ts
//
// Tenant middleware — enforces X-Tenant-ID + X-Channel on routes that opt in
// (Banking API Integration §3, "Multi-Tenant API Design — VERY IMPORTANT").
//
// Applied per-route rather than globally so legacy /api/* (SPA-internal)
// and /v1/* routes don't break. New endpoints + the migrated reference
// endpoint /v1/ews/evaluate use it.
//
// On success: tags `req.tenant` and `req.channel`. On failure: writes a
// standardized error envelope (Banking API §11 shape) and returns 400.
//
// The tenant lookup is injected so the middleware works against either an
// in-memory map (tests + dev-without-pg) or a pg-backed lookup (production).

import type { NextFunction, Request, Response } from 'express';
import { wrapError, readRequestId } from './envelope';

export interface Tenant {
  tenant_id: string;
  name: string;
  vertical: 'banking' | 'insurance';
  channels_allowed: string[];
  active: boolean;
}

/** Lookup signature; production wires to pg, tests inject a Map. */
export type TenantLookup = (tenantId: string) => Tenant | undefined | Promise<Tenant | undefined>;

/** Default in-memory tenant registry — mirrors the 005_tenants.sql seed. */
const DEFAULT_TENANTS: Tenant[] = [
  {
    tenant_id: 'BANK_DEMO',
    name: 'APEX Bank (demo)',
    vertical: 'banking',
    channels_allowed: ['LOS', 'MOBILE', 'BRANCH', 'API'],
    active: true,
  },
  {
    tenant_id: 'BIL',
    name: 'Bhutan Insurance Limited',
    vertical: 'insurance',
    channels_allowed: ['BRANCH', 'AGENT_PORTAL', 'API'],
    active: true,
  },
];

export function defaultTenantLookup(): TenantLookup {
  const byId = new Map(DEFAULT_TENANTS.map((t) => [t.tenant_id, t]));
  return (id: string) => byId.get(id);
}

/**
 * Express middleware factory. Each call returns a fresh middleware bound to
 * the supplied lookup. Routes that need tenant context apply it explicitly:
 *   app.post('/v1/ews/evaluate', requireTenant(lookup), requireRole(...), handler);
 */
export function requireTenant(lookup: TenantLookup = defaultTenantLookup()) {
  return async function tenantMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const requestId = readRequestId(req.body) ?? extractHeader(req, 'x-request-id');
    const ctx = { requestId };

    const tenantHeader = extractHeader(req, 'x-tenant-id');
    if (!tenantHeader) {
      sendError(res, 400, ctx, {
        code: 'EWS_400',
        message: 'X-Tenant-ID header is required',
        severity: 'HIGH',
      });
      return;
    }
    const channelHeader = extractHeader(req, 'x-channel');
    if (!channelHeader) {
      sendError(res, 400, ctx, {
        code: 'EWS_400',
        message: 'X-Channel header is required',
        severity: 'HIGH',
      });
      return;
    }

    const tenant = await lookup(tenantHeader);
    if (!tenant || !tenant.active) {
      sendError(res, 403, ctx, {
        code: 'EWS_403',
        message: `tenant '${tenantHeader}' is not registered or is inactive`,
        severity: 'HIGH',
      });
      return;
    }
    if (!tenant.channels_allowed.includes(channelHeader)) {
      sendError(res, 403, ctx, {
        code: 'EWS_403',
        message:
          `channel '${channelHeader}' not permitted for tenant '${tenant.tenant_id}'. ` +
          `Allowed: ${tenant.channels_allowed.join(',')}`,
        severity: 'HIGH',
      });
      return;
    }

    // Tag the request — handlers downstream can read these.
    (req as Request & { tenant: Tenant; channel: string }).tenant = tenant;
    (req as Request & { tenant: Tenant; channel: string }).channel = channelHeader;
    next();
  };
}

function extractHeader(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  return undefined;
}

function sendError(
  res: Response,
  status: number,
  ctx: { requestId?: string },
  err: { code: string; message: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' },
): void {
  res.status(status).json(wrapError(err, ctx));
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: Tenant;
      channel?: string;
    }
  }
}
