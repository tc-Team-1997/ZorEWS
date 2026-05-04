// Rule lifecycle HTTP service.
//
// Endpoints:
//   POST   /rules                  — create draft
//   GET    /rules                  — list
//   GET    /rules/:id              — read
//   POST   /rules/:id/simulate     — run sim against indicator history
//   POST   /rules/:id/promote      — draft|simulate → live (requires sim pass)
//   POST   /rules/:id/retire       — any → retired
//   GET    /rules/:id/audit        — audit-log entries for the rule
//
// All state-transitions append to an in-memory audit list — comments mark
// where agent-integration should bridge to the apex.audit.events Kafka topic.

import express, { Request, Response, NextFunction } from 'express';
import { RuleStore } from './lifecycle';
import { Rule } from '../../../../rules/types';
import { buildReport, loadHistory } from './simulator';
import { requireRole as rbacRequireRole } from '../../../../infra/rbac/lib/dist/src/index';

const ROLE_HEADER = 'x-apex-role';
function defaultGetRole(req: unknown): string | null {
  const r = req as { headers?: { [k: string]: string | string[] | undefined } };
  const v = r?.headers?.[ROLE_HEADER];
  return typeof v === 'string' && v ? v : null;
}

export interface AppDeps {
  store?: RuleStore;
  getRole?: (req: Request) => string | null;
}

export function makeApp(deps: AppDeps | RuleStore = {}) {
  // Backwards-compat: callers used to pass a bare RuleStore positional arg.
  // Detect that shape and adapt.
  const isStore = (x: unknown): x is RuleStore =>
    typeof x === 'object' && x !== null && 'audit' in (x as object);
  const cfg: AppDeps = isStore(deps) ? { store: deps } : deps;

  const store = cfg.store ?? new RuleStore();
  const getRole = cfg.getRole ?? defaultGetRole;
  const requireRole = (op: string) =>
    rbacRequireRole(op, getRole as (req: unknown) => string | null) as unknown as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void;

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // health
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // POST /rules — create draft
  app.post('/rules', requireRole('rules:create'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const rule = req.body as Rule;
      const created = store.create(rule, (req.header('x-actor') ?? 'system'));
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  });

  // GET /rules
  app.get('/rules', requireRole('rules:list'), (_req, res) => {
    res.json({ rules: store.list() });
  });

  // GET /rules/:id
  app.get('/rules/:id', requireRole('rules:read'), (req, res) => {
    const r = store.get(req.params.id);
    if (!r) return res.status(404).json({ error: `rule ${req.params.id} not found` });
    res.json(r);
  });

  // POST /rules/:id/simulate — runs the simulator and stores summary
  app.post('/rules/:id/simulate', requireRole('rules:simulate'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const r = store.get(id);
      if (!r) return res.status(404).json({ error: `rule ${id} not found` });
      const history = loadHistory();
      const report = buildReport([r], history);
      const summary = {
        rule_id: report.rules[0].rule_id,
        total_firings: report.rules[0].total_firings,
        fp_rate: report.rules[0].fp_rate,
        median_lead_time_days: report.rules[0].median_lead_time_days,
      };
      store.recordSimulation(id, summary, req.header('x-actor') ?? 'system');
      res.json({ summary, full: report.rules[0] });
    } catch (e) {
      next(e);
    }
  });

  // POST /rules/:id/promote — lifecycle transition; same role set as retire
  // (admin, supervisor). The matrix doesn't carry a dedicated `rules:promote`
  // op because both promotions and retirements are "manage rule lifecycle"
  // gestures and we don't split them by role.
  app.post('/rules/:id/promote', requireRole('rules:retire'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = store.promote(req.params.id, req.header('x-actor') ?? 'system');
      res.json(r);
    } catch (e) {
      next(e);
    }
  });

  // POST /rules/:id/retire
  app.post('/rules/:id/retire', requireRole('rules:retire'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const reason = (req.body && (req.body as { reason?: string }).reason) || undefined;
      const r = store.retire(req.params.id, req.header('x-actor') ?? 'system', reason);
      res.json(r);
    } catch (e) {
      next(e);
    }
  });

  // GET /rules/:id/audit
  app.get('/rules/:id/audit', requireRole('audit:read'), (req, res) => {
    const events = store.audit.filter((a) => a.rule_id === req.params.id);
    res.json({ events });
  });

  // error handler
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8081);
  // eslint-disable-next-line no-console
  makeApp().listen(port, () => console.log(`regulatory-svc/rules listening on :${port}`));
}
