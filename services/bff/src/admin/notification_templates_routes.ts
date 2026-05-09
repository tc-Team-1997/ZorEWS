// services/bff/src/admin/notification_templates_routes.ts
//
// Express router for /v1/admin/notification-templates — admin CRUD on
// app_admin.notification_templates. Mirrors the sla_config router
// pattern (factory function, no cycles, single mount line).

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
  NotificationTemplateError,
  validateCreate,
  validateUpdate,
  type NotificationTemplateStore,
} from './notification_templates_store';
import type {
  NotificationChannel,
  NotificationTemplateStatus,
} from './case_scenarios_types';

export interface NotificationTemplatesRouterDeps {
  store: NotificationTemplateStore;
  requireTenantMw: RequestHandler;
  requireRole: (op: string) => RequestHandler;
  now?: () => Date;
}

const ALL_CHANNELS: readonly NotificationChannel[] = ['EMAIL', 'SMS', 'IN_APP'];
const ALL_STATUSES: readonly NotificationTemplateStatus[] = ['DRAFT', 'ACTIVE', 'ARCHIVED'];

export function makeNotificationTemplatesRouter(
  deps: NotificationTemplatesRouterDeps,
): RouterType {
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
    if (err instanceof NotificationTemplateError) {
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

  // GET /v1/admin/notification-templates
  router.get(
    '/v1/admin/notification-templates',
    requireTenantMw,
    requireRole('admin:notification_templates:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filter: Parameters<typeof store.list>[1] = {};
      if (typeof q.channel === 'string' && q.channel) {
        if (!(ALL_CHANNELS as readonly string[]).includes(q.channel)) {
          throw new NotificationTemplateError(400, 'EWS_400_invalid_input', `unknown channel: ${q.channel}`);
        }
        filter.channel = q.channel as NotificationChannel;
      }
      if (typeof q.status === 'string' && q.status) {
        const arr = q.status.split(',').map((s) => s.trim()).filter(Boolean);
        for (const s of arr) {
          if (!(ALL_STATUSES as readonly string[]).includes(s)) {
            throw new NotificationTemplateError(400, 'EWS_400_invalid_input', `unknown status: ${s}`);
          }
        }
        filter.status = arr as NotificationTemplateStatus[];
      }
      if (q.include_deleted === 'true') filter.include_deleted = true;
      if (typeof q.page === 'string') filter.page = Number(q.page);
      if (typeof q.page_size === 'string') filter.page_size = Number(q.page_size);

      const out = await store.list(req.tenant!.tenant_id, filter);
      res.json(wrapResponse(out, ctx));
    }),
  );

  // GET /v1/admin/notification-templates/:id
  router.get(
    '/v1/admin/notification-templates/:id',
    requireTenantMw,
    requireRole('admin:notification_templates:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const row = await store.get(req.tenant!.tenant_id, req.params.id);
      if (!row) {
        throw new NotificationTemplateError(404, 'EWS_404_not_found', `notification template ${req.params.id} not found`);
      }
      res.json(wrapResponse(row, ctx));
    }),
  );

  // POST /v1/admin/notification-templates
  router.post(
    '/v1/admin/notification-templates',
    requireTenantMw,
    requireRole('admin:notification_templates:create'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const validated = validateCreate(req.body);
      const out = await store.create(req.tenant!.tenant_id, validated, actorOf(req), now());
      res.status(201).json(wrapResponse(out, ctx));
    }),
  );

  // PATCH /v1/admin/notification-templates/:id
  router.patch(
    '/v1/admin/notification-templates/:id',
    requireTenantMw,
    requireRole('admin:notification_templates:update'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const patch = validateUpdate(req.body);
      const out = await store.update(req.tenant!.tenant_id, req.params.id, patch, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  // POST /v1/admin/notification-templates/:id/activate
  router.post(
    '/v1/admin/notification-templates/:id/activate',
    requireTenantMw,
    requireRole('admin:notification_templates:update'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const out = await store.activate(req.tenant!.tenant_id, req.params.id, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  // DELETE /v1/admin/notification-templates/:id  (soft-delete + ARCHIVED)
  router.delete(
    '/v1/admin/notification-templates/:id',
    requireTenantMw,
    requireRole('admin:notification_templates:archive'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const out = await store.archive(req.tenant!.tenant_id, req.params.id, actorOf(req), now());
      res.json(wrapResponse(out, ctx));
    }),
  );

  return router;
}
