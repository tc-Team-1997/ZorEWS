// services/collection-adapter/src/server.ts
//
// HTTP facade for the collection adapter:
//
//   POST /collection/callback   — Collection reports an outcome → close case
//   POST /process               — admin trigger: scan source, route eligible
//   GET  /healthz               — liveness

import express, { NextFunction, Request, Response } from 'express';
import { CasesClientError, makeCasesClient, type CasesClient } from './cases_client';
import { CollectionProcessor } from './processor';
import { makeCollectionSink, type CollectionSink } from './sink';
import { makeCaseEventSource, type CaseEventSource } from './source';
import type { CollectionCallbackInput, Outcome } from './types';
import { requireRole as rbacRequireRole } from '../../../infra/rbac/lib/dist/src/index';

const VALID_OUTCOMES: Outcome[] = ['cured', 'cured_temp', 'defaulted'];

const ROLE_HEADER = 'x-apex-role';
function defaultGetRole(req: unknown): string | null {
  const r = req as { headers?: { [k: string]: string | string[] | undefined } };
  const v = r?.headers?.[ROLE_HEADER];
  return typeof v === 'string' && v ? v : null;
}

export interface AppDeps {
  source?: CaseEventSource;
  sink?: CollectionSink;
  casesClient?: CasesClient;
  now?: () => Date;
  getRole?: (req: Request) => string | null;
}

export function makeApp(deps: AppDeps = {}) {
  const source = deps.source ?? makeCaseEventSource();
  const sink = deps.sink ?? makeCollectionSink();
  const casesClient = deps.casesClient ?? makeCasesClient();
  const now = deps.now ?? (() => new Date());
  const processor = new CollectionProcessor(source, sink, now);
  const getRole = deps.getRole ?? defaultGetRole;
  const requireRole = (op: string) =>
    rbacRequireRole(op, getRole as (req: unknown) => string | null) as unknown as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void;
  // /process is an admin-only diagnostic trigger; the matrix doesn't carry a
  // dedicated operation for it, so guard inline rather than expand the matrix.
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const role = getRole(req);
    if (!role) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    if (role !== 'admin') {
      res.status(403).json({ error: `role ${role} cannot trigger /process (admin only)` });
      return;
    }
    next();
  };

  const app = express();
  app.use(express.json({ limit: '512kb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post('/collection/callback', requireRole('collection:callback'), async (req: Request, res: Response) => {
    const body = req.body as Partial<CollectionCallbackInput>;
    const errs: string[] = [];
    if (!body?.case_id) errs.push('case_id is required');
    if (!body?.status || !VALID_OUTCOMES.includes(body.status as Outcome)) {
      errs.push(`status must be one of ${VALID_OUTCOMES.join(',')}`);
    }
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });

    try {
      const result = await casesClient.close(
        body.case_id as string,
        body.status as Outcome,
        body.note ?? null,
      );
      res.status(200).json({ ok: true, case: result });
    } catch (e) {
      if (e instanceof CasesClientError) {
        return res.status(e.status).json({ error: e.message, body: e.body });
      }
      res.status(502).json({ error: e instanceof Error ? e.message : 'upstream failure' });
    }
  });

  app.post('/process', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const report = await processor.process();
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'process failed' });
    }
  });

  return { app, source, sink, casesClient, processor };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8085);
  const { app } = makeApp();
  // eslint-disable-next-line no-console
  app.listen(port, () => console.log(`collection-adapter listening on :${port}`));
}
