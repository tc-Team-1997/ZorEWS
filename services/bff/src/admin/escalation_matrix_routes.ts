// services/bff/src/admin/escalation_matrix_routes.ts
//
// Express router for /v1/admin/escalation-matrix — admin CRUD on
// app_admin.escalation_matrix + a resolveFor lookup driven by
// (case_category, priority) so the case-creation pipeline can ask
// "what escalation rule applies to a P1 fraud case in BIL?".

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
  EscalationMatrixError,
  validateCreate,
  validateUpdate,
  type EscalationMatrixStore,
} from './escalation_matrix_store';
import { PRIORITIES, type EscalationStatus, type Priority } from './case_scenarios_types';

export interface EscalationMatrixRouterDeps {
  store: EscalationMatrixStore;
  requireTenantMw: RequestHandler;
  requireRole: (op: string) => RequestHandler;
  now?: () => Date;
}

const ALL_STATUSES: readonly EscalationStatus[] = ['ACTIVE', 'ARCHIVED'];

export function makeEscalationMatrixRouter(deps: EscalationMatrixRouterDeps): RouterType {
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
    if (err instanceof EscalationMatrixError) {
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

  // GET /v1/admin/escalation-matrix
  // Note: literal `/resolve` is mounted BEFORE this so it doesn't get
  // shadowed by /:id. (Express matches in declaration order.)
  router.get(
    '/v1/admin/escalation-matrix/resolve',
    requireTenantMw,
    requireRole('admin:escalation_matrix:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const cat = req.query.case_category;
      const prio = req.query.priority;
      if (typeof cat !== 'string' || !cat.trim()) {
        throw new EscalationMatrixError(400, 'EWS_400_invalid_input', 'case_category required');
      }
      if (typeof prio !== 'string' || !(PRIORITIES as readonly string[]).includes(prio)) {
        throw new EscalationMatrixError(
          400,
          'EWS_400_invalid_input',
          `priority must be one of ${PRIORITIES.join('|')}`,
        );
      }
      const row = await store.resolveFor(req.tenant!.tenant_id, cat.trim(), prio as Priority);
      res.json(wrapResponse({ rule: row }, ctx));
    }),
  );

  router.get(
    '/v1/admin/escalation-matrix',
    requireTenantMw,
    requireRole('admin:escalation_matrix:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filter: Parameters<typeof store.list>[1] = {};
      if (typeof q.case_category === 'string' && q.case_category) filter.case_category = q.case_category;
      if (typeof q.priority === 'string' && q.priority) {
        if (!(PRIORITIES as readonly string[]).includes(q.priority)) {
          throw new EscalationMatrixError(400, 'EWS_400_invalid_input', `unknown priority: ${q.priority}`);
        }
        filter.priority = q.priority as Priority;
      }
      if (typeof q.status === 'string' && q.status) {
        const arr = q.status.split(',').map((s) => s.trim()).filter(Boolean);
        for (const s of arr) {
          if (!(ALL_STATUSES as readonly string[]).includes(s)) {
            throw new EscalationMatrixError(400, 'EWS_400_invalid_input', `unknown status: ${s}`);
          }
        }
        filter.status = arr as EscalationStatus[];
      }
      if (typeof q.page === 'string') filter.page = Number(q.page);
      if (typeof q.page_size === 'string') filter.page_size = Number(q.page_size);

      const out = await store.list(req.tenant!.tenant_id, filter);
      res.json(wrapResponse(out, ctx));
    }),
  );

  // GET /v1/admin/escalation-matrix/:id
  router.get(
    '/v1/admin/escalation-matrix/:id',
    requireTenantMw,
    requireRole('admin:escalation_matrix:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const row = await store.get(req.tenant!.tenant_id, req.params.id);
      if (!row) {
        throw new EscalationMatrixError(404, 'EWS_404_not_found', `escalation rule ${req.params.id} not found`);
      }
      res.json(wrapResponse(row, ctx));
    }),
  );

  // POST /v1/admin/escalation-matrix
  router.post(
    '/v1/admin/escalation-matrix',
    requireTenantMw,
    requireRole('admin:escalation_matrix:create'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const validated = validateCreate(req.body);
      const out = await store.create(req.tenant!.tenant_id, validated, actorOf(req), now());
      res.status(201).json(wrapResponse(out, ctx));
    }),
  );

  // PATCH /v1/admin/escalation-matrix/:id
  router.patch(
    '/v1/admin/escalation-matrix/:id',
    requireTenantMw,
    requireRole('admin:escalation_matrix:update'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const patch = validateUpdate(req.body);
      const out = await store.update(req.tenant!.tenant_id, req.params.id, patch, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  // DELETE /v1/admin/escalation-matrix/:id  (archive)
  router.delete(
    '/v1/admin/escalation-matrix/:id',
    requireTenantMw,
    requireRole('admin:escalation_matrix:archive'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const out = await store.archive(req.tenant!.tenant_id, req.params.id, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  return router;
}
