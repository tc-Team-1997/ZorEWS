// services/bff/src/admin/sla_config_routes.ts
//
// Express router for /v1/admin/sla-config — admin CRUD on top of the
// dashboard SLA Breach Matrix's read store. Mirrors the user-access-
// override router pattern: factory function so server.ts plumbs in
// store + middleware, no cycles, single mount line.

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
  SlaConfigError,
  validateCreate,
  validateUpdate,
  type Priority,
  type SlaConfigStore,
  type Status,
} from './sla_config_store';

export interface SlaConfigRouterDeps {
  store: SlaConfigStore;
  requireTenantMw: RequestHandler;
  requireRole: (op: string) => RequestHandler;
  now?: () => Date;
}

const ALL_STATUSES: Status[] = ['ACTIVE', 'SUPERSEDED', 'ARCHIVED'];

export function makeSlaConfigRouter(deps: SlaConfigRouterDeps): RouterType {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const { store, requireTenantMw, requireRole } = deps;

  const actorOf = (req: Request) => ({
    actor_id:
      (req.headers['x-apex-user'] as string | undefined) ??
      (req.headers['x-apex-actor'] as string | undefined) ??
      'unknown',
  });

  const handleErr = (err: unknown, req: Request, res: Response): void => {
    const ctx = extractCtx(req, now);
    if (err instanceof SlaConfigError) {
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
        { code: 'EWS_500', message: err instanceof Error ? err.message : 'internal error', severity: 'HIGH' },
        ctx,
      ),
    );
  };

  const wrap =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
    (req, res, next) => fn(req, res, next).catch((e) => handleErr(e, req, res));

  // GET /v1/admin/sla-config
  router.get(
    '/v1/admin/sla-config',
    requireTenantMw,
    requireRole('admin:sla_config:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filter: Parameters<typeof store.list>[1] = {};
      if (typeof q.case_category === 'string' && q.case_category) filter.case_category = q.case_category;
      if (typeof q.priority === 'string' && q.priority) filter.priority = q.priority as Priority;
      if (typeof q.business_unit === 'string') {
        // Empty string + sentinel '*' both mean "no BU" (NULL)
        filter.business_unit = q.business_unit === '' || q.business_unit === '*' ? null : q.business_unit;
      }
      if (typeof q.status === 'string' && q.status) {
        const arr = q.status.split(',').map((s) => s.trim()).filter(Boolean);
        for (const s of arr) {
          if (!ALL_STATUSES.includes(s as Status)) {
            throw new SlaConfigError(400, 'EWS_400_invalid_input', `unknown status: ${s}`);
          }
        }
        filter.status = arr as Status[];
      }
      if (typeof q.page === 'string') filter.page = Number(q.page);
      if (typeof q.page_size === 'string') filter.page_size = Number(q.page_size);

      const out = await store.list(req.tenant!.tenant_id, filter);
      res.json(wrapResponse(out, ctx));
    }),
  );

  // GET /v1/admin/sla-config/:id
  router.get(
    '/v1/admin/sla-config/:id',
    requireTenantMw,
    requireRole('admin:sla_config:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const row = await store.get(req.tenant!.tenant_id, req.params.id);
      if (!row) {
        throw new SlaConfigError(404, 'EWS_404_not_found', `sla_config ${req.params.id} not found`);
      }
      res.json(wrapResponse(row, ctx));
    }),
  );

  // POST /v1/admin/sla-config
  router.post(
    '/v1/admin/sla-config',
    requireTenantMw,
    requireRole('admin:sla_config:create'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const validated = validateCreate(req.body);
      const out = await store.create(req.tenant!.tenant_id, validated, actorOf(req), now());
      res.status(201).json(wrapResponse(out, ctx));
    }),
  );

  // PUT /v1/admin/sla-config/:id  (edit by supersede)
  router.put(
    '/v1/admin/sla-config/:id',
    requireTenantMw,
    requireRole('admin:sla_config:update'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const patch = validateUpdate(req.body);
      const out = await store.supersede(req.tenant!.tenant_id, req.params.id, patch, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  // DELETE /v1/admin/sla-config/:id  (archive)
  router.delete(
    '/v1/admin/sla-config/:id',
    requireTenantMw,
    requireRole('admin:sla_config:archive'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const out = await store.archive(req.tenant!.tenant_id, req.params.id, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  return router;
}
