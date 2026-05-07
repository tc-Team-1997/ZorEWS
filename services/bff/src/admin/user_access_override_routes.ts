// services/bff/src/admin/user_access_override_routes.ts
//
// Express router for the User Access Override admin module
// (BAC §3.1.6 + §3.1.7). All routes:
//   - mounted under /v1/admin/user-access-overrides + /v1/admin/users/:id/effective-access
//   - require tenant context (X-Tenant-ID + X-Channel + X-Source-System)
//   - return the EWS envelope { header, body } via envelope helpers
//   - audit-log every write via the store's writeAudit pathway
//
// The router is exported as a factory so server.ts can pass in the
// store + the existing requireTenantMw + requireRole helpers without
// us reimporting them and forming a cycle.

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router as RouterType,
} from 'express';

import { extractCtx, wrapError, wrapResponse } from '../envelope';
import {
  isModulePath,
  OverrideError,
  validateCreateOverride,
  type ListOverridesFilter,
  type ModulePath,
  type OverrideStatus,
} from './types';
import { getEffectiveUserAccess } from './user_access_override_resolver';
import type { ActorContext, UserAccessOverrideStore } from './user_access_override_store';

export interface OverrideRouterDeps {
  store: UserAccessOverrideStore;
  /** Tenant-context middleware re-used from server.ts (T4.24 envelope gate). */
  requireTenantMw: RequestHandler;
  /** RBAC gate factory: requireRole('op:name') → RequestHandler. */
  requireRole: (op: string) => RequestHandler;
  /**
   * Read the user's roles from the request (e.g. JWT claim or x-apex-role
   * header). Used by the effective-access endpoint. The route handler
   * passes the result into the resolver. Returning [] is fine — the
   * resolver just emits an empty role section.
   */
  rolesForUser: (tenant_id: string, user_id: string) => Promise<string[]>;
  now?: () => Date;
}

const ALL_STATUSES: OverrideStatus[] = [
  'PENDING_APPROVAL',
  'ACTIVE',
  'REJECTED',
  'REVOKED',
  'EXPIRED',
];

