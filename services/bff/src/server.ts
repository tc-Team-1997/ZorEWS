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
import {
  getTemplate as getRuleTemplate,
  isRuleTemplateCategory,
  isRuleTemplateVertical,
  listCategories as listRuleTemplateCategories,
  listTemplates as listRuleTemplates,
  type RuleTemplateCategory,
  type RuleTemplateVertical,
} from './rule_templates';
import {
  getScenarioPreset,
  isScenarioCategory,
  isScenarioRegulator,
  isScenarioSeverity,
  listScenarioCategories,
  listScenarioPresets,
  type ScenarioCategory,
  type ScenarioRegulator,
  type ScenarioSeverity,
} from './scenario_library';
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
import { requireTenant, defaultTenantLookup, TenantConflict, type TenantLookup } from './tenant';
import {
  runReadinessChecks,
  type ReadinessTenantLookup,
  type ReadinessTenantRecord,
} from './tenant_readiness';
import { makeJwtVerifier, type JwtVerifier } from './jwks_client';
import {
  buildAgentDashboard,
  buildClaimsDashboard,
  buildExecutiveWatchlist,
  buildOperationalDashboard,
  buildUnderwritingDashboard,
} from './bil_dashboards';
import { computeRiskScore, ScoringInputError, type ScoringItem, type ScoringThresholds } from './bil_scoring';
import {
  defaultEmailTransport,
  EmailValidationError,
  listTemplates as listEmailTemplates,
  renderTemplate as renderEmailTemplate,
  type EmailMessageInput,
  type EmailTemplateId,
  type EmailTransport,
} from './notifications/email';
import {
  defaultSmsTransport,
  listSmsTemplates,
  renderSmsTemplate,
  SmsValidationError,
  type SmsMessageInput,
  type SmsTemplateId,
  type SmsTransport,
} from './notifications/sms';
import {
  AlertClassificationError,
  classifyAlertSeverity,
  classifyWithMetadata,
  isBilAlertClass,
  listClassifications,
  type BilAlertClass,
  type SeverityInput,
} from './bil_alert_classification';
import {
  AlertRoutingError,
  defaultAlertRoutingEngine,
  type AlertRoutingEngine,
  type RoutingRule,
} from './alert_routing';
import {
  defaultInsuranceAdapter,
  type InsuranceAdapter,
} from './integrations/insurance';
import {
  defaultIfrs9Adapter,
  type Ifrs9Adapter,
  type Ifrs9StageNum,
} from './integrations/ifrs9';
import {
  AmlError,
  defaultAmlAdapter,
  isAmlMatchStatus,
  type AmlAdapter,
  type AmlMatchStatus,
} from './integrations/aml';
import {
  defaultDmsAdapter,
  DmsError,
  isDocumentStatus,
  listDocumentTypes,
  type DmsAdapter,
  type DocumentStatus,
} from './integrations/dms';
import {
  BureauError,
  defaultBureauAdapter,
  listBureauTypes,
  type BureauAdapter,
  type BureauType,
} from './integrations/bureau';
import {
  AgentError,
  defaultAgentAdapter,
  isAgentStatus,
  isAgentTier,
  type AgentAdapter,
  type AgentStatus,
  type AgentTier,
} from './integrations/agent';
import {
  defaultCaseInvestigationStore,
  InvestigationError,
  isInvestigationStatus,
  type CaseInvestigationStore,
  type InvestigationDecision,
  type InvestigationStatus,
} from './case_investigation';
import {
  defaultAiModelRegistry,
  isModelStatus,
  isModelType,
  ModelRegistryError,
  type AiModelRegistry,
  type InferenceInput,
  type ModelStatus,
  type ModelType,
} from './ai_model_registry';
import {
  ConfigValidationError,
  defaultConfigStore,
  listCategories as listConfigCategories,
  type ConfigCategory,
  type ConfigStore,
  type ConfigValue,
} from './admin_config';
import {
  AuditValidationError,
  defaultAuditTrailStore,
  isAuditOutcome,
  isAuditResourceType,
  isAuditSeverity,
  type AuditEventInput,
  type AuditFilters,
  type AuditOutcome,
  type AuditResourceType,
  type AuditSeverity,
  type AuditTrailStore,
} from './audit_trail';
import {
  defaultIngestionRegistry,
  IngestionError,
  type IngestionRegistry,
} from './ingestion';
import {
  defaultReportJobStore,
  isJobStatus,
  isReportCategory,
  isReportRegulator,
  listReportDefs,
  getReportDef,
  ReportsError,
  type JobStatus,
  type ReportCategory,
  type ReportJobInput,
  type ReportJobStore,
  type ReportRegulator,
} from './reports_catalog';

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
  /**
   * Override for tests — email transport (T6 M10.1). Defaults to the
   * module-level StubEmailTransport singleton (in-memory ledger).
   * Production deploys swap in a SES/SMTP transport implementing the
   * same interface.
   */
  emailTransport?: EmailTransport;
  /**
   * Override for tests — SMS transport (T6 M10.2). Defaults to the
   * module-level StubSmsTransport singleton. Production swaps in a
   * Twilio / MSG91 / SMS-gateway transport.
   */
  smsTransport?: SmsTransport;
  /**
   * Override for tests — alert routing engine (T6 M8.2). Defaults to
   * the module-level InMemoryAlertRoutingEngine. Tenant overrides
   * persist within the engine instance; tests pass a fresh engine.
   */
  alertRoutingEngine?: AlertRoutingEngine;
  /**
   * Override for tests — Core Insurance / Policy Master adapter
   * (T6 M14.1). Defaults to the module-level StubInsuranceAdapter
   * (deterministic synthetic data per (tenant, customer, day)).
   * Production swaps in a SOAP/REST gateway adapter.
   */
  insuranceAdapter?: InsuranceAdapter;
  /**
   * Override for tests — IFRS9 Stage adapter (T6 M14.2). Defaults
   * to the module-level StubIfrs9Adapter (deterministic synthetic
   * loan-book of 200 customers per tenant). Production swaps in an
   * HTTP-backed adapter pointing at the IFRS 9 engine.
   */
  ifrs9Adapter?: Ifrs9Adapter;
  /**
   * Override for tests — AML Watchlist adapter (T6 M14.3). Defaults
   * to the module-level StubAmlAdapter (deterministic synthetic
   * screening — ~85% clean, ~10% one match, ~5% multi-match).
   * Production swaps in a SOAP/REST gateway to the AML hub.
   */
  amlAdapter?: AmlAdapter;
  /**
   * Override for tests — DMS Document Management adapter (T6 M14.4).
   * Defaults to the module-level StubDmsAdapter (deterministic
   * 0-12 docs per customer with realistic type mix). Production
   * swaps in a DMS-vendor (e.g. SharePoint, Documentum) adapter.
   */
  dmsAdapter?: DmsAdapter;
  /**
   * Override for tests — Credit Bureau adapter (T6 M14.5). Defaults
   * to the module-level StubBureauAdapter (deterministic 300-900
   * score distribution biased toward prime). Production swaps in
   * the real bureau API gateway.
   */
  bureauAdapter?: BureauAdapter;
  /**
   * Override for tests — Agent Productivity adapter (T6 M14.6).
   * Defaults to the module-level StubAgentAdapter (50 agents per
   * tenant with monthly productivity history). Production swaps
   * in a HR-system-backed adapter (e.g. SAP SuccessFactors).
   */
  agentAdapter?: AgentAdapter;
  /**
   * Override for tests — admin config registry (T6 M13.1). Defaults
   * to the module-level InMemoryConfigStore. Tests pass a fresh
   * store per test so overrides don't leak across runs.
   */
  configStore?: ConfigStore;
  /**
   * Override for tests — BIL audit trail store (T6 M15.1). Defaults
   * to the module-level InMemoryAuditTrailStore. Production swaps
   * in a WORM-backed store with hash-chain integrity.
   */
  auditTrailStore?: AuditTrailStore;
  /**
   * Override for tests — BIL ingestion connector registry (T6 M3.1).
   * Defaults to the module-level InMemoryIngestionRegistry seeded with
   * 8 BIL upstream connectors. Production swaps in an
   * IngestionRegistry implementation that talks to the real scheduler
   * (Airflow, etc.) and connector pool.
   */
  ingestionRegistry?: IngestionRegistry;
  /**
   * Override for tests — BIL reports job store (T6 M12.1). Defaults
   * to the module-level InMemoryReportJobStore. Production swaps in
   * a queue-backed store; the synthetic stub completes synchronously.
   */
  reportJobStore?: ReportJobStore;
  /**
   * Override for tests — BIL case investigation store (T6 M9.1).
   * Defaults to the module-level InMemoryCaseInvestigationStore.
   * Production swaps in a PG-backed store satisfying the same
   * interface.
   */
  caseInvestigationStore?: CaseInvestigationStore;
  /**
   * Override for tests — BIL AI/ML model registry (T6 M7.1).
   * Defaults to the module-level InMemoryAiModelRegistry seeded with
   * 8 BIL model versions. Production swaps in an MLflow / Sagemaker
   * / Vertex-backed registry satisfying the same interface.
   */
  aiModelRegistry?: AiModelRegistry;
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
  const emailTransport = deps.emailTransport ?? defaultEmailTransport;
  const smsTransport = deps.smsTransport ?? defaultSmsTransport;
  const alertRoutingEngine = deps.alertRoutingEngine ?? defaultAlertRoutingEngine;
  const insuranceAdapter = deps.insuranceAdapter ?? defaultInsuranceAdapter;
  const ifrs9Adapter = deps.ifrs9Adapter ?? defaultIfrs9Adapter;
  const amlAdapter = deps.amlAdapter ?? defaultAmlAdapter;
  const dmsAdapter = deps.dmsAdapter ?? defaultDmsAdapter;
  const bureauAdapter = deps.bureauAdapter ?? defaultBureauAdapter;
  const agentAdapter = deps.agentAdapter ?? defaultAgentAdapter;
  const configStore = deps.configStore ?? defaultConfigStore;
  const auditTrailStore = deps.auditTrailStore ?? defaultAuditTrailStore;
  const ingestionRegistry = deps.ingestionRegistry ?? defaultIngestionRegistry;
  const reportJobStore = deps.reportJobStore ?? defaultReportJobStore;
  const caseInvestigationStore = deps.caseInvestigationStore ?? defaultCaseInvestigationStore;
  const aiModelRegistry = deps.aiModelRegistry ?? defaultAiModelRegistry;
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

  // ── BIL alert classification (T6 M8.1) — DataNetworks PDF §11 ─────────
  //
  // Three additive endpoints layered on top of the existing /v1/alerts.
  // The /v1/alerts response shape is intentionally unchanged — these
  // routes exist for SPA badge rendering + ad-hoc severity classification.

  /** GET /v1/alerts/classification/spec — full 4-class metadata table. */
  app.get(
    '/v1/alerts/classification/spec',
    requireTenantMw,
    requireRole('alerts:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = listClassifications();
      res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /**
   * POST /v1/alerts/classify
   * body: { severity: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL' (case-insensitive) }
   * Returns the BIL class + action metadata for the supplied severity.
   * Stateless — no alert lookup, just the pure mapping.
   */
  app.post(
    '/v1/alerts/classify',
    requireTenantMw,
    requireRole('alerts:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const { severity } = (inner ?? {}) as { severity?: SeverityInput };
      if (severity === undefined) {
        return res.status(400).json(
          wrapError({ code: 'EWS_400', message: 'severity is required', severity: 'MEDIUM' }, ctx),
        );
      }
      try {
        const result = classifyWithMetadata(severity);
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof AlertClassificationError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'classify failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * GET /v1/alerts/by-class/:class
   * class ∈ {red, orange, yellow, green}
   * Returns the same item shape as /v1/alerts but filtered to alerts
   * whose severity classifies into the requested BIL class. Each item
   * is decorated with `bil_class` + `bil_metadata` so the SPA can
   * render badges directly.
   */
  app.get(
    '/v1/alerts/by-class/:class',
    requireTenantMw,
    requireRole('alerts:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const cls = req.params.class;
      if (!isBilAlertClass(cls)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_class',
              message: 'class must be one of red|orange|yellow|green',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const target: BilAlertClass = cls;
      const canonicals = dedupeByAlertId(source.read());
      const all = mapAlertList(canonicals, lookups, {}, now);
      const items = all
        .filter((a) => classifyAlertSeverity(a.severity) === target)
        .map((a) => ({
          ...a,
          bil_class: target,
          bil_metadata: listClassifications().find((m) => m.class === target),
        }));
      res.json(wrapResponse({ items, total: items.length, class: target }, ctx));
    },
  );

  // ── BIL alert auto-routing (T6 M8.2) ──────────────────────────────────
  //
  // 4 routes layered on top of M8.1 classification: list effective rules,
  // decide routing for a given severity, set/clear per-tenant overrides.
  // Rules are admin-managed (audit:read); the decide endpoint is
  // analyst-level (alerts:list) since it's a read.

  /** GET /v1/alerts/routing/rules — effective rules (defaults + overrides). */
  app.get(
    '/v1/alerts/routing/rules',
    requireTenantMw,
    requireRole('alerts:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = alertRoutingEngine.listRules(req.tenant!.tenant_id).map((rule) => {
        const { source } = alertRoutingEngine.getRule(req.tenant!.tenant_id, rule.class);
        return { ...rule, source };
      });
      res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /**
   * POST /v1/alerts/routing/decide
   * body: { severity: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL' (case-insensitive) }
   * Returns the RoutingDecision for the supplied severity given the
   * tenant's effective rules.
   */
  app.post(
    '/v1/alerts/routing/decide',
    requireTenantMw,
    requireRole('alerts:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const severity = (inner as { severity?: unknown } | undefined)?.severity;
      if (severity === undefined) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'severity is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const decision = alertRoutingEngine.route(req.tenant!.tenant_id, severity as SeverityInput);
        return res.json(wrapResponse(decision, ctx));
      } catch (e) {
        if (e instanceof AlertClassificationError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'route failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * PUT /v1/alerts/routing/rules/:class
   * body: Partial<RoutingRule> (sans `class` — taken from path)
   * Set/update the tenant's override. Validates the rule (sla > escalation,
   * monitor_only ⇒ null SLA, etc).
   */
  app.put(
    '/v1/alerts/routing/rules/:class',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const cls = req.params.class;
      if (!isBilAlertClass(cls)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_class',
              message: 'class must be one of red|orange|yellow|green',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      // Path class wins — body class ignored if mismatched.
      const rule: Partial<RoutingRule> = { ...(inner as object), class: cls as BilAlertClass };
      try {
        const saved = alertRoutingEngine.setOverride(req.tenant!.tenant_id, rule);
        return res.json(wrapResponse({ ...saved, source: 'tenant_override' as const }, ctx));
      } catch (e) {
        if (e instanceof AlertRoutingError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'set failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** DELETE /v1/alerts/routing/rules/:class — clear override → revert. */
  app.delete(
    '/v1/alerts/routing/rules/:class',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const cls = req.params.class;
      if (!isBilAlertClass(cls)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_class',
              message: 'class must be one of red|orange|yellow|green',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      try {
        const reverted = alertRoutingEngine.clearOverride(
          req.tenant!.tenant_id,
          cls as BilAlertClass,
        );
        return res.json(wrapResponse({ ...reverted, source: 'platform_default' as const }, ctx));
      } catch (e) {
        if (e instanceof AlertRoutingError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'clear failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

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

  // ── BIL AI/ML model registry (T6 M7.1) ────────────────────────────────
  //
  // Model registry + ad-hoc inference + metrics. Same RBAC as the
  // per-customer risk-profile route since inference returns a per-
  // customer score (analyst-level data class).

  /** GET /v1/ai/models/types — enumerate the closed model-type set. */
  app.get(
    '/v1/ai/models/types',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items: ModelType[] = ['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity'];
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/ai/models/by-type/:type — production model for a type. 404 if none. */
  app.get(
    '/v1/ai/models/by-type/:type',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const type = req.params.type;
      if (!isModelType(type)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_type', message: `invalid type: ${type}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const m = aiModelRegistry.getProductionByType(type as ModelType);
      if (!m) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_no_production_model', message: `no production model for type ${type}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(m, ctx));
    },
  );

  /** GET /v1/ai/models?type=&status= — list with filters. */
  app.get(
    '/v1/ai/models',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const t = req.query.type as string | undefined;
      const s = req.query.status as string | undefined;
      if (t !== undefined && !isModelType(t)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_type', message: `invalid type: ${t}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (s !== undefined && !isModelStatus(s)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_status', message: `invalid status: ${s}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const items = aiModelRegistry.list({ type: t as ModelType | undefined, status: s as ModelStatus | undefined });
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/ai/models/:model_id — single model. 404 on miss. */
  app.get(
    '/v1/ai/models/:model_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.model_id ?? '';
      const m = aiModelRegistry.get(id);
      if (!m) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_model', message: `unknown model_id: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(m, ctx));
    },
  );

  /** GET /v1/ai/models/:model_id/metrics — performance metrics block only. */
  app.get(
    '/v1/ai/models/:model_id/metrics',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.model_id ?? '';
      const m = aiModelRegistry.get(id);
      if (!m) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_model', message: `unknown model_id: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(
        wrapResponse(
          {
            model_id: m.model_id,
            type: m.type,
            version: m.version,
            status: m.status,
            metrics: m.metrics,
          },
          ctx,
        ),
      );
    },
  );

  /**
   * POST /v1/ai/models/:model_id/score body: InferenceInput
   * Run inference. Deterministic per (model, tenant, customer, day).
   * 400 invalid_input on missing customer_id, 404 unknown_model,
   * 409 retired when targeting a retired model.
   */
  app.post(
    '/v1/ai/models/:model_id/score',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.model_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const result = aiModelRegistry.score(
          id,
          (inner ?? {}) as InferenceInput,
          req.tenant!.tenant_id,
          now(),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof ModelRegistryError) {
          const status =
            e.code === 'unknown_model' ? 404 :
            e.code === 'retired' ? 409 :
            400;
          const code =
            e.code === 'unknown_model' ? 'EWS_404_unknown_model' :
            e.code === 'retired' ? 'EWS_409_retired' :
            `EWS_400_${e.code}`;
          return res.status(status).json(
            wrapError({ code, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'score failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

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

  // ── BIL named scenario library (T6 M16.1) ────────────────────────────
  //
  // Three additive endpoints layered on top of T4.2 scenario/run +
  // T4.18 saved scenarios. The library is platform-wide (every tenant
  // sees the same 10 BIL presets); cloning into a saved scenario is
  // a separate op via POST /v1/scenarios.
  //
  // Routes MUST come before /v1/scenarios/:id so Express matches the
  // more-specific paths first.

  /** GET /v1/scenarios/library/categories — distinct scenario categories. */
  app.get(
    '/v1/scenarios/library/categories',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = listScenarioCategories();
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/scenarios/library?category=&regulator=&severity= — filtered list. */
  app.get(
    '/v1/scenarios/library',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const c = req.query.category as string | undefined;
      const r = req.query.regulator as string | undefined;
      const s = req.query.severity as string | undefined;
      if (c !== undefined && !isScenarioCategory(c)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_category', message: `invalid category: ${c}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (r !== undefined && !isScenarioRegulator(r)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_regulator', message: `invalid regulator: ${r}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (s !== undefined && !isScenarioSeverity(s)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_severity', message: `invalid severity: ${s}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const items = listScenarioPresets({
        category: c as ScenarioCategory | undefined,
        regulator: r as ScenarioRegulator | undefined,
        severity: s as ScenarioSeverity | undefined,
      });
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/scenarios/library/:id — single preset. 404 EWS_404_unknown_preset. */
  app.get(
    '/v1/scenarios/library/:id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const preset = getScenarioPreset(id);
      if (!preset) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_preset', message: `unknown preset: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(preset, ctx));
    },
  );

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

  // ── Email channel (T6 M10.1) — DataNetworks-EWS-Ver1.pdf §13 ──────────
  //
  // Out-of-band delivery transport for BIL. The default StubEmailTransport
  // records to an in-memory ledger; prod swaps to SES/SMTP. Templates are
  // rendered server-side so the SPA can preview before sending.

  /** GET /v1/notifications/email/templates — list canned BIL templates. */
  app.get(
    '/v1/notifications/email/templates',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = listEmailTemplates().map((t) => ({
        id: t.id,
        description: t.description,
        required_vars: t.required_vars,
        subject: t.subject,
        body_text: t.body_text,
      }));
      res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /**
   * POST /v1/notifications/email/preview
   * body: { template_id, template_vars }
   * Renders a template + vars to (subject, body_text, body_html?) without
   * sending. Useful for the SPA preview pane.
   */
  app.post(
    '/v1/notifications/email/preview',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const { template_id, template_vars } = (inner ?? {}) as {
        template_id?: EmailTemplateId;
        template_vars?: Record<string, string | number>;
      };
      if (!template_id || typeof template_id !== 'string') {
        return res.status(400).json(
          wrapError({ code: 'EWS_400', message: 'template_id is required', severity: 'MEDIUM' }, ctx),
        );
      }
      try {
        const out = renderEmailTemplate(template_id, template_vars ?? {});
        return res.json(wrapResponse({ template_id, ...out }, ctx));
      } catch (e) {
        if (e instanceof EmailValidationError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'preview failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * POST /v1/notifications/email/send
   * body: EmailMessageInput
   * Validates + dispatches via the configured transport. Mirrors the
   * RBAC of the publish endpoint (audit:read = admin) — sending email
   * is a higher-trust op than reading the SSE stream.
   */
  app.post(
    '/v1/notifications/email/send',
    requireTenantMw,
    requireRole('audit:read'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      if (!inner || typeof inner !== 'object') {
        return res.status(400).json(
          wrapError({ code: 'EWS_400', message: 'request body required', severity: 'MEDIUM' }, ctx),
        );
      }
      try {
        const receipt = await emailTransport.send(req.tenant!.tenant_id, inner as EmailMessageInput);
        return res.status(201).json(
          wrapResponse({ ok: true, receipt }, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof EmailValidationError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'send failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * GET /v1/notifications/email/log?limit=50
   * Recent ledger entries scoped to the caller's tenant. Admin-only —
   * the ledger contains rendered subject + body which may include PII.
   */
  app.get(
    '/v1/notifications/email/log',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const limitRaw = req.query.limit;
      const limit = typeof limitRaw === 'string' ? Math.max(1, Math.min(500, Number(limitRaw) || 50)) : 50;
      const items = emailTransport.recent(req.tenant!.tenant_id, limit);
      res.json(wrapResponse({ items, total: items.length, limit }, ctx));
    },
  );

  // ── SMS notification channel (T6 M10.2) ─────────────────────────────
  //
  // Mirrors the M10.1 email channel surface: templates / preview / send /
  // log. SMS bodies capped at 160 chars; phone numbers must be E.164.
  // 4 BIL canned templates per pitch §13.

  /** GET /v1/notifications/sms/templates — list canned BIL templates. */
  app.get(
    '/v1/notifications/sms/templates',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = listSmsTemplates().map((t) => ({
        id: t.id,
        description: t.description,
        required_vars: t.required_vars,
        body: t.body,
      }));
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /**
   * POST /v1/notifications/sms/preview body: { template_id, template_vars }
   * Render a template + vars to a body without sending.
   */
  app.post(
    '/v1/notifications/sms/preview',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const { template_id, template_vars } = (inner ?? {}) as {
        template_id?: SmsTemplateId;
        template_vars?: Record<string, string | number>;
      };
      if (!template_id || typeof template_id !== 'string') {
        return res.status(400).json(
          wrapError({ code: 'EWS_400', message: 'template_id is required', severity: 'MEDIUM' }, ctx),
        );
      }
      try {
        const out = renderSmsTemplate(template_id, template_vars ?? {});
        return res.json(wrapResponse({ template_id, ...out }, ctx));
      } catch (e) {
        if (e instanceof SmsValidationError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'preview failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * POST /v1/notifications/sms/send body: SmsMessageInput
   * Validates + dispatches via the configured transport. Admin-only —
   * sending SMS is higher-trust than reading the bell stream.
   */
  app.post(
    '/v1/notifications/sms/send',
    requireTenantMw,
    requireRole('audit:read'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      if (!inner || typeof inner !== 'object') {
        return res.status(400).json(
          wrapError({ code: 'EWS_400', message: 'request body required', severity: 'MEDIUM' }, ctx),
        );
      }
      try {
        const receipt = await smsTransport.send(req.tenant!.tenant_id, inner as SmsMessageInput);
        return res.status(201).json(
          wrapResponse({ ok: true, receipt }, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof SmsValidationError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'send failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/notifications/sms/log?limit=50 — tenant-scoped ledger. */
  app.get(
    '/v1/notifications/sms/log',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const limitRaw = req.query.limit;
      const limit = typeof limitRaw === 'string' ? Math.max(1, Math.min(500, Number(limitRaw) || 50)) : 50;
      const items = smsTransport.recent(req.tenant!.tenant_id, limit);
      res.json(wrapResponse({ items, total: items.length, limit }, ctx));
    },
  );

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

  // ── BIL Case Investigation tracker (T6 M9.1) ──────────────────────────
  //
  // Workflow container layered on top of /v1/action's audit log + the
  // case-events stream. Tracks the BIL §17 standard 8-step claim-fraud
  // checklist + a free-text notes thread. RBAC: any role with
  // cases:log_action (the same op that records actions on a case).

  function caseInvestigationActor(req: Request): string {
    const v = req.headers['x-apex-user'];
    return typeof v === 'string' && v.trim() ? v.trim() : 'admin';
  }

  function mapInvestigationError(e: unknown, ctx: ReturnType<typeof extractCtx>): {
    status: number;
    body: ReturnType<typeof wrapError>;
  } {
    if (!(e instanceof InvestigationError)) {
      return {
        status: 500,
        body: wrapError(
          { code: 'EWS_500', message: e instanceof Error ? e.message : 'investigation failed', severity: 'HIGH' },
          ctx,
        ),
      };
    }
    if (e.code === 'unknown_investigation' || e.code === 'unknown_step') {
      return {
        status: 404,
        body: wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
      };
    }
    if (e.code === 'investigation_already_open' || e.code === 'step_already_completed' || e.code === 'closed') {
      return {
        status: 409,
        body: wrapError({ code: `EWS_409_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
      };
    }
    return {
      status: 400,
      body: wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
    };
  }

  /**
   * POST /v1/investigations body: { case_id, customer_id }
   * Open a fresh investigation for a case. 409 when the case already
   * has an open one (must close first). 400 on missing fields.
   */
  app.post(
    '/v1/investigations',
    requireTenantMw,
    requireRole('cases:log_action'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const inv = caseInvestigationStore.open(
          req.tenant!.tenant_id,
          (inner ?? {}) as { case_id: string; customer_id: string },
          caseInvestigationActor(req),
          now(),
        );
        return res.status(201).json(
          wrapResponse(inv, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        const m = mapInvestigationError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  /** GET /v1/investigations?status=&case_id=&customer_id=&page=&page_size= */
  app.get(
    '/v1/investigations',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filters: { status?: InvestigationStatus; case_id?: string; customer_id?: string; page?: number; page_size?: number } = {};
      if (typeof q.status === 'string') {
        if (!isInvestigationStatus(q.status)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_status', message: `invalid status: ${q.status}`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filters.status = q.status as InvestigationStatus;
      }
      if (typeof q.case_id === 'string') filters.case_id = q.case_id;
      if (typeof q.customer_id === 'string') filters.customer_id = q.customer_id;
      if (typeof q.page === 'string') filters.page = Math.max(1, Number(q.page) || 1);
      if (typeof q.page_size === 'string') {
        filters.page_size = Math.max(1, Math.min(200, Number(q.page_size) || 50));
      }
      const out = caseInvestigationStore.list(req.tenant!.tenant_id, filters);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/investigations/:id — single. 404 on miss/cross-tenant. */
  app.get(
    '/v1/investigations/:id',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const inv = caseInvestigationStore.get(req.tenant!.tenant_id, id);
      if (!inv) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_investigation', message: `unknown investigation: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(inv, ctx));
    },
  );

  /**
   * PATCH /v1/investigations/:id/status body: { status, decision? }
   * Transition through the workflow. The state machine enforces legal
   * transitions; closing from `decision` requires a non-null decision.
   */
  app.patch(
    '/v1/investigations/:id/status',
    requireTenantMw,
    requireRole('cases:log_action'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const { status, decision } = (inner ?? {}) as {
        status?: InvestigationStatus;
        decision?: InvestigationDecision;
      };
      try {
        const inv = caseInvestigationStore.updateStatus(
          req.tenant!.tenant_id,
          id,
          status as InvestigationStatus,
          decision ?? null,
          caseInvestigationActor(req),
          now(),
        );
        return res.json(wrapResponse(inv, ctx));
      } catch (e) {
        const m = mapInvestigationError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  /**
   * POST /v1/investigations/:id/steps/:step_id/complete body: { evidence_link? }
   * Mark a checklist step as completed.
   */
  app.post(
    '/v1/investigations/:id/steps/:step_id/complete',
    requireTenantMw,
    requireRole('cases:log_action'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const step_id = req.params.step_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const evidence_link =
        inner && typeof inner === 'object' && typeof (inner as { evidence_link?: unknown }).evidence_link === 'string'
          ? ((inner as { evidence_link: string }).evidence_link)
          : null;
      try {
        const inv = caseInvestigationStore.completeStep(
          req.tenant!.tenant_id,
          id,
          step_id,
          caseInvestigationActor(req),
          evidence_link,
          now(),
        );
        return res.json(wrapResponse(inv, ctx));
      } catch (e) {
        const m = mapInvestigationError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  /**
   * POST /v1/investigations/:id/notes body: { body }
   * Append a note to the investigation thread. Returns the note +
   * the updated investigation (with bumped notes_count).
   */
  app.post(
    '/v1/investigations/:id/notes',
    requireTenantMw,
    requireRole('cases:log_action'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const noteBody =
        inner && typeof inner === 'object' && typeof (inner as { body?: unknown }).body === 'string'
          ? ((inner as { body: string }).body)
          : '';
      try {
        const result = caseInvestigationStore.addNote(
          req.tenant!.tenant_id,
          id,
          caseInvestigationActor(req),
          noteBody,
          now(),
        );
        return res.status(201).json(
          wrapResponse(result, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        const m = mapInvestigationError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  /** GET /v1/investigations/:id/notes — newest-first. 404 on unknown id. */
  app.get(
    '/v1/investigations/:id/notes',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      try {
        const items = caseInvestigationStore.listNotes(req.tenant!.tenant_id, id);
        return res.json(wrapResponse({ items, total: items.length, investigation_id: id }, ctx));
      } catch (e) {
        const m = mapInvestigationError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  // ── BIL dashboards (T6 M11.1+) — DataNetworks-EWS-Ver1.pdf §14 ────────
  //
  // Five BIL dashboards live under /v1/dashboards/bil/*. Each is tenant-
  // scoped + RBAC-gated; payloads are deterministic stubs today and swap
  // to real queries when the BIL synthetic dataset lands. Module 11 of
  // T6 ships them one at a time:
  //   M11.1 — claims (this endpoint)
  //   M11.2 — underwriting (future)
  //   M11.3 — agent (future)
  //   M11.4 — operational (future)
  // The Executive dashboard already exists for banking via /api/dashboards.
  app.get(
    '/v1/dashboards/bil/claims',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const tenant_id = req.tenant!.tenant_id;
      const dashboard = buildClaimsDashboard(tenant_id, now());
      res.json(wrapResponse(dashboard, ctx));
    },
  );

  // M11.2 — Underwriting Dashboard. High-risk proposals, churn trend
  // (6 months trailing), lapse predictions sorted by 30-day probability.
  app.get(
    '/v1/dashboards/bil/underwriting',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const dashboard = buildUnderwritingDashboard(req.tenant!.tenant_id, now());
      res.json(wrapResponse(dashboard, ctx));
    },
  );

  // M11.3 — Agent Dashboard. Performance leaderboard, risk-contribution
  // ranking (highest portfolio risk first), cancellation clusters.
  app.get(
    '/v1/dashboards/bil/agent',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const dashboard = buildAgentDashboard(req.tenant!.tenant_id, now());
      res.json(wrapResponse(dashboard, ctx));
    },
  );

  // M11.4 — Operational Dashboard. UW delay breakdown by branch +
  // underwriter, login anomalies (last 7 days), override audit trail
  // (last 30 days).
  app.get(
    '/v1/dashboards/bil/operational',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const dashboard = buildOperationalDashboard(req.tenant!.tenant_id, now());
      res.json(wrapResponse(dashboard, ctx));
    },
  );

  // ── BIL Executive Watchlist (T6 M11.5) ─────────────────────────────
  //
  // Cross-dashboard rollup — pulls top concerns from each of the 4
  // BIL dashboards into a single executive feed. Each item cites its
  // source so the SPA can deep-link back to the owning dashboard.
  app.get(
    '/v1/dashboards/bil/executive',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const watchlist = buildExecutiveWatchlist(req.tenant!.tenant_id, now());
      res.json(wrapResponse(watchlist, ctx));
    },
  );

  // ── BIL Σ(W×V) risk-scoring engine (T6 M6.1) ──────────────────────────
  //
  // Stateless POST that takes a list of (indicator_id, weight, value)
  // tuples and returns the BIL risk score per DataNetworks PDF §12.
  // Defaults to Low/Medium/High thresholds at 30/70 — caller can override.
  // Tenant-gated + the same role as scenario run (risk-analyst level).
  app.post(
    '/v1/scoring/risk',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const env = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      if (!inner || typeof inner !== 'object') {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'request body required', severity: 'MEDIUM' },
            env,
          ),
        );
      }
      const { items, thresholds } = inner as {
        items?: ScoringItem[];
        thresholds?: Partial<ScoringThresholds>;
      };
      try {
        const result = computeRiskScore(items ?? [], thresholds ?? {});
        return res.json(wrapResponse(result, env));
      } catch (e) {
        if (e instanceof ScoringInputError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, env),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'scoring failed', severity: 'HIGH' },
            env,
          ),
        );
      }
    },
  );

  // ── Multi-tenant introspection (T4.24 Phase 9) ────────────────────────
  //
  // Read-only endpoints for callers + admins to introspect the tenant
  // registry. /tenants/me works for any authenticated request that
  // carries tenant context (the middleware already populated it).
  // /tenants is admin-only — listing every configured tenant is a
  // platform-admin concern, not a per-tenant one.

  /** GET /v1/tenants/me — returns the caller's tenant. */
  app.get('/v1/tenants/me', requireTenantMw, (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    res.json(wrapResponse(req.tenant, ctx));
  });

  // ── Tenant readiness check (T6 M2.1) ─────────────────────────────────
  //
  // Adapter for the readiness lookup — wraps the production TenantLookup
  // with the narrower ReadinessTenantLookup shape the readiness module
  // expects. Tests can supply either the production lookup or a stub
  // satisfying ReadinessTenantLookup directly.
  const readinessLookup: ReadinessTenantLookup = {
    async get(tenant_id: string): Promise<ReadinessTenantRecord | null> {
      // TenantLookup is callable: tenantLookup(tenant_id) → Tenant | undefined.
      const t = await tenantLookup(tenant_id);
      if (!t) return null;
      return {
        tenant_id: t.tenant_id,
        name: t.name,
        channels: Array.isArray(t.channels_allowed) ? t.channels_allowed : [],
        active: t.active !== false,
        vertical: t.vertical,
      };
    },
  };

  /** GET /v1/tenants/me/readiness — readiness for the caller's tenant. */
  app.get(
    '/v1/tenants/me/readiness',
    requireTenantMw,
    requireRole('audit:read'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      try {
        const report = await runReadinessChecks(req.tenant!.tenant_id, {
          tenantLookup: readinessLookup,
          configStore,
          alertRoutingEngine,
          auditTrailStore,
          now,
        });
        return res.json(wrapResponse(report, ctx));
      } catch (e) {
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'readiness failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/tenants/:tenant_id/readiness — admin-only platform view. */
  app.get(
    '/v1/tenants/:tenant_id/readiness',
    requireTenantMw,
    requireRole('audit:read'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const target = req.params.tenant_id ?? '';
      if (!target) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'tenant_id path parameter is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const report = await runReadinessChecks(target, {
          tenantLookup: readinessLookup,
          configStore,
          alertRoutingEngine,
          auditTrailStore,
          now,
        });
        return res.json(wrapResponse(report, ctx));
      } catch (e) {
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'readiness failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * GET /v1/tenants — admin-only listing of every configured tenant.
   * 501 envelope when the tenant lookup doesn't expose `all()` (some
   * test stubs don't bother).
   */
  app.get('/v1/tenants', requireTenantMw, requireRole('audit:read'), async (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    if (!tenantLookup.all) {
      return res.status(501).json(
        wrapError(
          {
            code: 'EWS_501',
            message: 'tenant lookup does not support enumeration',
            severity: 'LOW',
          },
          ctx,
        ),
      );
    }
    const items = await tenantLookup.all();
    res.json(wrapResponse({ items, total: items.length }, ctx));
  });

  /**
   * POST /v1/tenants — admin creates a tenant (T4.24 Phase 10).
   *
   * Validates: tenant_id (uppercase + underscore + digits, ≤32 chars),
   * vertical in {banking, insurance}, channels_allowed non-empty, name
   * non-empty. 409 envelope on duplicate. 501 envelope when the lookup
   * doesn't support mutations.
   */
  app.post('/v1/tenants', requireTenantMw, requireRole('audit:read'), async (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    if (!tenantLookup.create) {
      return res.status(501).json(
        wrapError(
          { code: 'EWS_501', message: 'tenant lookup is read-only', severity: 'LOW' },
          ctx,
        ),
      );
    }
    const raw = req.body as { header?: unknown; body?: unknown } | unknown;
    const body = (raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
      ? (raw as { body: unknown }).body
      : raw) as {
      tenant_id?: unknown;
      name?: unknown;
      vertical?: unknown;
      channels_allowed?: unknown;
      active?: unknown;
    };
    const errs: string[] = [];
    if (typeof body?.tenant_id !== 'string' || !/^[A-Z][A-Z0-9_]{1,31}$/.test(body.tenant_id)) {
      errs.push('tenant_id must match ^[A-Z][A-Z0-9_]{1,31}$ (uppercase + digits + underscore)');
    }
    if (typeof body?.name !== 'string' || !body.name.trim()) {
      errs.push('name is required');
    }
    if (body?.vertical !== 'banking' && body?.vertical !== 'insurance') {
      errs.push("vertical must be 'banking' or 'insurance'");
    }
    if (
      !Array.isArray(body?.channels_allowed) ||
      body.channels_allowed.length === 0 ||
      !body.channels_allowed.every((c) => typeof c === 'string' && c.length > 0)
    ) {
      errs.push('channels_allowed must be a non-empty array of strings');
    }
    if (errs.length > 0) {
      return res.status(400).json(
        wrapError(
          { code: 'EWS_400', message: errs.join('; '), severity: 'MEDIUM' },
          ctx,
        ),
      );
    }
    try {
      const created = await tenantLookup.create({
        tenant_id: body.tenant_id as string,
        name: (body.name as string).trim(),
        vertical: body.vertical as 'banking' | 'insurance',
        channels_allowed: body.channels_allowed as string[],
        active: typeof body.active === 'boolean' ? body.active : true,
      });
      res.status(201).json(wrapResponse(created, ctx, { code: 'EWS_201', message: 'Created' }));
    } catch (e) {
      if (e instanceof TenantConflict) {
        return res.status(409).json(
          wrapError(
            {
              code: 'EWS_409',
              message: e.message,
              severity: 'MEDIUM',
              detail: { tenant_id: e.tenant_id },
            },
            ctx,
          ),
        );
      }
      throw e;
    }
  });

  /**
   * PATCH /v1/tenants/:tenant_id — admin updates name / channels / active.
   * tenant_id is immutable. 404 envelope when missing.
   */
  app.patch('/v1/tenants/:tenant_id', requireTenantMw, requireRole('audit:read'), async (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    if (!tenantLookup.update) {
      return res.status(501).json(
        wrapError(
          { code: 'EWS_501', message: 'tenant lookup is read-only', severity: 'LOW' },
          ctx,
        ),
      );
    }
    const raw = req.body as { header?: unknown; body?: unknown } | unknown;
    const body = (raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
      ? (raw as { body: unknown }).body
      : raw) as {
      name?: unknown;
      channels_allowed?: unknown;
      active?: unknown;
    };
    const patch: { name?: string; channels_allowed?: string[]; active?: boolean } = {};
    if (body?.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return res.status(400).json(
          wrapError({ code: 'EWS_400', message: 'name must be a non-empty string', severity: 'MEDIUM' }, ctx),
        );
      }
      patch.name = body.name.trim();
    }
    if (body?.channels_allowed !== undefined) {
      if (
        !Array.isArray(body.channels_allowed) ||
        body.channels_allowed.length === 0 ||
        !body.channels_allowed.every((c) => typeof c === 'string' && c.length > 0)
      ) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'channels_allowed must be a non-empty string array', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      patch.channels_allowed = body.channels_allowed as string[];
    }
    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        return res.status(400).json(
          wrapError({ code: 'EWS_400', message: 'active must be a boolean', severity: 'MEDIUM' }, ctx),
        );
      }
      patch.active = body.active;
    }
    const updated = await tenantLookup.update(req.params.tenant_id, patch);
    if (!updated) {
      return res.status(404).json(
        wrapError(
          { code: 'EWS_404', message: `tenant '${req.params.tenant_id}' not found`, severity: 'LOW' },
          ctx,
        ),
      );
    }
    res.json(wrapResponse(updated, ctx));
  });

  /**
   * DELETE /v1/tenants/:tenant_id — admin removes a tenant.
   * 204 on success. 404 envelope when missing. 409 envelope when the
   * tenant is system-protected (BANK_DEMO is always protected).
   */
  app.delete('/v1/tenants/:tenant_id', requireTenantMw, requireRole('audit:read'), async (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    if (!tenantLookup.delete) {
      return res.status(501).json(
        wrapError(
          { code: 'EWS_501', message: 'tenant lookup is read-only', severity: 'LOW' },
          ctx,
        ),
      );
    }
    const result = await tenantLookup.delete(req.params.tenant_id);
    if (result === 'system_protected') {
      return res.status(409).json(
        wrapError(
          {
            code: 'EWS_409',
            message: `tenant '${req.params.tenant_id}' is system-protected and cannot be deleted`,
            severity: 'MEDIUM',
          },
          ctx,
        ),
      );
    }
    if (result === false) {
      return res.status(404).json(
        wrapError(
          { code: 'EWS_404', message: `tenant '${req.params.tenant_id}' not found`, severity: 'LOW' },
          ctx,
        ),
      );
    }
    res.status(204).end();
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

  // ── Core Insurance / Policy Master adapter (T6 M14.1) ─────────────────
  //
  // Four data-fetch endpoints over the insurance adapter — first BIL
  // adapter in Module 14. Same RBAC as the per-customer risk-profile
  // route (`customers:read_risk_profile`) since the data class is the
  // same: per-customer financial profile.

  /** GET /v1/integrations/insurance/policies?customer_id=X */
  app.get(
    '/v1/integrations/insurance/policies',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const customer_id = (req.query.customer_id as string | undefined) ?? '';
      if (!customer_id) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'customer_id query parameter is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const items = await insuranceAdapter.listPolicies(req.tenant!.tenant_id, customer_id, now());
        return res.json(wrapResponse({ items, total: items.length, customer_id }, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'insurance adapter failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/insurance/policies/:policy_id */
  app.get(
    '/v1/integrations/insurance/policies/:policy_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const policy_id = req.params.policy_id ?? '';
      try {
        const policy = await insuranceAdapter.getPolicy(req.tenant!.tenant_id, policy_id, now());
        if (!policy) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `policy ${policy_id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(policy, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'insurance adapter failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/insurance/claims?customer_id=X */
  app.get(
    '/v1/integrations/insurance/claims',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const customer_id = (req.query.customer_id as string | undefined) ?? '';
      if (!customer_id) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'customer_id query parameter is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const items = await insuranceAdapter.listClaims(req.tenant!.tenant_id, customer_id, now());
        return res.json(wrapResponse({ items, total: items.length, customer_id }, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'insurance adapter failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/insurance/claims/:claim_id */
  app.get(
    '/v1/integrations/insurance/claims/:claim_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const claim_id = req.params.claim_id ?? '';
      try {
        const claim = await insuranceAdapter.getClaim(req.tenant!.tenant_id, claim_id, now());
        if (!claim) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `claim ${claim_id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(claim, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'insurance adapter failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  // ── IFRS9 Stage adapter (T6 M14.2) ────────────────────────────────────

  /** GET /v1/integrations/ifrs9/stages/:customer_id — fetch one stage. */
  app.get(
    '/v1/integrations/ifrs9/stages/:customer_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const customer_id = req.params.customer_id ?? '';
      try {
        const stage = await ifrs9Adapter.getStage(req.tenant!.tenant_id, customer_id, now());
        if (!stage) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `IFRS9 record for ${customer_id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(stage, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'ifrs9 adapter failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * GET /v1/integrations/ifrs9/stages?stage=2&page=1&page_size=50
   * Paginated list of customers in the IFRS 9 book, optionally
   * filtered by stage. Highest-ECL first within each page.
   */
  app.get(
    '/v1/integrations/ifrs9/stages',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const stageRaw = req.query.stage as string | undefined;
      let stage: Ifrs9StageNum | undefined;
      if (stageRaw !== undefined) {
        const n = Number(stageRaw);
        if (n !== 1 && n !== 2 && n !== 3) {
          return res.status(400).json(
            wrapError(
              {
                code: 'EWS_400_invalid_stage',
                message: 'stage must be 1, 2, or 3',
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
        stage = n as Ifrs9StageNum;
      }
      const pageRaw = req.query.page as string | undefined;
      const sizeRaw = req.query.page_size as string | undefined;
      const page = pageRaw ? Math.max(1, Number(pageRaw) || 1) : 1;
      const page_size = sizeRaw ? Math.max(1, Math.min(200, Number(sizeRaw) || 50)) : 50;
      try {
        const out = await ifrs9Adapter.listStages(
          req.tenant!.tenant_id,
          { stage, page, page_size },
          now(),
        );
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'ifrs9 adapter failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  // ── AML Watchlist adapter (T6 M14.3) ─────────────────────────────────

  /**
   * POST /v1/integrations/aml/screen body: { customer_id }
   * Screen a customer against the configured watchlists. Synchronous
   * stub — production wires this to the AML hub.
   */
  app.post(
    '/v1/integrations/aml/screen',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const customer_id = (inner as { customer_id?: string } | undefined)?.customer_id;
      if (typeof customer_id !== 'string' || !customer_id.trim()) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'customer_id is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const result = await amlAdapter.screenCustomer(req.tenant!.tenant_id, customer_id, now());
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'aml adapter failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/aml/matches?customer_id=X — list customer's matches. */
  app.get(
    '/v1/integrations/aml/matches',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const customer_id = (req.query.customer_id as string | undefined) ?? '';
      if (!customer_id) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'customer_id query parameter is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const items = await amlAdapter.listMatches(req.tenant!.tenant_id, customer_id);
        return res.json(wrapResponse({ items, total: items.length, customer_id }, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'aml adapter failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/aml/matches/:match_id — single match. 404 on miss. */
  app.get(
    '/v1/integrations/aml/matches/:match_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const match_id = req.params.match_id ?? '';
      try {
        const match = await amlAdapter.getMatch(req.tenant!.tenant_id, match_id);
        if (!match) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `aml match ${match_id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(match, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'aml adapter failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * PATCH /v1/integrations/aml/matches/:match_id body: { status }
   * Update a match's status (cleared / escalated / false_positive).
   * Records the changed_by user from X-APEX-USER (default 'admin').
   */
  app.patch(
    '/v1/integrations/aml/matches/:match_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const match_id = req.params.match_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const status = (inner as { status?: unknown } | undefined)?.status;
      if (!isAmlMatchStatus(status)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_status',
              message: 'status must be one of open|cleared|escalated|false_positive',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const changed_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const updated = await amlAdapter.updateMatchStatus(
          req.tenant!.tenant_id,
          match_id,
          status as AmlMatchStatus,
          changed_by,
          now(),
        );
        return res.json(wrapResponse(updated, ctx));
      } catch (e) {
        if (e instanceof AmlError) {
          if (e.code === 'unknown_match') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_match', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError(
              { code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        return res.status(502).json(
          wrapError(
            {
              code: 'EWS_502',
              message: e instanceof Error ? e.message : 'aml adapter failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  // ── DMS Document Management adapter (T6 M14.4) ───────────────────────
  //
  // Document metadata layer over the BIL DMS upstream. List by customer
  // / by case, fetch single, update review status. RBAC mirrors the
  // existing per-customer routes (customers:read_risk_profile).

  /** GET /v1/integrations/dms/document-types — closed enum for SPA filter. */
  app.get(
    '/v1/integrations/dms/document-types',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = listDocumentTypes();
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /**
   * GET /v1/integrations/dms/documents?customer_id=&case_id=
   * Exactly one of customer_id / case_id must be provided. case_id
   * scopes to documents linked to that case (across customers if
   * applicable); customer_id scopes to all documents for a customer.
   */
  app.get(
    '/v1/integrations/dms/documents',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const customer_id = (req.query.customer_id as string | undefined) ?? '';
      const case_id = (req.query.case_id as string | undefined) ?? '';
      if (!customer_id && !case_id) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'one of customer_id or case_id is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (customer_id && case_id) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'supply only one of customer_id / case_id', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const items = case_id
          ? await dmsAdapter.listByCase(req.tenant!.tenant_id, case_id)
          : await dmsAdapter.listByCustomer(req.tenant!.tenant_id, customer_id, now());
        return res.json(
          wrapResponse(
            { items, total: items.length, customer_id: customer_id || null, case_id: case_id || null },
            ctx,
          ),
        );
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'dms adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/dms/documents/:document_id — single. 404 on miss. */
  app.get(
    '/v1/integrations/dms/documents/:document_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.document_id ?? '';
      try {
        const doc = await dmsAdapter.get(req.tenant!.tenant_id, id);
        if (!doc) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `dms document ${id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(doc, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'dms adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * PATCH /v1/integrations/dms/documents/:document_id/status body: { status }
   * Update review status (pending_review / verified / rejected / expired).
   * Records changed_by from X-APEX-USER (default 'admin').
   */
  app.patch(
    '/v1/integrations/dms/documents/:document_id/status',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.document_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const status = (inner as { status?: unknown } | undefined)?.status;
      if (!isDocumentStatus(status)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_status',
              message: 'status must be one of pending_review|verified|rejected|expired',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const changed_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const updated = await dmsAdapter.updateStatus(
          req.tenant!.tenant_id,
          id,
          status as DocumentStatus,
          changed_by,
          now(),
        );
        return res.json(wrapResponse(updated, ctx));
      } catch (e) {
        if (e instanceof DmsError) {
          if (e.code === 'unknown_document') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_document', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError(
              { code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'dms adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── Credit Bureau adapter (T6 M14.5) ─────────────────────────────────
  //
  // 5th adapter completing the BIL upstream regulatory + risk-data
  // sweep (after insurance, ifrs9, aml, dms, bureau).

  /** GET /v1/integrations/bureau/types — closed enum of bureaus. */
  app.get(
    '/v1/integrations/bureau/types',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = listBureauTypes();
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /**
   * POST /v1/integrations/bureau/pull body: { customer_id, bureau_type }
   * Idempotent per (tenant, customer, bureau, day) — same caller,
   * same day = same report. Pulled-by recorded from X-APEX-USER.
   */
  app.post(
    '/v1/integrations/bureau/pull',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const { customer_id, bureau_type } = (inner ?? {}) as {
        customer_id?: string;
        bureau_type?: BureauType;
      };
      const pulled_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const report = await bureauAdapter.pull(
          req.tenant!.tenant_id,
          (customer_id ?? '') as string,
          bureau_type as BureauType,
          pulled_by,
          now(),
        );
        return res.json(wrapResponse(report, ctx));
      } catch (e) {
        if (e instanceof BureauError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'bureau adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/bureau/reports?customer_id=X — list, newest-first. */
  app.get(
    '/v1/integrations/bureau/reports',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const customer_id = (req.query.customer_id as string | undefined) ?? '';
      if (!customer_id) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'customer_id query parameter is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const items = await bureauAdapter.listByCustomer(req.tenant!.tenant_id, customer_id);
        return res.json(wrapResponse({ items, total: items.length, customer_id }, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'bureau adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/bureau/reports/:report_id — single. 404 on miss. */
  app.get(
    '/v1/integrations/bureau/reports/:report_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.report_id ?? '';
      try {
        const report = await bureauAdapter.get(req.tenant!.tenant_id, id);
        if (!report) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `bureau report ${id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(report, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'bureau adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── Agent Productivity adapter (T6 M14.6) ────────────────────────────
  //
  // 4 routes over the BIL Agent upstream — list/single + per-period +
  // history. Read-only at this stage; productivity edits would come
  // from the upstream HR system, not this surface.

  /** GET /v1/integrations/agent/agents?tier=&status=&page=&page_size= */
  app.get(
    '/v1/integrations/agent/agents',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const tier = req.query.tier as string | undefined;
      const status = req.query.status as string | undefined;
      if (tier !== undefined && !isAgentTier(tier)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_tier', message: `invalid tier: ${tier}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (status !== undefined && !isAgentStatus(status)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_status', message: `invalid status: ${status}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const pageRaw = req.query.page as string | undefined;
      const sizeRaw = req.query.page_size as string | undefined;
      const page = pageRaw ? Math.max(1, Number(pageRaw) || 1) : 1;
      const page_size = sizeRaw ? Math.max(1, Math.min(100, Number(sizeRaw) || 25)) : 25;
      try {
        const out = await agentAdapter.list(
          req.tenant!.tenant_id,
          { tier: tier as AgentTier | undefined, status: status as AgentStatus | undefined, page, page_size },
          now(),
        );
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'agent adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/agent/agents/:agent_id — single agent. 404 on miss. */
  app.get(
    '/v1/integrations/agent/agents/:agent_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.agent_id ?? '';
      try {
        const agent = await agentAdapter.get(req.tenant!.tenant_id, id);
        if (!agent) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `agent ${id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(agent, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'agent adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * GET /v1/integrations/agent/agents/:agent_id/productivity[?period=YYYY-MM]
   * Single-period productivity. Period defaults to YYYY-MM of now.
   * 400 EWS_400_invalid_period when period malformed.
   */
  app.get(
    '/v1/integrations/agent/agents/:agent_id/productivity',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.agent_id ?? '';
      const period = req.query.period as string | undefined;
      try {
        const out = await agentAdapter.getProductivity(
          req.tenant!.tenant_id,
          id,
          { period },
          now(),
        );
        if (!out) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `agent ${id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof AgentError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'agent adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * GET /v1/integrations/agent/agents/:agent_id/productivity/history?months=12
   * Productivity for the last N months ending at now, newest-first.
   * months clamped to [1, 36].
   */
  app.get(
    '/v1/integrations/agent/agents/:agent_id/productivity/history',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.agent_id ?? '';
      const monthsRaw = req.query.months as string | undefined;
      let months = 12;
      if (monthsRaw !== undefined) {
        const n = Number(monthsRaw);
        months = Math.max(1, Math.min(36, Number.isFinite(n) ? n : 12));
      }
      try {
        // Validate the agent exists first so we 404 cleanly.
        const agent = await agentAdapter.get(req.tenant!.tenant_id, id);
        if (!agent) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `agent ${id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        const items = await agentAdapter.listProductivity(req.tenant!.tenant_id, id, months, now());
        return res.json(
          wrapResponse({ items, total: items.length, agent_id: id, months }, ctx),
        );
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'agent adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── Admin Configuration registry (T6 M13.1) ──────────────────────────
  //
  // Tenant-scoped key-value config store. The schema is platform-wide
  // (DEFAULTS in admin_config.ts); the store persists overrides only.
  // All routes are admin-only (audit:read) — config is sensitive ops
  // surface, not analyst-level.

  /** GET /v1/admin/config/categories — list distinct categories. */
  app.get(
    '/v1/admin/config/categories',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = listConfigCategories();
      res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /**
   * GET /v1/admin/config[?category=alerts]
   * Returns every config entry for the caller's tenant. Optional
   * category filter narrows the list. Each entry includes
   * `is_default` so the SPA can highlight overridden values.
   */
  app.get(
    '/v1/admin/config',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const categoryRaw = req.query.category as string | undefined;
      let category: ConfigCategory | undefined;
      if (categoryRaw !== undefined) {
        const valid = listConfigCategories() as readonly string[];
        if (!valid.includes(categoryRaw)) {
          return res.status(400).json(
            wrapError(
              {
                code: 'EWS_400_invalid_category',
                message: `category must be one of ${valid.join(',')}`,
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
        category = categoryRaw as ConfigCategory;
      }
      const all = configStore.list(req.tenant!.tenant_id);
      const items = category ? all.filter((e) => e.category === category) : all;
      res.json(wrapResponse({ items, total: items.length, category: category ?? null }, ctx));
    },
  );

  /** GET /v1/admin/config/:key — single entry. 404 when key is unknown. */
  app.get(
    '/v1/admin/config/:key',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const key = req.params.key ?? '';
      const entry = configStore.get(req.tenant!.tenant_id, key);
      if (!entry) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_key', message: `unknown config key: ${key}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      res.json(wrapResponse(entry, ctx));
    },
  );

  /**
   * PUT /v1/admin/config/:key
   * body: { value }
   * Sets the override for the supplied key. Validates the value
   * against the declared type. Returns the resulting entry.
   */
  app.put(
    '/v1/admin/config/:key',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const key = req.params.key ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      if (!inner || typeof inner !== 'object' || !('value' in (inner as object))) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'request body must include a value field', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const value = (inner as { value: unknown }).value as ConfigValue;
      const updated_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const entry = configStore.set(req.tenant!.tenant_id, key, value, updated_by, now());
        return res.json(wrapResponse(entry, ctx));
      } catch (e) {
        if (e instanceof ConfigValidationError) {
          const status = e.code === 'unknown_key' ? 404 : 400;
          const code = e.code === 'unknown_key' ? 'EWS_404_unknown_key' : `EWS_400_${e.code}`;
          return res.status(status).json(
            wrapError({ code, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'set failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** DELETE /v1/admin/config/:key — clear override → revert to default. */
  app.delete(
    '/v1/admin/config/:key',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const key = req.params.key ?? '';
      try {
        const entry = configStore.reset(req.tenant!.tenant_id, key);
        return res.json(wrapResponse(entry, ctx));
      } catch (e) {
        if (e instanceof ConfigValidationError && e.code === 'unknown_key') {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404_unknown_key', message: e.message, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'reset failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── BIL Audit & Compliance trail (T6 M15.1) ─────────────────────────
  //
  // Per-tenant structured audit log with filters tuned for RBI/IRDAI
  // evidence dumps. All routes RBAC audit:read (admin-only) — audit
  // events can contain PII (actor names, IP addresses, sensitive
  // resource ids).

  /**
   * POST /v1/audit/events — record a new audit event.
   * body: AuditEventInput
   * Returns the recorded event with assigned event_id + ts.
   */
  app.post(
    '/v1/audit/events',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      if (!inner || typeof inner !== 'object') {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'request body required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const event = auditTrailStore.record(req.tenant!.tenant_id, inner as AuditEventInput, now());
        return res.status(201).json(
          wrapResponse(event, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof AuditValidationError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'audit record failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * GET /v1/audit/events?actor_username=&action=&resource_type=&outcome=&
   *   severity=&since=&until=&page=&page_size=
   * Newest-first paginated query. Multiple actions can be supplied as a
   * comma-separated list (action=auth.login,auth.logout).
   */
  app.get(
    '/v1/audit/events',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filters: AuditFilters = {};
      if (typeof q.actor_username === 'string') filters.actor_username = q.actor_username;
      if (typeof q.action === 'string') filters.action = q.action;
      if (typeof q.resource_type === 'string') {
        if (!isAuditResourceType(q.resource_type)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_resource_type', message: `invalid resource_type: ${q.resource_type}`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filters.resource_type = q.resource_type as AuditResourceType;
      }
      if (typeof q.outcome === 'string') {
        if (!isAuditOutcome(q.outcome)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_outcome', message: `invalid outcome: ${q.outcome}`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filters.outcome = q.outcome as AuditOutcome;
      }
      if (typeof q.severity === 'string') {
        if (!isAuditSeverity(q.severity)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_severity', message: `invalid severity: ${q.severity}`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filters.severity = q.severity as AuditSeverity;
      }
      if (typeof q.since === 'string') filters.since = q.since;
      if (typeof q.until === 'string') filters.until = q.until;
      if (typeof q.page === 'string') filters.page = Math.max(1, Number(q.page) || 1);
      if (typeof q.page_size === 'string') {
        filters.page_size = Math.max(1, Math.min(500, Number(q.page_size) || 50));
      }
      const out = auditTrailStore.list(req.tenant!.tenant_id, filters);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/audit/actions — distinct action verbs for this tenant. */
  app.get(
    '/v1/audit/actions',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = auditTrailStore.listActions(req.tenant!.tenant_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /**
   * GET /v1/audit/summary?days=30
   * Aggregate counts by outcome / severity / action / resource_type
   * over the trailing window. days defaults to 30, clamped to [1, 365].
   */
  app.get(
    '/v1/audit/summary',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const daysRaw = req.query.days as string | undefined;
      let days = 30;
      if (daysRaw !== undefined) {
        const n = Number(daysRaw);
        days = Math.max(1, Math.min(365, Number.isFinite(n) ? n : 30));
      }
      const summary = auditTrailStore.summarise(req.tenant!.tenant_id, days, now());
      return res.json(wrapResponse({ ...summary, days }, ctx));
    },
  );

  /**
   * GET /v1/audit/integrity — recompute the chain hash and report
   * any tampering. Returns valid=true + last_hash on a clean chain.
   * Tenant-scoped; admin only.
   */
  app.get(
    '/v1/audit/integrity',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const out = auditTrailStore.verifyChain(req.tenant!.tenant_id, now());
      res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/audit/events/:event_id — single event. 404 on miss. */
  app.get(
    '/v1/audit/events/:event_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const event_id = req.params.event_id ?? '';
      const event = auditTrailStore.get(req.tenant!.tenant_id, event_id);
      if (!event) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404', message: `audit event ${event_id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(event, ctx));
    },
  );

  // ── BIL Data Ingestion connector registry (T6 M3.1) ─────────────────
  //
  // 8 BIL upstream connectors (CBS, Core Insurance, Policy Master,
  // Claims, Agent Productivity, AML, Bureau, IFRS9). Read routes are
  // analyst-level (audit:read = admin); the run-now + pause/resume
  // mutations are admin-only.

  /** GET /v1/ingestion/health — fleet aggregate. */
  app.get(
    '/v1/ingestion/health',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const summary = ingestionRegistry.health(req.tenant!.tenant_id);
      return res.json(wrapResponse(summary, ctx));
    },
  );

  /** GET /v1/ingestion/connectors — list every connector. */
  app.get(
    '/v1/ingestion/connectors',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = ingestionRegistry.list(req.tenant!.tenant_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/ingestion/connectors/:id — single connector. 404 on miss. */
  app.get(
    '/v1/ingestion/connectors/:id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const c = ingestionRegistry.get(req.tenant!.tenant_id, id);
      if (!c) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_connector', message: `unknown connector: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(c, ctx));
    },
  );

  /** GET /v1/ingestion/connectors/:id/runs?limit=50 — recent runs. */
  app.get(
    '/v1/ingestion/connectors/:id/runs',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const limitRaw = req.query.limit as string | undefined;
      const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw) || 50)) : 50;
      try {
        const items = ingestionRegistry.listRuns(req.tenant!.tenant_id, id, limit);
        return res.json(wrapResponse({ items, total: items.length, connector_id: id, limit }, ctx));
      } catch (e) {
        if (e instanceof IngestionError && e.code === 'unknown_connector') {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404_unknown_connector', message: e.message, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'list runs failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * POST /v1/ingestion/connectors/:id/run
   * Trigger an ad-hoc run. 404 on unknown id, 409 on paused connector.
   * Records the triggering user from X-APEX-USER (default 'admin').
   */
  app.post(
    '/v1/ingestion/connectors/:id/run',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const triggered_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const run = ingestionRegistry.runNow(req.tenant!.tenant_id, id, triggered_by, now());
        return res.status(202).json(
          wrapResponse(run, ctx, { code: 'EWS_202', message: 'Accepted' }),
        );
      } catch (e) {
        if (e instanceof IngestionError) {
          if (e.code === 'unknown_connector') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_connector', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          if (e.code === 'paused') {
            return res.status(409).json(
              wrapError(
                { code: 'EWS_409_paused', message: e.message, severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'run failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * POST /v1/ingestion/connectors/:id/{pause,resume}
   * Pause / resume a connector. 404 on unknown id.
   */
  app.post(
    '/v1/ingestion/connectors/:id/pause',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      try {
        const c = ingestionRegistry.setPaused(req.tenant!.tenant_id, id, true, now());
        return res.json(wrapResponse(c, ctx));
      } catch (e) {
        if (e instanceof IngestionError && e.code === 'unknown_connector') {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404_unknown_connector', message: e.message, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'pause failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  app.post(
    '/v1/ingestion/connectors/:id/resume',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      try {
        const c = ingestionRegistry.setPaused(req.tenant!.tenant_id, id, false, now());
        return res.json(wrapResponse(c, ctx));
      } catch (e) {
        if (e instanceof IngestionError && e.code === 'unknown_connector') {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404_unknown_connector', message: e.message, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'resume failed', severity: 'HIGH' },
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

  // ── BIL reports catalog + jobs (T6 M12.1) ─────────────────────────
  //
  // Additive on top of the existing /v1/reports/:type. The catalog is
  // a SPA picker source; jobs are a per-tenant ledger of who exported
  // what. RBAC: catalog read = customers:read_risk_profile (analyst+);
  // job submit/list = audit:read (admin) since the dump can include
  // PII.

  /** GET /v1/reports/catalog?category=&regulator= */
  app.get(
    '/v1/reports/catalog',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const cat = req.query.category as string | undefined;
      const reg = req.query.regulator as string | undefined;
      if (cat !== undefined && !isReportCategory(cat)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_category', message: `invalid category: ${cat}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (reg !== undefined && !isReportRegulator(reg)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_regulator', message: `invalid regulator: ${reg}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const items = listReportDefs({
        category: cat as ReportCategory | undefined,
        regulator: reg as ReportRegulator | undefined,
      });
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/reports/catalog/:id — single report definition. */
  app.get(
    '/v1/reports/catalog/:id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const def = getReportDef(id);
      if (!def) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_report', message: `unknown report_id: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(def, ctx));
    },
  );

  /**
   * POST /v1/reports/jobs body: ReportJobInput
   * Submit a report-export job. Stub completes synchronously and returns
   * a download_url; production wires this to a queue-backed worker.
   */
  app.post(
    '/v1/reports/jobs',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      if (!inner || typeof inner !== 'object') {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: 'request body required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const requested_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const job = reportJobStore.submit(
          req.tenant!.tenant_id,
          inner as ReportJobInput,
          requested_by,
          now(),
        );
        return res.status(201).json(
          wrapResponse(job, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof ReportsError) {
          const status =
            e.code === 'unknown_report' ? 404 :
            e.code === 'unsupported_format' ? 409 :
            400;
          const code =
            e.code === 'unknown_report' ? 'EWS_404_unknown_report' :
            e.code === 'unsupported_format' ? 'EWS_409_unsupported_format' :
            `EWS_400_${e.code}`;
          return res.status(status).json(
            wrapError({ code, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'submit failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * GET /v1/reports/jobs?status=&report_id=&requested_by=&page=&page_size=
   * Paginated newest-first listing for the caller's tenant.
   */
  app.get(
    '/v1/reports/jobs',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filters: { status?: JobStatus; report_id?: string; requested_by?: string; page?: number; page_size?: number } = {};
      if (typeof q.status === 'string') {
        if (!isJobStatus(q.status)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_status', message: `invalid status: ${q.status}`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filters.status = q.status as JobStatus;
      }
      if (typeof q.report_id === 'string') filters.report_id = q.report_id;
      if (typeof q.requested_by === 'string') filters.requested_by = q.requested_by;
      if (typeof q.page === 'string') filters.page = Math.max(1, Number(q.page) || 1);
      if (typeof q.page_size === 'string') {
        filters.page_size = Math.max(1, Math.min(200, Number(q.page_size) || 50));
      }
      const out = reportJobStore.list(req.tenant!.tenant_id, filters);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/reports/jobs/:job_id — single job. 404 on miss/cross-tenant. */
  app.get(
    '/v1/reports/jobs/:job_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const job_id = req.params.job_id ?? '';
      const job = reportJobStore.get(req.tenant!.tenant_id, job_id);
      if (!job) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404', message: `report job ${job_id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(job, ctx));
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
      const ctx = extractCtx(req, now);
      const type = req.params.type as ReportType;
      if (!REPORT_TYPES.includes(type)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: `type must be one of ${REPORT_TYPES.join(',')}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const periodRaw = (req.query.period as string | undefined) ?? 'month';
      if (!REPORT_PERIODS.includes(periodRaw as ReportPeriod)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: `period must be one of ${REPORT_PERIODS.join(',')}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const format = (req.query.format as string | undefined) ?? 'json';
      const VALID_FORMATS = ['json', 'csv', 'pdf', 'xlsx'] as const;
      if (!VALID_FORMATS.includes(format as (typeof VALID_FORMATS)[number])) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400', message: `format must be one of ${VALID_FORMATS.join(',')}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
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
        // T4.24 Phase 9 — JSON variant uses the bank-grade envelope.
        // Binary formats (csv/pdf/xlsx) above stay raw because the
        // envelope can't wrap a Buffer + Content-Disposition cleanly.
        res.json(wrapResponse(payload, ctx));
      } catch (e) {
        res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'report failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── Rules v2 (Module 3 banking-grade enhancements) ─────────────────

  /** GET /v1/rules/variables — banking variable library, grouped by category. */
  app.get('/v1/rules/variables', requireTenantMw, requireRole('rules:list'), (req: Request, res: Response) => {
    const ctx = extractCtx(req, now);
    res.json(wrapResponse({ categories: variablesByCategory() }, ctx));
  });

  // ── BIL rule template library (T6 M5.1) ────────────────────────────
  //
  // Three additive endpoints layered on top of T4.7's CRUD. Templates
  // are platform-wide (every tenant sees the same library); cloning
  // happens via the existing POST /v1/rules path.
  //
  // RBAC mirrors the rest of the rules surface: rules:list (analyst+).
  // Note: declaration order matters — `/v1/rules/templates*` and
  // `/v1/rules/variables` MUST come before `/v1/rules/:id` to win
  // pattern matching.

  /** GET /v1/rules/templates/categories — distinct template categories. */
  app.get(
    '/v1/rules/templates/categories',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = listRuleTemplateCategories();
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/rules/templates?vertical=&category= — filterable list. */
  app.get(
    '/v1/rules/templates',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const v = req.query.vertical as string | undefined;
      const c = req.query.category as string | undefined;
      if (v !== undefined && !isRuleTemplateVertical(v)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_vertical', message: `invalid vertical: ${v}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (c !== undefined && !isRuleTemplateCategory(c)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_category', message: `invalid category: ${c}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const items = listRuleTemplates({
        vertical: v as RuleTemplateVertical | undefined,
        category: c as RuleTemplateCategory | undefined,
      });
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/rules/templates/:id — single template. 404 EWS_404_unknown_template. */
  app.get(
    '/v1/rules/templates/:id',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const tpl = getRuleTemplate(id);
      if (!tpl) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_template', message: `unknown template: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(tpl, ctx));
    },
  );

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
