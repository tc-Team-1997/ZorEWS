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
import { renderTemplate } from './notification_template_render';
import type {
  DispatchStatus,
  DispatchTrigger,
  NotificationDispatchStore,
} from './notification_dispatch_store';

export interface NotificationTemplatesRouterDeps {
  store: NotificationTemplateStore;
  /** Optional — when set, the M14.24 preview/test-fire/dispatches
   *  routes mount. Without this slot the routes 503 (or rather
   *  silently no-op for /dispatches GET) so the SPA can degrade. */
  dispatchStore?: NotificationDispatchStore;
  requireTenantMw: RequestHandler;
  requireRole: (op: string) => RequestHandler;
  now?: () => Date;
}

const ALL_DISPATCH_STATUSES: readonly DispatchStatus[] = ['sent', 'preview', 'failed'];
const ALL_DISPATCH_TRIGGERS: readonly DispatchTrigger[] = [
  'admin_test_fire',
  'case_create_pipeline',
  'escalation_worker',
];

const ALL_CHANNELS: readonly NotificationChannel[] = ['EMAIL', 'SMS', 'IN_APP'];
const ALL_STATUSES: readonly NotificationTemplateStatus[] = ['DRAFT', 'ACTIVE', 'ARCHIVED'];

export function makeNotificationTemplatesRouter(
  deps: NotificationTemplatesRouterDeps,
): RouterType {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const { store, dispatchStore, requireTenantMw, requireRole } = deps;

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

  // GET /v1/admin/notification-templates/dispatches (T6 M14.24)
  // Declared BEFORE /:id so the literal /dispatches doesn't get
  // mistaken for an id segment.
  router.get(
    '/v1/admin/notification-templates/dispatches',
    requireTenantMw,
    requireRole('admin:notification_templates:list'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      if (!dispatchStore) {
        // Degrade gracefully — admin sees an empty log when the store
        // isn't wired (dev-mode fallback before the SPA expects it).
        res.json(wrapResponse({ items: [], total: 0, page: 1, page_size: 100 }, ctx));
        return;
      }
      const q = req.query;
      const filter: Parameters<typeof dispatchStore.list>[1] = {};
      if (typeof q.template_id === 'string' && q.template_id) filter.template_id = q.template_id;
      if (typeof q.reference === 'string' && q.reference) filter.reference = q.reference;
      if (typeof q.trigger === 'string' && q.trigger) {
        if (!(ALL_DISPATCH_TRIGGERS as readonly string[]).includes(q.trigger)) {
          throw new NotificationTemplateError(400, 'EWS_400_invalid_input', `unknown trigger: ${q.trigger}`);
        }
        filter.trigger = q.trigger as DispatchTrigger;
      }
      if (typeof q.status === 'string' && q.status) {
        const arr = q.status.split(',').map((s) => s.trim()).filter(Boolean);
        for (const s of arr) {
          if (!(ALL_DISPATCH_STATUSES as readonly string[]).includes(s)) {
            throw new NotificationTemplateError(400, 'EWS_400_invalid_input', `unknown dispatch status: ${s}`);
          }
        }
        filter.status = arr as DispatchStatus[];
      }
      if (typeof q.since === 'string' && q.since.trim()) {
        const d = new Date(q.since);
        if (!Number.isFinite(d.getTime())) {
          throw new NotificationTemplateError(400, 'EWS_400_invalid_input', 'since must be ISO 8601');
        }
        filter.since = d;
      }
      if (typeof q.page === 'string') filter.page = Number(q.page);
      if (typeof q.page_size === 'string') filter.page_size = Number(q.page_size);
      const out = await dispatchStore.list(req.tenant!.tenant_id, filter);
      res.json(wrapResponse(out, ctx));
    }),
  );

  // POST /v1/admin/notification-templates/:id/preview (T6 M14.24)
  // Body: { vars: Record<string, unknown> }
  // Returns the rendered preview without persisting anything.
  router.post(
    '/v1/admin/notification-templates/:id/preview',
    requireTenantMw,
    requireRole('admin:notification_templates:preview'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const tpl = await store.get(req.tenant!.tenant_id, req.params.id);
      if (!tpl) {
        throw new NotificationTemplateError(404, 'EWS_404_not_found', `notification template ${req.params.id} not found`);
      }
      const body = req.body as { vars?: unknown } | unknown;
      const vars =
        body && typeof body === 'object' && 'vars' in (body as object)
          ? (body as { vars?: unknown }).vars
          : {};
      if (vars !== null && vars !== undefined && typeof vars !== 'object') {
        throw new NotificationTemplateError(400, 'EWS_400_invalid_input', 'vars must be an object');
      }
      const result = renderTemplate(tpl, {
        tenant_id: req.tenant!.tenant_id,
        vars: (vars as Record<string, unknown>) ?? {},
      });
      res.json(wrapResponse(result, ctx));
    }),
  );

  // POST /v1/admin/notification-templates/:id/test-fire (T6 M14.24)
  // Body: { vars: Record<string, unknown>, recipient: string,
  //         reference?: string, refuse_when_missing?: boolean }
  // Renders + appends to the dispatch log. When refuse_when_missing is
  // true and the render flagged any missing vars, returns 422 without
  // logging.
  router.post(
    '/v1/admin/notification-templates/:id/test-fire',
    requireTenantMw,
    requireRole('admin:notification_templates:test_fire'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      if (!dispatchStore) {
        throw new NotificationTemplateError(
          503,
          'EWS_503_dispatch_store_unavailable',
          'notification dispatch store not wired in this deployment',
        );
      }
      const tpl = await store.get(req.tenant!.tenant_id, req.params.id);
      if (!tpl) {
        throw new NotificationTemplateError(404, 'EWS_404_not_found', `notification template ${req.params.id} not found`);
      }
      if (tpl.deleted_at !== null || tpl.status === 'ARCHIVED') {
        throw new NotificationTemplateError(409, 'EWS_409_invalid_state', 'cannot test-fire an archived template');
      }
      const body = (req.body ?? {}) as {
        vars?: unknown;
        recipient?: unknown;
        reference?: unknown;
        refuse_when_missing?: unknown;
      };
      if (typeof body.recipient !== 'string' || !body.recipient.trim()) {
        throw new NotificationTemplateError(400, 'EWS_400_invalid_input', 'recipient required (string)');
      }
      if (body.recipient.length > 200) {
        throw new NotificationTemplateError(400, 'EWS_400_invalid_input', 'recipient max 200 chars');
      }
      const vars =
        body.vars === null || body.vars === undefined
          ? {}
          : typeof body.vars === 'object' && !Array.isArray(body.vars)
            ? (body.vars as Record<string, unknown>)
            : null;
      if (vars === null) {
        throw new NotificationTemplateError(400, 'EWS_400_invalid_input', 'vars must be an object');
      }
      const refuseMissing = body.refuse_when_missing === true;
      const reference =
        typeof body.reference === 'string' && body.reference.trim()
          ? body.reference.trim().slice(0, 200)
          : null;
      const rendered = renderTemplate(tpl, { tenant_id: req.tenant!.tenant_id, vars });
      if (refuseMissing && rendered.missing_vars.length > 0) {
        throw new NotificationTemplateError(
          422,
          'EWS_422_missing_template_vars',
          `refuse_when_missing: template references unset vars: ${rendered.missing_vars.join(', ')}`,
        );
      }
      const actor =
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() ||
        ((req.headers['x-apex-actor'] as string | undefined) ?? '').trim() ||
        'admin';
      const entry = await dispatchStore.append(
        req.tenant!.tenant_id,
        {
          template_id: tpl.template_id,
          template_name: tpl.name,
          channel: tpl.channel,
          recipient: body.recipient.trim(),
          trigger: 'admin_test_fire',
          reference,
          rendered_subject: rendered.subject,
          rendered_body: rendered.body,
          missing_vars: rendered.missing_vars,
          status: 'sent',
          status_reason:
            rendered.missing_vars.length > 0
              ? `dispatched with ${rendered.missing_vars.length} missing var(s)`
              : null,
          performed_by: actor,
        },
        now(),
      );
      res.json(wrapResponse({ rendered, dispatch: entry }, ctx));
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
