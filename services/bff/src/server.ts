// services/bff/src/server.ts
//
// HTTP facade. Two surfaces:
//
//   /api/*  — internal BFF for the SPA (currently `/api/alerts` from T3.10).
//   /v1/*   — public REST API v1 (T3.7): /v1/alerts, /v1/ews/evaluate,
//             /v1/risk-profile/:customer_id, /v1/action.
//
// Both consume the same mapping pipeline and lookups. /v1 is what external
// partners (mobile, CBS adapters, regulators) call; /api is what the SPA's
// MSW currently fakes.

import express, { NextFunction, Request, Response } from 'express';
import { dedupeByAlertId, mapAlertList } from './mapping';
import { makeAlertSource, type AlertSource } from './source';
import { makeSeedLookups } from './lookups';
import {
  CaseActionError,
  makeCaseActionSink,
  type CaseActionInput,
  type CaseActionSink,
} from './case_action';
import {
  StubEvaluator,
  type CustomerFeatures,
  type Evaluator,
} from './score';
import { StubRiskProfileSource, type RiskProfileSource } from './risk_profile';
import type { Lookups, UiSeverity } from './types';
import { requireRole as rbacRequireRole } from '../../../infra/rbac/lib/dist/src/index';
import { respondAsync as copilotRespond, type ChatRequest } from './copilot/chat';
import { runScenario, validateShocks } from './scenario/engine';
import { defaultPortfolio, type Account } from './scenario/portfolio';
import {
  InMemoryScenarioStore,
  makeScenarioStore,
  type IScenarioStore,
} from './scenario/store';
import { reportFor } from './reports/compute';
import { reportToCsv } from './reports/csv';
import { reportToPdf } from './reports/pdf';
import { reportToXlsx } from './reports/xlsx';
import type { ReportPeriod, ReportType } from './reports/types';
import { pingIntegrations, type Fetcher, type HealthReport } from './integrations/health';
import { summarise as summariseSla, type SlaCase } from './sla/evaluator';
import { makeFleet } from './sla/data';
import { defaultBus, NotificationBus } from './notifications/bus';
import { openSse } from './notifications/sse';
import type { NotificationLevel } from './notifications/types';
import { defaultWebhookStore, makeWebhookStore, type IWebhookStore } from './webhooks/store';
import { WebhookDispatcher } from './webhooks/dispatcher';
import type { WebhookEventType } from './webhooks/types';
import { RuleStore, defaultStore as defaultRuleStore } from './rules/store';
import { variablesByCategory } from './rules/variables';
import { backtest as runBacktest } from './rules/backtest';
import { performanceFor } from './rules/performance';
import {
  applyTransition,
  IllegalTransition,
  InvalidPayload,
  legalTransitions,
  rbacFor,
  type Transition as RuleTransition,
} from './rules/state_machine';
import type { RuleProduct, RuleState as RuleV2State } from './rules/types';
import { wrapError, wrapResponse, readRequestId, extractCtx, EnterpriseError, type ErrorSeverity } from './envelope';
import { requireTenant, defaultTenantLookup, type TenantLookup } from './tenant';
import { makeJwtVerifier, type JwtVerifier } from './jwks_client';

const ROLE_HEADER = 'x-apex-role';
function defaultGetRole(req: unknown): string | null {
  const r = req as { headers?: { [k: string]: string | string[] | undefined } };
  const v = r?.headers?.[ROLE_HEADER];
  return typeof v === 'string' && v ? v : null;
}

const VALID_SEVERITIES: UiSeverity[] = ['low', 'medium', 'high', 'critical'];
const VALID_ACTION_KINDS = ['call', 'visit', 'sms', 'email', 'note'] as const;

export interface AppDeps {
  source?: AlertSource;
  lookups?: Lookups;
  evaluator?: Evaluator;
  riskProfile?: RiskProfileSource;
  caseAction?: CaseActionSink;
  /** Override for tests — defaults to the cached synthetic portfolio. */
  portfolio?: Account[];
  /** Override for tests — pings the integration-mocks service when omitted. */
  integrationsFetcher?: Fetcher;
  /** Override for tests — defaults to a deterministic synthetic fleet. */
  slaFleet?: SlaCase[];
  /** Override for tests — defaults to the module-level singleton. */
  notificationBus?: NotificationBus;
  /** Override for tests — defaults to the seeded singleton. */
  ruleStore?: RuleStore;
  /**
   * Override for tests — webhook subscription store. Defaults to the
   * module-level singleton. Tests pass a fresh store per test so
   * subscriptions don't leak across runs. Production callers
   * should call makeWebhookStore() (env-driven factory) and pass
   * the result here so a pg-backed store can be injected when
   * BFF_PG_URL is set.
   */
  webhookStore?: IWebhookStore;
  /**
   * Override for tests — webhook dispatcher. Tests inject a custom
   * fetch + zero retry-delays so they don't hang for 21s on an HTTP
   * failure path.
   */
  webhookDispatcher?: WebhookDispatcher;
  /**
   * Override for tests — saved-scenario store. Defaults to a fresh
   * in-memory store per call so tests stay isolated. Production callers
   * should call makeScenarioStore() (env-driven factory) and pass the
   * result here so a pg-backed store is used when BFF_PG_URL is set.
   */
  scenarioStore?: IScenarioStore;
  /**
   * Override for tests — tenant lookup used by the multi-tenant
   * middleware (T4.24). Defaults to the in-memory registry mirroring
   * 005_tenants.sql (BANK_DEMO + BIL).
   */
  tenantLookup?: TenantLookup;
  /**
   * Override for tests — JWT verifier used by the multi-tenant
   * middleware to extract `tenant_id` from the Authorization Bearer
   * token (T4.24 Phase 7). Defaults to env-driven: BFF_JWKS_URL set →
   * remote JWKS verification; unset → InsecureDecodeVerifier (the
   * Phase 3 shim, retained for hermetic tests).
   */
  jwtVerifier?: JwtVerifier;
  now?: () => Date;
  getRole?: (req: Request) => string | null;
}

