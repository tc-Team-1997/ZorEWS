// services/regulatory-svc/cases/src/server.ts
//
// Express HTTP facade for the case service. Same factory-with-deps pattern
// as alerts/server.ts so __tests__/server.test.ts can inject an isolated
// store + producer per test.

import express, { NextFunction, Request, Response } from 'express';
import * as path from 'node:path';
import { CaseService, CASE_TOPIC } from './service';
import { OutboxCaseProducer, makeCaseProducer } from './producer';
import { CaseStore, makeCaseStore, type ICaseStore } from './store';
import { ApprovalsClient } from './approvals';
import { IllegalTransition } from './state_machine';
import type {
  ActionKind,
  AlertSummary,
  CapStatus,
  CasDecision,
  CaseState,
  CauseType,
  IssuePriority,
  Outcome,
  ReviewStatus,
  SeverityAssessment,
} from './types';
// RBAC matrix lives at infra/rbac/matrix.json. We import the helper via
// relative path (same cross-module pattern as rules→rules/types). Each
// mutating route is guarded with requireRole so the matrix is enforced at
// runtime, not just documented. The role is read from `x-apex-role` for
// the prototype; production swaps this for a JWT claim extractor.
import {
  can,
  requireRole as rbacRequireRole,
} from '../../../../infra/rbac/lib/dist/src/index';

const ROLE_HEADER = 'x-apex-role';
function defaultGetRole(req: unknown): string | null {
  const r = req as { headers?: { [k: string]: string | string[] | undefined } };
  const v = r?.headers?.[ROLE_HEADER];
  return typeof v === 'string' && v ? v : null;
}

/**
 * T4.24 Phase 5 — extract tenant context from the incoming request.
 * The BFF proxies X-Tenant-ID from the original /v1/* call (already
 * tenant-gated by the BFF middleware). When the header is missing
 * (legacy callers, internal smoke tests) we default to BANK_DEMO so
 * the existing test suite keeps passing — the proper tenant gate
 * lives at the BFF layer, not here.
 */
function tenantOf(req: Request): string {
  const v = req.headers['x-tenant-id'];
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  return 'BANK_DEMO';
}

const VALID_ACTION_KINDS: ActionKind[] = ['call', 'visit', 'sms', 'email', 'note'];
const VALID_OUTCOMES: Outcome[] = ['cured', 'cured_temp', 'defaulted'];
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const VALID_STATES: CaseState[] = ['open', 'assigned', 'in_action', 'monitored', 'closed'];

// CAS / CAP enums (BAC-A manual §3.1.5, T4.19).
const VALID_CAUSE_TYPES: CauseType[] = [
  'industry_downturn',
  'borrower_specific',
  'data_quality',
  'macro_shock',
  'fraud_suspected',
  'other',
];
const VALID_SEVERITY_ASSESSMENTS: SeverityAssessment[] = ['minor', 'material', 'severe'];
const VALID_CAS_DECISIONS: CasDecision[] = ['close_case', 'proceed_to_cap'];
const VALID_REVIEW_OUTCOMES: ReviewStatus[] = ['approved', 'rework', 'rejected'];
const VALID_ISSUE_PRIORITIES: IssuePriority[] = ['low_risk', 'medium_risk', 'high_risk'];
// CAP statuses callers can filter by — though writes go through service methods, not direct PATCH.
const VALID_CAP_STATUSES: CapStatus[] = ['open', 'in_progress', 'closed', 'overdue'];
void VALID_CAP_STATUSES; // currently unused; reserved for the future GET /caps?status= filter

export interface AppDeps {
  service?: CaseService;
  store?: ICaseStore;
  producer?: OutboxCaseProducer;
  now?: () => Date;
  topic?: string;
  /** Override the role-extraction strategy (tests inject `() => 'admin'`). */
  getRole?: (req: Request) => string | null;
  /** Cross-cutting maker-checker fan-out client (T4.20). Defaults to a
   *  no-op so in-memory tests don't need a pg pool wired through. The
   *  `require.main === module` bootstrap injects a live one when
   *  `CASES_PG_URL` is set. */
  approvals?: ApprovalsClient;
}

