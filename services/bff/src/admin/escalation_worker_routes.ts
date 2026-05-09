// services/bff/src/admin/escalation_worker_routes.ts
//
// Admin routes for the M14.25 escalation worker primitive:
//   POST /v1/admin/escalations/preview — dry run; returns due[]
//   POST /v1/admin/escalations/tick    — dry run + dispatch; returns
//                                        due[] + dispatched[]
//
// Both take the open-case list as request body so the route stays
// decoupled from the CMS case store. Future M14.25b will wrap these
// with a cron + the live case source.
//
// Body shape:
//   { open_cases: OpenCaseRef[] }
//
// Response (preview):
//   { due, cases_inspected, cases_with_no_scenario,
//     cases_with_archived_escalation, already_dispatched_count }
// Response (tick):
//   ... + { dispatched }

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
  computeDueEscalations,
  dispatchDueEscalations,
  filterAlreadyDispatched,
  type EscalationWorkerDeps,
  type OpenCaseRef,
} from './escalation_worker';

export interface EscalationWorkerRouterDeps extends EscalationWorkerDeps {
  requireTenantMw: RequestHandler;
  requireRole: (op: string) => RequestHandler;
  now?: () => Date;
}

export class EscalationWorkerError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'EscalationWorkerError';
  }
}

const VALID_PRIORITIES = new Set(['P1', 'P2', 'P3', 'P4']);

function validateOpenCases(raw: unknown): OpenCaseRef[] {
  if (!Array.isArray(raw)) {
    throw new EscalationWorkerError(400, 'EWS_400_invalid_input', 'open_cases must be an array');
  }
  if (raw.length > 1000) {
    throw new EscalationWorkerError(400, 'EWS_400_invalid_input', 'open_cases max 1000 per request');
  }
  const out: OpenCaseRef[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') {
      throw new EscalationWorkerError(400, 'EWS_400_invalid_input', `open_cases[${i}] must be an object`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.case_id !== 'string' || !r.case_id.trim()) {
      throw new EscalationWorkerError(400, 'EWS_400_invalid_input', `open_cases[${i}].case_id required`);
    }
    if (typeof r.case_category !== 'string' || !r.case_category.trim()) {
      throw new EscalationWorkerError(400, 'EWS_400_invalid_input', `open_cases[${i}].case_category required`);
    }
    if (typeof r.priority !== 'string' || !VALID_PRIORITIES.has(r.priority)) {
      throw new EscalationWorkerError(400, 'EWS_400_invalid_input', `open_cases[${i}].priority must be P1..P4`);
    }
    if (typeof r.opened_at !== 'string' || !Number.isFinite(new Date(r.opened_at).getTime())) {
      throw new EscalationWorkerError(400, 'EWS_400_invalid_input', `open_cases[${i}].opened_at must be ISO 8601`);
    }
    if (
      r.context_vars !== undefined &&
      r.context_vars !== null &&
      (typeof r.context_vars !== 'object' || Array.isArray(r.context_vars))
    ) {
      throw new EscalationWorkerError(400, 'EWS_400_invalid_input', `open_cases[${i}].context_vars must be an object`);
    }
    out.push({
      case_id: r.case_id.trim(),
      case_category: r.case_category.trim(),
      priority: r.priority as OpenCaseRef['priority'],
      opened_at: r.opened_at,
      context_vars: (r.context_vars as Record<string, unknown> | undefined) ?? undefined,
    });
  }
  return out;
}

export function makeEscalationWorkerRouter(
  deps: EscalationWorkerRouterDeps,
): RouterType {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const {
    scenarioStore,
    escalationMatrixStore,
    templateStore,
    dispatchStore,
    requireTenantMw,
    requireRole,
  } = deps;

  const handleErr = (err: unknown, req: Request, res: Response): void => {
    const ctx = extractCtx(req, now);
    if (err instanceof EscalationWorkerError) {
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

  // Shared work for preview + tick — load scenarios once + run the
  // pure resolver + run the idempotency filter.
  async function resolve(tenant_id: string, open_cases: OpenCaseRef[]) {
    const scenarios = await scenarioStore.list(tenant_id, {
      status: ['ACTIVE'],
      page_size: 200,
    });
    const computed = await computeDueEscalations(
      tenant_id,
      open_cases,
      scenarios.items,
      (id) => escalationMatrixStore.get(tenant_id, id),
      (id) => templateStore.get(tenant_id, id),
      now(),
    );
    const filtered = await filterAlreadyDispatched(tenant_id, computed.due, dispatchStore);
    return {
      ...computed,
      due: filtered,
      already_dispatched_count: computed.due.length - filtered.length,
    };
  }

  router.post(
    '/v1/admin/escalations/preview',
    requireTenantMw,
    requireRole('admin:escalations:preview'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const body = (req.body ?? {}) as { open_cases?: unknown };
      const open_cases = validateOpenCases(body.open_cases ?? []);
      const out = await resolve(req.tenant!.tenant_id, open_cases);
      res.json(wrapResponse(out, ctx));
    }),
  );

  router.post(
    '/v1/admin/escalations/tick',
    requireTenantMw,
    requireRole('admin:escalations:tick'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const body = (req.body ?? {}) as { open_cases?: unknown };
      const open_cases = validateOpenCases(body.open_cases ?? []);
      const out = await resolve(req.tenant!.tenant_id, open_cases);
      const actor =
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() ||
        ((req.headers['x-apex-actor'] as string | undefined) ?? '').trim() ||
        'admin';
      const dispatched = await dispatchDueEscalations(
        req.tenant!.tenant_id,
        out.due,
        dispatchStore,
        now(),
        actor,
      );
      res.json(wrapResponse({ ...out, dispatched }, ctx));
    }),
  );

  return router;
}
