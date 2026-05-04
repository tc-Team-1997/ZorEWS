// services/regulatory-svc/alerts/src/server.ts
//
// HTTP entrypoints for the alert producer + smart-queue.
//
// Endpoints
// ---------
//   POST /alerts/evaluate      — evaluate a rule firing and emit canonical alert
//   GET  /alerts               — list queue entries, filterable by bucket / assignee
//   GET  /alerts/:id           — read one entry
//   POST /alerts/:id/assign    — set assignee {user_id}
//   POST /alerts/:id/ack       — analyst ack
//   POST /alerts/:id/close     — close with {outcome, note}
//   GET  /healthz              — liveness
//
// The factory `makeApp({...})` accepts injected producer / queue / scoreClient
// for test isolation. server.ts is also runnable as a standalone process.

import express, { NextFunction, Request, Response } from 'express';
import * as path from 'node:path';
import { AlertEvaluator } from './evaluator';
import { OutboxProducer, makeProducer, type Producer } from './producer';
import { SmartQueue, makeQueue, type IQueue } from './queue';
import { HttpScoreClient, StubScoreClient, type ScoreClient } from './score_client';
import type { Bucket, RuleFiring } from './types';
import { requireRole as rbacRequireRole } from '../../../../infra/rbac/lib/dist/src/index';

const ROLE_HEADER = 'x-apex-role';

/**
 * T4.24 Phase 6 — extract tenant context from the incoming request.
 * The BFF (or an upstream proxy) sets X-Tenant-ID; we default to
 * BANK_DEMO when absent (BFF is the strict gate, this service trusts
 * the upstream to have already verified).
 */
function tenantOf(req: Request): string {
  const v = req.headers['x-tenant-id'];
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  return 'BANK_DEMO';
}

function defaultGetRole(req: unknown): string | null {
  const r = req as { headers?: { [k: string]: string | string[] | undefined } };
  const v = r?.headers?.[ROLE_HEADER];
  return typeof v === 'string' && v ? v : null;
}

export interface AppDeps {
  producer?: Producer;
  queue?: IQueue;
  scoreClient?: ScoreClient;
  topic?: string;
  now?: () => Date;
  getRole?: (req: Request) => string | null;
}

export function makeApp(deps: AppDeps = {}) {
  const producer = deps.producer ?? makeProducer();
  const queue =
    deps.queue ??
    new SmartQueue(
      process.env.APEX_QUEUE_PATH ??
        path.resolve(__dirname, '..', '.queue', 'queue.ndjson'),
      (process.env.APEX_ANALYST_POOL ?? '').split(',').filter(Boolean),
    );
  const scoreClient: ScoreClient =
    deps.scoreClient ??
    (process.env.APEX_SCORE_URL
      ? new HttpScoreClient({ baseUrl: process.env.APEX_SCORE_URL })
      : new StubScoreClient(null));

  const evaluator = new AlertEvaluator({
    producer,
    queue,
    scoreClient,
    topic: deps.topic,
    now: deps.now,
  });
  const getRole = deps.getRole ?? defaultGetRole;
  const requireRole = (op: string) =>
    rbacRequireRole(op, getRole as (req: unknown) => string | null) as unknown as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void;
  // /alerts/evaluate is a producer endpoint called by the rule engine, not a
  // user operation; the matrix doesn't carry a dedicated op for it. Guard
  // inline as admin-only.
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const role = getRole(req);
    if (!role) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    if (role !== 'admin') {
      res
        .status(403)
        .json({ error: `role ${role} cannot POST /alerts/evaluate (admin only)` });
      return;
    }
    next();
  };

  const app = express();
  app.use(express.json({ limit: '512kb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // POST /alerts/evaluate
  app.post('/alerts/evaluate', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const firing = req.body as RuleFiring;
      const result = await evaluator.evaluate(firing, tenantOf(req));
      res.status(result.alertExisting ? 200 : 201).json(result);
    } catch (e) {
      next(e);
    }
  });

  // GET /alerts?bucket=critical|medium|low&assignee=&state=&page=1&pageSize=50
  app.get('/alerts', requireRole('alerts:list'), (req: Request, res: Response) => {
    const bucket = req.query.bucket as Bucket | undefined;
    const assignee = (req.query.assignee as string | undefined) || undefined;
    const state = (req.query.state as string | undefined) as
      | 'queued'
      | 'assigned'
      | 'acked'
      | 'closed'
      | undefined;
    const page = req.query.page ? Number(req.query.page) : undefined;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;
    res.json(queue.list({ tenant_id: tenantOf(req), bucket, assignee, state, page, pageSize }));
  });

  // GET /alerts/:id
  app.get('/alerts/:id', requireRole('alerts:read'), (req, res) => {
    const e = queue.get(req.params.id, tenantOf(req));
    if (!e) return res.status(404).json({ error: `alert ${req.params.id} not found` });
    res.json(e);
  });

  // POST /alerts/:id/assign  body: {user_id}
  app.post('/alerts/:id/assign', requireRole('alerts:assign'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.body as { user_id?: string };
      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }
      res.json(queue.assign(req.params.id, user_id, tenantOf(req)));
    } catch (e) {
      next(e);
    }
  });

  // POST /alerts/:id/ack
  app.post('/alerts/:id/ack', requireRole('alerts:ack'), (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(queue.ack(req.params.id, tenantOf(req)));
    } catch (e) {
      next(e);
    }
  });

  // POST /alerts/:id/close  body: {outcome, note?}
  app.post('/alerts/:id/close', requireRole('alerts:close'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const { outcome, note } = req.body as { outcome?: string; note?: string };
      if (!outcome) return res.status(400).json({ error: 'outcome is required' });
      res.json(queue.close(req.params.id, { outcome, note }, tenantOf(req)));
    } catch (e) {
      next(e);
    }
  });

  // Error handler.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
  });

  return { app, producer, queue, evaluator };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8082);
  void (async () => {
    const analysts = (process.env.APEX_ANALYST_POOL ?? '').split(',').filter(Boolean);
    const { queue } = await makeQueue(process.env, undefined, analysts);
    const { app, producer } = makeApp({ queue });
    app.listen(port, () => {
      const kind = producer instanceof OutboxProducer ? 'outbox' : 'kafka';
      // eslint-disable-next-line no-console
      console.log(
        `regulatory-svc/alerts listening on :${port} (producer=${kind}, store=${
          process.env.ALERTS_PG_URL ? 'postgres (app_alerts.*)' : 'ndjson'
        })`,
      );
    });
  })();
}
