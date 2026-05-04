// Indicator compute HTTP service.
//
// Endpoints:
//   GET    /healthz                    — liveness, also reports registry status
//   POST   /indicators/compute         — body {customer_id, snapshot_date}
//                                        → returns array of {indicator_id, value, breached, severity}
//   POST   /indicators/compute/batch   — body {items: [{customer_id, snapshot_date}, ...]}
//                                        → returns one EvaluateResult per request
//   GET    /indicators                 — returns the catalog (for downstream agents)
//
// Breached records are emitted on the in-process emitter — by default the
// emitter prints `// emit to apex.indicator.values` markers; agent-integration
// will swap in a Kafka producer in Phase 1 wiring.

import express, { Request, Response, NextFunction } from 'express';
import { IndicatorEngine, IndicatorEventEmitter, defaultEmitter, EvaluateRequest } from './engine';
import { InMemoryMartReader, MartReader } from './mart/reader';
import { COMPUTE_REGISTRY } from './compute';
import { checkRegistryAgainstCatalog, loadCatalog, loadCatalogFor, loadInsuranceCatalog } from './catalog';

const ROLE_HEADER = 'x-apex-role';
function defaultGetRole(req: unknown): string | null {
  const r = req as { headers?: { [k: string]: string | string[] | undefined } };
  const v = r?.headers?.[ROLE_HEADER];
  return typeof v === 'string' && v ? v : null;
}

export interface ServerOptions {
  reader?: MartReader;
  emitter?: IndicatorEventEmitter;
  getRole?: (req: Request) => string | null;
}

export function makeApp(opts: ServerOptions = {}) {
  const reader = opts.reader ?? new InMemoryMartReader();
  const emitter = opts.emitter ?? defaultEmitter;
  const engine = new IndicatorEngine({ reader, emitter });
  const getRole = opts.getRole ?? defaultGetRole;

  // /indicators/compute is a system-internal endpoint called by ai-copilot-svc
  // and the rule engine — admin-only inline (matrix doesn't carry an
  // `indicators:compute` op because it's not a published operator action).
  // /healthz and /indicators (catalog read) stay open: the SPA's rule editor
  // needs the catalog before login is required by some flows, and /healthz
  // is k8s-probe-friendly.
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const role = getRole(req);
    if (!role) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    if (role !== 'admin') {
      res
        .status(403)
        .json({ error: `role ${role} cannot run /indicators/compute (admin only)` });
      return;
    }
    next();
  };

  // Registry-completeness guard at boot. We don't throw here — we just
  // expose the result on /healthz so an integration test can assert it.
  const registryCheck = checkRegistryAgainstCatalog(COMPUTE_REGISTRY);

  const app = express();
  app.use(express.json({ limit: '512kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: registryCheck.ok,
      registry: {
        catalog_size: loadCatalog().indicators.length,
        compute_size: Object.keys(COMPUTE_REGISTRY).length,
        missing: registryCheck.missing,
        extras: registryCheck.extras,
      },
    });
  });

  app.get('/indicators', (_req, res) => {
    res.json(loadCatalog());
  });

  // T6 M4.1 — BIL insurance catalog (5 KRI families: Policy / Customer /
  // Agent / Claim / Operational; 25 indicators total). Read-only contract;
  // compute fns land alongside the BIL synthetic-data follow-up.
  app.get('/indicators/insurance', (_req, res) => {
    res.json(loadInsuranceCatalog());
  });

  // Vertical-aware shortcut. Caller passes ?vertical=banking|insurance and
  // gets the matching catalog. Tenants carry vertical (T4.24 Phase 1) so
  // the BFF can forward `?vertical=${req.tenant.vertical}` and the
  // indicator service picks the right one without the BFF hard-coding.
  app.get('/indicators/by-vertical', (req, res) => {
    const v = (req.query.vertical as string | undefined) ?? 'banking';
    if (v !== 'banking' && v !== 'insurance') {
      return res.status(400).json({
        error: `vertical must be 'banking' or 'insurance' (got '${v}')`,
      });
    }
    res.json(loadCatalogFor(v));
  });

  app.post('/indicators/compute', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Partial<EvaluateRequest>;
      if (!body || !body.customer_id || !body.snapshot_date) {
        return res.status(400).json({ error: 'customer_id and snapshot_date are required' });
      }
      const result = await engine.evaluate({
        customer_id: body.customer_id,
        snapshot_date: body.snapshot_date,
      });
      if (result.not_found) {
        return res.status(404).json({
          error: `no mart snapshot for customer ${body.customer_id} at ${body.snapshot_date}`,
        });
      }
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.post('/indicators/compute/batch', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { items?: EvaluateRequest[] };
      if (!body || !Array.isArray(body.items) || body.items.length === 0) {
        return res.status(400).json({ error: 'items[] is required' });
      }
      for (const it of body.items) {
        if (!it.customer_id || !it.snapshot_date) {
          return res.status(400).json({ error: 'each item needs customer_id and snapshot_date' });
        }
      }
      const results = await engine.evaluateBatch(body.items);
      res.json({ results });
    } catch (e) {
      next(e);
    }
  });

  // error handler
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8082);
  const check = checkRegistryAgainstCatalog(COMPUTE_REGISTRY);
  if (!check.ok) {
    // eslint-disable-next-line no-console
    console.error(
      `[indicator-svc] FATAL: compute registry does not match catalog. missing=${JSON.stringify(
        check.missing,
      )} extras=${JSON.stringify(check.extras)}`,
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  makeApp().listen(port, () => console.log(`regulatory-svc/indicators listening on :${port}`));
}