export function makeApp(deps: AppDeps = {}) {
  const source = deps.source ?? makeAlertSource();
  const lookups = deps.lookups ?? makeSeedLookups();
  const evaluator = deps.evaluator ?? new StubEvaluator();
  const riskProfile = deps.riskProfile ?? new StubRiskProfileSource();
  const caseAction = deps.caseAction ?? makeCaseActionSink();
  const portfolio = deps.portfolio ?? defaultPortfolio();
  const bus = deps.notificationBus ?? defaultBus;
  const ruleStore = deps.ruleStore ?? defaultRuleStore;
  const webhookStore = deps.webhookStore ?? defaultWebhookStore;
  const webhookDispatcher = deps.webhookDispatcher ?? new WebhookDispatcher(webhookStore);
  const scenarioStore = deps.scenarioStore ?? new InMemoryScenarioStore();
  const tenantLookup = deps.tenantLookup ?? defaultTenantLookup();
  const jwtVerifier = deps.jwtVerifier ?? makeJwtVerifier();
  const requireTenantMw = requireTenant(tenantLookup, jwtVerifier);
  const now = deps.now ?? (() => new Date());
  const getRole = deps.getRole ?? defaultGetRole;
  const requireRole = (op: string) =>
    rbacRequireRole(op, getRole as (req: unknown) => string | null) as unknown as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void;

  const app = express();
  // Hide express's identifying header before any route runs.
  app.disable('x-powered-by');
  // OWASP-recommended security headers — applies to every response.
  // Loaded lazily so test imports don't pull in the middleware module
  // unless they boot the server.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { securityHeaders } = require('./security_headers');
  app.use(securityHeaders());
  app.use(express.json({ limit: '512kb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // ---------- /api (internal BFF — T3.10) ----------
  app.get('/api/alerts', requireRole('alerts:list'), (req, res) =>
    listAlerts(req, res, source, lookups, now),
  );

  // ---------- /v1 (public REST API v1 — T3.7, envelope + tenant per T4.24) ----------

  /**
   * /v1/alerts — same data + filters as /api/alerts; T4.24 wraps the
   * response in the bank-grade envelope and gates on tenant context.
   */
  app.get('/v1/alerts', requireTenantMw, requireRole('alerts:list'), (req, res) => {
    const ctx = extractCtx(req, now);
    const sevRaw = req.query.severity as string | undefined;
    if (sevRaw && !VALID_SEVERITIES.includes(sevRaw as UiSeverity)) {
      return res.status(400).json(
        wrapError(
          {
            code: 'EWS_400',
            message: `severity must be one of ${VALID_SEVERITIES.join(',')}`,
            severity: 'MEDIUM',
          },
          ctx,
        ),
      );
    }
    const assignee = (req.query.assignee as string | undefined) || undefined;
    const canonicals = dedupeByAlertId(source.read());
    const items = mapAlertList(
      canonicals,
      lookups,
      { severity: sevRaw as UiSeverity | undefined, assignee },
      now,
    );
    res.json(wrapResponse({ items, total: items.length }, ctx));
  });

  /**
   * POST /v1/ews/evaluate — Banking API §6 reference shape (T4.24).
   *
   * Request envelope:
   *   { header: { tenantId, channel, requestId, timestamp }, body: { customer_id?, features? } }
   *
   * Response envelope (success):
   *   { header: { status: 'SUCCESS', code, message, requestId, timestamp }, body: ScoreResponse }
   *
   * Response envelope (error, §11 shape):
   *   { header: { status: 'FAILURE', requestId, timestamp }, error: { code, message, severity } }
   *
   * Tenant context (X-Tenant-ID + X-Channel) is enforced via the
   * requireTenant middleware before this handler runs.
   *
   * Legacy callers that POST a bare body (no envelope) are still served:
   * the handler peels `body.body` if present, otherwise treats the whole
   * payload as the inner body — preserves T3.7 compatibility while
   * partners migrate.
   */
  app.post(
    '/v1/ews/evaluate',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const requestId = readRequestId(req.body);
      const ctx = { requestId, timestamp: now().toISOString() };
      // Accept both envelope (`{header, body}`) and legacy raw shapes.
      const raw = req.body as { header?: unknown; body?: unknown; customer_id?: unknown; features?: unknown };
      const inner =
        raw && typeof raw === 'object' && raw.header && raw.body && typeof raw.body === 'object'
          ? (raw.body as { customer_id?: unknown; features?: unknown })
          : raw;
      const customer_id =
        typeof inner?.customer_id === 'string' && inner.customer_id ? inner.customer_id : undefined;
      const features = (inner?.features as CustomerFeatures | undefined) ?? undefined;
      if (!customer_id && !features) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400',
              message: 'either customer_id or features is required',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      try {
        const score = await evaluator.evaluate({ customer_id, features });
        if (score.level === 'High') {
          // Fire-and-forget — webhook latency doesn't delay the API response.
          // Phase 4: only fires to subscriptions in the same tenant.
          webhookDispatcher.dispatch(
            'alert.created',
            {
              tenant_id: req.tenant?.tenant_id,
              channel: req.channel,
              customer_id: score.customer_id,
              pd: score.pd,
              level: score.level,
              top_reasons: score.top_reasons,
              model_name: score.model_name,
              model_version: score.model_version,
              evaluated_at: now().toISOString(),
            },
            req.tenant!.tenant_id,
          );
        }
        res.json(wrapResponse(score, ctx));
      } catch (e) {
        if (e instanceof EnterpriseError) {
          return res.status(e.status).json(wrapError(e.payload, ctx));
        }
        res.status(500).json(
          wrapError(
            {
              code: 'EWS_500',
              message: e instanceof Error ? e.message : 'evaluation failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * GET /v1/risk-profile/:customer_id — T4.24 envelope + tenant.
   * 404 returns the §11 error envelope; success returns SUCCESS envelope.
   */
  app.get(
    '/v1/risk-profile/:customer_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      try {
        const profile = await riskProfile.get(req.params.customer_id);
        if (!profile) {
          return res.status(404).json(
            wrapError(
              {
                code: 'EWS_404',
                message: `customer ${req.params.customer_id} not found`,
                severity: 'LOW',
              },
              ctx,
            ),
          );
        }
        res.json(wrapResponse(profile, ctx));
      } catch (e) {
        res.status(500).json(
          wrapError(
            {
              code: 'EWS_500',
              message: e instanceof Error ? e.message : 'lookup failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * POST /v1/action — T4.24 envelope + tenant.
   * body: { case_id, kind, officer_id, outcome_note?, gps? } (or wrapped).
   * Proxies to regulatory-svc/cases POST /cases/:id/actions.
   */
  app.post(
    '/v1/action',
    requireTenantMw,
    requireRole('cases:log_action'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as
        | { header?: unknown; body?: unknown }
        | Partial<CaseActionInput>;
      const inner = (raw && typeof raw === 'object' && 'header' in raw && 'body' in raw && raw.body && typeof raw.body === 'object'
        ? (raw.body as Partial<CaseActionInput>)
        : (raw as Partial<CaseActionInput>));
      const errs: string[] = [];
      if (!inner?.case_id) errs.push('case_id is required');
      if (!inner?.kind || !VALID_ACTION_KINDS.includes(inner.kind as never)) {
        errs.push(`kind must be one of ${VALID_ACTION_KINDS.join(',')}`);
      }
      if (!inner?.officer_id) errs.push('officer_id is required');
      if (inner?.gps) {
        if (typeof inner.gps.lat !== 'number' || typeof inner.gps.lng !== 'number') {
          errs.push('gps.lat and gps.lng must be numbers');
        }
      }
      if (errs.length) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: errs.join('; '), severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const result = await caseAction.log({
          ...(inner as CaseActionInput),
          tenant_id: req.tenant?.tenant_id,
          channel: req.channel,
        });
        res
          .status(201)
          .json(wrapResponse(result, ctx, { code: 'EWS_201', message: 'Created' }));
      } catch (e) {
        if (e instanceof CaseActionError) {
          return res.status(e.status).json(
            wrapError(
              {
                code: `EWS_${e.status}`,
                message: e.message,
                severity: e.status >= 500 ? 'HIGH' : 'MEDIUM',
                detail: e.body as Record<string, unknown>,
              },
              ctx,
            ),
          );
        }
        res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'upstream failure',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * POST /v1/copilot/chat — T4.24 envelope + tenant.
   * body: { message, context?: { page?, entity?, role? } }
   * Templated context-aware brain — see services/bff/src/copilot/chat.ts.
   * Open to any authenticated role (no extra capability needed beyond what
   * the user already sees on the page they're on).
   */
  app.post('/v1/copilot/chat', requireTenantMw, async (req: Request, res: Response) => {
    const env = extractCtx(req, now);
    if (!getRole(req)) {
      return res
        .status(401)
        .json(wrapError({ code: 'EWS_401', message: 'authentication required', severity: 'MEDIUM' }, env));
    }
    const raw = req.body as { header?: unknown; body?: unknown } | Partial<ChatRequest>;
    const inner = (raw && typeof raw === 'object' && 'header' in raw && 'body' in raw && raw.body && typeof raw.body === 'object'
      ? (raw.body as Partial<ChatRequest>)
      : (raw as Partial<ChatRequest>));
    if (!inner || typeof inner.message !== 'string' || !inner.message.trim()) {
      return res
        .status(400)
        .json(wrapError({ code: 'EWS_400', message: 'message is required', severity: 'MEDIUM' }, env));
    }
    if (inner.message.length > 2000) {
      return res
        .status(400)
        .json(wrapError({ code: 'EWS_400', message: 'message exceeds 2000 chars', severity: 'MEDIUM' }, env));
    }
    const role = getRole(req) ?? undefined;
    const chatCtx = inner.context ?? {};
    const out = await copilotRespond({
      message: inner.message,
      context: { ...chatCtx, role: chatCtx.role ?? role },
    });
    res.json(wrapResponse(out, env));
  });

  /**
   * POST /v1/scenario/run — T4.24 envelope + tenant.
   * body: { gdp: number, rate: number, fx: number }
   * Runs a portfolio-wide stress test and returns the baseline vs. stressed
   * PD distribution, ECL delta, segment heatmap rows, and top-affected
   * customers. Pure compute — no upstream calls — so the response time is
   * O(portfolio_size) and a 240-account run lands well under 50ms.
   */
  app.post('/v1/scenario/run', requireTenantMw, requireRole('customers:read_risk_profile'), (req: Request, res: Response) => {
    const env = extractCtx(req, now);
    const raw = req.body as { header?: unknown; body?: unknown } | unknown;
    const innerBody =
      raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
        ? (raw as { body: unknown }).body
        : raw;
    let shocks;
    try {
      shocks = validateShocks(innerBody);
    } catch (e) {
      return res.status(400).json(
        wrapError(
          { code: 'EWS_400', message: e instanceof Error ? e.message : 'invalid shocks', severity: 'MEDIUM' },
          env,
        ),
      );
    }
    try {
      const result = runScenario(portfolio, shocks, now);
      // Push a real-time notification — the SPA bell shows it without a refresh.
      const adverse = result.ecl_delta_kes > 0;
      bus.publish({
        level: adverse ? 'warning' : 'info',
        title: adverse
          ? `Scenario shows +KES ${(result.ecl_delta_kes / 1_000_000).toFixed(2)}M ECL impact`
          : 'Scenario complete',
        body: `GDP ${shocks.gdp}% · rate ${shocks.rate}bps · FX ${shocks.fx}% · ${result.portfolio_size} accounts`,
        href: '/scenario',
      });
      // Fire scenario.run webhook to any subscribed external system —
      // useful for ops dashboards that aggregate stress-test results.
      // Phase 4: only fires to subscriptions in the same tenant.
      webhookDispatcher.dispatch('scenario.run', {
        tenant_id: req.tenant?.tenant_id,
        channel: req.channel,
        inputs: result.inputs,
        portfolio_size: result.portfolio_size,
        baseline_ecl_kes: result.baseline_ecl_kes,
        stressed_ecl_kes: result.stressed_ecl_kes,
        ecl_delta_kes: result.ecl_delta_kes,
        baseline_portfolio_pd: result.baseline_portfolio_pd,
        stressed_portfolio_pd: result.stressed_portfolio_pd,
        computed_at: result.computed_at,
      }, req.tenant!.tenant_id);
      res.json(wrapResponse(result, env));
    } catch (e) {
      res.status(500).json(
        wrapError(
          { code: 'EWS_500', message: e instanceof Error ? e.message : 'scenario run failed', severity: 'HIGH' },
          env,
        ),
      );
    }
  });

  /**
   * Saved scenarios (T4.18). Lives in `app_scenario.saved_scenarios` when
   * `BFF_PG_URL` is set, in-memory otherwise. Reads are scoped to the
   * caller's username (x-apex-user header — same convention as the report
   * generator). Admin role can list everyone's, intentionally — supports
   * "review what the team is stress-testing" workflows.
   */
  function callerUsername(req: Request): string {
    const v = req.headers['x-apex-user'];
    return typeof v === 'string' && v.length > 0 ? v : 'anonymous';
  }

  app.get('/v1/scenarios', requireTenantMw, requireRole('customers:read_risk_profile'), (req: Request, res: Response) => {
    const env = extractCtx(req, now);
    const role = getRole(req);
    const me = callerUsername(req);
    const tenant_id = req.tenant!.tenant_id;
    const items = scenarioStore.list(
      role === 'admin' ? { tenant_id } : { tenant_id, saved_by: me },
    );
    res.json(wrapResponse({ items, total: items.length }, env));
  });

  app.get('/v1/scenarios/:id', requireTenantMw, requireRole('customers:read_risk_profile'), (req: Request, res: Response) => {
    const env = extractCtx(req, now);
    const tenant_id = req.tenant!.tenant_id;
    const s = scenarioStore.get(req.params.id, tenant_id);
    const role = getRole(req);
    if (!s || (role !== 'admin' && s.saved_by !== callerUsername(req))) {
      return res.status(404).json(
        wrapError(
          { code: 'EWS_404', message: `scenario ${req.params.id} not found`, severity: 'LOW' },
          env,
        ),
      );
    }
    res.json(wrapResponse(s, env));
  });

  app.post('/v1/scenarios', requireTenantMw, requireRole('customers:read_risk_profile'), (req: Request, res: Response) => {
    const env = extractCtx(req, now);
    const raw = req.body as { header?: unknown; body?: unknown } | unknown;
    const body = (raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
      ? (raw as { body: unknown }).body
      : raw) as {
      id?: string;
      name?: string;
      inputs?: { gdp?: number; rate?: number; fx?: number };
      result?: unknown;
    };
    if (!body?.name || !body.name.trim()) {
      return res
        .status(400)
        .json(wrapError({ code: 'EWS_400', message: 'name is required', severity: 'MEDIUM' }, env));
    }
    if (
      !body.inputs ||
      typeof body.inputs.gdp !== 'number' ||
      typeof body.inputs.rate !== 'number' ||
      typeof body.inputs.fx !== 'number'
    ) {
      return res
        .status(400)
        .json(wrapError({ code: 'EWS_400', message: 'inputs.{gdp,rate,fx} must all be numbers', severity: 'MEDIUM' }, env));
    }
    if (!body.result || typeof body.result !== 'object') {
      return res
        .status(400)
        .json(wrapError({ code: 'EWS_400', message: 'result is required', severity: 'MEDIUM' }, env));
    }
    try {
      const saved = scenarioStore.save({
        id: body.id,
        tenant_id: req.tenant!.tenant_id,
        name: body.name,
        saved_by: callerUsername(req),
        inputs: body.inputs as { gdp: number; rate: number; fx: number },
        result: body.result as never,
      });
      res.status(201).json(wrapResponse(saved, env, { code: 'EWS_201', message: 'Created' }));
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      res.status(status).json(
        wrapError(
          {
            code: `EWS_${status}`,
            message: e instanceof Error ? e.message : 'save failed',
            severity: status >= 500 ? 'HIGH' : 'MEDIUM',
          },
          env,
        ),
      );
    }
  });

  app.delete('/v1/scenarios/:id', requireTenantMw, requireRole('customers:read_risk_profile'), (req: Request, res: Response) => {
    const env = extractCtx(req, now);
    const tenant_id = req.tenant!.tenant_id;
    const s = scenarioStore.get(req.params.id, tenant_id);
    const role = getRole(req);
    if (!s || (role !== 'admin' && s.saved_by !== callerUsername(req))) {
      return res.status(404).json(
        wrapError(
          { code: 'EWS_404', message: `scenario ${req.params.id} not found`, severity: 'LOW' },
          env,
        ),
      );
    }
    scenarioStore.delete(req.params.id, tenant_id);
    res.status(204).end();
  });

  /**
   * GET /v1/notifications/stream
   * Server-Sent Events feed of in-app notifications. The SPA bell connects
   * here and stays open; reconnect is handled by the browser's EventSource.
   * Auth: any role with cases:list (i.e. all 5 seed roles) — notifications
   * are intentionally low-sensitivity (titles + deep links, no PII).
   */
  app.get('/v1/notifications/stream', requireTenantMw, requireRole('cases:list'), (req: Request, res: Response) => {
    openSse(req, res, bus);
  });

  /**
   * POST /v1/notifications/publish
   * body: { level, title, body?, href? }
   * Admin-only — used by ops dashboards + tests to seed an event.
   * The scenario route publishes via the in-process bus directly, not
   * via this endpoint.
   */
  app.post('/v1/notifications/publish', requireTenantMw, requireRole('audit:read'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    const body = req.body as {
      level?: NotificationLevel;
      title?: string;
      body?: string;
      href?: string;
    };
    const errs: string[] = [];
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      errs.push('title is required');
    }
    const validLevels: NotificationLevel[] = ['info', 'success', 'warning', 'danger'];
    if (!body.level || !validLevels.includes(body.level)) {
      errs.push(`level must be one of ${validLevels.join(',')}`);
    }
    if (errs.length) {
      return res.status(400).json(
        wrapError({ code: 'EWS_400', message: errs.join('; '), severity: 'MEDIUM' }, ctx),
      );
    }
    const n = bus.publish({
      level: body.level!,
      title: body.title!,
      body: body.body,
      href: body.href,
    });
    res.status(201).json(
      wrapResponse(
        { ok: true, notification: n, subscribers: bus.size() },
        ctx,
        { code: 'EWS_201', message: 'Created' },
      ),
    );
  });

  /**
   * GET /v1/integrations/health
   * Pings each upstream mock (CBS, AML, IFRS9, Collection) in parallel
   * and returns status + latency. Admin-only — health diagnostics surface
   * sensitive infrastructure detail.
   */
  /**
   * GET /v1/cases/sla-summary
   * Returns SLA classification across the synthetic case fleet:
   *   - by_severity counts (on_track / approaching / breached / closed)
   *   - portfolio totals
   *   - the breached_cases list (most-overdue first)
   * Visible to anyone with cases:list.
   */
  app.get('/v1/cases/sla-summary', requireTenantMw, requireRole('cases:list'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    const fleet = deps.slaFleet ?? makeFleet(now());
    const summary = summariseSla(fleet, now());
    res.json(wrapResponse(summary, ctx));
  });

  app.get(
    '/v1/integrations/health',
    requireTenantMw,
    requireRole('audit:read'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      try {
        const report: HealthReport = await pingIntegrations({
          fetcher: deps.integrationsFetcher,
          now,
        });
        res.json(wrapResponse(report, ctx));
      } catch (e) {
        res.status(500).json(
          wrapError(
            {
              code: 'EWS_500',
              message: e instanceof Error ? e.message : 'health probe failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  // ---------- /v1/webhooks (admin-managed outbound delivery) ----------
  //
  // Lets admins register external URLs that should receive APEX events
  // (alert.created, scenario.run, etc.) over HTTP POST. Recipients
  // verify the X-APEX-Signature header against the shared secret
  // returned at create-time. See services/bff/src/webhooks/dispatcher.ts
  // for the wire format.

  const VALID_WEBHOOK_EVENTS: readonly WebhookEventType[] = [
    'alert.created',
    'alert.updated',
    'case.assigned',
    'case.closed',
    'scenario.run',
    'webhook.test',
  ] as const;

  app.get('/v1/webhooks', requireTenantMw, requireRole('webhooks:manage'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    res.json(wrapResponse({ items: webhookStore.list(req.tenant!.tenant_id) }, ctx));
  });

  app.post('/v1/webhooks', requireTenantMw, requireRole('webhooks:manage'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    const body = req.body as { name?: unknown; url?: unknown; events?: unknown };
    const errs: string[] = [];
    if (typeof body?.name !== 'string' || !body.name.trim()) errs.push('name is required');
    if (typeof body?.url !== 'string' || !/^https?:\/\//.test(body.url)) {
      errs.push('url must start with http:// or https://');
    }
    if (!Array.isArray(body?.events) || body.events.length === 0) {
      errs.push('events must be a non-empty array');
    } else {
      for (const e of body.events) {
        if (typeof e !== 'string' || !VALID_WEBHOOK_EVENTS.includes(e as WebhookEventType)) {
          errs.push(`unknown event type: ${String(e)}`);
        }
      }
    }
    if (errs.length > 0) {
      return res.status(400).json(
        wrapError({ code: 'EWS_400', message: errs.join('; '), severity: 'MEDIUM' }, ctx),
      );
    }

    // Returning the FULL record (with secret) — only time the secret
    // is ever returned. The admin UI displays it once with a "copy
    // and store" warning; subsequent GETs use the public projection.
    const created = webhookStore.create({
      tenant_id: req.tenant!.tenant_id,
      name: body.name as string,
      url: body.url as string,
      events: body.events as WebhookEventType[],
    });
    res.status(201).json(wrapResponse(created, ctx, { code: 'EWS_201', message: 'Created' }));
  });

  app.delete('/v1/webhooks/:id', requireTenantMw, requireRole('webhooks:manage'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    const ok = webhookStore.delete(req.params.id, req.tenant!.tenant_id);
    if (!ok) {
      return res.status(404).json(
        wrapError({ code: 'EWS_404', message: 'subscription not found', severity: 'LOW' }, ctx),
      );
    }
    res.status(204).end();
  });

  app.get(
    '/v1/webhooks/:id/deliveries',
    requireTenantMw,
    requireRole('webhooks:manage'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const tenant_id = req.tenant!.tenant_id;
      const sub = webhookStore.get(req.params.id, tenant_id);
      if (!sub) {
        return res.status(404).json(
          wrapError({ code: 'EWS_404', message: 'subscription not found', severity: 'LOW' }, ctx),
        );
      }
      res.json(wrapResponse({ items: webhookStore.deliveriesFor(req.params.id, tenant_id) }, ctx));
    },
  );

  /**
   * POST /v1/webhooks/:id/test
   * Synthesise a `webhook.test` event and dispatch it just to this
   * subscription. Lets admins verify the URL reachable + signature
   * verifying without waiting for a real alert. We AWAIT the delivery
   * here so the response can include the outcome.
   */
  app.post(
    '/v1/webhooks/:id/test',
    requireTenantMw,
    requireRole('webhooks:manage'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const sub = webhookStore.internalGet(req.params.id);
      // Cross-tenant guard — internalGet doesn't filter by tenant on
      // purpose (the dispatcher needs that escape hatch), but admin-test
      // calls must be scoped to the caller's tenant.
      if (!sub || sub.tenant_id !== req.tenant!.tenant_id) {
        return res.status(404).json(
          wrapError({ code: 'EWS_404', message: 'subscription not found', severity: 'LOW' }, ctx),
        );
      }
      const delivery = await webhookDispatcher.deliverOne(sub, 'webhook.test', {
        message: 'APEX EWS webhook test event',
        subscription_id: sub.id,
        tenant_id: sub.tenant_id,
        sent_at: now().toISOString(),
      });
      // 200 even if the recipient returned non-2xx — the delivery row
      // captures the failure and the admin can inspect it. The endpoint
      // succeeded (we sent the request); only the recipient failed.
      res.json(wrapResponse(delivery, ctx));
    },
  );

  /**
   * GET /v1/reports/:type?period={week|month|quarter}&format={json|csv}
   * type ∈ {snapshot, alerts, cases, rbi}
   *
   * Returns a typed Report payload (JSON) or a flat CSV download. The
   * synthetic history is regenerated deterministically per call so the
   * same (type, period, now) tuple always produces the same body.
   */
  app.get(
    '/v1/reports/:type',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const type = req.params.type as ReportType;
      if (!REPORT_TYPES.includes(type)) {
        return res
          .status(400)
          .json({ error: `type must be one of ${REPORT_TYPES.join(',')}` });
      }
      const periodRaw = (req.query.period as string | undefined) ?? 'month';
      if (!REPORT_PERIODS.includes(periodRaw as ReportPeriod)) {
        return res
          .status(400)
          .json({ error: `period must be one of ${REPORT_PERIODS.join(',')}` });
      }
      const format = (req.query.format as string | undefined) ?? 'json';
      const VALID_FORMATS = ['json', 'csv', 'pdf', 'xlsx'] as const;
      if (!VALID_FORMATS.includes(format as (typeof VALID_FORMATS)[number])) {
        return res
          .status(400)
          .json({ error: `format must be one of ${VALID_FORMATS.join(',')}` });
      }
      // Pull the operator's display_name off an optional header so the PDF
      // and XLSX exports can stamp it in the footer / metadata sheet for
      // leak traceability. Frontend forwards the JWT display_name claim
      // here. Anonymous fallback when missing.
      const generatedBy =
        (req.headers['x-apex-user'] as string | undefined) ?? 'anonymous';
      try {
        const payload = reportFor(type, periodRaw as ReportPeriod, now());
        const filename = `${type}-${periodRaw}-${payload.period_end}`;
        if (format === 'csv') {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filename}.csv"`,
          );
          return res.send(reportToCsv(payload));
        }
        if (format === 'pdf') {
          const buf = await reportToPdf(payload, { generated_by: generatedBy });
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filename}.pdf"`,
          );
          return res.send(buf);
        }
        if (format === 'xlsx') {
          const buf = await reportToXlsx(payload, { generated_by: generatedBy });
          res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          );
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filename}.xlsx"`,
          );
          return res.send(buf);
        }
        res.json(payload);
      } catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : 'report failed' });
      }
    },
  );

  // ── Rules v2 (Module 3 banking-grade enhancements) ─────────────────

  /** GET /v1/rules/variables — banking variable library, grouped by category. */
  app.get('/v1/rules/variables', requireTenantMw, requireRole('rules:list'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    res.json(wrapResponse({ categories: variablesByCategory() }, ctx));
  });

  /** GET /v1/rules?state=…&product=… — filtered list with embedded performance. */
  app.get('/v1/rules', requireTenantMw, requireRole('rules:list'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    const stateRaw = req.query.state as string | undefined;
    const productRaw = req.query.product as string | undefined;
    if (stateRaw && !VALID_RULE_STATES.includes(stateRaw as RuleV2State)) {
      return res.status(400).json(
        wrapError(
          { code: 'EWS_400', message: `state must be one of ${VALID_RULE_STATES.join(',')}`, severity: 'MEDIUM' },
          ctx,
        ),
      );
    }
    if (productRaw && !VALID_PRODUCTS.includes(productRaw as RuleProduct)) {
      return res.status(400).json(
        wrapError(
          { code: 'EWS_400', message: `product must be one of ${VALID_PRODUCTS.join(',')}`, severity: 'MEDIUM' },
          ctx,
        ),
      );
    }
    const items = ruleStore.list({
      state: stateRaw as RuleV2State | undefined,
      product: productRaw as RuleProduct | undefined,
    });
    const enriched = items.map((rule) => ({
      ...rule,
      performance: performanceFor(rule, now()),
      legal_transitions: legalTransitions(rule.state),
    }));
    res.json(wrapResponse({ items: enriched, total: enriched.length }, ctx));
  });

  /** GET /v1/rules/:id — full rule envelope with audit trail. */
  app.get('/v1/rules/:id', requireTenantMw, requireRole('rules:read'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    const rule = ruleStore.get(req.params.id);
    if (!rule) {
      return res.status(404).json(
        wrapError({ code: 'EWS_404', message: 'rule_not_found', severity: 'LOW' }, ctx),
      );
    }
    res.json(
      wrapResponse(
        {
          rule,
          performance: performanceFor(rule, now()),
          legal_transitions: legalTransitions(rule.state),
        },
        ctx,
      ),
    );
  });

  /** POST /v1/rules/:id/transition — fire a maker-checker action. */
  app.post(
    '/v1/rules/:id/transition',
    requireTenantMw,
    (req: Request, res: Response, next: NextFunction) => {
      const ctx = extractCtx(req, now);
      // Look up the rule first so we know which RBAC capability the
      // transition needs from the current state.
      const rule = ruleStore.get(req.params.id);
      if (!rule) {
        return res.status(404).json(
          wrapError({ code: 'EWS_404', message: 'rule_not_found', severity: 'LOW' }, ctx),
        );
      }
      const body = req.body as { transition?: string };
      const transition = (body?.transition ?? '') as RuleTransition;
      if (!VALID_TRANSITIONS.includes(transition)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: `transition must be one of ${VALID_TRANSITIONS.join(',')}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const op = rbacFor(transition, rule.state);
      // Reuse the RBAC middleware against the resolved capability.
      const guard = requireRole(op);
      guard(req, res, () => {
        const role = getRole(req) ?? 'unknown';
        try {
          const next = applyTransition(rule, transition, {
            actor_id: `${role}.actor`,
            actor_role: role,
            ts: now().toISOString(),
            comment: (req.body as { comment?: string }).comment,
          });
          ruleStore.upsert(next);
          // Fan a notification on every approve/activate so the bell
          // surfaces the maker-checker hand-off.
          if (transition === 'approve' || transition === 'activate') {
            bus.publish({
              level: 'success',
              title: `Rule ${next.name} → ${next.state}`,
              body: `Actor ${role} · v${next.version}`,
              href: '/rules',
            });
          }
          res.status(200).json(
            wrapResponse(
              {
                rule: next,
                performance: performanceFor(next, now()),
                legal_transitions: legalTransitions(next.state),
              },
              ctx,
            ),
          );
        } catch (e) {
          if (e instanceof IllegalTransition) {
            return res.status(409).json(
              wrapError(
                {
                  code: 'EWS_409',
                  message: e.message,
                  severity: 'MEDIUM',
                  detail: { error_kind: 'illegal_transition', current_state: rule.state },
                },
                ctx,
              ),
            );
          }
          if (e instanceof InvalidPayload) {
            return res.status(400).json(
              wrapError(
                {
                  code: 'EWS_400',
                  message: e.message,
                  severity: 'MEDIUM',
                  detail: { error_kind: 'invalid_payload' },
                },
                ctx,
              ),
            );
          }
          next(e);
        }
      });
    },
  );

  /** POST /v1/rules/:id/backtest — run the deterministic backtest. */
  app.post('/v1/rules/:id/backtest', requireTenantMw, requireRole('rules:simulate'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    const rule = ruleStore.get(req.params.id);
    if (!rule) {
      return res.status(404).json(
        wrapError({ code: 'EWS_404', message: 'rule_not_found', severity: 'LOW' }, ctx),
      );
    }
    res.json(wrapResponse(runBacktest(rule, now()), ctx));
  });

  /** GET /v1/rules/:id/performance — live metrics. */
  app.get('/v1/rules/:id/performance', requireTenantMw, requireRole('rules:read'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    const rule = ruleStore.get(req.params.id);
    if (!rule) {
      return res.status(404).json(
        wrapError({ code: 'EWS_404', message: 'rule_not_found', severity: 'LOW' }, ctx),
      );
    }
    res.json(wrapResponse(performanceFor(rule, now()), ctx));
  });

  return { app, source, lookups, evaluator, riskProfile, caseAction, portfolio, ruleStore };
}

const VALID_RULE_STATES: RuleV2State[] = [
  'draft',
  'pending_review',
  'approved',
  'active',
  'rejected',
  'deprecated',
];
const VALID_PRODUCTS: RuleProduct[] = [
  'home_loan',
  'auto_loan',
  'personal_loan',
  'credit_card',
  'msme',
  'agri',
];
const VALID_TRANSITIONS: RuleTransition[] = [
  'submit',
  'approve',
  'reject',
  'activate',
  'deprecate',
  'edit',
];

const REPORT_TYPES: ReportType[] = ['snapshot', 'alerts', 'cases', 'rbi'];
const REPORT_PERIODS: ReportPeriod[] = ['week', 'month', 'quarter'];

function listAlerts(
  req: Request,
  res: Response,
  source: AlertSource,
  lookups: Lookups,
  now: () => Date,
) {
  const sevRaw = req.query.severity as string | undefined;
  if (sevRaw && !VALID_SEVERITIES.includes(sevRaw as UiSeverity)) {
    return res
      .status(400)
      .json({ error: `severity must be one of ${VALID_SEVERITIES.join(',')}` });
  }
  const assignee = (req.query.assignee as string | undefined) || undefined;

  const canonicals = dedupeByAlertId(source.read());
  const items = mapAlertList(
    canonicals,
    lookups,
    { severity: sevRaw as UiSeverity | undefined, assignee },
    now,
  );
  res.json({ items, total: items.length });
}

if (require.main === module) {
  // Production / dev bootstrap. Both pg-backed stores hydrate their
  // caches before the listener binds so requests hit a warm cache from
  // the first call.
  const port = Number(process.env.PORT ?? 8084);
  void (async () => {
    const webhookStore = await makeWebhookStore();
    const { store: scenarioStore } = await makeScenarioStore();
    const { app } = makeApp({ webhookStore, scenarioStore });
    // eslint-disable-next-line no-console
    app.listen(port, () =>
      console.log(
        `bff listening on :${port} — store: ${
          process.env.BFF_PG_URL ? 'postgres (app_bff.* + app_scenario.*)' : 'in-memory'
        }`,
      ),
    );
  })();
}