export function makeUserAccessOverrideRouter(deps: OverrideRouterDeps): RouterType {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const { store, requireTenantMw, requireRole, rolesForUser } = deps;

  // ── helpers ────────────────────────────────────────────────────────

  const actorOf = (req: Request): ActorContext => ({
    actor_id:
      (req.headers['x-apex-user'] as string | undefined) ??
      (req.headers['x-apex-actor'] as string | undefined) ??
      'unknown',
    actor_role:
      (req.headers['x-apex-role'] as string | undefined) ?? 'admin',
    request_id: (req.headers['x-request-id'] as string | undefined) ?? readReqId(req),
    ip_address:
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip,
    user_agent: req.headers['user-agent'] as string | undefined,
  });

  const readReqId = (req: Request): string | undefined => {
    const body = req.body as { header?: { requestId?: string } } | undefined;
    return body?.header?.requestId;
  };

  const handleErr = (err: unknown, req: Request, res: Response): void => {
    const ctx = extractCtx(req, now);
    if (err instanceof OverrideError) {
      res.status(err.status).json(
        wrapError(
          { code: err.code, message: err.message, severity: err.status >= 500 ? 'HIGH' : 'MEDIUM' },
          ctx,
        ),
      );
      return;
    }
    res.status(500).json(
      wrapError(
        {
          code: 'EWS_500',
          message: err instanceof Error ? err.message : 'internal error',
          severity: 'HIGH',
        },
        ctx,
      ),
    );
  };

  const wrap =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
    (req, res, next) => {
      fn(req, res, next).catch((e) => handleErr(e, req, res));
    };

  // ── GET /v1/admin/user-access-overrides ────────────────────────────

  router.get(
    '/v1/admin/user-access-overrides',
    requireTenantMw,
    requireRole('admin:user_access_override:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filter: ListOverridesFilter = {};
      if (typeof q.user_id === 'string' && q.user_id) filter.user_id = q.user_id;
      if (typeof q.status === 'string' && q.status) {
        const arr = q.status.split(',').map((s) => s.trim()).filter(Boolean);
        for (const s of arr) {
          if (!ALL_STATUSES.includes(s as OverrideStatus)) {
            throw new OverrideError(400, 'EWS_400_invalid_input', `unknown status: ${s}`);
          }
        }
        filter.status = arr as OverrideStatus[];
      }
      if (typeof q.module_path === 'string' && q.module_path) {
        if (!isModulePath(q.module_path)) {
          throw new OverrideError(400, 'EWS_400_invalid_input', `unknown module_path: ${q.module_path}`);
        }
        filter.module_path = q.module_path as ModulePath;
      }
      if (typeof q.created_from === 'string') filter.created_from = q.created_from;
      if (typeof q.created_to === 'string') filter.created_to = q.created_to;
      if (typeof q.page === 'string') filter.page = Number(q.page);
      if (typeof q.page_size === 'string') filter.page_size = Number(q.page_size);

      const out = await store.list(req.tenant!.tenant_id, filter);
      res.json(wrapResponse(out, ctx));
    }),
  );

  // ── GET /v1/admin/user-access-overrides/:id ────────────────────────

  router.get(
    '/v1/admin/user-access-overrides/:id',
    requireTenantMw,
    requireRole('admin:user_access_override:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const row = await store.get(req.tenant!.tenant_id, req.params.id);
      if (!row) {
        throw new OverrideError(404, 'EWS_404_not_found', `override ${req.params.id} not found`);
      }
      res.json(wrapResponse(row, ctx));
    }),
  );

  // ── POST /v1/admin/user-access-overrides ───────────────────────────

  router.post(
    '/v1/admin/user-access-overrides',
    requireTenantMw,
    requireRole('admin:user_access_override:create'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const validated = validateCreateOverride(req.body, now());
      const created = await store.create(req.tenant!.tenant_id, validated, actorOf(req), now());
      res
        .status(201)
        .json(wrapResponse({ overrides: created, created: created.length }, ctx));
    }),
  );

  // ── PUT /v1/admin/user-access-overrides/:id ────────────────────────

  router.put(
    '/v1/admin/user-access-overrides/:id',
    requireTenantMw,
    requireRole('admin:user_access_override:create'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      // Validate the partial patch (we only require types if provided).
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof store.update>[2] = {};
      if (Array.isArray(body.module_paths)) {
        for (const p of body.module_paths) {
          if (!isModulePath(p)) {
            throw new OverrideError(400, 'EWS_400_invalid_input', `module_path "${String(p)}" is not allowed`);
          }
        }
        patch.module_paths = body.module_paths as ModulePath[];
      }
      if (typeof body.override_type === 'string') {
        if (body.override_type !== 'GRANT' && body.override_type !== 'REVOKE') {
          throw new OverrideError(400, 'EWS_400_invalid_input', 'override_type must be GRANT or REVOKE');
        }
        patch.override_type = body.override_type;
      }
      if (typeof body.permission_type === 'string') {
        if (!['VIEW', 'EDIT', 'APPROVE', 'FULL'].includes(body.permission_type)) {
          throw new OverrideError(400, 'EWS_400_invalid_input', 'invalid permission_type');
        }
        patch.permission_type = body.permission_type as Parameters<typeof store.update>[2]['permission_type'];
      }
      if (typeof body.effective_from === 'string') patch.effective_from = body.effective_from;
      if (body.effective_till === null || typeof body.effective_till === 'string') {
        patch.effective_till = body.effective_till as string | null;
      }
      if (typeof body.reason === 'string') {
        if (body.reason.trim().length < 10) {
          throw new OverrideError(400, 'EWS_400_invalid_input', 'reason ≥ 10 chars required');
        }
        patch.reason = body.reason.trim();
      }
      const updated = await store.update(req.tenant!.tenant_id, req.params.id, patch, actorOf(req), now());
      res.json(wrapResponse(updated, ctx));
    }),
  );

  // ── POST /v1/admin/user-access-overrides/:id/approve ───────────────

  router.post(
    '/v1/admin/user-access-overrides/:id/approve',
    requireTenantMw,
    requireRole('admin:user_access_override:approve'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const note = (req.body as { approval_note?: string } | undefined)?.approval_note ?? null;
      const out = await store.approve(req.tenant!.tenant_id, req.params.id, note, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  // ── POST /v1/admin/user-access-overrides/:id/reject ────────────────

  router.post(
    '/v1/admin/user-access-overrides/:id/reject',
    requireTenantMw,
    requireRole('admin:user_access_override:approve'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const reason = (req.body as { rejection_reason?: string } | undefined)?.rejection_reason ?? '';
      const out = await store.reject(req.tenant!.tenant_id, req.params.id, reason, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  // ── POST /v1/admin/user-access-overrides/:id/revoke ────────────────

  router.post(
    '/v1/admin/user-access-overrides/:id/revoke',
    requireTenantMw,
    requireRole('admin:user_access_override:revoke'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const reason = (req.body as { revocation_reason?: string } | undefined)?.revocation_reason ?? '';
      const out = await store.revoke(req.tenant!.tenant_id, req.params.id, reason, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  // ── GET /v1/admin/users/:user_id/effective-access ──────────────────

  router.get(
    '/v1/admin/users/:user_id/effective-access',
    requireTenantMw,
    requireRole('admin:user_access_override:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const tenant_id = req.tenant!.tenant_id;
      const user_id = req.params.user_id;
      const [roles, overrides] = await Promise.all([
        rolesForUser(tenant_id, user_id),
        store.listForUser(tenant_id, user_id),
      ]);
      const eff = getEffectiveUserAccess(user_id, roles, overrides, now());
      res.json(wrapResponse(eff, ctx));
    }),
  );

  // ── GET /v1/admin/admin-audit-log ──────────────────────────────────

  router.get(
    '/v1/admin/admin-audit-log',
    requireTenantMw,
    requireRole('admin:user_access_override:audit'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const out = await store.listAuditLog(req.tenant!.tenant_id, {
        entity_id: typeof q.entity_id === 'string' ? q.entity_id : undefined,
        actor_id: typeof q.actor_id === 'string' ? q.actor_id : undefined,
        from: typeof q.from === 'string' ? q.from : undefined,
        to: typeof q.to === 'string' ? q.to : undefined,
        page: typeof q.page === 'string' ? Number(q.page) : undefined,
        page_size: typeof q.page_size === 'string' ? Number(q.page_size) : undefined,
      });
      res.json(wrapResponse(out, ctx));
    }),
  );

  return router;
}
