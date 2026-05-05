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
  BulkCloneError,
  expandBulkClone,
  type BulkCloneInput,
} from './rule_bulk_clone';
import {
  RuleSimulationError,
  simulateRuleByIds,
  type RuleSimulationInput,
} from './rule_simulation';
import {
  simulateRuleBundle,
  type BundleSimulationInput,
} from './rule_simulation_bundle';
import {
  RuleTemplateDiffError,
  diffRuleTemplatesByIds,
} from './rule_template_diff';
import {
  CustomRuleTemplateError,
  defaultCustomRuleTemplateStore,
  getEffectiveRuleTemplate,
  type CustomRuleTemplateStore,
} from './rule_templates_custom';
import {
  ThresholdError,
  checkBreachById,
  defaultThresholdOverrideStore,
  getEffectiveThreshold,
  getThreshold,
  listThresholds,
  type ThresholdOverrideStore,
} from './indicator_thresholds';
import {
  BreachScanError,
  scanCustomerBreaches,
  scanCustomerBreachesBulk,
  type BreachScanInput,
  type BulkBreachScanInput,
} from './customer_breach_scan';
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
import {
  ScenarioDiffError,
  diffScenariosByIds,
} from './scenario_diff';
import {
  CustomPresetError,
  defaultCustomPresetStore,
  getEffectivePreset,
  type CustomPresetStore,
} from './scenario_custom';
import {
  BulkRunError,
  resolveBulkInput,
  runBulkScenarios,
  type BulkRunInput,
} from './scenario_bulk';
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
import {
  ONBOARDING_STEPS,
  OnboardingError,
  defaultOnboardingStore,
  type OnboardingStore,
} from './tenant_onboarding';
import {
  TenantBulkError,
  applyBulkTenants,
  parseTenantCsv,
} from './tenant_bulk';
import {
  ApiKeyError,
  defaultApiKeyStore,
  validateInput as validateApiKeyInput,
  type ApiKeyStore,
} from './api_keys';
import {
  ConfigRollbackError,
  rollbackConfig,
} from './config_rollback';
import {
  ConfigBulkError,
  cloneTenantConfig,
  diffTenantConfig,
  exportConfig,
  importConfig,
} from './config_bulk';
import {
  optionalApiKeyAuth,
  requireApiKey,
  requireScope,
} from './api_key_auth';
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
  defaultIndicatorWeightLookup,
  IndicatorLookupError,
  isScoringVertical,
  scoreFromIndicators,
  type ByIndicatorItem,
  type IndicatorWeightLookup,
  type ScoringVertical,
} from './bil_scoring_v2';
import {
  WeightPresetError,
  compareByPresets,
  getWeightPreset,
  isWeightPresetMode,
  listWeightPresets,
  scoreByPreset,
  scoreByPresetBatch,
  type CompareByPresetsInput,
  type ScoreBatchInput,
  type WeightPresetMode,
} from './scoring_presets';
import {
  CustomWeightPresetError,
  defaultCustomWeightPresetStore,
  getEffectiveWeightPreset,
  type CustomWeightPresetStore,
} from './scoring_presets_custom';
import {
  BacktestError as IndicatorBacktestError,
  runBacktest as runIndicatorBacktest,
  type BacktestInput as IndicatorBacktestInput,
} from './indicator_backtest';
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
  defaultPushTransport,
  listPushTemplates,
  PushValidationError,
  renderPushTemplate,
  type PushMessageInput,
  type PushTemplateId,
  type PushTransport,
} from './notifications/push';
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
  AlertAckError,
  defaultAlertAckStore,
  type AlertAckStore,
} from './alert_ack';
import {
  AutoAckError,
  defaultAutoAckRuleStore,
  evaluateAutoAck,
  type AlertContext,
  type AutoAckRuleStore,
} from './alert_auto_ack';
import {
  WebhookChannelError,
  defaultNotificationWebhookStore,
  type NotificationWebhookStore,
} from './notification_webhook';
import {
  PreferenceError,
  defaultNotificationPreferenceStore,
  type NotificationPreferenceStore,
} from './notification_preferences';
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
  defaultFinanceAdapter,
  FinanceError,
  type FinanceAdapter,
} from './integrations/finance';
import {
  defaultHrAdapter,
  isEmployeeDepartment,
  isEmployeeStatus,
  type EmployeeDepartment,
  type EmployeeStatus,
  type HrAdapter,
} from './integrations/hr';
import {
  listFleetAdapters,
  runFleetHealth,
  type AdapterFleet,
} from './adapter_health';
import { buildCustomer360, Customer360Error } from './customer_360';
import {
  defaultCaseInvestigationStore,
  InvestigationError,
  isInvestigationStatus,
  type CaseInvestigationStore,
  type InvestigationDecision,
  type InvestigationStatus,
} from './case_investigation';
import {
  ChecklistError,
  defaultChecklistTemplateStore,
  isChecklistCategory,
  materialiseSteps,
  type ChecklistCategory,
  type ChecklistTemplateStore,
} from './case_checklists';
import {
  defaultMakerCheckerEngine,
  isMakerCheckerStatus,
  isSensitiveActionType,
  MakerCheckerError,
  type MakerCheckerEngine,
  type MakerCheckerStatus,
  type SensitiveActionType,
} from './case_maker_checker';
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
  AbTestError,
  runAbTest,
  runAbTestBatch,
  type AbTestBatchInput,
  type AbTestInput,
} from './ai_model_ab_test';
import {
  defaultPromotionEngine,
  isPromotionRequestStatus,
  PromotionError,
  type PromotionEngine,
  type PromotionRequestStatus,
} from './ai_model_promotion';
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
  EvidenceError,
  defaultEvidencePackageStore,
  validateFilters,
  type EvidenceFilters,
  type EvidencePackageStore,
} from './audit_evidence';
import {
  defaultIngestionRegistry,
  IngestionError,
  type IngestionRegistry,
} from './ingestion';
import {
  ConnectorSchemaError,
  getConnectorSchema,
  validateRecord,
} from './connector_schema';
import {
  SchemaOverrideError,
  defaultSchemaOverrideStore,
  type SchemaOverrideStore,
} from './connector_schema_overrides';
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
import {
  ScheduleError,
  defaultReportScheduleStore,
  type ReportScheduleInput,
  type ReportSchedulePatch,
  type ReportScheduleStore,
} from './report_schedules';

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
   * Override for tests — push transport (T6 M10.3). Defaults to the
   * module-level StubPushTransport. Production swaps in a Firebase
   * Admin SDK / APNS / Web Push transport.
   */
  pushTransport?: PushTransport;
  /**
   * Override for tests — alert routing engine (T6 M8.2). Defaults to
   * the module-level InMemoryAlertRoutingEngine. Tenant overrides
   * persist within the engine instance; tests pass a fresh engine.
   */
  alertRoutingEngine?: AlertRoutingEngine;
  /**
   * Override for tests — alert acknowledgment store (T6 M8.3). Defaults
   * to the module-level InMemoryAlertAckStore.
   */
  alertAckStore?: AlertAckStore;
  /**
   * Override for tests — alert auto-ack rule store (T6 M8.4).
   */
  autoAckRuleStore?: AutoAckRuleStore;
  /** Override for tests — notification webhook channel store (T6 M10.4). */
  notificationWebhookStore?: NotificationWebhookStore;
  /** Override for tests — per-user notification preference store (T6 M10.5). */
  notificationPreferenceStore?: NotificationPreferenceStore;
  /**
   * Override for tests — per-tenant custom scenario preset store
   * (T6 M16.4).
   */
  customPresetStore?: CustomPresetStore;
  /**
   * Override for tests — per-tenant custom weight preset store
   * (T6 M6.4).
   */
  customWeightPresetStore?: CustomWeightPresetStore;
  /** Override for tests — per-tenant connector schema overrides (T6 M3.3). */
  schemaOverrideStore?: SchemaOverrideStore;
  /** Override for tests — per-tenant custom rule template store (T6 M5.6). */
  customRuleTemplateStore?: CustomRuleTemplateStore;
  /** Override for tests — per-tenant indicator threshold overrides (T6 M4.4). */
  thresholdOverrideStore?: ThresholdOverrideStore;
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
   * Override for tests — Finance / Treasury adapter (T6 M14.7).
   * Defaults to the module-level StubFinanceAdapter. Production
   * swaps in an HTTP/SOAP gateway to the Finance core (e.g. Oracle
   * Flexcube / TCS BaNCS).
   */
  financeAdapter?: FinanceAdapter;
  /**
   * Override for tests — HR adapter (T6 M14.8). Defaults to the
   * module-level StubHrAdapter (80 staff per tenant + leave balance).
   * Production swaps in a SAP SuccessFactors / Workday / similar HR
   * upstream adapter.
   */
  hrAdapter?: HrAdapter;
  /**
   * Override for tests — indicator weight lookup (T6 M6.2). Defaults
   * to the module-level StubIndicatorWeightLookup with a hand-curated
   * BIL + banking catalogue mirror. Production swaps in an HTTP-backed
   * adapter to regulatory-svc/indicators.
   */
  indicatorWeightLookup?: IndicatorWeightLookup;
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
   * Override for tests — evidence package store (T6 M15.3). Defaults
   * to the module-level InMemoryEvidencePackageStore (cap 100/tenant).
   */
  evidenceStore?: EvidencePackageStore;
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
   * Override for tests — recurring report schedule store (T6 M12.2).
   * Defaults to the module-level InMemoryReportScheduleStore (cap 50).
   */
  reportScheduleStore?: ReportScheduleStore;
  /**
   * Override for tests — tenant onboarding store (T6 M2.2). Defaults
   * to the module-level InMemoryOnboardingStore.
   */
  onboardingStore?: OnboardingStore;
  /**
   * Override for tests — service-account API key store (T6 M1.2).
   * Defaults to the module-level InMemoryApiKeyStore (cap 20 active/tenant).
   */
  apiKeyStore?: ApiKeyStore;
  /**
   * Override for tests — BIL case investigation store (T6 M9.1).
   * Defaults to the module-level InMemoryCaseInvestigationStore.
   * Production swaps in a PG-backed store satisfying the same
   * interface.
   */
  caseInvestigationStore?: CaseInvestigationStore;
  /**
   * Override for tests — checklist template store (T6 M9.2).
   * Defaults to module-level singleton; tests pass a fresh store.
   */
  checklistTemplateStore?: ChecklistTemplateStore;
  /**
   * Override for tests — maker-checker engine (T6 M9.3). Defaults
   * to module-level singleton. Tracks pending sensitive actions
   * pending 4-eyes approval.
   */
  makerCheckerEngine?: MakerCheckerEngine;
  /**
   * Override for tests — BIL AI/ML model registry (T6 M7.1).
   * Defaults to the module-level InMemoryAiModelRegistry seeded with
   * 8 BIL model versions. Production swaps in an MLflow / Sagemaker
   * / Vertex-backed registry satisfying the same interface.
   */
  aiModelRegistry?: AiModelRegistry;
  /**
   * Override for tests — model promotion engine (T6 M7.2). Defaults
   * to the module-level InMemoryPromotionEngine. Tracks promotion
   * requests + decisions; does NOT mutate the registry's view (M7.3
   * will close that loop).
   */
  promotionEngine?: PromotionEngine;
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
  const pushTransport = deps.pushTransport ?? defaultPushTransport;
  const alertRoutingEngine = deps.alertRoutingEngine ?? defaultAlertRoutingEngine;
  const alertAckStore = deps.alertAckStore ?? defaultAlertAckStore;
  const autoAckRuleStore = deps.autoAckRuleStore ?? defaultAutoAckRuleStore;
  const notificationWebhookStore = deps.notificationWebhookStore ?? defaultNotificationWebhookStore;
  const notificationPreferenceStore =
    deps.notificationPreferenceStore ?? defaultNotificationPreferenceStore;
  const customPresetStore = deps.customPresetStore ?? defaultCustomPresetStore;
  const customWeightPresetStore = deps.customWeightPresetStore ?? defaultCustomWeightPresetStore;
  const schemaOverrideStore = deps.schemaOverrideStore ?? defaultSchemaOverrideStore;
  const customRuleTemplateStore = deps.customRuleTemplateStore ?? defaultCustomRuleTemplateStore;
  const thresholdOverrideStore = deps.thresholdOverrideStore ?? defaultThresholdOverrideStore;
  const insuranceAdapter = deps.insuranceAdapter ?? defaultInsuranceAdapter;
  const ifrs9Adapter = deps.ifrs9Adapter ?? defaultIfrs9Adapter;
  const amlAdapter = deps.amlAdapter ?? defaultAmlAdapter;
  const dmsAdapter = deps.dmsAdapter ?? defaultDmsAdapter;
  const bureauAdapter = deps.bureauAdapter ?? defaultBureauAdapter;
  const agentAdapter = deps.agentAdapter ?? defaultAgentAdapter;
  const financeAdapter = deps.financeAdapter ?? defaultFinanceAdapter;
  const hrAdapter = deps.hrAdapter ?? defaultHrAdapter;
  const indicatorWeightLookup = deps.indicatorWeightLookup ?? defaultIndicatorWeightLookup;
  const configStore = deps.configStore ?? defaultConfigStore;
  const auditTrailStore = deps.auditTrailStore ?? defaultAuditTrailStore;
  const evidenceStore = deps.evidenceStore ?? defaultEvidencePackageStore;
  const ingestionRegistry = deps.ingestionRegistry ?? defaultIngestionRegistry;
  const reportJobStore = deps.reportJobStore ?? defaultReportJobStore;
  const reportScheduleStore = deps.reportScheduleStore ?? defaultReportScheduleStore;
  const onboardingStore = deps.onboardingStore ?? defaultOnboardingStore;
  const apiKeyStore = deps.apiKeyStore ?? defaultApiKeyStore;
  const caseInvestigationStore = deps.caseInvestigationStore ?? defaultCaseInvestigationStore;
  const checklistTemplateStore = deps.checklistTemplateStore ?? defaultChecklistTemplateStore;
  const makerCheckerEngine = deps.makerCheckerEngine ?? defaultMakerCheckerEngine;
  const aiModelRegistry = deps.aiModelRegistry ?? defaultAiModelRegistry;
  const promotionEngine = deps.promotionEngine ?? defaultPromotionEngine;
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

  // ── Alert acknowledgment workflow (T6 M8.3) ─────────────────────────
  //
  // Per-alert ack/unack lifecycle with notes + history. The full
  // investigation lifecycle lives in M9.1; this is the lighter "I've
  // seen this" affordance the BIL §11 SLA timer needs to satisfy.
  // Ack = analyst+ (cases:log_action); reads = alerts:list.

  /** POST /v1/alerts/:alert_id/ack body { notes? } — 200 with new state. */
  app.post(
    '/v1/alerts/:alert_id/ack',
    requireTenantMw,
    requireRole('cases:log_action'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const alert_id = req.params.alert_id ?? '';
      const actor_username = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { notes?: unknown };
      try {
        const out = alertAckStore.acknowledge(
          req.tenant!.tenant_id,
          alert_id,
          actor_username,
          wrapper.notes as string | null | undefined,
          now(),
        );
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof AlertAckError) {
          if (e.code === 'already_acknowledged') {
            return res.status(409).json(
              wrapError({ code: `EWS_409_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'ack failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** POST /v1/alerts/:alert_id/unack body { reason } — required reason. */
  app.post(
    '/v1/alerts/:alert_id/unack',
    requireTenantMw,
    requireRole('cases:log_action'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const alert_id = req.params.alert_id ?? '';
      const actor_username = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { reason?: unknown };
      try {
        const out = alertAckStore.unacknowledge(
          req.tenant!.tenant_id,
          alert_id,
          actor_username,
          (wrapper.reason ?? '') as string,
          now(),
        );
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof AlertAckError) {
          if (e.code === 'not_acknowledged') {
            return res.status(409).json(
              wrapError({ code: `EWS_409_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'unack failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/alerts/:alert_id/ack — current ack state. Always 200
   *  (an alert that was never touched returns status='open'). */
  app.get(
    '/v1/alerts/:alert_id/ack',
    requireTenantMw,
    requireRole('alerts:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const alert_id = req.params.alert_id ?? '';
      try {
        const state = alertAckStore.get(req.tenant!.tenant_id, alert_id);
        return res.json(wrapResponse(state, ctx));
      } catch (e) {
        if (e instanceof AlertAckError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/alerts/:alert_id/ack/history — history list (oldest-first). */
  app.get(
    '/v1/alerts/:alert_id/ack/history',
    requireTenantMw,
    requireRole('alerts:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const alert_id = req.params.alert_id ?? '';
      try {
        const state = alertAckStore.get(req.tenant!.tenant_id, alert_id);
        return res.json(wrapResponse({ alert_id, items: state.history, total: state.history.length }, ctx));
      } catch (e) {
        if (e instanceof AlertAckError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  // ── Alert auto-ack threshold rules (T6 M8.4) ─────────────────────────
  //
  // Tenant-scoped policy: which alerts get auto-acked at receipt
  // time? CRUD + an evaluate endpoint that the future alert-ingest
  // path (M8.5) will call before persisting an alert.

  /** GET /v1/alerts/auto-ack/rules — list rules. */
  app.get(
    '/v1/alerts/auto-ack/rules',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = autoAckRuleStore.list(req.tenant!.tenant_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/alerts/auto-ack/rules — create rule. */
  app.post(
    '/v1/alerts/auto-ack/rules',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const rule = autoAckRuleStore.create(
          req.tenant!.tenant_id,
          inner,
          created_by,
          now(),
        );
        return res.status(201).json(
          wrapResponse(rule, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof AutoAckError) {
          if (e.code === 'cap_reached') {
            return res.status(409).json(
              wrapError(
                { code: 'EWS_409_cap_reached', message: e.message, severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** DELETE /v1/alerts/auto-ack/rules/:rule_id — remove rule. */
  app.delete(
    '/v1/alerts/auto-ack/rules/:rule_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const removed = autoAckRuleStore.delete(req.tenant!.tenant_id, id);
      if (!removed) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_rule', message: `auto-ack rule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.status(204).send();
    },
  );

  /** POST /v1/alerts/auto-ack/evaluate body { bil_class, source_system?, tags? }
   *  — return matching rule (if any). */
  app.post(
    '/v1/alerts/auto-ack/evaluate',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as AlertContext;
      if (!wrapper || typeof wrapper !== 'object' || !isBilAlertClass(wrapper.bil_class)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'bil_class is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const rules = autoAckRuleStore.list(req.tenant!.tenant_id);
      const match = evaluateAutoAck(rules, wrapper);
      return res.json(
        wrapResponse({ matched: match !== null, match }, ctx),
      );
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

  // ── Per-customer 360 drill-through (T6 M11.6) ────────────────────────
  //
  // Single endpoint that orchestrates 6 integration adapters
  // (insurance, ifrs9, aml, dms, bureau, finance) + the M9.1
  // investigation store into one consolidated customer view. Panel-
  // level degradation: if any adapter throws, that panel comes back
  // null + the panel name is added to `degraded[]` in the response,
  // but the call still 200s — partial answers beat hard failures
  // when the SPA needs to render *something* on the customer page.
  app.get(
    '/v1/customers/:customer_id/360',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const customer_id = req.params.customer_id ?? '';
      try {
        const view = await buildCustomer360(
          req.tenant!.tenant_id,
          customer_id,
          {
            insuranceAdapter,
            ifrs9Adapter,
            amlAdapter,
            dmsAdapter,
            bureauAdapter,
            financeAdapter,
            caseInvestigationStore,
          },
          now,
        );
        return res.json(wrapResponse(view, ctx));
      } catch (e) {
        if (e instanceof Customer360Error) {
          return res.status(400).json(
            wrapError(
              { code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        return res.status(500).json(
          wrapError(
            {
              code: 'EWS_500',
              message: e instanceof Error ? e.message : 'customer-360 failed',
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

  /** POST /v1/ai/models/ab-test (T6 M7.3) — score the same input
   *  against TWO models and return both + a delta summary. */
  app.post(
    '/v1/ai/models/ab-test',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const result = runAbTest(
          aiModelRegistry,
          (inner ?? {}) as AbTestInput,
          req.tenant!.tenant_id,
          now(),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof AbTestError) {
          if (e.code === 'unknown_model') {
            return res.status(404).json(
              wrapError({ code: 'EWS_404_unknown_model', message: e.message, severity: 'LOW' }, ctx),
            );
          }
          if (e.code === 'inference_failed') {
            return res.status(500).json(
              wrapError({ code: 'EWS_500_inference_failed', message: e.message, severity: 'HIGH' }, ctx),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/ai/models/ab-test/batch (T6 M7.4) — same A/B harness
   *  across N customers; aggregate delta + band-match rate. */
  app.post(
    '/v1/ai/models/ab-test/batch',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const result = runAbTestBatch(
          aiModelRegistry,
          (inner ?? {}) as AbTestBatchInput,
          req.tenant!.tenant_id,
          now(),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof AbTestError) {
          if (e.code === 'unknown_model') {
            return res.status(404).json(
              wrapError({ code: 'EWS_404_unknown_model', message: e.message, severity: 'LOW' }, ctx),
            );
          }
          if (e.code === 'inference_failed') {
            return res.status(500).json(
              wrapError({ code: 'EWS_500_inference_failed', message: e.message, severity: 'HIGH' }, ctx),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

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

  // ── BIL AI/ML model promotion workflow (T6 M7.2) ─────────────────────
  //
  // 5 routes for the request → review → approve/reject lifecycle.
  // Read = analyst+ (customers:read_risk_profile); request = same;
  // approve/reject = admin (audit:read).

  function mapPromotionError(e: unknown, ctx: ReturnType<typeof extractCtx>): {
    status: number;
    body: ReturnType<typeof wrapError>;
  } {
    if (!(e instanceof PromotionError)) {
      return {
        status: 500,
        body: wrapError(
          { code: 'EWS_500', message: e instanceof Error ? e.message : 'promotion failed', severity: 'HIGH' },
          ctx,
        ),
      };
    }
    if (e.code === 'unknown_request') {
      return {
        status: 404,
        body: wrapError(
          { code: 'EWS_404_unknown_request', message: e.message, severity: 'LOW' },
          ctx,
        ),
      };
    }
    if (e.code === 'request_already_pending' || e.code === 'already_decided') {
      return {
        status: 409,
        body: wrapError(
          { code: `EWS_409_${e.code}`, message: e.message, severity: 'MEDIUM' },
          ctx,
        ),
      };
    }
    return {
      status: 400,
      body: wrapError(
        { code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' },
        ctx,
      ),
    };
  }

  function promotionActor(req: Request): string {
    const v = req.headers['x-apex-user'];
    return typeof v === 'string' && v.trim() ? v.trim() : 'admin';
  }

  /** POST /v1/ai/promotions — request a promotion (analyst+). */
  app.post(
    '/v1/ai/promotions',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const r = promotionEngine.requestPromotion(
          req.tenant!.tenant_id,
          inner,
          promotionActor(req),
          now(),
        );
        return res.status(201).json(
          wrapResponse(r, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        const m = mapPromotionError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  /** GET /v1/ai/promotions?status=&model_id=&requested_by=&page=&page_size= */
  app.get(
    '/v1/ai/promotions',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filters: {
        status?: PromotionRequestStatus;
        model_id?: string;
        requested_by?: string;
        page?: number;
        page_size?: number;
      } = {};
      if (typeof q.status === 'string') {
        if (!isPromotionRequestStatus(q.status)) {
          return res.status(400).json(
            wrapError(
              {
                code: 'EWS_400_invalid_status',
                message: `invalid status: ${q.status}`,
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
        filters.status = q.status as PromotionRequestStatus;
      }
      if (typeof q.model_id === 'string') filters.model_id = q.model_id;
      if (typeof q.requested_by === 'string') filters.requested_by = q.requested_by;
      if (typeof q.page === 'string') filters.page = Math.max(1, Number(q.page) || 1);
      if (typeof q.page_size === 'string') {
        filters.page_size = Math.max(1, Math.min(200, Number(q.page_size) || 50));
      }
      const out = promotionEngine.list(req.tenant!.tenant_id, filters);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/ai/promotions/:request_id — single request. */
  app.get(
    '/v1/ai/promotions/:request_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.request_id ?? '';
      const r = promotionEngine.get(req.tenant!.tenant_id, id);
      if (!r) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_request', message: `unknown promotion request: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(r, ctx));
    },
  );

  /** POST /v1/ai/promotions/:request_id/approve body: { decision_notes? } */
  app.post(
    '/v1/ai/promotions/:request_id/approve',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.request_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const notes =
        inner && typeof inner === 'object' && 'decision_notes' in (inner as object)
          ? ((inner as { decision_notes: unknown }).decision_notes as string | null)
          : null;
      try {
        const r = promotionEngine.approve(
          req.tenant!.tenant_id,
          id,
          promotionActor(req),
          notes ?? null,
          now(),
        );
        return res.json(wrapResponse(r, ctx));
      } catch (e) {
        const m = mapPromotionError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  /** POST /v1/ai/promotions/:request_id/reject body: { decision_notes? } */
  app.post(
    '/v1/ai/promotions/:request_id/reject',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.request_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const notes =
        inner && typeof inner === 'object' && 'decision_notes' in (inner as object)
          ? ((inner as { decision_notes: unknown }).decision_notes as string | null)
          : null;
      try {
        const r = promotionEngine.reject(
          req.tenant!.tenant_id,
          id,
          promotionActor(req),
          notes ?? null,
          now(),
        );
        return res.json(wrapResponse(r, ctx));
      } catch (e) {
        const m = mapPromotionError(e, ctx);
        return res.status(m.status).json(m.body);
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

  // ── Custom user-defined scenario presets (T6 M16.4) ──────────────────
  // Declared BEFORE /library/:id so the literal "custom" segment wins.

  /** GET /v1/scenarios/library/custom — list custom presets for tenant. */
  app.get(
    '/v1/scenarios/library/custom',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = customPresetStore.list(req.tenant!.tenant_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/scenarios/library/custom — create custom preset. */
  app.post(
    '/v1/scenarios/library/custom',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const preset = customPresetStore.create(
          req.tenant!.tenant_id,
          inner,
          created_by,
          now(),
        );
        // T6 M16.6 — write audit event for the create.
        try {
          auditTrailStore.record(
            req.tenant!.tenant_id,
            {
              actor_username: created_by,
              actor_role: 'admin',
              action: 'scenario.create',
              resource_type: 'scenario',
              resource_id: preset.id,
              outcome: 'success',
              severity: 'info',
              metadata: {
                name: preset.name,
                vertical: preset.regulator,
                severity_tier: preset.severity,
                shocks: preset.shocks,
              },
            },
            now(),
          );
        } catch {
          // swallow — preset created successfully; audit failure
          // will surface via M15.2 chain check.
        }
        return res.status(201).json(
          wrapResponse(preset, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof CustomPresetError) {
          if (e.code === 'cap_reached') {
            return res.status(409).json(
              wrapError(
                { code: 'EWS_409_cap_reached', message: e.message, severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/scenarios/library/custom/clone-from-library (T6 M16.8)
   *  body { source_preset_id, name? } — reads a library preset and
   *  creates an editable custom copy. Writes scenario.create audit
   *  with `cloned_from` metadata. Declared BEFORE /:preset_id so the
   *  literal `clone-from-library` segment wins. */
  app.post(
    '/v1/scenarios/library/custom/clone-from-library',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { source_preset_id?: unknown; name?: unknown };
      if (typeof wrapper.source_preset_id !== 'string' || !wrapper.source_preset_id.trim()) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'source_preset_id is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const source = getScenarioPreset(wrapper.source_preset_id);
      if (!source) {
        return res.status(404).json(
          wrapError(
            {
              code: 'EWS_404_unknown_preset',
              message: `library preset ${wrapper.source_preset_id} not found`,
              severity: 'LOW',
            },
            ctx,
          ),
        );
      }
      // Build the create input from the source preset; override name
      // when caller supplies one, else default to "Copy of <name>".
      const overrideName = typeof wrapper.name === 'string' && wrapper.name.trim()
        ? wrapper.name.trim()
        : null;
      const createInput = {
        name: overrideName ?? `Copy of ${source.name}`,
        description: source.description,
        category: source.category,
        regulator: source.regulator,
        severity: source.severity,
        shocks: source.shocks,
        source_doc: `Cloned from ${source.id} by ${created_by}`,
      };
      try {
        const preset = customPresetStore.create(
          req.tenant!.tenant_id,
          createInput,
          created_by,
          now(),
        );
        // Write scenario.create audit event with cloned_from metadata.
        try {
          auditTrailStore.record(
            req.tenant!.tenant_id,
            {
              actor_username: created_by,
              actor_role: 'admin',
              action: 'scenario.create',
              resource_type: 'scenario',
              resource_id: preset.id,
              outcome: 'success',
              severity: 'info',
              metadata: {
                name: preset.name,
                cloned_from: source.id,
                shocks: preset.shocks,
              },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.status(201).json(
          wrapResponse(preset, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof CustomPresetError) {
          if (e.code === 'cap_reached') {
            return res.status(409).json(
              wrapError(
                { code: 'EWS_409_cap_reached', message: e.message, severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/scenarios/library/custom/bulk-clone-from-library (T6 M16.9)
   *  body { preset_ids[], name_prefix? } — iterates M16.8 single-clone
   *  over the list. Cap 10 per call. Writes one scenario.create audit
   *  event per successful clone (cloned_from metadata). Per-row
   *  outcome surfaced as {created[], skipped[]}. */
  app.post(
    '/v1/scenarios/library/custom/bulk-clone-from-library',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { preset_ids?: unknown; name_prefix?: unknown };
      if (!Array.isArray(wrapper.preset_ids) || wrapper.preset_ids.length === 0) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'preset_ids[] must be non-empty', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (wrapper.preset_ids.length > 10) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'preset_ids[] exceeds cap of 10', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const prefix =
        typeof wrapper.name_prefix === 'string' && wrapper.name_prefix.trim()
          ? wrapper.name_prefix.trim()
          : null;
      const tenantId = req.tenant!.tenant_id;
      const created: Array<{ source_preset_id: string; preset_id: string; name: string }> = [];
      const skipped: Array<{ source_preset_id: string; reason: string }> = [];

      for (const sid of wrapper.preset_ids) {
        if (typeof sid !== 'string' || !sid.trim()) {
          skipped.push({ source_preset_id: String(sid), reason: 'invalid_id' });
          continue;
        }
        const source = getScenarioPreset(sid);
        if (!source) {
          skipped.push({ source_preset_id: sid, reason: 'unknown_source' });
          continue;
        }
        const createInput = {
          name: prefix ? `${prefix}${source.name}` : `Copy of ${source.name}`,
          description: source.description,
          category: source.category,
          regulator: source.regulator,
          severity: source.severity,
          shocks: source.shocks,
          source_doc: `Cloned from ${source.id} by ${created_by}`,
        };
        try {
          const preset = customPresetStore.create(tenantId, createInput, created_by, now());
          // Best-effort audit
          try {
            auditTrailStore.record(
              tenantId,
              {
                actor_username: created_by,
                actor_role: 'admin',
                action: 'scenario.create',
                resource_type: 'scenario',
                resource_id: preset.id,
                outcome: 'success',
                severity: 'info',
                metadata: {
                  name: preset.name,
                  cloned_from: source.id,
                  shocks: preset.shocks,
                  bulk: true,
                },
              },
              now(),
            );
          } catch {
            // swallow
          }
          created.push({
            source_preset_id: source.id,
            preset_id: preset.id,
            name: preset.name,
          });
        } catch (e) {
          if (e instanceof CustomPresetError) {
            skipped.push({ source_preset_id: sid, reason: e.code });
          } else {
            skipped.push({
              source_preset_id: sid,
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      return res.json(
        wrapResponse(
          {
            requested_count: wrapper.preset_ids.length,
            created_count: created.length,
            skipped_count: skipped.length,
            created,
            skipped,
            generated_at: now().toISOString(),
          },
          ctx,
        ),
      );
    },
  );

  /** PUT /v1/scenarios/library/custom/:preset_id (T6 M16.7) — replace
   *  mutable fields. Writes scenario.update audit event with metadata. */
  app.put(
    '/v1/scenarios/library/custom/:preset_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.preset_id ?? '';
      const updated_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      // Capture previous for audit metadata
      const previous = customPresetStore.get(req.tenant!.tenant_id, id);
      try {
        const next = customPresetStore.update(
          req.tenant!.tenant_id,
          id,
          inner,
          updated_by,
          now(),
        );
        // Write scenario.update audit event
        try {
          auditTrailStore.record(
            req.tenant!.tenant_id,
            {
              actor_username: updated_by,
              actor_role: 'admin',
              action: 'scenario.update',
              resource_type: 'scenario',
              resource_id: id,
              outcome: 'success',
              severity: 'info',
              metadata: {
                previous_name: previous?.name ?? null,
                new_name: next.name,
                shocks_before: previous?.shocks ?? null,
                shocks_after: next.shocks,
              },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.json(wrapResponse(next, ctx));
      } catch (e) {
        if (e instanceof CustomPresetError) {
          if (e.code === 'unknown_preset') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_preset', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** DELETE /v1/scenarios/library/custom/:preset_id — remove custom preset. */
  app.delete(
    '/v1/scenarios/library/custom/:preset_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.preset_id ?? '';
      const deleted_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      // T6 M16.6 — capture the preset for the audit metadata BEFORE delete.
      const previous = customPresetStore.get(req.tenant!.tenant_id, id);
      const removed = customPresetStore.delete(req.tenant!.tenant_id, id);
      if (!removed) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_preset', message: `custom preset ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      // Write audit event for the delete.
      try {
        auditTrailStore.record(
          req.tenant!.tenant_id,
          {
            actor_username: deleted_by,
            actor_role: 'admin',
            action: 'scenario.delete',
            resource_type: 'scenario',
            resource_id: id,
            outcome: 'success',
            severity: 'info',
            metadata: previous
              ? {
                  previous_name: previous.name,
                  previous_severity: previous.severity,
                }
              : {},
          },
          now(),
        );
      } catch {
        // swallow
      }
      return res.status(204).send();
    },
  );

  /** GET /v1/scenarios/library/custom/:preset_id/history?limit=50 (T6 M16.6)
   *  — slim audit-history view filtered to scenario events for this id. */
  app.get(
    '/v1/scenarios/library/custom/:preset_id/history',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.preset_id ?? '';
      const limitRaw = req.query.limit;
      const limit =
        typeof limitRaw === 'string' ? Math.max(1, Math.min(200, Number(limitRaw) || 50)) : 50;
      const out = auditTrailStore.list(req.tenant!.tenant_id, {
        resource_type: 'scenario',
        action: 'scenario.create,scenario.update,scenario.delete',
        page_size: limit,
      });
      const items = out.items
        .filter((e) => e.resource_id === id)
        .map((e) => ({
          event_id: e.event_id,
          ts: e.ts,
          actor_username: e.actor_username,
          action: e.action,
          metadata: e.metadata,
        }));
      return res.json(wrapResponse({ items, total: items.length, preset_id: id, limit }, ctx));
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

  // ── BIL scenario bulk-run + comparison (T6 M16.2) ────────────────────
  //
  // Fires multiple presets against the portfolio and returns a ranked
  // comparison table. Caller supplies EITHER preset_ids[] OR category;
  // exactly one. Re-uses the existing runScenario engine + portfolio.
  app.post(
    '/v1/scenarios/bulk-run',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const tenantId = req.tenant!.tenant_id;
        const { presets, selection } = resolveBulkInput(
          (inner ?? {}) as BulkRunInput,
          (id) => getEffectivePreset(customPresetStore, tenantId, id),
        );
        const result = runBulkScenarios(
          req.tenant!.tenant_id,
          presets,
          selection,
          portfolio,
          now,
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof BulkRunError) {
          const status = e.code === 'unknown_preset' ? 404 : 400;
          const code =
            e.code === 'unknown_preset'
              ? 'EWS_404_unknown_preset'
              : `EWS_400_${e.code}`;
          return res.status(status).json(
            wrapError({ code, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            {
              code: 'EWS_500',
              message: e instanceof Error ? e.message : 'bulk-run failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  // ── Scenario diff (T6 M16.3) ─────────────────────────────────────────
  //
  // Pure-function field-by-field diff between two M16.1 library
  // presets. Drives the SPA's side-by-side compare panel.
  // RBAC matches the rest of /v1/scenarios — analyst-level read.
  app.post(
    '/v1/scenarios/diff',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { left_id?: unknown; right_id?: unknown };
      try {
        const tenantId = req.tenant!.tenant_id;
        const result = diffScenariosByIds(
          wrapper.left_id,
          wrapper.right_id,
          now(),
          (id) => getEffectivePreset(customPresetStore, tenantId, id),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof ScenarioDiffError) {
          if (e.code === 'unknown_preset') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_preset', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'diff failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── Custom user-defined scenario presets (T6 M16.4) ──────────────────
  //
  // Per-tenant CRUD for user-authored scenario presets. Same shape
  // as M16.1 ScenarioPreset so M16.2 bulk-run + M16.3 diff work
  // unchanged when a custom id is passed in.

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

  // ── Push notification channel (T6 M10.3) ────────────────────────────
  //
  // 3rd <Channel>Transport (after email + SMS). 4 routes mirror the
  // shape: templates / preview / send / log.

  /** GET /v1/notifications/push/templates — list canned BIL templates. */
  app.get(
    '/v1/notifications/push/templates',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = listPushTemplates().map((t) => ({
        id: t.id,
        description: t.description,
        required_vars: t.required_vars,
        title: t.title,
        body: t.body,
      }));
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /**
   * POST /v1/notifications/push/preview body: { template_id, template_vars }
   * Render a template + vars to (title, body, missing_vars[]) without sending.
   */
  app.post(
    '/v1/notifications/push/preview',
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
        template_id?: PushTemplateId;
        template_vars?: Record<string, string | number>;
      };
      if (!template_id || typeof template_id !== 'string') {
        return res.status(400).json(
          wrapError({ code: 'EWS_400', message: 'template_id is required', severity: 'MEDIUM' }, ctx),
        );
      }
      try {
        const out = renderPushTemplate(template_id, template_vars ?? {});
        return res.json(wrapResponse({ template_id, ...out }, ctx));
      } catch (e) {
        if (e instanceof PushValidationError) {
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
   * POST /v1/notifications/push/send body: PushMessageInput
   * Validates + dispatches via the configured transport. Admin-only —
   * sending push is higher-trust than reading the bell stream.
   */
  app.post(
    '/v1/notifications/push/send',
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
        const receipt = await pushTransport.send(req.tenant!.tenant_id, inner as PushMessageInput);
        return res.status(201).json(
          wrapResponse({ ok: true, receipt }, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof PushValidationError) {
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

  /** GET /v1/notifications/push/log?limit=50 — tenant-scoped ledger. */
  app.get(
    '/v1/notifications/push/log',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const limitRaw = req.query.limit;
      const limit = typeof limitRaw === 'string' ? Math.max(1, Math.min(500, Number(limitRaw) || 50)) : 50;
      const items = pushTransport.recent(req.tenant!.tenant_id, limit);
      res.json(wrapResponse({ items, total: items.length, limit }, ctx));
    },
  );

  // ── Notification webhook channel (T6 M10.4) ──────────────────────────
  // Sibling to M10.1/2/3 (email/SMS/push). BIL admins register an
  // outbound URL that receives every notification as JSON POST.

  /** GET /v1/notifications/webhook/subscriptions */
  app.get(
    '/v1/notifications/webhook/subscriptions',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = notificationWebhookStore.list(req.tenant!.tenant_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/notifications/webhook/subscriptions {name, url, enabled?} */
  app.post(
    '/v1/notifications/webhook/subscriptions',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const sub = notificationWebhookStore.create(
          req.tenant!.tenant_id,
          inner,
          created_by,
          now(),
        );
        return res.status(201).json(
          wrapResponse(sub, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof WebhookChannelError) {
          if (e.code === 'cap_reached' || e.code === 'duplicate_url') {
            return res.status(409).json(
              wrapError({ code: `EWS_409_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** DELETE /v1/notifications/webhook/subscriptions/:webhook_id */
  app.delete(
    '/v1/notifications/webhook/subscriptions/:webhook_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.webhook_id ?? '';
      const removed = notificationWebhookStore.delete(req.tenant!.tenant_id, id);
      if (!removed) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_webhook', message: `webhook ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.status(204).send();
    },
  );

  /** POST /v1/notifications/webhook/send {event_type, payload} — fan to all enabled subs. */
  app.post(
    '/v1/notifications/webhook/send',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { event_type?: string; payload?: Record<string, unknown> };
      try {
        const items = notificationWebhookStore.send(
          req.tenant!.tenant_id,
          wrapper.event_type ?? '',
          wrapper.payload ?? {},
          now(),
        );
        return res.json(wrapResponse({ items, total: items.length }, ctx));
      } catch (e) {
        if (e instanceof WebhookChannelError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/notifications/webhook/subscriptions/:webhook_id/deliveries */
  app.get(
    '/v1/notifications/webhook/subscriptions/:webhook_id/deliveries',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.webhook_id ?? '';
      const limitRaw = req.query.limit;
      const limit =
        typeof limitRaw === 'string' ? Math.max(1, Math.min(200, Number(limitRaw) || 50)) : 50;
      const items = notificationWebhookStore.listDeliveries(req.tenant!.tenant_id, id, limit);
      return res.json(wrapResponse({ items, total: items.length, limit }, ctx));
    },
  );

  // ── Notification channel preference per-user (T6 M10.5) ─────────────
  // Per-(tenant, user) opt-in/out for the 4 M10.x channels. Default
  // policy: all enabled. Stored only when the user has changed at least
  // one toggle.

  /** GET /v1/notifications/preferences/tenant-defaults (T6 M10.6) —
   *  per-tenant defaults; admin-only. */
  app.get(
    '/v1/notifications/preferences/tenant-defaults',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      try {
        const td = notificationPreferenceStore.getTenantDefault(req.tenant!.tenant_id);
        return res.json(wrapResponse(td, ctx));
      } catch (e) {
        if (e instanceof PreferenceError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** PUT /v1/notifications/preferences/tenant-defaults — admin sets
   *  defaults via partial patch. */
  app.put(
    '/v1/notifications/preferences/tenant-defaults',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const updated_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const td = notificationPreferenceStore.setTenantDefault(
          req.tenant!.tenant_id,
          inner,
          updated_by,
          now(),
        );
        return res.json(wrapResponse(td, ctx));
      } catch (e) {
        if (e instanceof PreferenceError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/notifications/preferences/me — returns the caller's prefs.
   *  Always 200 (defaults to all-enabled for never-touched users). */
  app.get(
    '/v1/notifications/preferences/me',
    requireTenantMw,
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      try {
        const pref = notificationPreferenceStore.get(
          req.tenant!.tenant_id,
          callerUsername(req),
        );
        return res.json(wrapResponse(pref, ctx));
      } catch (e) {
        if (e instanceof PreferenceError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** PUT /v1/notifications/preferences/me body { email?, sms?, push?, webhook? } —
   *  partial update; at least one channel must be supplied. */
  app.put(
    '/v1/notifications/preferences/me',
    requireTenantMw,
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const pref = notificationPreferenceStore.update(
          req.tenant!.tenant_id,
          callerUsername(req),
          inner,
          now(),
        );
        return res.json(wrapResponse(pref, ctx));
      } catch (e) {
        if (e instanceof PreferenceError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** PUT /v1/notifications/preferences/me/quiet-hours (T6 M10.7) —
   *  set or clear the caller's mute window. Body { start_hour, end_hour }
   *  to set, or `null` to clear. */
  app.put(
    '/v1/notifications/preferences/me/quiet-hours',
    requireTenantMw,
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        // Caller can send `{ start_hour, end_hour }` to set, or `null`
        // (or `{}`) to clear. Treat empty object as clear too — UX convention.
        let qh: { start_hour: number; end_hour: number } | null = null;
        if (
          inner !== null &&
          typeof inner === 'object' &&
          'start_hour' in (inner as object)
        ) {
          const i = inner as { start_hour: unknown; end_hour: unknown };
          for (const k of ['start_hour', 'end_hour'] as const) {
            if (
              typeof i[k] !== 'number' ||
              !Number.isInteger(i[k]) ||
              (i[k] as number) < 0 ||
              (i[k] as number) > 23
            ) {
              return res.status(400).json(
                wrapError(
                  { code: 'EWS_400_invalid_input', message: `${k} must be an integer 0-23`, severity: 'MEDIUM' },
                  ctx,
                ),
              );
            }
          }
          qh = {
            start_hour: i.start_hour as number,
            end_hour: i.end_hour as number,
          };
        }
        const pref = notificationPreferenceStore.setQuietHours(
          req.tenant!.tenant_id,
          callerUsername(req),
          qh,
          now(),
        );
        return res.json(wrapResponse(pref, ctx));
      } catch (e) {
        if (e instanceof PreferenceError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/notifications/preferences/me/reset — back to all-enabled defaults. */
  app.post(
    '/v1/notifications/preferences/me/reset',
    requireTenantMw,
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      notificationPreferenceStore.reset(req.tenant!.tenant_id, callerUsername(req));
      const pref = notificationPreferenceStore.get(
        req.tenant!.tenant_id,
        callerUsername(req),
      );
      return res.json(wrapResponse(pref, ctx));
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
   * POST /v1/investigations body: { case_id, customer_id, checklist_template_id? }
   * Open a fresh investigation for a case. 409 when the case already
   * has an open one (must close first). 400 on missing fields.
   * When `checklist_template_id` is supplied, the template's steps
   * seed the investigation instead of the default 8-step BIL §17 set.
   * 404 when the template id is unknown / cross-tenant.
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
      const body = (inner ?? {}) as {
        case_id?: string;
        customer_id?: string;
        checklist_template_id?: string;
      };

      // Resolve the checklist override before delegating to the store.
      // M9.1 default behaviour (no template_id) → use defaultSteps()
      // inside the store. M9.2 with template_id → look up + materialise.
      let steps_override: ReturnType<typeof materialiseSteps> | undefined;
      let template_id_for_record: string | undefined;
      if (typeof body.checklist_template_id === 'string' && body.checklist_template_id) {
        const tpl = checklistTemplateStore.get(req.tenant!.tenant_id, body.checklist_template_id);
        if (!tpl) {
          return res.status(404).json(
            wrapError(
              {
                code: 'EWS_404_unknown_template',
                message: `unknown checklist template: ${body.checklist_template_id}`,
                severity: 'LOW',
              },
              ctx,
            ),
          );
        }
        steps_override = materialiseSteps(tpl);
        template_id_for_record = tpl.id;
      }

      try {
        const inv = caseInvestigationStore.open(
          req.tenant!.tenant_id,
          {
            case_id: body.case_id ?? '',
            customer_id: body.customer_id ?? '',
            steps_override,
            checklist_template_id: template_id_for_record,
          },
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

  // ── Checklist templates (T6 M9.2) ────────────────────────────────────
  //
  // 4 routes for managing per-tenant custom investigation checklists.
  // Read = analyst+ (cases:list); create/delete = admin (cases:log_action
  // is too narrow — we use audit:read for parity with the rest of the
  // admin surface).

  function mapChecklistError(e: unknown, ctx: ReturnType<typeof extractCtx>): {
    status: number;
    body: ReturnType<typeof wrapError>;
  } {
    if (!(e instanceof ChecklistError)) {
      return {
        status: 500,
        body: wrapError(
          {
            code: 'EWS_500',
            message: e instanceof Error ? e.message : 'checklist failed',
            severity: 'HIGH',
          },
          ctx,
        ),
      };
    }
    if (e.code === 'unknown_template') {
      return {
        status: 404,
        body: wrapError(
          { code: 'EWS_404_unknown_template', message: e.message, severity: 'LOW' },
          ctx,
        ),
      };
    }
    if (e.code === 'cannot_delete_builtin') {
      return {
        status: 409,
        body: wrapError(
          { code: 'EWS_409_cannot_delete_builtin', message: e.message, severity: 'MEDIUM' },
          ctx,
        ),
      };
    }
    return {
      status: 400,
      body: wrapError(
        { code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' },
        ctx,
      ),
    };
  }

  /** GET /v1/investigations/checklists?category= — list visible templates. */
  app.get(
    '/v1/investigations/checklists',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const cat = req.query.category as string | undefined;
      if (cat !== undefined && !isChecklistCategory(cat)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_category', message: `invalid category: ${cat}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const items = checklistTemplateStore.list(req.tenant!.tenant_id, {
        category: cat as ChecklistCategory | undefined,
      });
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/investigations/checklists/:id — single template. */
  app.get(
    '/v1/investigations/checklists/:id',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const tpl = checklistTemplateStore.get(req.tenant!.tenant_id, id);
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

  /**
   * POST /v1/investigations/checklists body: CreateTemplateInput
   * Create a custom template for the caller's tenant.
   */
  app.post(
    '/v1/investigations/checklists',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const created_by = caseInvestigationActor(req);
      try {
        const tpl = checklistTemplateStore.create(
          req.tenant!.tenant_id,
          inner,
          created_by,
          now(),
        );
        return res.status(201).json(
          wrapResponse(tpl, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        const m = mapChecklistError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  /**
   * DELETE /v1/investigations/checklists/:id — delete a custom template.
   * 409 EWS_409_cannot_delete_builtin when targeting the platform default.
   * 404 EWS_404_unknown_template when id is unknown / cross-tenant.
   */
  app.delete(
    '/v1/investigations/checklists/:id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      try {
        checklistTemplateStore.delete(req.tenant!.tenant_id, id);
        return res.json(wrapResponse({ deleted: true, template_id: id }, ctx));
      } catch (e) {
        const m = mapChecklistError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  // ── BIL case maker-checker workflow (T6 M9.3) ────────────────────────
  //
  // 5 routes for the 4-eyes approval workflow on sensitive case actions
  // (close / escalate / override). Submit = cases:log_action (analyst+);
  // approve/reject = audit:read (admin) — segregation of duties enforced
  // by RBAC at the route level + by the engine via self-approval refusal.

  function makerCheckerActor(req: Request): string {
    const v = req.headers['x-apex-user'];
    return typeof v === 'string' && v.trim() ? v.trim() : 'admin';
  }

  function mapMakerCheckerError(e: unknown, ctx: ReturnType<typeof extractCtx>): {
    status: number;
    body: ReturnType<typeof wrapError>;
  } {
    if (!(e instanceof MakerCheckerError)) {
      return {
        status: 500,
        body: wrapError(
          {
            code: 'EWS_500',
            message: e instanceof Error ? e.message : 'maker-checker failed',
            severity: 'HIGH',
          },
          ctx,
        ),
      };
    }
    if (e.code === 'unknown_action') {
      return {
        status: 404,
        body: wrapError({ code: 'EWS_404_unknown_action', message: e.message, severity: 'LOW' }, ctx),
      };
    }
    if (
      e.code === 'submission_already_pending' ||
      e.code === 'already_decided' ||
      e.code === 'self_approval_forbidden'
    ) {
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

  /** POST /v1/cases/maker-checker — submit a sensitive case action. */
  app.post(
    '/v1/cases/maker-checker',
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
        const action = makerCheckerEngine.submit(
          req.tenant!.tenant_id,
          inner,
          makerCheckerActor(req),
          now(),
        );
        return res.status(201).json(
          wrapResponse(action, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        const m = mapMakerCheckerError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  /**
   * GET /v1/cases/maker-checker?status=&action_type=&case_id=&maker_username=&
   *   page=&page_size=
   */
  app.get(
    '/v1/cases/maker-checker',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filters: {
        status?: MakerCheckerStatus;
        action_type?: SensitiveActionType;
        case_id?: string;
        maker_username?: string;
        page?: number;
        page_size?: number;
      } = {};
      if (typeof q.status === 'string') {
        if (!isMakerCheckerStatus(q.status)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_status', message: `invalid status: ${q.status}`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filters.status = q.status as MakerCheckerStatus;
      }
      if (typeof q.action_type === 'string') {
        if (!isSensitiveActionType(q.action_type)) {
          return res.status(400).json(
            wrapError(
              {
                code: 'EWS_400_invalid_action_type',
                message: `invalid action_type: ${q.action_type}`,
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
        filters.action_type = q.action_type as SensitiveActionType;
      }
      if (typeof q.case_id === 'string') filters.case_id = q.case_id;
      if (typeof q.maker_username === 'string') filters.maker_username = q.maker_username;
      if (typeof q.page === 'string') filters.page = Math.max(1, Number(q.page) || 1);
      if (typeof q.page_size === 'string') {
        filters.page_size = Math.max(1, Math.min(200, Number(q.page_size) || 50));
      }
      const out = makerCheckerEngine.list(req.tenant!.tenant_id, filters);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/cases/maker-checker/:action_id — single action. */
  app.get(
    '/v1/cases/maker-checker/:action_id',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.action_id ?? '';
      const action = makerCheckerEngine.get(req.tenant!.tenant_id, id);
      if (!action) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_action', message: `unknown maker-checker action: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(action, ctx));
    },
  );

  /** POST /v1/cases/maker-checker/:action_id/approve body: { decision_notes? } */
  app.post(
    '/v1/cases/maker-checker/:action_id/approve',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.action_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const notes =
        inner && typeof inner === 'object' && 'decision_notes' in (inner as object)
          ? ((inner as { decision_notes: unknown }).decision_notes as string | null)
          : null;
      try {
        const action = makerCheckerEngine.approve(
          req.tenant!.tenant_id,
          id,
          makerCheckerActor(req),
          notes ?? null,
          now(),
        );
        return res.json(wrapResponse(action, ctx));
      } catch (e) {
        const m = mapMakerCheckerError(e, ctx);
        return res.status(m.status).json(m.body);
      }
    },
  );

  /** POST /v1/cases/maker-checker/:action_id/reject body: { decision_notes? } */
  app.post(
    '/v1/cases/maker-checker/:action_id/reject',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.action_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const notes =
        inner && typeof inner === 'object' && 'decision_notes' in (inner as object)
          ? ((inner as { decision_notes: unknown }).decision_notes as string | null)
          : null;
      try {
        const action = makerCheckerEngine.reject(
          req.tenant!.tenant_id,
          id,
          makerCheckerActor(req),
          notes ?? null,
          now(),
        );
        return res.json(wrapResponse(action, ctx));
      } catch (e) {
        const m = mapMakerCheckerError(e, ctx);
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

  // ── BIL scoring with catalog weight lookup (T6 M6.2) ─────────────────
  //
  // Convenience layer over M6.1 — caller passes (indicator_id, value)
  // and the engine fetches severity_weight from the indicator catalog,
  // then delegates to computeRiskScore. Same RBAC / tenant gating as
  // /v1/scoring/risk; same response shape plus a `resolved` array
  // surfacing the indicator names so the SPA doesn't round-trip.
  app.post(
    '/v1/scoring/risk/by-indicators',
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
      const { items, vertical, thresholds } = inner as {
        items?: ByIndicatorItem[];
        vertical?: ScoringVertical;
        thresholds?: Partial<ScoringThresholds>;
      };
      if (vertical !== undefined && !isScoringVertical(vertical)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_vertical',
              message: 'vertical must be one of banking|insurance',
              severity: 'MEDIUM',
            },
            env,
          ),
        );
      }
      try {
        const result = scoreFromIndicators(items ?? [], indicatorWeightLookup, {
          vertical,
          thresholds,
        });
        return res.json(wrapResponse(result, env));
      } catch (e) {
        if (e instanceof IndicatorLookupError) {
          const status = e.code === 'unknown_indicator' ? 404 : 400;
          const code =
            e.code === 'unknown_indicator'
              ? 'EWS_404_unknown_indicator'
              : `EWS_400_${e.code}`;
          return res.status(status).json(
            wrapError({ code, message: e.message, severity: 'MEDIUM' }, env),
          );
        }
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

  // ── Scoring weight presets (T6 M6.3) ─────────────────────────────────
  //
  // Named bundles of weight-multipliers (conservative/balanced/
  // aggressive × banking/insurance) tenants can apply on top of the
  // M6.2 catalog defaults. Pure-data — no store, no tenant overrides
  // here; M6.4 will land custom presets.

  /** GET /v1/scoring/presets?vertical=&mode= — filtered list of presets. */
  app.get(
    '/v1/scoring/presets',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const verticalRaw = req.query.vertical as string | undefined;
      const modeRaw = req.query.mode as string | undefined;
      if (verticalRaw && !isScoringVertical(verticalRaw)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_vertical', message: 'vertical must be banking|insurance', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (modeRaw && !isWeightPresetMode(modeRaw)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_mode', message: 'mode must be conservative|balanced|aggressive', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const items = listWeightPresets({
        vertical: verticalRaw as ScoringVertical | undefined,
        mode: modeRaw as WeightPresetMode | undefined,
      });
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  // ── Custom user-defined weight presets (T6 M6.4) ─────────────────────
  // Declared BEFORE /v1/scoring/presets/:id so the literal "custom"
  // segment wins. Mirrors M16.4 (custom scenario presets).

  /** GET /v1/scoring/presets/custom — list custom presets for tenant. */
  app.get(
    '/v1/scoring/presets/custom',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = customWeightPresetStore.list(req.tenant!.tenant_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/scoring/presets/custom — create custom preset. */
  app.post(
    '/v1/scoring/presets/custom',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const preset = customWeightPresetStore.create(
          req.tenant!.tenant_id,
          inner,
          created_by,
          now(),
        );
        return res.status(201).json(
          wrapResponse(preset, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof CustomWeightPresetError) {
          if (e.code === 'cap_reached') {
            return res.status(409).json(
              wrapError(
                { code: 'EWS_409_cap_reached', message: e.message, severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** DELETE /v1/scoring/presets/custom/:preset_id — remove custom preset. */
  app.delete(
    '/v1/scoring/presets/custom/:preset_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.preset_id ?? '';
      const removed = customWeightPresetStore.delete(req.tenant!.tenant_id, id);
      if (!removed) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_preset', message: `custom preset ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.status(204).send();
    },
  );

  /** GET /v1/scoring/presets/:id — single preset. 404 EWS_404_unknown_preset. */
  app.get(
    '/v1/scoring/presets/:id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const preset = getWeightPreset(id);
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

  /** POST /v1/scoring/risk/by-preset body { preset_id, items } — score using
   *  the preset's multipliers on top of catalog defaults. */
  app.post(
    '/v1/scoring/risk/by-preset',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const tenantId = req.tenant!.tenant_id;
        const result = scoreByPreset(
          (inner ?? {}) as { preset_id: string; items: ByIndicatorItem[] },
          indicatorWeightLookup,
          (id) => getEffectiveWeightPreset(customWeightPresetStore, tenantId, id),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof WeightPresetError) {
          if (e.code === 'unknown_preset') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_preset', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        if (e instanceof IndicatorLookupError) {
          const status = e.code === 'unknown_indicator' ? 404 : 400;
          const code =
            e.code === 'unknown_indicator'
              ? 'EWS_404_unknown_indicator'
              : `EWS_400_${e.code}`;
          return res.status(status).json(
            wrapError({ code, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        if (e instanceof ScoringInputError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'preset scoring failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** POST /v1/scoring/risk/by-preset/batch (T6 M6.6) — score N customers
   *  with the same preset; aggregate band distribution. */
  app.post(
    '/v1/scoring/risk/by-preset/batch',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const tenantId = req.tenant!.tenant_id;
        const result = scoreByPresetBatch(
          (inner ?? {}) as ScoreBatchInput,
          indicatorWeightLookup,
          (id) => getEffectiveWeightPreset(customWeightPresetStore, tenantId, id),
          now(),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof WeightPresetError) {
          if (e.code === 'unknown_preset') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_preset', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        if (e instanceof IndicatorLookupError) {
          const status = e.code === 'unknown_indicator' ? 404 : 400;
          const code =
            e.code === 'unknown_indicator'
              ? 'EWS_404_unknown_indicator'
              : `EWS_400_${e.code}`;
          return res.status(status).json(
            wrapError({ code, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        if (e instanceof ScoringInputError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'batch preset scoring failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** POST /v1/scoring/risk/by-preset/compare (T6 M6.7) — apply two
   *  presets to the same items[]; return left + right + delta. */
  app.post(
    '/v1/scoring/risk/by-preset/compare',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const tenantId = req.tenant!.tenant_id;
        const result = compareByPresets(
          (inner ?? {}) as CompareByPresetsInput,
          indicatorWeightLookup,
          (id) => getEffectiveWeightPreset(customWeightPresetStore, tenantId, id),
          now(),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof WeightPresetError) {
          if (e.code === 'unknown_preset') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_preset', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        if (e instanceof IndicatorLookupError) {
          const status = e.code === 'unknown_indicator' ? 404 : 400;
          const code =
            e.code === 'unknown_indicator'
              ? 'EWS_404_unknown_indicator'
              : `EWS_400_${e.code}`;
          return res.status(status).json(
            wrapError({ code, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        if (e instanceof ScoringInputError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'preset compare failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── KRI threshold breach detection (T6 M4.3) ─────────────────────────
  //
  // 3-zone threshold check (yellow/orange/red) over the M6.2 indicator
  // catalog. Foundational primitive that turns an indicator value into
  // a breach class — the input the M8.1 alert classifier needs.

  /** GET /v1/indicators/thresholds?vertical=banking|insurance — list. */
  app.get(
    '/v1/indicators/thresholds',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const verticalRaw = req.query.vertical as string | undefined;
      if (verticalRaw && !isScoringVertical(verticalRaw)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_vertical', message: 'vertical must be banking|insurance', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const items = listThresholds({
        vertical: verticalRaw as ScoringVertical | undefined,
      });
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/indicators/thresholds/overrides — list per-tenant
   *  overrides (T6 M4.4). Declared BEFORE /:indicator_id. */
  app.get(
    '/v1/indicators/thresholds/overrides',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = thresholdOverrideStore.listOverrides(req.tenant!.tenant_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/indicators/thresholds/:indicator_id — single threshold
   *  resolved through tenant overrides (M4.4 wires getEffectiveThreshold). */
  app.get(
    '/v1/indicators/thresholds/:indicator_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.indicator_id ?? '';
      const t = getEffectiveThreshold(thresholdOverrideStore, req.tenant!.tenant_id, id);
      if (!t) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_indicator', message: `unknown indicator: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(t, ctx));
    },
  );

  /** PUT /v1/indicators/thresholds/:indicator_id (T6 M4.4) — set
   *  per-tenant override. Body { yellow_at, orange_at, red_at } —
   *  monotonic + [0,1] enforced. */
  app.put(
    '/v1/indicators/thresholds/:indicator_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.indicator_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const t = thresholdOverrideStore.setOverride(req.tenant!.tenant_id, id, inner);
        return res.json(wrapResponse(t, ctx));
      } catch (e) {
        if (e instanceof ThresholdError) {
          if (e.code === 'unknown_indicator') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_indicator', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** DELETE /v1/indicators/thresholds/:indicator_id — clear override
   *  → revert to platform default. 204 / 404. */
  app.delete(
    '/v1/indicators/thresholds/:indicator_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.indicator_id ?? '';
      const removed = thresholdOverrideStore.deleteOverride(req.tenant!.tenant_id, id);
      if (!removed) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_no_override', message: `no override for ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.status(204).send();
    },
  );

  /** POST /v1/indicators/thresholds/check {indicator_id, value} —
   *  classify a value into green|yellow|orange|red. */
  app.post(
    '/v1/indicators/thresholds/check',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { indicator_id?: unknown; value?: unknown };
      try {
        const tenantId = req.tenant!.tenant_id;
        const out = checkBreachById(
          wrapper.indicator_id,
          wrapper.value,
          (id) => getEffectiveThreshold(thresholdOverrideStore, tenantId, id),
        );
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof ThresholdError) {
          if (e.code === 'unknown_indicator') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_indicator', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/indicators/scan-customer (T6 M4.5) — synthesise all
   *  applicable indicator values for a customer, run each through
   *  effective thresholds (M4.4), return ranked breaches + summary.
   *  Closes the M4.1 catalog → M4.3 thresholds → M4.4 overrides chain. */
  app.post(
    '/v1/indicators/scan-customer',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { customer_id?: unknown; vertical?: unknown };
      try {
        const result = scanCustomerBreaches(
          {
            tenant_id: req.tenant!.tenant_id,
            customer_id: typeof wrapper.customer_id === 'string' ? wrapper.customer_id : '',
            vertical: wrapper.vertical as ScoringVertical | undefined,
          } as BreachScanInput,
          thresholdOverrideStore,
          now(),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof BreachScanError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/indicators/scan-customers (T6 M4.6) — bulk variant of
   *  M4.5: scan up to 50 customers in one shot, return ranked
   *  per-customer summary + portfolio aggregate. */
  app.post(
    '/v1/indicators/scan-customers',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { customer_ids?: unknown; vertical?: unknown };
      try {
        const result = scanCustomerBreachesBulk(
          {
            tenant_id: req.tenant!.tenant_id,
            customer_ids: Array.isArray(wrapper.customer_ids)
              ? (wrapper.customer_ids as string[])
              : [],
            vertical: wrapper.vertical as ScoringVertical | undefined,
          } as BulkBreachScanInput,
          thresholdOverrideStore,
          now(),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof BreachScanError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  // ── BIL indicator backtest (T6 M4.2) ────────────────────────────────
  //
  // Simulation surface — "what would this indicator have fired on
  // over the last N days?". Required pre-launch evidence per BIL §10.
  // Uses M6.2's IndicatorWeightLookup so the catalog stays shared.
  app.post(
    '/v1/indicators/backtest',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const env = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const result = runIndicatorBacktest(
          req.tenant!.tenant_id,
          inner as IndicatorBacktestInput,
          indicatorWeightLookup,
          now(),
        );
        return res.json(wrapResponse(result, env));
      } catch (e) {
        if (e instanceof IndicatorBacktestError) {
          const status = e.code === 'unknown_indicator' ? 404 : 400;
          const code =
            e.code === 'unknown_indicator'
              ? 'EWS_404_unknown_indicator'
              : `EWS_400_${e.code}`;
          return res.status(status).json(
            wrapError({ code, message: e.message, severity: 'MEDIUM' }, env),
          );
        }
        return res.status(500).json(
          wrapError(
            {
              code: 'EWS_500',
              message: e instanceof Error ? e.message : 'backtest failed',
              severity: 'HIGH',
            },
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

  // ── Tenant onboarding wizard (T6 M2.2) ───────────────────────────────
  //
  // 8-step platform-defined wizard the BIL ops team uses to walk a
  // new tenant through setup. Pure-data step catalogue + in-memory
  // progress store. State per (tenant) — get is total (returns
  // all-pending for never-touched tenants).

  /** GET /v1/tenants/onboarding/steps — platform step catalog. */
  app.get(
    '/v1/tenants/onboarding/steps',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      return res.json(
        wrapResponse(
          {
            items: [...ONBOARDING_STEPS].sort((a, b) => a.order - b.order),
            total: ONBOARDING_STEPS.length,
          },
          ctx,
        ),
      );
    },
  );

  /** GET /v1/tenants/me/onboarding — caller's tenant onboarding state. */
  app.get(
    '/v1/tenants/me/onboarding',
    requireTenantMw,
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const state = onboardingStore.get(req.tenant!.tenant_id);
      return res.json(wrapResponse(state, ctx));
    },
  );

  /** GET /v1/tenants/:tenant_id/onboarding — admin lookup. */
  app.get(
    '/v1/tenants/:tenant_id/onboarding',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const target = req.params.tenant_id ?? '';
      try {
        const state = onboardingStore.get(target);
        return res.json(wrapResponse(state, ctx));
      } catch (e) {
        if (e instanceof OnboardingError) {
          return res.status(400).json(
            wrapError(
              { code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/tenants/:tenant_id/onboarding/steps/:step_id body { status, notes? }. */
  app.post(
    '/v1/tenants/:tenant_id/onboarding/steps/:step_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const target = req.params.tenant_id ?? '';
      const step_id = req.params.step_id ?? '';
      const actor_username = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { status?: unknown; notes?: unknown };
      try {
        const state = onboardingStore.markStep(
          target,
          step_id,
          (wrapper.status ?? '') as string,
          actor_username,
          wrapper.notes,
          now(),
        );
        return res.json(wrapResponse(state, ctx));
      } catch (e) {
        if (e instanceof OnboardingError) {
          if (e.code === 'unknown_step') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_step', message: e.message, severity: 'LOW' },
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
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'mark step failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** POST /v1/tenants/:tenant_id/onboarding/reset — full reset. */
  app.post(
    '/v1/tenants/:tenant_id/onboarding/reset',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const target = req.params.tenant_id ?? '';
      const actor_username = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const state = onboardingStore.reset(target, actor_username, now());
        return res.json(wrapResponse(state, ctx));
      } catch (e) {
        if (e instanceof OnboardingError) {
          return res.status(400).json(
            wrapError(
              { code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' },
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
  /** POST /v1/tenants/bulk-import (T6 M2.3) — CSV-driven bulk creation.
   *  Body: { csv: string, dry_run?: boolean }. Header row required:
   *    tenant_id,name,vertical,channels_allowed
   *  channels_allowed cells are `;`-separated. */
  app.post(
    '/v1/tenants/bulk-import',
    requireTenantMw,
    requireRole('audit:read'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { csv?: unknown; dry_run?: unknown };
      if (typeof wrapper.csv !== 'string') {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'csv body required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const rows = parseTenantCsv(wrapper.csv);
        const summary = await applyBulkTenants(rows, tenantLookup, {
          dry_run: wrapper.dry_run === true,
        });
        return res.json(wrapResponse(summary, ctx));
      } catch (e) {
        if (e instanceof TenantBulkError) {
          return res.status(400).json(
            wrapError(
              { code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        throw e;
      }
    },
  );

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

  // ── Finance / Treasury adapter (T6 M14.7) ────────────────────────────
  //
  // 3 routes over the BIL Finance upstream — accounts (by-customer +
  // by-id) + ledger (paginated with optional since/until window).
  // Read-only at this stage; balance mutations come from the upstream
  // posting engine.

  /** GET /v1/integrations/finance/accounts?customer_id=X — list. */
  app.get(
    '/v1/integrations/finance/accounts',
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
        const items = await financeAdapter.listAccountsForCustomer(
          req.tenant!.tenant_id,
          customer_id,
          now(),
        );
        return res.json(wrapResponse({ items, total: items.length, customer_id }, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'finance adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/finance/accounts/:account_id — single. */
  app.get(
    '/v1/integrations/finance/accounts/:account_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.account_id ?? '';
      try {
        const account = await financeAdapter.getAccount(req.tenant!.tenant_id, id, now());
        if (!account) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `finance account ${id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(account, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'finance adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /**
   * GET /v1/integrations/finance/accounts/:account_id/ledger?since=&until=&page=&page_size=
   * Paginated ledger entries newest-first. since/until are ISO timestamps;
   * 400 EWS_400_invalid_since / _invalid_until on malformed values.
   * 404 EWS_404_unknown_account on miss / cross-tenant lookup.
   */
  app.get(
    '/v1/integrations/finance/accounts/:account_id/ledger',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.account_id ?? '';
      const since = req.query.since as string | undefined;
      const until = req.query.until as string | undefined;
      const pageRaw = req.query.page as string | undefined;
      const sizeRaw = req.query.page_size as string | undefined;
      const page = pageRaw ? Math.max(1, Number(pageRaw) || 1) : 1;
      const page_size = sizeRaw ? Math.max(1, Math.min(200, Number(sizeRaw) || 50)) : 50;
      try {
        const out = await financeAdapter.listLedger(
          req.tenant!.tenant_id,
          id,
          { since, until, page, page_size },
          now(),
        );
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof FinanceError) {
          if (e.code === 'unknown_account') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_account', message: e.message, severity: 'LOW' },
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
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'finance adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── HR adapter (T6 M14.8) ────────────────────────────────────────────
  //
  // 3 routes over the BIL HR upstream — staff list/single + leave
  // balance. RBAC mirrors the rest of the integration surface
  // (customers:read_risk_profile = analyst+).

  /** GET /v1/integrations/hr/employees?department=&status=&page=&page_size= */
  app.get(
    '/v1/integrations/hr/employees',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const dept = req.query.department as string | undefined;
      const status = req.query.status as string | undefined;
      if (dept !== undefined && !isEmployeeDepartment(dept)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_department', message: `invalid department: ${dept}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (status !== undefined && !isEmployeeStatus(status)) {
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
        const out = await hrAdapter.list(
          req.tenant!.tenant_id,
          {
            department: dept as EmployeeDepartment | undefined,
            status: status as EmployeeStatus | undefined,
            page,
            page_size,
          },
          now(),
        );
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'hr adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/hr/employees/:employee_id — single. */
  app.get(
    '/v1/integrations/hr/employees/:employee_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.employee_id ?? '';
      try {
        const employee = await hrAdapter.get(req.tenant!.tenant_id, id);
        if (!employee) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `employee ${id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(employee, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'hr adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/integrations/hr/employees/:employee_id/leave-balance */
  app.get(
    '/v1/integrations/hr/employees/:employee_id/leave-balance',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.employee_id ?? '';
      try {
        const balance = await hrAdapter.getLeaveBalance(req.tenant!.tenant_id, id, now());
        if (!balance) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404', message: `employee ${id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        return res.json(wrapResponse(balance, ctx));
      } catch (e) {
        return res.status(502).json(
          wrapError(
            { code: 'EWS_502', message: e instanceof Error ? e.message : 'hr adapter failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── Adapter fleet health roll-up (T6 M14.9) ──────────────────────────
  //
  // Cross-module orchestrator probing all 8 M14.x adapters in parallel
  // via their existing list/get methods. Returns per-adapter
  // status + latency + sample_count + aggregate counters. Never
  // throws — failures surface as `degraded` entries so one bad
  // upstream doesn't take the whole fleet view down.

  const fleetForHealth: AdapterFleet = {
    insurance: insuranceAdapter,
    ifrs9: ifrs9Adapter,
    aml: amlAdapter,
    dms: dmsAdapter,
    bureau: bureauAdapter,
    agent: agentAdapter,
    finance: financeAdapter,
    hr: hrAdapter,
  };

  /** GET /v1/integrations/adapters — static catalog (no probes). */
  app.get(
    '/v1/integrations/adapters',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = listFleetAdapters();
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/integrations/adapters/health — probe all 8 in parallel. */
  app.get(
    '/v1/integrations/adapters/health',
    requireTenantMw,
    requireRole('audit:read'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const report = await runFleetHealth(req.tenant!.tenant_id, now(), fleetForHealth);
      return res.json(wrapResponse(report, ctx));
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

  // ── Bulk config import/export (T6 M13.4) ───────────────────────────
  // Declared BEFORE /v1/admin/config/:key so the literal path wins.

  /** GET /v1/admin/config/_export — snapshot all overrides. */
  app.get(
    '/v1/admin/config/_export',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const snap = exportConfig(configStore, req.tenant!.tenant_id, now());
      return res.json(wrapResponse(snap, ctx));
    },
  );

  /** POST /v1/admin/config/_import body { snapshot, dry_run? } */
  app.post(
    '/v1/admin/config/_import',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const applied_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { snapshot?: unknown; dry_run?: boolean };
      try {
        const summary = importConfig(
          configStore,
          req.tenant!.tenant_id,
          wrapper.snapshot,
          applied_by,
          wrapper.dry_run === true,
          now(),
        );
        return res.json(wrapResponse(summary, ctx));
      } catch (e) {
        if (e instanceof ConfigBulkError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/admin/config/_diff?tenant_a=X&tenant_b=Y (T6 M13.5) —
   *  per-key comparison of two tenants' override states. Admin-only.
   *  Declared before /:key so the literal _diff segment wins. */
  app.get(
    '/v1/admin/config/_diff',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const tenant_a = (req.query.tenant_a as string | undefined) ?? '';
      const tenant_b = (req.query.tenant_b as string | undefined) ?? '';
      try {
        const result = diffTenantConfig(configStore, tenant_a, tenant_b, now());
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof ConfigBulkError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/admin/config/_clone (T6 M13.6) — copy source tenant's
   *  overrides into the caller's tenant. Body { source_tenant_id,
   *  dry_run? }. Returns ImportSummary shape. Admin-only. */
  app.post(
    '/v1/admin/config/_clone',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const applied_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { source_tenant_id?: unknown; dry_run?: unknown };
      try {
        const summary = cloneTenantConfig(
          configStore,
          typeof wrapper.source_tenant_id === 'string' ? wrapper.source_tenant_id : '',
          req.tenant!.tenant_id,
          applied_by,
          wrapper.dry_run === true,
          now(),
        );
        return res.json(wrapResponse(summary, ctx));
      } catch (e) {
        if (e instanceof ConfigBulkError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
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
   *
   * T6 M13.2 — every successful mutation writes an audit event:
   *   action=config.update, resource_type=config, resource_id=key,
   *   metadata={ previous_value, previous_was_default, new_value }
   * The audit write happens after the mutation succeeds, so failed
   * sets don't pollute the trail.
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
        // Snapshot the prior state for the audit trail.
        const previous = configStore.get(req.tenant!.tenant_id, key);
        const entry = configStore.set(req.tenant!.tenant_id, key, value, updated_by, now());
        // Audit trail record — best-effort. Throwing here would mean
        // the config is updated but the audit log is missing — log +
        // continue rather than failing the request. (Production WORM
        // store guarantees this never throws on valid input.)
        try {
          auditTrailStore.record(
            req.tenant!.tenant_id,
            {
              actor_username: updated_by,
              actor_role: 'admin',
              action: 'config.update',
              resource_type: 'config',
              resource_id: key,
              outcome: 'success',
              severity: 'info',
              metadata: {
                previous_value: previous?.value,
                previous_was_default: previous?.is_default ?? null,
                new_value: entry.value,
              },
            },
            now(),
          );
        } catch (auditErr) {
          // swallow + continue — surface in server logs in production
        }
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

  /**
   * DELETE /v1/admin/config/:key — clear override → revert to default.
   * T6 M13.2 — writes a config.reset audit event with metadata
   *   { previous_value, default_value }.
   */
  app.delete(
    '/v1/admin/config/:key',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const key = req.params.key ?? '';
      const reset_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const previous = configStore.get(req.tenant!.tenant_id, key);
        const entry = configStore.reset(req.tenant!.tenant_id, key);
        // Only write an audit event when there was actually an override
        // to clear — resetting a never-set key is a no-op and shouldn't
        // pollute the trail.
        if (previous && !previous.is_default) {
          try {
            auditTrailStore.record(
              req.tenant!.tenant_id,
              {
                actor_username: reset_by,
                actor_role: 'admin',
                action: 'config.reset',
                resource_type: 'config',
                resource_id: key,
                outcome: 'success',
                severity: 'info',
                metadata: {
                  previous_value: previous.value,
                  default_value: entry.value,
                },
              },
              now(),
            );
          } catch {
            // swallow
          }
        }
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

  /**
   * GET /v1/admin/config/:key/history?limit=50
   * Returns audit events for the given config key, newest-first.
   * T6 M13.2 — filters the audit trail by resource_type='config' AND
   * resource_id=key. Returns 404 EWS_404_unknown_key when the key
   * isn't in the schema (so callers don't query phantom history).
   */
  app.get(
    '/v1/admin/config/:key/history',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const key = req.params.key ?? '';
      // Validate the key is in the schema before walking the audit trail
      // — saves callers from chasing typos through empty results.
      const known = configStore.get(req.tenant!.tenant_id, key);
      if (!known) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_key', message: `unknown config key: ${key}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const limitRaw = req.query.limit;
      const limit =
        typeof limitRaw === 'string' ? Math.max(1, Math.min(200, Number(limitRaw) || 50)) : 50;
      const out = auditTrailStore.list(req.tenant!.tenant_id, {
        resource_type: 'config',
        action: 'config.update,config.reset',
        page_size: limit,
      });
      // Surface a slim shape — the SPA only cares about who/when/what
      // changed; the full event id + correlation_id are still in the
      // /v1/audit/events surface.
      const items = out.items
        .filter((e) => e.resource_id === key)
        .map((e) => ({
          event_id: e.event_id,
          ts: e.ts,
          actor_username: e.actor_username,
          action: e.action,
          previous_value: e.metadata.previous_value ?? null,
          new_value: e.metadata.new_value ?? e.metadata.default_value ?? null,
          rolled_back_from_event_id:
            (e.metadata as { rolled_back_from_event_id?: unknown }).rolled_back_from_event_id ?? null,
        }));
      res.json(wrapResponse({ items, total: items.length, key, limit }, ctx));
    },
  );

  /**
   * POST /v1/admin/config/:key/rollback body { to_event_id }
   * T6 M13.3 — restore the config key to the value it held immediately
   * after the targeted audit event was applied. Records a NEW
   * config.update event with `rolled_back_from_event_id` metadata.
   */
  app.post(
    '/v1/admin/config/:key/rollback',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const key = req.params.key ?? '';
      const actor = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { to_event_id?: unknown };
      const to_event_id =
        typeof wrapper.to_event_id === 'string' ? wrapper.to_event_id : '';
      try {
        const out = rollbackConfig(
          req.tenant!.tenant_id,
          key,
          to_event_id,
          actor,
          now(),
          configStore,
          auditTrailStore,
        );
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof ConfigRollbackError) {
          if (e.code === 'unknown_event') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_event', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          if (e.code === 'already_at_value') {
            return res.status(409).json(
              wrapError(
                { code: 'EWS_409_already_at_value', message: e.message, severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'rollback failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── Service-account API keys (T6 M1.2) ──────────────────────────────
  //
  // Provisioning + revocation surface for machine-identity API keys.
  // The full key value is shown ONCE on creation; subsequent reads
  // return only the prefix. SHA-256 hashed at rest. Authentication
  // middleware that accepts these keys is M1.3 — this slice is
  // provisioning-only. RBAC audit:read = admin (machine identity is
  // an admin concern, not analyst).

  /** POST /v1/admin/api-keys body: ApiKeyInput → 201 with full key. */
  app.post(
    '/v1/admin/api-keys',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const validated = validateApiKeyInput(inner ?? {}, now());
        const out = apiKeyStore.create(req.tenant!.tenant_id, validated, created_by, now());
        return res.status(201).json(
          wrapResponse(out, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof ApiKeyError) {
          if (e.code === 'cap_reached') {
            return res.status(409).json(
              wrapError(
                { code: 'EWS_409_cap_reached', message: e.message, severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'create failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/admin/api-keys?page=1&page_size=20 — newest-first redacted list. */
  app.get(
    '/v1/admin/api-keys',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const page = req.query.page ? Math.max(1, Number(req.query.page) || 1) : 1;
      const page_size = req.query.page_size ? Math.max(1, Math.min(100, Number(req.query.page_size) || 20)) : 20;
      const out = apiKeyStore.list(req.tenant!.tenant_id, page, page_size);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/admin/api-keys/:key_id — single redacted entry. */
  app.get(
    '/v1/admin/api-keys/:key_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.key_id ?? '';
      const e = apiKeyStore.get(req.tenant!.tenant_id, id);
      if (!e) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_key', message: `api key ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(e, ctx));
    },
  );

  /** POST /v1/admin/api-keys/:key_id/revoke — 200 with revoked entry. */
  app.post(
    '/v1/admin/api-keys/:key_id/revoke',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.key_id ?? '';
      const revoked_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const out = apiKeyStore.revoke(req.tenant!.tenant_id, id, revoked_by, now());
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof ApiKeyError) {
          if (e.code === 'unknown_key') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_key', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          if (e.code === 'already_revoked') {
            return res.status(409).json(
              wrapError(
                { code: 'EWS_409_already_revoked', message: e.message, severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'revoke failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** DELETE /v1/admin/api-keys/:key_id — irreversible removal (204). */
  app.delete(
    '/v1/admin/api-keys/:key_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.key_id ?? '';
      const removed = apiKeyStore.delete(req.tenant!.tenant_id, id);
      if (!removed) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_key', message: `api key ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.status(204).send();
    },
  );

  // ── Service-account auth surface (T6 M1.3) ───────────────────────────
  //
  // /v1/svc/* endpoints accept ONLY the api-key bearer token (no
  // human auth). Tenant binding comes from the verified key — X-
  // Tenant-ID is ignored here. Scope enforcement is per-route via
  // requireScope.
  const apiKeyMw = optionalApiKeyAuth(apiKeyStore, now);
  const requireKeyMw = requireApiKey(now);

  /** GET /v1/svc/whoami — returns the verified api-key context.
   *  Requires only that the caller be authenticated (no scope). */
  app.get(
    '/v1/svc/whoami',
    apiKeyMw,
    requireKeyMw,
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      return res.json(
        wrapResponse(
          {
            key_id: req.apiKey!.entry.key_id,
            tenant_id: req.apiKey!.entry.tenant_id,
            name: req.apiKey!.entry.name,
            scopes: req.apiKey!.scopes,
            last_used_at: req.apiKey!.entry.last_used_at,
            expires_at: req.apiKey!.entry.expires_at,
          },
          ctx,
        ),
      );
    },
  );

  /** GET /v1/svc/audit/integrity — service-account-readable variant of
   *  the M15.2 chain-verification surface. Requires `audit:read`
   *  scope on the key. Demonstrates requireScope on a real route. */
  app.get(
    '/v1/svc/audit/integrity',
    apiKeyMw,
    requireKeyMw,
    requireScope('audit:read', now),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const out = auditTrailStore.verifyChain(req.tenant!.tenant_id, now());
      return res.json(wrapResponse(out, ctx));
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

  // ── Audit evidence packaging (T6 M15.3) ─────────────────────────────
  //
  // Build a filtered + chain-verified snapshot of audit events that
  // BIL compliance can hand to a regulator. Per-tenant cap = 100
  // packages — older entries evict oldest-first. Reuses the M15.1
  // audit log + M15.2 chain-verifier; this layer only assembles
  // the package + retains it.

  /** POST /v1/audit/evidence body { since?, until?, actor_username?,
   *  action?, resource_type?, resource_id?, outcome?, severity? } —
   *  build + retain a new package. 201 created. Records X-APEX-USER
   *  as `generated_by`.
   */
  app.post(
    '/v1/audit/evidence',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const generated_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const filters: EvidenceFilters = validateFilters(inner ?? {});
        const pkg = evidenceStore.create(
          req.tenant!.tenant_id,
          auditTrailStore,
          generated_by,
          filters,
          now(),
        );
        return res.status(201).json(
          wrapResponse(pkg, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof EvidenceError) {
          return res.status(400).json(
            wrapError(
              { code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'evidence build failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/audit/evidence?page=1&page_size=20 — list packages
   *  newest-first. */
  app.get(
    '/v1/audit/evidence',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const page = req.query.page ? Math.max(1, Number(req.query.page) || 1) : 1;
      const page_size = req.query.page_size ? Math.max(1, Math.min(50, Number(req.query.page_size) || 20)) : 20;
      const out = evidenceStore.list(req.tenant!.tenant_id, page, page_size);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/audit/evidence/:package_id — single package. 404 on miss. */
  app.get(
    '/v1/audit/evidence/:package_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const package_id = req.params.package_id ?? '';
      const pkg = evidenceStore.get(req.tenant!.tenant_id, package_id);
      if (!pkg) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_package', message: `evidence package ${package_id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(pkg, ctx));
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

  // ── Connector schema metadata (T6 M3.2) ─────────────────────────────
  //
  // Per-connector field-level schema (name, type, required, sample,
  // enum_values, length/range bounds). Pure-data + pure validator —
  // no store, no AppDeps slot. The ingestion UI uses these to render
  // a column-mapper preview before file upload + validate sample
  // rows server-side.

  /** GET /v1/ingestion/connectors/:id/schema — full field schema. */
  app.get(
    '/v1/ingestion/connectors/:id/schema',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const schema = getConnectorSchema(id);
      if (!schema) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_connector', message: `unknown connector: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(schema, ctx));
    },
  );

  /** POST /v1/ingestion/connectors/:id/schema/validate { record } —
   *  pure-function validator. Always 200 (valid: true | false in body)
   *  unless the connector id is unknown (404) or the record shape is
   *  malformed (400). */
  app.post(
    '/v1/ingestion/connectors/:id/schema/validate',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { record?: unknown };
      try {
        const result = validateRecord(id, wrapper.record);
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof ConnectorSchemaError) {
          if (e.code === 'unknown_connector') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_connector', message: e.message, severity: 'LOW' },
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
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'validate failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  // ── Per-tenant connector schema overrides (T6 M3.3) ─────────────────
  // Add additional fields on top of the platform-default schema. Existing
  // fields are NOT overridable; only ADDITIONS allowed.

  /** GET /v1/ingestion/connectors/:id/schema/overrides — tenant additions. */
  app.get(
    '/v1/ingestion/connectors/:id/schema/overrides',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      if (!getConnectorSchema(id)) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_connector', message: `unknown connector: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const items = schemaOverrideStore.list(req.tenant!.tenant_id, id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/ingestion/connectors/:id/schema/overrides — add a field. */
  app.post(
    '/v1/ingestion/connectors/:id/schema/overrides',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const field = schemaOverrideStore.add(req.tenant!.tenant_id, id, inner);
        return res.status(201).json(
          wrapResponse(field, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof SchemaOverrideError) {
          if (e.code === 'unknown_connector') {
            return res.status(404).json(
              wrapError({ code: 'EWS_404_unknown_connector', message: e.message, severity: 'LOW' }, ctx),
            );
          }
          if (e.code === 'cap_reached' || e.code === 'duplicate_field' || e.code === 'reserved_field') {
            return res.status(409).json(
              wrapError({ code: `EWS_409_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** DELETE /v1/ingestion/connectors/:id/schema/overrides/:field_name */
  app.delete(
    '/v1/ingestion/connectors/:id/schema/overrides/:field_name',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const fname = req.params.field_name ?? '';
      const removed = schemaOverrideStore.remove(req.tenant!.tenant_id, id, fname);
      if (!removed) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_field', message: `field ${fname} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.status(204).send();
    },
  );

  /** GET /v1/ingestion/connectors/:id/schema/effective — platform + tenant additions. */
  app.get(
    '/v1/ingestion/connectors/:id/schema/effective',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const eff = schemaOverrideStore.effective(req.tenant!.tenant_id, id);
      if (!eff) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_connector', message: `unknown connector: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(eff, ctx));
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

  // ── Recurring report schedules (T6 M12.2) ───────────────────────────
  //
  // Schedules over the M12.1 catalog. SPA polls /due, fans matching
  // jobs via M12.1 POST /v1/reports/jobs, then calls /mark-run to
  // advance next_run_at. Schedule machinery decoupled from job tracker.
  // CRUD = admin (audit:read).

  /** POST /v1/reports/schedules body: ReportScheduleInput → 201. */
  app.post(
    '/v1/reports/schedules',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const entry = reportScheduleStore.create(
          req.tenant!.tenant_id,
          (inner ?? {}) as ReportScheduleInput,
          created_by,
          now(),
        );
        return res.status(201).json(
          wrapResponse(entry, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof ScheduleError) {
          if (e.code === 'cap_reached') {
            return res.status(409).json(
              wrapError({ code: 'EWS_409_cap_reached', message: e.message, severity: 'MEDIUM' }, ctx),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'create schedule failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** GET /v1/reports/schedules?page=1&page_size=20 — newest-first. */
  app.get(
    '/v1/reports/schedules',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const page = req.query.page ? Math.max(1, Number(req.query.page) || 1) : 1;
      const page_size = req.query.page_size ? Math.max(1, Math.min(100, Number(req.query.page_size) || 20)) : 20;
      const out = reportScheduleStore.list(req.tenant!.tenant_id, page, page_size);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/reports/schedules/due?as_of=ISO — schedules ready to fire.
   *  Declared BEFORE /:schedule_id so the literal "due" wins. */
  app.get(
    '/v1/reports/schedules/due',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const asOfRaw = req.query.as_of as string | undefined;
      const as_of = asOfRaw ? new Date(asOfRaw) : now();
      if (Number.isNaN(as_of.getTime())) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'as_of must be an ISO timestamp', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const items = reportScheduleStore.listDue(req.tenant!.tenant_id, as_of);
      return res.json(wrapResponse({ items, total: items.length, as_of: as_of.toISOString() }, ctx));
    },
  );

  /** GET /v1/reports/schedules/:schedule_id — single schedule. */
  app.get(
    '/v1/reports/schedules/:schedule_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.schedule_id ?? '';
      const e = reportScheduleStore.get(req.tenant!.tenant_id, id);
      if (!e) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_schedule', message: `schedule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(e, ctx));
    },
  );

  /** PATCH /v1/reports/schedules/:schedule_id — partial update. */
  app.patch(
    '/v1/reports/schedules/:schedule_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.schedule_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const updated = reportScheduleStore.update(
          req.tenant!.tenant_id,
          id,
          (inner ?? {}) as ReportSchedulePatch,
          now(),
        );
        return res.json(wrapResponse(updated, ctx));
      } catch (e) {
        if (e instanceof ScheduleError) {
          if (e.code === 'unknown_schedule') {
            return res.status(404).json(
              wrapError({ code: 'EWS_404_unknown_schedule', message: e.message, severity: 'LOW' }, ctx),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'update failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** DELETE /v1/reports/schedules/:schedule_id — 204 on success, 404 on miss. */
  app.delete(
    '/v1/reports/schedules/:schedule_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.schedule_id ?? '';
      const removed = reportScheduleStore.delete(req.tenant!.tenant_id, id);
      if (!removed) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_schedule', message: `schedule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.status(204).send();
    },
  );

  /** POST /v1/reports/schedules/:schedule_id/mark-run — bumps last_run_at. */
  app.post(
    '/v1/reports/schedules/:schedule_id/mark-run',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.schedule_id ?? '';
      try {
        const updated = reportScheduleStore.markRun(req.tenant!.tenant_id, id, now());
        return res.json(wrapResponse(updated, ctx));
      } catch (e) {
        if (e instanceof ScheduleError && e.code === 'unknown_schedule') {
          return res.status(404).json(
            wrapError({ code: 'EWS_404_unknown_schedule', message: e.message, severity: 'LOW' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'mark-run failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
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

  /**
   * POST /v1/rules/templates/bulk-clone
   * body: { template_ids?: string[], category?, vertical?, name_prefix? }
   * Materialises N draft rule shapes from the template selection.
   * Pure preview — does NOT mutate the rules store. The SPA iterates
   * the result and POSTs each clone to /v1/rules to commit.
   *
   * Selection: EITHER template_ids[] OR (category, vertical). 400 on
   * both/neither. > 50 ids → 400. RBAC rules:list (analyst+).
   *
   * Inserted before /v1/rules/templates/:id so Express matches
   * /bulk-clone as a literal path.
   */
  app.post(
    '/v1/rules/templates/bulk-clone',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const result = expandBulkClone((inner ?? {}) as BulkCloneInput, now());
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof BulkCloneError) {
          return res.status(400).json(
            wrapError(
              { code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        return res.status(500).json(
          wrapError(
            {
              code: 'EWS_500',
              message: e instanceof Error ? e.message : 'bulk-clone failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
    },
  );

  /** POST /v1/rules/templates/diff (T6 M5.5) — field-by-field
   *  comparison of two templates. Declared BEFORE /:id so the
   *  literal "diff" segment wins. */
  app.post(
    '/v1/rules/templates/diff',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { left_id?: unknown; right_id?: unknown };
      try {
        const tenantId = req.tenant!.tenant_id;
        const result = diffRuleTemplatesByIds(
          wrapper.left_id,
          wrapper.right_id,
          now(),
          (id) => getEffectiveRuleTemplate(customRuleTemplateStore, tenantId, id),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof RuleTemplateDiffError) {
          if (e.code === 'unknown_template') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_template', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  // ── Custom rule templates per-tenant (T6 M5.6) ───────────────────────
  // Mirrors M16.4 (custom scenarios). Declared BEFORE /v1/rules/templates/:id
  // so the literal "custom" segment wins.

  /** GET /v1/rules/templates/custom — list per-tenant custom templates. */
  app.get(
    '/v1/rules/templates/custom',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = customRuleTemplateStore.list(req.tenant!.tenant_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/rules/templates/custom — create custom template. */
  app.post(
    '/v1/rules/templates/custom',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const template = customRuleTemplateStore.create(
          req.tenant!.tenant_id,
          inner,
          created_by,
          now(),
        );
        // T6 M5.8 — audit event for the create.
        try {
          auditTrailStore.record(
            req.tenant!.tenant_id,
            {
              actor_username: created_by,
              actor_role: 'admin',
              action: 'rule.create',
              resource_type: 'rule',
              resource_id: template.id,
              outcome: 'success',
              severity: 'info',
              metadata: {
                name: template.name,
                vertical: template.vertical,
                category: template.category,
                recommended_severity: template.recommended_severity,
              },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.status(201).json(
          wrapResponse(template, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof CustomRuleTemplateError) {
          if (e.code === 'cap_reached') {
            return res.status(409).json(
              wrapError(
                { code: 'EWS_409_cap_reached', message: e.message, severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/rules/templates/custom/clone-from-library (T6 M5.9)
   *  body { source_template_id, name? } — reads a library template and
   *  creates an editable custom copy. Writes rule.create audit with
   *  `cloned_from` metadata. Declared BEFORE /:template_id so the
   *  literal `clone-from-library` segment wins. */
  app.post(
    '/v1/rules/templates/custom/clone-from-library',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { source_template_id?: unknown; name?: unknown };
      if (typeof wrapper.source_template_id !== 'string' || !wrapper.source_template_id.trim()) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'source_template_id is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const source = getRuleTemplate(wrapper.source_template_id);
      if (!source) {
        return res.status(404).json(
          wrapError(
            {
              code: 'EWS_404_unknown_template',
              message: `library template ${wrapper.source_template_id} not found`,
              severity: 'LOW',
            },
            ctx,
          ),
        );
      }
      const overrideName = typeof wrapper.name === 'string' && wrapper.name.trim()
        ? wrapper.name.trim()
        : null;
      const createInput = {
        name: overrideName ?? `Copy of ${source.name}`,
        description: source.description,
        vertical: source.vertical,
        category: source.category,
        condition_pseudocode: source.condition_pseudocode,
        recommended_severity: source.recommended_severity,
        recommended_actions: [...source.recommended_actions],
        supporting_indicators: [...source.supporting_indicators],
        source_doc: `Cloned from ${source.id} by ${created_by}`,
      };
      try {
        const template = customRuleTemplateStore.create(
          req.tenant!.tenant_id,
          createInput,
          created_by,
          now(),
        );
        try {
          auditTrailStore.record(
            req.tenant!.tenant_id,
            {
              actor_username: created_by,
              actor_role: 'admin',
              action: 'rule.create',
              resource_type: 'rule',
              resource_id: template.id,
              outcome: 'success',
              severity: 'info',
              metadata: {
                name: template.name,
                cloned_from: source.id,
                vertical: template.vertical,
                category: template.category,
              },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.status(201).json(
          wrapResponse(template, ctx, { code: 'EWS_201', message: 'Created' }),
        );
      } catch (e) {
        if (e instanceof CustomRuleTemplateError) {
          if (e.code === 'cap_reached') {
            return res.status(409).json(
              wrapError(
                { code: 'EWS_409_cap_reached', message: e.message, severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/rules/templates/custom/bulk-clone-from-library (T6 M5.10)
   *  body { template_ids[], name_prefix? } — iterates M5.9 single-clone
   *  over the list. Cap 10 per call. Per-row outcome surfaced as
   *  {created[], skipped[]}. Writes rule.create audit per successful
   *  clone with metadata.bulk=true. */
  app.post(
    '/v1/rules/templates/custom/bulk-clone-from-library',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { template_ids?: unknown; name_prefix?: unknown };
      if (!Array.isArray(wrapper.template_ids) || wrapper.template_ids.length === 0) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'template_ids[] must be non-empty', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (wrapper.template_ids.length > 10) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'template_ids[] exceeds cap of 10', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const prefix =
        typeof wrapper.name_prefix === 'string' && wrapper.name_prefix.trim()
          ? wrapper.name_prefix.trim()
          : null;
      const tenantId = req.tenant!.tenant_id;
      const created: Array<{ source_template_id: string; template_id: string; name: string }> = [];
      const skipped: Array<{ source_template_id: string; reason: string }> = [];

      for (const sid of wrapper.template_ids) {
        if (typeof sid !== 'string' || !sid.trim()) {
          skipped.push({ source_template_id: String(sid), reason: 'invalid_id' });
          continue;
        }
        const source = getRuleTemplate(sid);
        if (!source) {
          skipped.push({ source_template_id: sid, reason: 'unknown_source' });
          continue;
        }
        const createInput = {
          name: prefix ? `${prefix}${source.name}` : `Copy of ${source.name}`,
          description: source.description,
          vertical: source.vertical,
          category: source.category,
          condition_pseudocode: source.condition_pseudocode,
          recommended_severity: source.recommended_severity,
          recommended_actions: [...source.recommended_actions],
          supporting_indicators: [...source.supporting_indicators],
          source_doc: `Cloned from ${source.id} by ${created_by}`,
        };
        try {
          const template = customRuleTemplateStore.create(tenantId, createInput, created_by, now());
          try {
            auditTrailStore.record(
              tenantId,
              {
                actor_username: created_by,
                actor_role: 'admin',
                action: 'rule.create',
                resource_type: 'rule',
                resource_id: template.id,
                outcome: 'success',
                severity: 'info',
                metadata: {
                  name: template.name,
                  cloned_from: source.id,
                  vertical: template.vertical,
                  category: template.category,
                  bulk: true,
                },
              },
              now(),
            );
          } catch {
            // swallow
          }
          created.push({
            source_template_id: source.id,
            template_id: template.id,
            name: template.name,
          });
        } catch (e) {
          if (e instanceof CustomRuleTemplateError) {
            skipped.push({ source_template_id: sid, reason: e.code });
          } else {
            skipped.push({
              source_template_id: sid,
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      return res.json(
        wrapResponse(
          {
            requested_count: wrapper.template_ids.length,
            created_count: created.length,
            skipped_count: skipped.length,
            created,
            skipped,
            generated_at: now().toISOString(),
          },
          ctx,
        ),
      );
    },
  );

  /** PUT /v1/rules/templates/custom/:template_id (T6 M5.8) — replace
   *  mutable fields. Writes rule.update audit event with metadata. */
  app.put(
    '/v1/rules/templates/custom/:template_id',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.template_id ?? '';
      const updated_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      // Capture previous for audit metadata
      const previous = customRuleTemplateStore.get(req.tenant!.tenant_id, id);
      try {
        const next = customRuleTemplateStore.update(
          req.tenant!.tenant_id,
          id,
          inner,
          updated_by,
          now(),
        );
        // Write rule.update audit event
        try {
          auditTrailStore.record(
            req.tenant!.tenant_id,
            {
              actor_username: updated_by,
              actor_role: 'admin',
              action: 'rule.update',
              resource_type: 'rule',
              resource_id: id,
              outcome: 'success',
              severity: 'info',
              metadata: {
                previous_name: previous?.name ?? null,
                new_name: next.name,
                previous_severity: previous?.recommended_severity ?? null,
                new_severity: next.recommended_severity,
              },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.json(wrapResponse(next, ctx));
      } catch (e) {
        if (e instanceof CustomRuleTemplateError) {
          if (e.code === 'unknown_template') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_template', message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** DELETE /v1/rules/templates/custom/:template_id — remove custom template.
   *  T6 M5.8 — writes rule.delete audit event. */
  app.delete(
    '/v1/rules/templates/custom/:template_id',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.template_id ?? '';
      const deleted_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const previous = customRuleTemplateStore.get(req.tenant!.tenant_id, id);
      const removed = customRuleTemplateStore.delete(req.tenant!.tenant_id, id);
      if (!removed) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_template', message: `custom template ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      // Audit
      try {
        auditTrailStore.record(
          req.tenant!.tenant_id,
          {
            actor_username: deleted_by,
            actor_role: 'admin',
            action: 'rule.delete',
            resource_type: 'rule',
            resource_id: id,
            outcome: 'success',
            severity: 'info',
            metadata: previous
              ? {
                  previous_name: previous.name,
                  previous_severity: previous.recommended_severity,
                }
              : {},
          },
          now(),
        );
      } catch {
        // swallow
      }
      return res.status(204).send();
    },
  );

  /** GET /v1/rules/templates/custom/:template_id/history?limit=50 (T6 M5.8)
   *  — slim audit-history view filtered to rule events for this id. */
  app.get(
    '/v1/rules/templates/custom/:template_id/history',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.template_id ?? '';
      const limitRaw = req.query.limit;
      const limit =
        typeof limitRaw === 'string' ? Math.max(1, Math.min(200, Number(limitRaw) || 50)) : 50;
      const out = auditTrailStore.list(req.tenant!.tenant_id, {
        resource_type: 'rule',
        action: 'rule.create,rule.update,rule.delete',
        page_size: limit,
      });
      const items = out.items
        .filter((e) => e.resource_id === id)
        .map((e) => ({
          event_id: e.event_id,
          ts: e.ts,
          actor_username: e.actor_username,
          action: e.action,
          metadata: e.metadata,
        }));
      return res.json(
        wrapResponse({ items, total: items.length, template_id: id, limit }, ctx),
      );
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

  // ── Rule simulation against scenario (T6 M5.3) ───────────────────────
  //
  // Pure-function fire-rate simulator combining M5.1 templates with
  // M16.1 scenarios. Drives the SPA's "what would this rule do under
  // RBI Severely Adverse?" pre-activation check.
  app.post(
    '/v1/rules/simulate',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const tenantId = req.tenant!.tenant_id;
        const result = simulateRuleByIds(
          (inner ?? {}) as RuleSimulationInput,
          now(),
          (id) => getEffectiveRuleTemplate(customRuleTemplateStore, tenantId, id),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof RuleSimulationError) {
          if (e.code === 'unknown_template' || e.code === 'unknown_scenario') {
            return res.status(404).json(
              wrapError(
                { code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' },
                ctx,
              ),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'simulate failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** POST /v1/rules/simulate/bundle (T6 M5.4) — one rule × all M16.1 presets. */
  app.post(
    '/v1/rules/simulate/bundle',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const tenantId = req.tenant!.tenant_id;
        const result = simulateRuleBundle(
          (inner ?? {}) as BundleSimulationInput,
          now(),
          (id) => getEffectiveRuleTemplate(customRuleTemplateStore, tenantId, id),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof RuleSimulationError) {
          if (e.code === 'unknown_template' || e.code === 'unknown_scenario') {
            return res.status(404).json(
              wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'bundle failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
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