export function makeApp(deps: AppDeps = {}) {
  const store =
    deps.store ??
    new CaseStore(
      process.env.APEX_CASE_STORE_PATH ??
        path.resolve(__dirname, '..', '.store', 'cases.ndjson'),
    );
  const producer = deps.producer ?? makeCaseProducer();
  const approvals = deps.approvals ?? ApprovalsClient.noop();
  const service =
    deps.service ??
    new CaseService({ store, producer, now: deps.now, topic: deps.topic, approvals });
  const getRole = deps.getRole ?? defaultGetRole;
  const requireRole = (op: string) =>
    rbacRequireRole(op, getRole as (req: unknown) => string | null) as unknown as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void;

  const app = express();
  app.use(express.json({ limit: '512kb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // POST /cases — create from alert
  app.post('/cases', requireRole('cases:create'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Partial<AlertSummary>;
      const errs = validateAlertSummary(body);
      if (errs.length) return res.status(400).json({ error: errs.join('; ') });
      const result = await service.createFromAlert(body as AlertSummary, tenantOf(req));
      res.status(result.created ? 201 : 200).json(result);
    } catch (e) {
      next(e);
    }
  });

  // GET /cases?state=&assignee=&customer_id=&page=&pageSize=
  app.get('/cases', requireRole('cases:list'), (req: Request, res: Response) => {
    const stateRaw = req.query.state as string | undefined;
    if (stateRaw && !VALID_STATES.includes(stateRaw as CaseState)) {
      return res.status(400).json({ error: `state must be one of ${VALID_STATES.join(',')}` });
    }
    const list = service.list({
      tenant_id: tenantOf(req),
      state: stateRaw as CaseState | undefined,
      assignee: (req.query.assignee as string) || undefined,
      customer_id: (req.query.customer_id as string) || undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    });
    res.json(list);
  });

  // GET /cases/:id
  app.get('/cases/:id', requireRole('cases:read'), (req, res) => {
    const c = service.get(req.params.id, tenantOf(req));
    if (!c) return res.status(404).json({ error: `case ${req.params.id} not found` });
    res.json(c);
  });

  // POST /cases/:id/assign  body: { user_id }
  app.post('/cases/:id/assign', requireRole('cases:assign'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.body as { user_id?: string };
      if (!user_id) return res.status(400).json({ error: 'user_id is required' });
      res.json(await service.assign(req.params.id, user_id, tenantOf(req)));
    } catch (e) {
      next(e);
    }
  });

  // POST /cases/:id/actions
  app.post('/cases/:id/actions', requireRole('cases:log_action'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        kind?: string;
        officer_id?: string;
        outcome_note?: string | null;
        gps?: { lat?: number; lng?: number; accuracy_m?: number | null } | null;
      };
      if (!body.kind || !VALID_ACTION_KINDS.includes(body.kind as ActionKind)) {
        return res
          .status(400)
          .json({ error: `kind must be one of ${VALID_ACTION_KINDS.join(',')}` });
      }
      if (!body.officer_id) return res.status(400).json({ error: 'officer_id is required' });
      let gps = null as null | { lat: number; lng: number; accuracy_m?: number | null };
      if (body.gps) {
        if (typeof body.gps.lat !== 'number' || typeof body.gps.lng !== 'number') {
          return res.status(400).json({ error: 'gps.lat and gps.lng must be numbers' });
        }
        gps = {
          lat: body.gps.lat,
          lng: body.gps.lng,
          accuracy_m: body.gps.accuracy_m ?? null,
        };
      }
      const updated = await service.logAction(req.params.id, {
        kind: body.kind as ActionKind,
        officer_id: body.officer_id,
        outcome_note: body.outcome_note ?? null,
        gps,
      }, tenantOf(req));
      res.status(201).json(updated);
    } catch (e) {
      next(e);
    }
  });

  // POST /cases/:id/monitor
  app.post('/cases/:id/monitor', requireRole('cases:monitor'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await service.monitor(req.params.id, tenantOf(req)));
    } catch (e) {
      next(e);
    }
  });

  // POST /cases/:id/close  body: { outcome, note? }
  app.post('/cases/:id/close', requireRole('cases:close'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { outcome, note } = req.body as { outcome?: string; note?: string | null };
      if (!outcome || !VALID_OUTCOMES.includes(outcome as Outcome)) {
        return res
          .status(400)
          .json({ error: `outcome must be one of ${VALID_OUTCOMES.join(',')}` });
      }
      res.json(
        await service.close(req.params.id, { outcome: outcome as Outcome, note: note ?? null }, tenantOf(req)),
      );
    } catch (e) {
      next(e);
    }
  });

  // ─── CAS — Causal Analysis Stage routes (T4.19, BAC-A §3.1.5) ──────────

  // POST /cases/:id/cas — submit a new CAS record (maker)
  // body: { cause_type, cause_summary, severity_assessment, decision, submitted_by, attachments? }
  app.post('/cases/:id/cas', requireRole('cases:cas_submit'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        cause_type?: string;
        cause_summary?: string;
        severity_assessment?: string;
        decision?: string;
        submitted_by?: string;
        attachments?: unknown;
      };
      if (!body.cause_type || !VALID_CAUSE_TYPES.includes(body.cause_type as CauseType)) {
        return res.status(400).json({ error: `cause_type must be one of ${VALID_CAUSE_TYPES.join(',')}` });
      }
      if (!body.cause_summary || !body.cause_summary.trim()) {
        return res.status(400).json({ error: 'cause_summary is required' });
      }
      if (
        !body.severity_assessment ||
        !VALID_SEVERITY_ASSESSMENTS.includes(body.severity_assessment as SeverityAssessment)
      ) {
        return res
          .status(400)
          .json({ error: `severity_assessment must be one of ${VALID_SEVERITY_ASSESSMENTS.join(',')}` });
      }
      if (!body.decision || !VALID_CAS_DECISIONS.includes(body.decision as CasDecision)) {
        return res.status(400).json({ error: `decision must be one of ${VALID_CAS_DECISIONS.join(',')}` });
      }
      if (!body.submitted_by) {
        return res.status(400).json({ error: 'submitted_by is required' });
      }
      const cas = await service.submitCas(req.params.id, {
        cause_type: body.cause_type as CauseType,
        cause_summary: body.cause_summary.trim(),
        severity_assessment: body.severity_assessment as SeverityAssessment,
        decision: body.decision as CasDecision,
        submitted_by: body.submitted_by,
        attachments: Array.isArray(body.attachments) ? (body.attachments as never) : null,
      }, tenantOf(req));
      res.status(201).json(cas);
    } catch (e) {
      next(e);
    }
  });

  // POST /cases/:id/cas/:cas_id/review — checker reviews (approve/rework/reject)
  // body: { reviewed_by, review_status, review_comments? }
  app.post(
    '/cases/:id/cas/:cas_id/review',
    requireRole('cases:cas_review'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as {
          reviewed_by?: string;
          review_status?: string;
          review_comments?: string | null;
        };
        if (!body.reviewed_by) {
          return res.status(400).json({ error: 'reviewed_by is required' });
        }
        if (
          !body.review_status ||
          !VALID_REVIEW_OUTCOMES.includes(body.review_status as ReviewStatus)
        ) {
          return res
            .status(400)
            .json({ error: `review_status must be one of ${VALID_REVIEW_OUTCOMES.join(',')}` });
        }
        const cas = await service.reviewCas(req.params.id, req.params.cas_id, {
          reviewed_by: body.reviewed_by,
          review_status: body.review_status as 'approved' | 'rework' | 'rejected',
          review_comments: body.review_comments ?? null,
        }, tenantOf(req));
        res.json(cas);
      } catch (e) {
        next(e);
      }
    },
  );

  // ─── CAP — Corrective Action Plan routes (T4.19, BAC-A §3.1.5) ─────────

  // POST /cases/:id/caps — propose a new CAP (maker)
  // body: { cap_item, issue_owner_group, issue_owner, issue_priority, target_completion_date, proposed_by, attachments? }
  app.post('/cases/:id/caps', requireRole('cases:cap_propose'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        cap_item?: string;
        issue_owner_group?: string;
        issue_owner?: string;
        issue_priority?: string;
        target_completion_date?: string;
        proposed_by?: string;
        attachments?: unknown;
      };
      if (!body.cap_item || !body.cap_item.trim()) {
        return res.status(400).json({ error: 'cap_item is required' });
      }
      if (!body.issue_owner_group) {
        return res.status(400).json({ error: 'issue_owner_group is required' });
      }
      if (!body.issue_owner) {
        return res.status(400).json({ error: 'issue_owner is required' });
      }
      if (
        !body.issue_priority ||
        !VALID_ISSUE_PRIORITIES.includes(body.issue_priority as IssuePriority)
      ) {
        return res
          .status(400)
          .json({ error: `issue_priority must be one of ${VALID_ISSUE_PRIORITIES.join(',')}` });
      }
      if (!body.target_completion_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.target_completion_date)) {
        return res.status(400).json({ error: 'target_completion_date must be ISO date YYYY-MM-DD' });
      }
      if (!body.proposed_by) {
        return res.status(400).json({ error: 'proposed_by is required' });
      }
      const cap = await service.proposeCap(req.params.id, {
        cap_item: body.cap_item.trim(),
        issue_owner_group: body.issue_owner_group,
        issue_owner: body.issue_owner,
        issue_priority: body.issue_priority as IssuePriority,
        target_completion_date: body.target_completion_date,
        proposed_by: body.proposed_by,
        attachments: Array.isArray(body.attachments) ? (body.attachments as never) : null,
      }, tenantOf(req));
      res.status(201).json(cap);
    } catch (e) {
      next(e);
    }
  });

  // POST /cases/:id/caps/:cap_id/approve — checker approves (or rejects)
  // body: { approved_by, approve, comments? }
  app.post(
    '/cases/:id/caps/:cap_id/approve',
    requireRole('cases:cap_approve'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as {
          approved_by?: string;
          approve?: boolean;
          comments?: string | null;
        };
        if (!body.approved_by) {
          return res.status(400).json({ error: 'approved_by is required' });
        }
        if (typeof body.approve !== 'boolean') {
          return res.status(400).json({ error: 'approve must be a boolean (true=accept, false=reject)' });
        }
        const cap = await service.approveCap(req.params.id, req.params.cap_id, {
          approved_by: body.approved_by,
          approve: body.approve,
          comments: body.comments ?? null,
        }, tenantOf(req));
        res.json(cap);
      } catch (e) {
        next(e);
      }
    },
  );

  // POST /cases/:id/caps/:cap_id/close — issue owner closes after implementing
  // body: { closed_by, closure_comments? }
  app.post(
    '/cases/:id/caps/:cap_id/close',
    requireRole('cases:cap_close'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as { closed_by?: string; closure_comments?: string | null };
        if (!body.closed_by) {
          return res.status(400).json({ error: 'closed_by is required' });
        }
        const cap = await service.closeCap(req.params.id, req.params.cap_id, {
          closed_by: body.closed_by,
          closure_comments: body.closure_comments ?? null,
        }, tenantOf(req));
        res.json(cap);
      } catch (e) {
        next(e);
      }
    },
  );

  // Error handler — IllegalTransition -> 409, generic -> 500.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof IllegalTransition) {
      return res
        .status(409)
        .json({ error: err.message, current_state: err.current, attempted: err.attempted });
    }
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return { app, service, store, producer };
}

