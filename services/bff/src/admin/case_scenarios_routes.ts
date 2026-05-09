// services/bff/src/admin/case_scenarios_routes.ts
//
// Express router for /v1/admin/case-scenarios — admin CRUD on
// app_admin.case_scenarios + lifecycle (activate/archive/restore) +
// per-scenario history listing (case_scenario_history).

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
  CaseScenarioError,
  validateCreate,
  validateUpdate,
  type CaseScenarioStore,
} from './case_scenarios_store';
import type { CaseScenarioHistoryStore } from './case_scenario_history_store';
import { PRIORITIES, type CaseScenarioStatus, type Priority } from './case_scenarios_types';

export interface CaseScenariosRouterDeps {
  store: CaseScenarioStore;
  /** Optional — when set, GET /:id/history returns this scenario's audit log. */
  history?: CaseScenarioHistoryStore;
  requireTenantMw: RequestHandler;
  requireRole: (op: string) => RequestHandler;
  now?: () => Date;
}

const ALL_STATUSES: readonly CaseScenarioStatus[] = ['DRAFT', 'ACTIVE', 'ARCHIVED'];

export function makeCaseScenariosRouter(deps: CaseScenariosRouterDeps): RouterType {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const { store, history, requireTenantMw, requireRole } = deps;

  const actorOf = (req: Request) => ({
    actor_id:
      (req.headers['x-apex-user'] as string | undefined) ??
      (req.headers['x-apex-actor'] as string | undefined) ??
      'unknown',
  });

  const handleErr = (err: unknown, req: Request, res: Response): void => {
    const ctx = extractCtx(req, now);
    if (err instanceof CaseScenarioError) {
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

  // GET /v1/admin/case-scenarios
  router.get(
    '/v1/admin/case-scenarios',
    requireTenantMw,
    requireRole('admin:case_scenarios:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filter: Parameters<typeof store.list>[1] = {};
      if (typeof q.case_category === 'string' && q.case_category) filter.case_category = q.case_category;
      if (typeof q.priority === 'string' && q.priority) {
        if (!(PRIORITIES as readonly string[]).includes(q.priority)) {
          throw new CaseScenarioError(400, 'EWS_400_invalid_input', `unknown priority: ${q.priority}`);
        }
        filter.priority = q.priority as Priority;
      }
      if (typeof q.status === 'string' && q.status) {
        const arr = q.status.split(',').map((s) => s.trim()).filter(Boolean);
        for (const s of arr) {
          if (!(ALL_STATUSES as readonly string[]).includes(s)) {
            throw new CaseScenarioError(400, 'EWS_400_invalid_input', `unknown status: ${s}`);
          }
        }
        filter.status = arr as CaseScenarioStatus[];
      }
      if (typeof q.trigger_indicator_id === 'string' && q.trigger_indicator_id) {
        filter.trigger_indicator_id = q.trigger_indicator_id;
      }
      if (q.include_deleted === 'true') filter.include_deleted = true;
      if (typeof q.page === 'string') filter.page = Number(q.page);
      if (typeof q.page_size === 'string') filter.page_size = Number(q.page_size);

      const out = await store.list(req.tenant!.tenant_id, filter);
      res.json(wrapResponse(out, ctx));
    }),
  );

  // GET /v1/admin/case-scenarios/:id/history  (declared BEFORE /:id so /history doesn't get mistaken for an id)
  router.get(
    '/v1/admin/case-scenarios/:id/history',
    requireTenantMw,
    requireRole('admin:case_scenarios:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      if (!history) {
        // Schema is wired but BFF wasn't booted with a history store —
        // return empty so SPA renders gracefully.
        res.json(wrapResponse({ items: [], total: 0, page: 1, page_size: 100 }, ctx));
        return;
      }
      const sc = await store.get(req.tenant!.tenant_id, req.params.id);
      if (!sc) {
        throw new CaseScenarioError(404, 'EWS_404_not_found', `scenario ${req.params.id} not found`);
      }
      const filter: Parameters<typeof history.list>[1] = { scenario_id: req.params.id };
      if (typeof req.query.page === 'string') filter.page = Number(req.query.page);
      if (typeof req.query.page_size === 'string') filter.page_size = Number(req.query.page_size);
      const out = await history.list(req.tenant!.tenant_id, filter);
      res.json(wrapResponse(out, ctx));
    }),
  );

  // GET /v1/admin/case-scenarios/:id
  router.get(
    '/v1/admin/case-scenarios/:id',
    requireTenantMw,
    requireRole('admin:case_scenarios:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const row = await store.get(req.tenant!.tenant_id, req.params.id);
      if (!row) {
        throw new CaseScenarioError(404, 'EWS_404_not_found', `scenario ${req.params.id} not found`);
      }
      res.json(wrapResponse(row, ctx));
    }),
  );

  // POST /v1/admin/case-scenarios
  router.post(
    '/v1/admin/case-scenarios',
    requireTenantMw,
    requireRole('admin:case_scenarios:create'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const validated = validateCreate(req.body);
      const out = await store.create(req.tenant!.tenant_id, validated, actorOf(req), now());
      res.status(201).json(wrapResponse(out, ctx));
    }),
  );

  // PATCH /v1/admin/case-scenarios/:id
  router.patch(
    '/v1/admin/case-scenarios/:id',
    requireTenantMw,
    requireRole('admin:case_scenarios:update'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const patch = validateUpdate(req.body);
      const out = await store.update(req.tenant!.tenant_id, req.params.id, patch, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  // POST /v1/admin/case-scenarios/:id/activate
  router.post(
    '/v1/admin/case-scenarios/:id/activate',
    requireTenantMw,
    requireRole('admin:case_scenarios:lifecycle'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const out = await store.activate(req.tenant!.tenant_id, req.params.id, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  // POST /v1/admin/case-scenarios/:id/restore
  router.post(
    '/v1/admin/case-scenarios/:id/restore',
    requireTenantMw,
    requireRole('admin:case_scenarios:lifecycle'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const out = await store.restore(req.tenant!.tenant_id, req.params.id, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  // DELETE /v1/admin/case-scenarios/:id  (archive + soft-delete)
  router.delete(
    '/v1/admin/case-scenarios/:id',
    requireTenantMw,
    requireRole('admin:case_scenarios:archive'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const out = await store.archive(req.tenant!.tenant_id, req.params.id, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  return router;
}