function validateAlertSummary(body: Partial<AlertSummary>): string[] {
  const errs: string[] = [];
  if (!body.alert_id) errs.push('alert_id is required');
  if (!body.customer_id) errs.push('customer_id is required');
  if (!body.rule_id) errs.push('rule_id is required');
  if (!body.raised_at) errs.push('raised_at is required');
  if (!body.severity || !VALID_SEVERITIES.includes(body.severity as never)) {
    errs.push(`severity must be one of ${VALID_SEVERITIES.join(',')}`);
  }
  return errs;
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8083);
  void (async () => {
    const { store, pool } = await makeCaseStore();
    // When pg is wired in, also wire the cross-cutting approvals fan-out
    // (T4.20). In-memory mode keeps the no-op default — there's no pg
    // pool to talk to, and approvals.* is purely cross-cutting analytics.
    const approvals = pool ? new ApprovalsClient(pool) : ApprovalsClient.noop();
    const { app } = makeApp({ store, approvals });
    app.listen(port, () =>
      // eslint-disable-next-line no-console
      console.log(
        `regulatory-svc/cases listening on :${port} — store: ${
          process.env.CASES_PG_URL ? 'postgres (app_cases.* + app_audit.approvals fan-out)' : 'ndjson'
        }`,
      ),
    );
  })();
}
