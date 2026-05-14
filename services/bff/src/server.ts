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

import { randomUUID } from 'node:crypto';
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
import {
  defaultCopilotAuditStore,
  type CopilotAuditStore,
} from './copilot/audit_store';
import { maskPII } from './copilot/pii_masker';
import {
  COPILOT_DEFAULT_LIMIT,
  checkAndConsume,
  defaultRateState,
  inspect as inspectRate,
} from './copilot/rate_limiter';
import { tryHandleEwsIntent } from './copilot/ews_intents';
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
  BundleError,
  exportBundle as exportRuleTemplateBundle,
  importBundle as importRuleTemplateBundle,
} from './rule_template_bundle';
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
  WatchlistError,
  defaultWatchlistStore,
  type WatchlistStore,
} from './customer_watchlist';
import {
  FieldVisitError,
  aggregateByOutcome,
  defaultFieldVisitStore,
  isVisitOutcome,
  isVisitTz,
  type FieldVisitStore,
  type VisitFilter,
  type VisitOutcome,
} from './field_officer';
import { summarizeFieldOperations } from './field_operations_analytics';
import {
  PreviewError,
  applyBulkImportPreview,
  createBulkImportPreview,
  defaultBulkImportPreviewStore,
  type BulkImportPreviewStore,
} from './tenant_bulk_preview';
import {
  CASE_EVENT_DEFAULT_LIMIT,
  CASE_EVENT_MAX_LIMIT,
  CaseEventError,
  defaultCaseEventStore,
  type CaseEventStore,
} from './case_events';
import { detectCaseSlaBreaches } from './case_sla_breach';
import {
  DashboardError,
  WIDGET_CATALOG,
  defaultCustomDashboardStore,
  type CustomDashboardStore,
  type DashboardWidget,
} from './custom_dashboards';
import {
  DashboardBundleError,
  exportDashboardBundle,
  importDashboardBundle,
} from './custom_dashboard_bundle';
import {
  WidgetResolverError,
  resolveDashboard,
  resolveWidget,
} from './dashboard_widget_resolver';
import {
  CMS_CASE_STATES,
  CMS_PRIORITIES,
  CMS_SLA_WARNING_PCT,
  CmsCaseError,
  isCmsCaseState,
  isCmsPriority,
  isSlaBreached,
  slaProgressPct,
  type CmsCase,
  type CmsCaseState,
  type CmsPriority,
} from './cms_cases';
import {
  defaultCmsCaseStore,
  seedDemoCmsCases,
  type CmsCaseStore,
  type CmsListFilter,
} from './cms_store';
import { seedDefaultEwsRules } from './ews_rules_seed';
import {
  autoCreateCaseFromAlert,
  defaultAssigneePoolStore,
  findInactiveCases,
  type AssigneePoolStore,
  type AutoCreateInput,
} from './cms_automation';
import {
  InMemoryModelPerformanceStore,
  ModelPerformanceError,
  PERFORMANCE_METRICS,
  isPerformanceMetric,
  summarizePerformance,
  type ModelPerformanceStore,
  type PerformanceFilter,
  type PerformanceMetric,
} from './model_performance';
import {
  EWS_RULE_CATEGORIES,
  EWS_RULE_STATES,
  EwsRuleError,
  defaultEwsRuleStore,
  isEwsRuleCategory,
  isEwsRuleState,
  type EwsRuleStore,
} from './ews_rules';
import {
  SEMVER_INITIAL,
  approveWithFourEyes,
  buildCloneInput,
  bumpSemver,
  classifyEditBump,
  defaultEwsRuleVersionsStore,
  diffRuleSnapshots,
  isSemver,
  rejectWithFourEyes,
  type EwsRuleVersionsStore,
} from './ews_rules_versions';
import {
  EWS_INDICATOR_CATALOG,
  type EwsIndicator,
} from './ews_indicators';
import {
  evaluateRules,
  ruleMatches,
  firingIndicators,
  type EntityType,
  type IndicatorValues,
} from './ews_rules_executor';
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
  diffPresetVersionsByNumber,
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
  cloneTenantConfigSelective,
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
  backtestPreset,
  compareByPresets,
  getWeightPreset,
  isWeightPresetMode,
  listWeightPresets,
  scoreByPreset,
  scoreByPresetBatch,
  type BackTestInput,
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
import { diffWeightPresets } from './scoring_preset_diff';
import {
  BacktestCompareError,
  compareFromUnknown as compareBacktestFromUnknown,
} from './indicator_backtest_compare';
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
  ROUTING_ANALYTICS_DEFAULT_WINDOW,
  ROUTING_ANALYTICS_MAX_WINDOW,
  aggregateRoutingAnalytics,
  defaultRoutingLedger,
  type RoutingLedger,
} from './alert_routing_analytics';
import {
  AutoAckError,
  defaultAutoAckRuleStore,
  evaluateAutoAck,
  ingestAlertWithAutoAck,
  type AlertContext,
  type AutoAckRuleStore,
} from './alert_auto_ack';
import {
  defaultQuietHoursMuteEventStore,
  evaluateQuietHoursMute,
  type QuietHoursMuteEventStore,
} from './alert_quiet_hours_mute';
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
  CHAIN_SAMPLE_DEFAULT_WINDOW,
  CHAIN_SAMPLE_MAX_WINDOW,
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
import { introspectAuditCatalog } from './audit_action_catalog';
import { analyseTemplateCloneHistory } from './template_clone_analysis';
import { bucketVisitsByDowHour, isHeatmapTz } from './field_visit_heatmap';
import { listInvestigationStateGraph } from './investigation_state_graph';
import { indexConnectorSchemaFields } from './connector_schema_field_index';
import { analyseDashboardWidgetUsage } from './dashboard_widget_usage';
import { listOnboardingSkips } from './onboarding_skip_history';
import {
  EvidenceError,
  defaultEvidencePackageStore,
  validateFilters,
  type EvidenceFilters,
  type EvidencePackageStore,
} from './audit_evidence';
import { renderEvidenceSummary } from './audit_evidence_summary';
import { renderPerformanceSummary } from './model_performance_summary';
import {
  defaultIngestionRegistry,
  IngestionError,
  type ConnectorRun,
  type IngestionRegistry,
} from './ingestion';
import {
  RUN_ANALYTICS_DEFAULT_WINDOW,
  RUN_ANALYTICS_MAX_WINDOW,
  aggregateRunAnalytics,
} from './connector_run_analytics';
import {
  AdapterSlaError,
  DEFAULT_SLA_TARGETS,
  buildAdapterSlaDashboard,
  defaultAdapterSlaBreachEventStore,
  defaultAdapterSlaTargetsStore,
  recordBreachEvents,
  resolveSlaTargets,
  validateSlaTargets,
  type AdapterSlaBreachEventStore,
  type AdapterSlaTargets,
  type AdapterSlaTargetsStore,
} from './adapter_sla_dashboard';
import {
  ConnectorSchemaError,
  getConnectorSchema,
  listSchemaConnectorIds,
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
import { summarizeReportJobs } from './report_job_analytics';
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

/**
 * Default rolesForUser — used by the User Access Override
 * effective-access resolver. Reads from app_iam.users when a Postgres
 * pool is reachable; falls back to ['admin'] in dev so the endpoint
 * still returns a useful answer in MSW / no-PG mode.
 *
 * Production swaps this for a JWT-claim extractor + cache.
 */
async function defaultRolesForUser(_tenant_id: string, user_id: string): Promise<string[]> {
  const url = process.env.BFF_PG_URL ?? process.env.AUTH_PG_URL;
  if (!url) {
    // Heuristic: hand back the role implied by the seed-username convention
    // (alice.admin → admin, sue.super → supervisor, etc.).
    if (user_id.includes('admin')) return ['admin'];
    if (user_id.includes('super')) return ['supervisor'];
    if (user_id.includes('risk'))  return ['risk_analyst'];
    if (user_id.includes('collect')) return ['collection_officer'];
    if (user_id.includes('field')) return ['field_officer'];
    return ['admin'];
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg') as typeof import('pg');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const r = await pool.query<{ role: string }>(
      `SELECT role FROM app_iam.users WHERE id = $1 OR username = $1 LIMIT 1`,
      [user_id],
    );
    if (r.rows[0]?.role) return [r.rows[0].role];
    return ['admin'];
  } catch {
    return ['admin'];
  } finally {
    await pool.end();
  }
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
   * Override for tests — alert routing ledger (T6 M8.6). Captures each
   * /v1/alerts/ingest call's routing snapshot for analytics roll-up.
   */
  routingLedger?: RoutingLedger;
  /**
   * Override for tests — alert auto-ack rule store (T6 M8.4).
   */
  autoAckRuleStore?: AutoAckRuleStore;
  /** Override for tests — notification webhook channel store (T6 M10.4). */
  notificationWebhookStore?: NotificationWebhookStore;
  /** Override for tests — per-user notification preference store (T6 M10.5). */
  notificationPreferenceStore?: NotificationPreferenceStore;
  /** Override for tests — quiet-hours mute event audit store (T6 M10.8). */
  quietHoursMuteEventStore?: QuietHoursMuteEventStore;
  /** Override for tests — per-tenant adapter SLA targets store (T6 M14.12). */
  adapterSlaTargetsStore?: AdapterSlaTargetsStore;
  /** Override for tests — per-tenant adapter SLA breach audit store (T6 M14.13). */
  adapterSlaBreachEventStore?: AdapterSlaBreachEventStore;
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
  /** Override for tests — per-tenant customer watchlist (T6 M4.7). */
  watchlistStore?: WatchlistStore;
  /** Override for tests — per-tenant field-officer visit ledger (T6 M14.10). */
  fieldVisitStore?: FieldVisitStore;
  /** Override for tests — per-tenant bulk-import preview store (T6 M2.4). */
  bulkImportPreviewStore?: BulkImportPreviewStore;
  /** Override for tests — per-tenant case event journal (T6 M9.4). */
  caseEventStore?: CaseEventStore;
  /** Override for tests — per-tenant custom dashboard store (T6 M11.7). */
  customDashboardStore?: CustomDashboardStore;
  /** Override for tests — per-tenant per-model performance ledger (T6 M7.5). */
  modelPerformanceStore?: ModelPerformanceStore;
  /** Override for tests — per-tenant EWS rules store (EWS-2). */
  ewsRuleStore?: EwsRuleStore;
  /** Override for tests — versions + approvals ledger (RP-1). */
  ewsRuleVersionsStore?: EwsRuleVersionsStore;
  /** Override for tests — per-tenant CMS case store (CMS-2). */
  cmsCaseStore?: CmsCaseStore;
  /** Override for tests — per-tenant assignee pool (CMS-4). */
  cmsAssigneePoolStore?: AssigneePoolStore;
  /** Override for tests — copilot audit + conversation store (Copilot-1). */
  copilotAuditStore?: CopilotAuditStore;
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

  /**
   * Per-user access override store (BAC §3.1.6/§3.1.7). When provided,
   * mounts the /v1/admin/user-access-overrides + /v1/admin/users/:id/
   * effective-access + /v1/admin/admin-audit-log routes. Wired by the
   * bootstrap path below to a PG-backed store when BFF_PG_URL is set.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userAccessOverrideStore?: any;
  /**
   * Tenant-scoped lookup for a user's roles. Used by the
   * effective-access resolver. Defaults to a stub that reads from
   * app_iam.users when a PG pool is reachable, else returns ['admin'].
   */
  rolesForUser?: (tenant_id: string, user_id: string) => Promise<string[]>;
  /**
   * Source for the SLA breach matrix dashboard widget (BAC §3.1.9.1.4).
   * When provided, mounts /v1/dashboard/sla-breach-matrix. The bootstrap
   * path wires this to a PG-backed source that joins app_admin.sla_config
   * × app_cases.cms_cases.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slaMatrixSource?: any;
  /**
   * Admin CRUD store for app_admin.sla_config (BAC §3.1.6 admin
   * widget). When provided, mounts /v1/admin/sla-config routes.
   * Bootstrap path wires this to a PG-backed store via
   * makeSlaConfigStore() when ADMIN_PG_URL || BFF_PG_URL is set.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slaConfigStore?: any;
  /**
   * Admin CRUD store for app_admin.notification_templates (T6 M14.16).
   * When provided, mounts /v1/admin/notification-templates routes.
   * Bootstrap path may wire this to a PG-backed store; in-memory
   * default is suitable for tests + dev.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notificationTemplateStore?: any;
  /**
   * Append-only dispatch log (T6 M14.24). When set, the template
   * routes mount Preview / Test-fire / GET /dispatches. Without it
   * the GET degrades gracefully (returns empty); the POST /test-fire
   * returns 503.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notificationDispatchStore?: any;
  /**
   * Admin CRUD store for app_admin.escalation_matrix (T6 M14.17).
   * When provided, mounts /v1/admin/escalation-matrix routes.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  escalationMatrixStore?: any;
  /**
   * Admin CRUD store for app_admin.case_scenarios (T6 M14.18).
   * When provided, mounts /v1/admin/case-scenarios routes.
   * The store carries injected resolvers for FK validation against
   * escalation_matrix + notification_templates plus an optional
   * history fan-out target.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  caseScenarioStore?: any;
  /**
   * Append-only history store for app_admin.case_scenario_history.
   * When set, GET /v1/admin/case-scenarios/:id/history returns
   * paginated entries (mutation log w/ RFC-6902-flavoured diff).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  caseScenarioHistoryStore?: any;
  /**
   * Optional cron handle (T6 M14.25b). When provided, the escalation
   * worker's GET /worker/status route reports live metadata. Bootstrap
   * starts the cron when ESCALATION_WORKER_INTERVAL_SEC is set; tests
   * + dev runs without the env get a status route that reports
   * cron_wired=false.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  escalationWorkerCron?: any;
  /**
   * Source for the Cases Report detail (BAC §3.1.8). When provided,
   * mounts /v1/reports/cases/detail + /v1/reports/cases/filters.
   * Bootstrap wires this to a Pg-backed source via
   * makeCasesDetailSource() when BFF_PG_URL || ADMIN_PG_URL is set.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  casesDetailSource?: any;
  /** Saved-filter store (paired with casesDetailSource). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  savedFilterStore?: any;
  /** Optional Pg pool used to record export audit rows. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reportAuditPool?: any;
  /**
   * Source for the Analytics Dashboard sub-dashboards (T4.1, EWS.docx
   * §5.5 / §8). When provided, mounts /v1/analytics/* endpoints.
   * Bootstrap path wires this to a Pg-backed source via
   * makeAlertResolutionSource() when BFF_PG_URL is set.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  alertResolutionSource?: any;
  /** Source for the Risk Trend sub-dashboard (T4.1 4b). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  riskTrendSource?: any;
  /** Source for the PD Distribution sub-dashboard (T4.1 4c). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdDistributionSource?: any;
  /** Source for the Stage Migration sub-dashboard (T4.1 4d). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stageMigrationSource?: any;
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
  const routingLedger = deps.routingLedger ?? defaultRoutingLedger;
  const autoAckRuleStore = deps.autoAckRuleStore ?? defaultAutoAckRuleStore;
  const notificationWebhookStore = deps.notificationWebhookStore ?? defaultNotificationWebhookStore;
  const notificationPreferenceStore =
    deps.notificationPreferenceStore ?? defaultNotificationPreferenceStore;
  const quietHoursMuteEventStore =
    deps.quietHoursMuteEventStore ?? defaultQuietHoursMuteEventStore;
  const adapterSlaTargetsStore =
    deps.adapterSlaTargetsStore ?? defaultAdapterSlaTargetsStore;
  const adapterSlaBreachEventStore =
    deps.adapterSlaBreachEventStore ?? defaultAdapterSlaBreachEventStore;
  const customPresetStore = deps.customPresetStore ?? defaultCustomPresetStore;
  const customWeightPresetStore = deps.customWeightPresetStore ?? defaultCustomWeightPresetStore;
  const schemaOverrideStore = deps.schemaOverrideStore ?? defaultSchemaOverrideStore;
  const customRuleTemplateStore = deps.customRuleTemplateStore ?? defaultCustomRuleTemplateStore;
  const thresholdOverrideStore = deps.thresholdOverrideStore ?? defaultThresholdOverrideStore;
  const watchlistStore = deps.watchlistStore ?? defaultWatchlistStore;
  const fieldVisitStore = deps.fieldVisitStore ?? defaultFieldVisitStore;
  const bulkImportPreviewStore = deps.bulkImportPreviewStore ?? defaultBulkImportPreviewStore;
  const caseEventStore = deps.caseEventStore ?? defaultCaseEventStore;
  const customDashboardStore = deps.customDashboardStore ?? defaultCustomDashboardStore;
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
  const modelPerformanceStore =
    deps.modelPerformanceStore ?? new InMemoryModelPerformanceStore(aiModelRegistry);
  const ewsRuleStore = deps.ewsRuleStore ?? defaultEwsRuleStore;
  const ewsRuleVersionsStore = deps.ewsRuleVersionsStore ?? defaultEwsRuleVersionsStore;
  const cmsCaseStore = deps.cmsCaseStore ?? defaultCmsCaseStore;
  const cmsAssigneePoolStore = deps.cmsAssigneePoolStore ?? defaultAssigneePoolStore;
  const copilotAuditStore = deps.copilotAuditStore ?? defaultCopilotAuditStore;
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

  // ---------- /v1/admin/* — User Access Override (BAC §3.1.6/§3.1.7) ----------
  // Mounted as a child router so the routes file owns its own routing
  // table; server.ts just plumbs in the store + middleware shims.
  if (deps.userAccessOverrideStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeUserAccessOverrideRouter } = require('./admin/user_access_override_routes') as
      typeof import('./admin/user_access_override_routes');
    app.use(
      makeUserAccessOverrideRouter({
        store: deps.userAccessOverrideStore,
        requireTenantMw,
        requireRole,
        rolesForUser: deps.rolesForUser ?? defaultRolesForUser,
        webhookDispatcher,
        now,
      }),
    );
  }

  // ---------- /v1/admin/sla-config — admin CRUD on app_admin.sla_config
  if (deps.slaConfigStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeSlaConfigRouter } = require('./admin/sla_config_routes') as
      typeof import('./admin/sla_config_routes');
    app.use(
      makeSlaConfigRouter({
        store: deps.slaConfigStore,
        requireTenantMw,
        requireRole,
        now,
      }),
    );
  }

  // ---------- /v1/admin/notification-templates (T6 M14.16, M14.24) ----
  if (deps.notificationTemplateStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeNotificationTemplatesRouter } = require('./admin/notification_templates_routes') as
      typeof import('./admin/notification_templates_routes');
    app.use(
      makeNotificationTemplatesRouter({
        store: deps.notificationTemplateStore,
        // M14.24 — preview/test-fire/dispatches log routes mount when
        // a dispatch store is wired. Bootstrap path defaults to the
        // in-memory FIFO store; PG-backed lands in M14.24b.
        dispatchStore: deps.notificationDispatchStore,
        requireTenantMw,
        requireRole,
        now,
      }),
    );
  }

  // ---------- /v1/admin/escalation-matrix (T6 M14.17) -----------------
  if (deps.escalationMatrixStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeEscalationMatrixRouter } = require('./admin/escalation_matrix_routes') as
      typeof import('./admin/escalation_matrix_routes');
    app.use(
      makeEscalationMatrixRouter({
        store: deps.escalationMatrixStore,
        requireTenantMw,
        requireRole,
        now,
      }),
    );
  }

  // ---------- /v1/admin/case-scenarios (T6 M14.18) --------------------
  if (deps.caseScenarioStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeCaseScenariosRouter } = require('./admin/case_scenarios_routes') as
      typeof import('./admin/case_scenarios_routes');
    app.use(
      makeCaseScenariosRouter({
        store: deps.caseScenarioStore,
        history: deps.caseScenarioHistoryStore,
        requireTenantMw,
        requireRole,
        now,
      }),
    );
  }

  // ---------- /v1/admin/escalations/* (T6 M14.25 + M14.25b status) ---
  // Mounts when the full triad (scenarios + matrix + templates +
  // dispatch log) is wired so the worker can resolve the chain.
  // The optional `escalationWorkerCron` deps slot enables the
  // /worker/status route to surface live cron metadata.
  if (
    deps.caseScenarioStore &&
    deps.escalationMatrixStore &&
    deps.notificationTemplateStore &&
    deps.notificationDispatchStore
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeEscalationWorkerRouter } = require('./admin/escalation_worker_routes') as
      typeof import('./admin/escalation_worker_routes');
    app.use(
      makeEscalationWorkerRouter({
        scenarioStore: deps.caseScenarioStore,
        escalationMatrixStore: deps.escalationMatrixStore,
        templateStore: deps.notificationTemplateStore,
        dispatchStore: deps.notificationDispatchStore,
        cron: deps.escalationWorkerCron,
        requireTenantMw,
        requireRole,
        now,
      }),
    );
  }

  // ---------- /v1/reports/cases/* — Cases Report (BAC §3.1.8) ----------
  if (deps.casesDetailSource && deps.savedFilterStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeCasesDetailRouter } = require('./reports/cases_detail_routes') as
      typeof import('./reports/cases_detail_routes');
    app.use(
      makeCasesDetailRouter({
        source: deps.casesDetailSource,
        savedFilterStore: deps.savedFilterStore,
        auditPool: deps.reportAuditPool ?? null,
        requireTenantMw,
        requireRole,
        now,
      }),
    );
  }

  // ---------- /api (internal BFF — T3.10) ----------
  app.get('/api/alerts', requireRole('alerts:list'), (req, res) =>
    listAlerts(req, res, source, lookups, now),
  );

  // /api/customers — list of monitored customers (SPA Customers page).
  // Each row is a thin summary; the detail page hydrates via /api/customers/:id/risk.
  app.get('/api/customers', requireRole('customers:read_risk_profile'), async (req, res) => {
    const levelFilter = String(req.query.level ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const pdMin = Number(req.query.pdMin ?? 0);
    const items: Array<{
      id: string; name: string; pd: number; level: 'Low'|'Medium'|'High';
      exposure: number; dpd: number;
    }> = [];
    for (const id of Object.keys(lookups.customers)) {
      const profile = await riskProfile.get(id);
      if (!profile) continue;
      if (levelFilter.length && !levelFilter.includes(profile.level)) continue;
      if (Number.isFinite(pdMin) && profile.pd < pdMin) continue;
      items.push({
        id: profile.id, name: profile.name, pd: profile.pd, level: profile.level,
        exposure: profile.exposure, dpd: profile.dpd,
      });
    }
    items.sort((a, b) => b.pd - a.pd);
    res.json({ items, total: items.length });
  });

  // /api/customers/:id/risk — full risk profile for the SPA Customer 360 page.
  app.get('/api/customers/:id/risk', requireRole('customers:read_risk_profile'), async (req, res) => {
    const profile = await riskProfile.get(req.params.id);
    if (!profile) return res.status(404).json({ error: `customer ${req.params.id} not found` });
    res.json(profile);
  });

  // /api/rules — list of rules in the SPA's RuleSummary shape (sourced from BFF rules seed).
  app.get('/api/rules', requireRole('rules:list'), async (_req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SEED_RULES } = require('./rules/seed') as { SEED_RULES: Array<Record<string, unknown>> };
    const STATE_TO_STATUS: Record<string, string> = {
      active: 'live', approved: 'simulate', pending_review: 'simulate',
      draft: 'draft', deprecated: 'retired',
    };
    const FAMILY_OK = new Set(['Financial', 'Behavioural', 'Transaction', 'Credit']);
    const items = SEED_RULES.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      name: String(r.name),
      family: FAMILY_OK.has(String(r.family)) ? r.family : 'Behavioural',
      status: STATE_TO_STATUS[String(r.state ?? 'draft')] ?? 'draft',
      version: String(r.version ?? '0.1.0'),
      when: r.conditions ?? {},
      then: { alert: { severity: ((r.outcome as Record<string, unknown>)?.severity ?? 'low') } },
      owner: String(r.owner_id ?? 'risk-ops'),
      updated_at: String(r.updated_at ?? '2026-01-01'),
    }));
    res.json({ items });
  });

  // /api/cases — list of cases for the SPA Cases page. Pulls from cases-svc.
  app.get('/api/cases', requireRole('cases:list'), async (req, res) => {
    try {
      const baseUrl = process.env.APEX_CASES_URL ?? 'http://localhost:8083';
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      const r = await fetch(`${baseUrl}/cases${qs ? '?' + qs : ''}`, {
        headers: {
          'x-tenant-id': 'BANK_DEMO',
          'x-apex-role': req.headers['x-apex-role'] as string ?? 'risk_analyst',
          'x-apex-user': req.headers['x-apex-user'] as string ?? 'spa',
        },
      });
      const body = (await r.json()) as { items?: Array<Record<string, unknown>>; cases?: Array<Record<string, unknown>> };
      const rows = body.items ?? body.cases ?? [];
      const items = rows.map((c) => ({
        id: c.case_id ?? c.id,
        alert_id: c.alert_id,
        customer: {
          id: c.customer_id,
          name: lookups.customers[String(c.customer_id)]?.name ?? String(c.customer_id),
        },
        state: c.state,
        assignee: c.assignee ?? null,
        age_min: c.created_at
          ? Math.max(0, Math.floor((now().getTime() - Date.parse(String(c.created_at))) / 60000))
          : 0,
        sla_status: c.sla_status ?? 'on_track',
      }));
      res.json({ items });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'cases-svc unreachable' });
    }
  });

  // /api/cases/:id — single case detail
  app.get('/api/cases/:id', requireRole('cases:read'), async (req, res) => {
    try {
      const baseUrl = process.env.APEX_CASES_URL ?? 'http://localhost:8083';
      const r = await fetch(`${baseUrl}/cases/${req.params.id}`, {
        headers: {
          'x-tenant-id': 'BANK_DEMO',
          'x-apex-role': req.headers['x-apex-role'] as string ?? 'risk_analyst',
          'x-apex-user': req.headers['x-apex-user'] as string ?? 'spa',
        },
      });
      if (r.status === 404) return res.status(404).json({ error: 'case not found' });
      const c = (await r.json()) as Record<string, unknown> & { case?: Record<string, unknown> };
      const detail = c.case ?? c;
      res.json({
        ...detail,
        id: detail.case_id ?? detail.id,
        customer: {
          id: detail.customer_id,
          name: lookups.customers[String(detail.customer_id)]?.name ?? String(detail.customer_id),
        },
        rule: { id: detail.rule_id, name: lookups.rules[String(detail.rule_id)]?.name ?? String(detail.rule_id) },
      });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'cases-svc unreachable' });
    }
  });

  // Dashboard KPI summary used by the SPA's home page. Aggregates from
  // in-memory sources so a local `make up` produces a populated dashboard.
  app.get('/api/dashboard/summary', requireRole('alerts:list'), (_req, res) => {
    const allAlerts = source.read();
    const sevCount = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const a of allAlerts) {
      const sev = String(a.severity ?? '').toLowerCase() as keyof typeof sevCount;
      if (sev in sevCount) sevCount[sev] += 1;
    }
    res.json({
      customers_monitored: Object.keys(lookups.customers).length || 18432,
      high_risk_customers: 412,
      active_alerts: allAlerts.length,
      cases_open: 64,
      risk_trend: [
        { week: 'W-11', pd: 0.038 },
        { week: 'W-10', pd: 0.040 },
        { week: 'W-9',  pd: 0.043 },
        { week: 'W-8',  pd: 0.041 },
        { week: 'W-7',  pd: 0.045 },
        { week: 'W-6',  pd: 0.052 },
        { week: 'W-5',  pd: 0.048 },
        { week: 'W-4',  pd: 0.057 },
        { week: 'W-3',  pd: 0.061 },
        { week: 'W-2',  pd: 0.058 },
        { week: 'W-1',  pd: 0.063 },
        { week: 'W-0',  pd: 0.066 },
      ],
      alerts_by_severity: [
        { severity: 'critical', count: sevCount.critical },
        { severity: 'high',     count: sevCount.high     },
        { severity: 'medium',   count: sevCount.medium   },
        { severity: 'low',      count: sevCount.low      },
      ],
    });
  });

  // ---------- /v1 (public REST API v1 — T3.7, envelope + tenant per T4.24) ----------

  // /v1/dashboard/sla-breach-matrix — BAC §3.1.6 / §3.1.9.1.4 widget.
  // Computes the four-bucket (0-7 / 8-30 / 31-90 / 90+) age breakdown
  // with breach % derived live from app_admin.sla_config × open
  // app_cases.cms_cases. The resolver itself is pure; PG IO happens
  // in deps.slaMatrixSource (env-driven factory at bootstrap).
  if (deps.slaMatrixSource) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { computeSlaBreachMatrix } = require('./dashboard/sla_breach_matrix') as
      typeof import('./dashboard/sla_breach_matrix');
    app.get(
      '/v1/dashboard/sla-breach-matrix',
      requireTenantMw,
      requireRole('dashboard:sla_breach_matrix:read'),
      async (req: Request, res: Response) => {
        const ctx = extractCtx(req, now);
        try {
          const tenant_id = req.tenant!.tenant_id;
          const branch = typeof req.query.branch === 'string' ? req.query.branch : undefined;
          const business_unit =
            typeof req.query.business_unit === 'string' ? req.query.business_unit : undefined;
          const asOf =
            typeof req.query.as_of === 'string' ? new Date(req.query.as_of) : now();
          if (Number.isNaN(asOf.getTime())) {
            return res.status(400).json(
              wrapError(
                { code: 'EWS_400_invalid_input', message: 'as_of must be ISO 8601', severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          const [configs, cases] = await Promise.all([
            deps.slaMatrixSource.loadConfigs(tenant_id),
            deps.slaMatrixSource.loadOpenCases(tenant_id, { branch, business_unit }),
          ]);
          const matrix = computeSlaBreachMatrix({
            tenant_id,
            cases,
            configs,
            asOf,
            filters: { branch, business_unit },
          });
          res.json(wrapResponse(matrix, ctx));
        } catch (e) {
          res.status(500).json(
            wrapError(
              { code: 'EWS_500', message: e instanceof Error ? e.message : 'matrix failed', severity: 'HIGH' },
              ctx,
            ),
          );
        }
      },
    );

    // POST /v1/dashboard/sla-breach-matrix/preview — show the impact of
    // a hypothetical sla_config patch BEFORE the admin saves. Returns
    // the current matrix, the patched matrix, and a per-bucket delta.
    // Used by the SlaConfigEditModal to surface "this change will
    // move N cases" before commit.
    app.post(
      '/v1/dashboard/sla-breach-matrix/preview',
      requireTenantMw,
      requireRole('dashboard:sla_breach_matrix:read'),
      async (req: Request, res: Response) => {
        const ctx = extractCtx(req, now);
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { applyConfigPatches, diffMatrices, computeSlaBreachMatrix } =
            require('./dashboard/sla_breach_matrix') as
              typeof import('./dashboard/sla_breach_matrix');
          const tenant_id = req.tenant!.tenant_id;
          const body = (req.body ?? {}) as { patches?: unknown };
          if (!Array.isArray(body.patches) || body.patches.length === 0) {
            return res.status(400).json(
              wrapError(
                { code: 'EWS_400_invalid_input', message: 'patches must be a non-empty array', severity: 'MEDIUM' },
                ctx,
              ),
            );
          }
          const validated: import('./dashboard/sla_breach_matrix').SlaConfigPatch[] = [];
          for (const raw of body.patches) {
            if (!raw || typeof raw !== 'object') {
              return res.status(400).json(
                wrapError(
                  { code: 'EWS_400_invalid_input', message: 'patch must be an object', severity: 'MEDIUM' },
                  ctx,
                ),
              );
            }
            const p = raw as Record<string, unknown>;
            if (typeof p.case_category !== 'string' || !p.case_category.trim()) {
              return res.status(400).json(
                wrapError(
                  { code: 'EWS_400_invalid_input', message: 'case_category required on each patch', severity: 'MEDIUM' },
                  ctx,
                ),
              );
            }
            if (p.priority !== 'P1' && p.priority !== 'P2' && p.priority !== 'P3' && p.priority !== 'P4') {
              return res.status(400).json(
                wrapError(
                  { code: 'EWS_400_invalid_input', message: 'priority must be P1..P4', severity: 'MEDIUM' },
                  ctx,
                ),
              );
            }
            const target = typeof p.sla_target_days === 'number' ? p.sla_target_days : Number(p.sla_target_days);
            if (!Number.isFinite(target) || target <= 0 || target > 365) {
              return res.status(400).json(
                wrapError(
                  { code: 'EWS_400_invalid_input', message: 'sla_target_days must be in (0, 365]', severity: 'MEDIUM' },
                  ctx,
                ),
              );
            }
            validated.push({
              case_category: p.case_category.trim(),
              priority: p.priority,
              business_unit:
                typeof p.business_unit === 'string' && p.business_unit.trim()
                  ? p.business_unit.trim()
                  : null,
              sla_target_days: target,
            });
          }
          const [configs, cases] = await Promise.all([
            deps.slaMatrixSource.loadConfigs(tenant_id),
            deps.slaMatrixSource.loadOpenCases(tenant_id, {}),
          ]);
          const patchedConfigs = applyConfigPatches(tenant_id, configs, validated);
          const asOf = now();
          const current = computeSlaBreachMatrix({ tenant_id, cases, configs, asOf });
          const patched = computeSlaBreachMatrix({ tenant_id, cases, configs: patchedConfigs, asOf });
          res.json(
            wrapResponse(
              { current, patched, delta: diffMatrices(current, patched), patches: validated },
              ctx,
            ),
          );
        } catch (e) {
          res.status(500).json(
            wrapError(
              { code: 'EWS_500', message: e instanceof Error ? e.message : 'preview failed', severity: 'HIGH' },
              ctx,
            ),
          );
        }
      },
    );
  }

  // /v1/analytics/stage-migration — T4.1 4d.
  // 3×3 (from-stage × to-stage) transition matrix between two snapshots,
  // with per-stage totals + upgrade/downgrade/stationary counts.
  if (deps.stageMigrationSource) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { computeStageMigration } = require('./analytics/stage_migration') as
      typeof import('./analytics/stage_migration');
    app.get(
      '/v1/analytics/stage-migration',
      requireTenantMw,
      requireRole('dashboard:analytics:read'),
      async (req: Request, res: Response) => {
        const ctx = extractCtx(req, now);
        try {
          const tenant_id = req.tenant!.tenant_id;
          const filter = {
            as_of: typeof req.query.as_of === 'string' ? req.query.as_of : undefined,
            prior_as_of: typeof req.query.prior_as_of === 'string' ? req.query.prior_as_of : undefined,
            segment: typeof req.query.segment === 'string' ? req.query.segment : undefined,
          };
          for (const k of ['as_of', 'prior_as_of'] as const) {
            const v = filter[k];
            if (v && Number.isNaN(Date.parse(v))) {
              return res.status(400).json(
                wrapError(
                  { code: 'EWS_400_invalid_input', message: `${k} must be ISO 8601`, severity: 'MEDIUM' },
                  ctx,
                ),
              );
            }
          }
          const asOfDate = filter.as_of ? new Date(filter.as_of) : now();
          // Default 30-day prior window when not provided
          const priorDate = filter.prior_as_of
            ? new Date(filter.prior_as_of)
            : new Date(asOfDate.getTime() - 30 * 86_400_000);
          const [current, prior] = await Promise.all([
            deps.stageMigrationSource.loadSnapshot(tenant_id, asOfDate),
            deps.stageMigrationSource.loadSnapshot(tenant_id, priorDate),
          ]);
          const out = computeStageMigration({
            tenant_id,
            current,
            prior,
            filter,
            asOf: now(),
          });
          res.json(wrapResponse(out, ctx));
        } catch (e) {
          res.status(500).json(
            wrapError(
              { code: 'EWS_500', message: e instanceof Error ? e.message : 'analytics failed', severity: 'HIGH' },
              ctx,
            ),
          );
        }
      },
    );
  }

  // /v1/analytics/pd-distribution — T4.1 4c.
  // 10-bin histogram of latest criticality_score per customer, with
  // optional prior-snapshot delta line + risk-band overlay.
  if (deps.pdDistributionSource) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { computePdDistribution } = require('./analytics/pd_distribution') as
      typeof import('./analytics/pd_distribution');
    app.get(
      '/v1/analytics/pd-distribution',
      requireTenantMw,
      requireRole('dashboard:analytics:read'),
      async (req: Request, res: Response) => {
        const ctx = extractCtx(req, now);
        try {
          const tenant_id = req.tenant!.tenant_id;
          const filter = {
            as_of: typeof req.query.as_of === 'string' ? req.query.as_of : undefined,
            prior_as_of: typeof req.query.prior_as_of === 'string' ? req.query.prior_as_of : undefined,
            segment: typeof req.query.segment === 'string' ? req.query.segment : undefined,
          };
          for (const k of ['as_of', 'prior_as_of'] as const) {
            const v = filter[k];
            if (v && Number.isNaN(Date.parse(v))) {
              return res.status(400).json(
                wrapError(
                  { code: 'EWS_400_invalid_input', message: `${k} must be ISO 8601`, severity: 'MEDIUM' },
                  ctx,
                ),
              );
            }
          }
          const asOfDate = filter.as_of ? new Date(filter.as_of) : now();
          const priorDate = filter.prior_as_of ? new Date(filter.prior_as_of) : null;
          const [current, prior] = await Promise.all([
            deps.pdDistributionSource.loadSnapshot(tenant_id, asOfDate),
            priorDate ? deps.pdDistributionSource.loadSnapshot(tenant_id, priorDate) : Promise.resolve(null),
          ]);
          const out = computePdDistribution({
            tenant_id,
            current,
            prior,
            filter,
            asOf: now(),
          });
          res.json(wrapResponse(out, ctx));
        } catch (e) {
          res.status(500).json(
            wrapError(
              { code: 'EWS_500', message: e instanceof Error ? e.message : 'analytics failed', severity: 'HIGH' },
              ctx,
            ),
          );
        }
      },
    );
  }

  // /v1/analytics/risk-trend — T4.1 4b, EWS.docx §5.5 / §8 sub-dashboard.
  // Weekly bucketed alert counts by severity + average criticality. Same
  // RBAC + envelope shape as the alert-resolution sibling.
  if (deps.riskTrendSource) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { computeRiskTrend } = require('./analytics/risk_trend') as
      typeof import('./analytics/risk_trend');
    app.get(
      '/v1/analytics/risk-trend',
      requireTenantMw,
      requireRole('dashboard:analytics:read'),
      async (req: Request, res: Response) => {
        const ctx = extractCtx(req, now);
        try {
          const tenant_id = req.tenant!.tenant_id;
          const filter = {
            from: typeof req.query.from === 'string' ? req.query.from : undefined,
            to: typeof req.query.to === 'string' ? req.query.to : undefined,
            segment: typeof req.query.segment === 'string' ? req.query.segment : undefined,
          };
          for (const k of ['from', 'to'] as const) {
            const v = filter[k];
            if (v && Number.isNaN(Date.parse(v))) {
              return res.status(400).json(
                wrapError(
                  { code: 'EWS_400_invalid_input', message: `${k} must be ISO 8601`, severity: 'MEDIUM' },
                  ctx,
                ),
              );
            }
          }
          const rows = await deps.riskTrendSource.loadAlerts(tenant_id, filter);
          const out = computeRiskTrend({ tenant_id, rows, filter, asOf: now() });
          res.json(wrapResponse(out, ctx));
        } catch (e) {
          res.status(500).json(
            wrapError(
              { code: 'EWS_500', message: e instanceof Error ? e.message : 'analytics failed', severity: 'HIGH' },
              ctx,
            ),
          );
        }
      },
    );
  }

  // /v1/analytics/alert-resolution — T4.1, EWS.docx §5.5 / §8 sub-dashboard.
  // Funnel + p50/p95 ack/close durations + weekly trend off the
  // app_alerts.alerts row set. Pure resolver; Pg IO via deps.
  if (deps.alertResolutionSource) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { computeAlertResolution } = require('./analytics/alert_resolution') as
      typeof import('./analytics/alert_resolution');
    app.get(
      '/v1/analytics/alert-resolution',
      requireTenantMw,
      requireRole('dashboard:analytics:read'),
      async (req: Request, res: Response) => {
        const ctx = extractCtx(req, now);
        try {
          const tenant_id = req.tenant!.tenant_id;
          const sevRaw = typeof req.query.severity === 'string' ? req.query.severity : undefined;
          const VALID_SEV = ['critical', 'high', 'medium', 'low', 'all'] as const;
          if (sevRaw && !VALID_SEV.includes(sevRaw as (typeof VALID_SEV)[number])) {
            return res.status(400).json(
              wrapError(
                {
                  code: 'EWS_400_invalid_input',
                  message: `severity must be one of ${VALID_SEV.join(',')}`,
                  severity: 'MEDIUM',
                },
                ctx,
              ),
            );
          }
          const filter = {
            from: typeof req.query.from === 'string' ? req.query.from : undefined,
            to: typeof req.query.to === 'string' ? req.query.to : undefined,
            severity: sevRaw as
              | 'critical' | 'high' | 'medium' | 'low' | 'all' | undefined,
          };
          for (const k of ['from', 'to'] as const) {
            const v = filter[k];
            if (v && Number.isNaN(Date.parse(v))) {
              return res.status(400).json(
                wrapError(
                  { code: 'EWS_400_invalid_input', message: `${k} must be ISO 8601`, severity: 'MEDIUM' },
                  ctx,
                ),
              );
            }
          }
          const rows = await deps.alertResolutionSource.loadAlertLifecycle(tenant_id, filter);
          const out = computeAlertResolution({ tenant_id, rows, filter, asOf: now() });
          res.json(wrapResponse(out, ctx));
        } catch (e) {
          res.status(500).json(
            wrapError(
              { code: 'EWS_500', message: e instanceof Error ? e.message : 'analytics failed', severity: 'HIGH' },
              ctx,
            ),
          );
        }
      },
    );
  }

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

  /** GET /v1/alerts/routing/channel-coverage (T6 M8.9) — cross-module
   *  validator: for each routing rule, check whether every channel
   *  in its `channels[]` has a wired M10 transport. Surfaces gaps
   *  like 'in_app' (no out-of-process transport — it's a SPA bell
   *  badge). Per-rule {class, channels[]: {channel, wired},
   *  has_unwired_channel, unwired_channels[]}; envelope adds
   *  fully_wired_count + partially_wired_count + all_wired bool +
   *  distinct_unwired_channels[] union. */
  app.get(
    '/v1/alerts/routing/channel-coverage',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const rules = alertRoutingEngine.listRules(req.tenant!.tenant_id);
      const { checkRoutingChannelCoverage } = require('./routing_channel_coverage') as
        typeof import('./routing_channel_coverage');
      const out = checkRoutingChannelCoverage(rules);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/alerts/routing/matrix (T6 M8.8) — full 4-class routing
   *  matrix snapshot for the tenant + SHA-256 fingerprint of the
   *  canonical encoding. Lets the SPA detect "routing has been
   *  edited since I last viewed" in one round-trip rather than
   *  diffing field-by-field. Per-row source annotation
   *  ('platform_default'|'tenant_override') so the SPA can badge
   *  each row without a separate resolution-chain call. Mounted
   *  BEFORE /:class catch-alls. */
  app.get(
    '/v1/alerts/routing/matrix',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const { listRoutingMatrix } = require('./routing_matrix_snapshot') as
        typeof import('./routing_matrix_snapshot');
      const snapshot = listRoutingMatrix(alertRoutingEngine, req.tenant!.tenant_id);
      return res.json(wrapResponse(snapshot, ctx));
    },
  );

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

  /** POST /v1/alerts/routing/preview (T6 M8.7) — dry-run that
   *  decorates the M8.2 routing decision with computed sla_deadline
   *  + escalation_deadline ISO timestamps and an ordered
   *  notifications_chain[] of {channel, assignee_role, tier} pairs.
   *  Body { severity, at? }. `at` defaults to now(); accepts any
   *  ISO-8601 timestamp. `audit:read` RBAC matches the rest of M8. */
  app.post(
    '/v1/alerts/routing/preview',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { severity?: unknown; at?: unknown };
      if (wrapper.severity === undefined) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'severity is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      let at = now();
      if (typeof wrapper.at === 'string' && wrapper.at.trim()) {
        const d = new Date(wrapper.at);
        if (!Number.isFinite(d.getTime())) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'at must be a valid ISO-8601 timestamp', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        at = d;
      }
      try {
        const { previewAlertRouting } = require('./alert_routing_preview') as
          typeof import('./alert_routing_preview');
        const preview = previewAlertRouting(
          alertRoutingEngine,
          req.tenant!.tenant_id,
          wrapper.severity as SeverityInput,
          at,
        );
        return res.json(wrapResponse(preview, ctx));
      } catch (e) {
        if (e instanceof AlertClassificationError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
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
        if (out.acked_at) {
          routingLedger.markAcked(req.tenant!.tenant_id, alert_id, out.acked_at);
        }
        webhookDispatcher.dispatch(
          'alert.updated',
          {
            tenant_id: req.tenant!.tenant_id,
            alert_id,
            change: 'acknowledged',
            actor: actor_username,
            at: now().toISOString(),
            ack_state: out,
          },
          req.tenant!.tenant_id,
        );
        bus.publish({
          type: 'system',
          level: 'info',
          title: `Alert ${alert_id} acknowledged by ${actor_username}`,
          href: `/alerts`,
          meta: { alert_id, change: 'acknowledged', actor: actor_username },
        });
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
        webhookDispatcher.dispatch(
          'alert.updated',
          {
            tenant_id: req.tenant!.tenant_id,
            alert_id,
            change: 'unacknowledged',
            actor: actor_username,
            at: now().toISOString(),
            ack_state: out,
          },
          req.tenant!.tenant_id,
        );
        bus.publish({
          type: 'system',
          level: 'warning',
          title: `Alert ${alert_id} re-opened by ${actor_username}`,
          href: `/alerts`,
          meta: { alert_id, change: 'unacknowledged', actor: actor_username },
        });
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

  /** GET /v1/alerts/routing/analytics?window=N (T6 M8.6) — aggregate
   *  routing performance over the recent window: class mix, channel
   *  mix, ack rate, time-to-ack percentiles, SLA breach count, escalation
   *  due count. Pulls from the routing ledger populated at /v1/alerts/ingest. */
  app.get(
    '/v1/alerts/routing/analytics',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const windowRaw = req.query.window as string | undefined;
      const window =
        windowRaw === undefined ? ROUTING_ANALYTICS_DEFAULT_WINDOW : Number(windowRaw);
      if (
        !Number.isInteger(window) ||
        window < 1 ||
        window > ROUTING_ANALYTICS_MAX_WINDOW
      ) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: `window must be 1..${ROUTING_ANALYTICS_MAX_WINDOW}`,
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const records = routingLedger.list(req.tenant!.tenant_id, window);
      const analytics = aggregateRoutingAnalytics(records, now());
      return res.json(wrapResponse({ window, analytics }, ctx));
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

  /** POST /v1/alerts/ingest (T6 M8.5) — ingest a single alert and
   *  auto-ack it if a tenant rule matches. body
   *  { alert_id, bil_class, source_system?, tags?, target_username? }
   *  → returns the resolved policy decision + live ack state.
   *
   *  M10.8 extension: when `target_username` is provided and the named
   *  user is currently inside their M10.7 quiet-hours window, and the
   *  M8.4 rule didn't already auto-ack, the alert is auto-muted with
   *  reason "quiet hours". RED severity bypasses (operator pages on
   *  critical even at night). The decision is reported under the
   *  `quiet_hours_mute` field on the response. */
  app.post(
    '/v1/alerts/ingest',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const rules = autoAckRuleStore.list(req.tenant!.tenant_id);
      try {
        const baseResult = ingestAlertWithAutoAck(
          rules,
          alertAckStore,
          req.tenant!.tenant_id,
          inner,
          now(),
        );
        // M10.8 — quiet-hours auto-mute pass.
        const innerObj =
          inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {};
        const target_username =
          typeof innerObj.target_username === 'string' && innerObj.target_username.trim()
            ? (innerObj.target_username as string).trim()
            : undefined;
        const quiet_hours_mute = evaluateQuietHoursMute({
          prefStore: notificationPreferenceStore,
          ackStore: alertAckStore,
          muteStore: quietHoursMuteEventStore,
          tenant_id: req.tenant!.tenant_id,
          alert_id: baseResult.alert_id,
          bil_class: baseResult.bil_class,
          target_username,
          already_auto_acked: baseResult.auto_acked,
          now: now(),
        });
        // If quiet-hours mute applied, prefer its ack_state (newer
        // transition); otherwise keep the M8.4 result.
        const finalAckState = quiet_hours_mute.applied
          ? quiet_hours_mute.ack_state
          : baseResult.ack_state;
        // T6 M8.6 — snapshot the routing decision for analytics roll-up.
        const { rule: routingRule } = alertRoutingEngine.getRule(
          req.tenant!.tenant_id,
          baseResult.bil_class,
        );
        routingLedger.record({
          alert_id: baseResult.alert_id,
          tenant_id: req.tenant!.tenant_id,
          created_at: baseResult.ingested_at,
          severity_in: baseResult.bil_class,
          class: baseResult.bil_class,
          channels: routingRule.channels,
          sla_hours: routingRule.sla_hours,
          escalate_after_hours: routingRule.escalate_after_hours,
          monitor_only: routingRule.monitor_only,
          acked_at: finalAckState.acked_at,
        });
        return res.json(
          wrapResponse({ ...baseResult, ack_state: finalAckState, quiet_hours_mute }, ctx),
        );
      } catch (e) {
        if (e instanceof AutoAckError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/alerts/quiet-hours-muted/me?since=ISO&limit=N (T6 M10.8) —
   *  list alerts auto-muted for the calling user during their quiet
   *  hours, newest-first. Caller is identified by X-APEX-USER. */
  app.get(
    '/v1/alerts/quiet-hours-muted/me',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const username =
        typeof req.headers['x-apex-user'] === 'string'
          ? (req.headers['x-apex-user'] as string).trim()
          : '';
      if (!username) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_missing_user', message: 'X-APEX-USER header required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const sinceRaw = req.query.since;
      let since: Date | undefined;
      if (typeof sinceRaw === 'string' && sinceRaw.trim()) {
        const d = new Date(sinceRaw);
        if (!Number.isFinite(d.getTime())) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_since', message: 'since must be a valid ISO timestamp', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        since = d;
      }
      const limitRaw = req.query.limit;
      let limit: number | undefined;
      if (typeof limitRaw === 'string' && limitRaw.trim()) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n <= 0 || n > 200) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_limit', message: 'limit must be 1-200', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        limit = n;
      }
      const items = quietHoursMuteEventStore.listForUser(
        req.tenant!.tenant_id,
        username,
        since,
        limit,
      );
      const total = quietHoursMuteEventStore.countForUser(req.tenant!.tenant_id, username);
      return res.json(wrapResponse({ items, total, returned: items.length }, ctx));
    },
  );

  /** GET /v1/alerts/quiet-hours-muted/analytics?since=ISO (T6 M10.9)
   *  — tenant-wide rollup over the M10.8 quiet-hours mute event log:
   *  sample size, distinct users, class mix (RED never appears since
   *  M10.8 bypasses it by design), per-day buckets oldest-first, top
   *  10 muted users (sorted by count desc, tie-broken by username asc).
   *  audit:read RBAC; mounted before any /:username wildcard. */
  app.get(
    '/v1/alerts/quiet-hours-muted/analytics',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const sinceRaw = req.query.since;
      let since: Date | undefined;
      if (typeof sinceRaw === 'string' && sinceRaw.trim()) {
        const d = new Date(sinceRaw);
        if (!Number.isFinite(d.getTime())) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'since must be a valid ISO-8601 timestamp', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        since = d;
      }
      const events = quietHoursMuteEventStore.listAllForTenant(
        req.tenant!.tenant_id,
        since,
      );
      const { summarizeQuietHoursMutes } = require('./alert_quiet_hours_mute_analytics') as
        typeof import('./alert_quiet_hours_mute_analytics');
      const analytics = summarizeQuietHoursMutes(events);
      return res.json(wrapResponse({ analytics }, ctx));
    },
  );

  /** DELETE /v1/alerts/quiet-hours-muted/me (T6 M10.8) — clear the
   *  caller's quiet-hours-mute audit history (e.g. after the user
   *  reviewed it). Returns the number of cleared rows. */
  app.delete(
    '/v1/alerts/quiet-hours-muted/me',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const username =
        typeof req.headers['x-apex-user'] === 'string'
          ? (req.headers['x-apex-user'] as string).trim()
          : '';
      if (!username) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_missing_user', message: 'X-APEX-USER header required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const cleared = quietHoursMuteEventStore.clearForUser(
        req.tenant!.tenant_id,
        username,
      );
      return res.json(wrapResponse({ cleared }, ctx));
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
          // T2.12 — also fan out to the in-process notifications bus so SSE
          // subscribers (the SPA bell + the live AlertListPage banner) get
          // the same event without each subscriber needing its own webhook.
          bus.publish({
            type: 'alert.created',
            level: 'warning',
            title: `New high-risk alert · ${score.customer_id}`,
            body: `PD ${(score.pd * 100).toFixed(1)}% — ${score.top_reasons?.[0]?.feature ?? 'evaluator'}`,
            href: `/alerts?customer=${encodeURIComponent(score.customer_id ?? '')}`,
            meta: {
              customer_id: score.customer_id,
              pd: score.pd,
              level: score.level,
              tenant_id: req.tenant?.tenant_id,
              evaluated_at: now().toISOString(),
            },
          });
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

  // ── Copilot v2 — hardened route + EWS intents (Copilot-2) ────────────
  //
  // Adds: role gate (copilot:use), per-user rate limit (30/hour),
  // PII masking before persistence + LLM, audit log per query,
  // optional conversation persistence (auto-create on first turn),
  // 4 EWS-specific intents (why_flagged / summarize_alert /
  // suggest_case_steps / explain_kri).
  //
  // Legacy /v1/copilot/chat above is untouched — additive only.

  /** POST /v1/copilot/v2/chat
   *  body { message, conversation_id?, context?: { page, entity, role } }
   *  Returns { conversation_id, reply, suggestions, used_intent,
   *            masked_pii_kinds, used_llm, quota }. */
  app.post(
    '/v1/copilot/v2/chat',
    requireTenantMw,
    requireRole('copilot:use'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const tenant_id = req.tenant!.tenant_id;
      const user_id =
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() ||
        getRole(req) ||
        'anonymous';

      // Rate limit
      const rate = checkAndConsume(defaultRateState, tenant_id, user_id, now());
      if (!rate.ok) {
        res.set('Retry-After', String(
          Math.max(1, Math.ceil((new Date(rate.reset_at).getTime() - now().getTime()) / 1000)),
        ));
        return res.status(429).json(
          wrapError(
            {
              code: 'EWS_429_rate_limited',
              message: `${COPILOT_DEFAULT_LIMIT} queries/hour exceeded. Try again at ${rate.reset_at}.`,
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
      const w = (inner ?? {}) as {
        message?: unknown;
        conversation_id?: unknown;
        context?: { page?: unknown; entity?: unknown; role?: unknown };
      };
      if (typeof w.message !== 'string' || !w.message.trim()) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'message is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (w.message.length > 2000) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'message exceeds 2000 chars', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }

      // PII mask BEFORE persistence + LLM
      const { masked: maskedMessage, hits: piiKinds } = maskPII(w.message);

      // Conversation: auto-create on first turn or honour client-supplied id
      let conv = null as ReturnType<CopilotAuditStore['getConversation']>;
      if (typeof w.conversation_id === 'string' && w.conversation_id.trim()) {
        conv = copilotAuditStore.getConversation(tenant_id, w.conversation_id.trim());
        if (!conv) {
          return res.status(404).json(
            wrapError(
              {
                code: 'EWS_404_unknown_conversation',
                message: `conversation ${w.conversation_id} not found`,
                severity: 'LOW',
              },
              ctx,
            ),
          );
        }
        if (conv.user_id !== user_id) {
          return res.status(403).json(
            wrapError(
              {
                code: 'EWS_403_conversation_owner_mismatch',
                message: 'conversation belongs to a different user',
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
      }
      const chatCtx = (w.context ?? {}) as ChatRequest['context'];
      const role = getRole(req) ?? undefined;
      if (!conv) {
        const ent = chatCtx?.entity;
        conv = copilotAuditStore.startConversation({
          tenant_id,
          user_id,
          initial_page: typeof chatCtx?.page === 'string' ? chatCtx.page : undefined,
          initial_entity_id:
            ent && typeof ent === 'object' && 'id' in ent ? String(ent.id) : undefined,
          now: now(),
        });
      }

      // Persist user turn (masked)
      copilotAuditStore.appendMessage({
        tenant_id,
        conversation_id: conv.conversation_id,
        role: 'user',
        text: maskedMessage,
        now: now(),
      });

      // Try EWS intents first; fall through to legacy brain if none match.
      const ewsHit = tryHandleEwsIntent(maskedMessage, {
        ...(chatCtx ?? {}),
        role: chatCtx?.role ?? role,
      });
      let reply: string;
      let suggestions: string[];
      let intent: string;
      let used_llm = false;
      if (ewsHit) {
        reply = ewsHit.reply;
        suggestions = ewsHit.suggestions;
        intent = ewsHit.intent;
      } else {
        const brain = await copilotRespond({
          message: maskedMessage,
          context: { ...(chatCtx ?? {}), role: chatCtx?.role ?? role },
        });
        reply = brain.reply;
        suggestions = brain.suggestions;
        intent = brain.used_context.matched_intent;
        used_llm = intent === 'llm';
      }

      // Persist assistant turn
      copilotAuditStore.appendMessage({
        tenant_id,
        conversation_id: conv.conversation_id,
        role: 'assistant',
        text: reply,
        matched_intent: intent,
        now: now(),
      });

      // Audit
      copilotAuditStore.recordAudit({
        tenant_id,
        user_id,
        conversation_id: conv.conversation_id,
        intent,
        page: typeof chatCtx?.page === 'string' ? chatCtx.page : null,
        entity_type:
          chatCtx?.entity && typeof chatCtx.entity === 'object' && 'type' in chatCtx.entity
            ? String(chatCtx.entity.type)
            : null,
        entity_id:
          chatCtx?.entity && typeof chatCtx.entity === 'object' && 'id' in chatCtx.entity
            ? String(chatCtx.entity.id)
            : null,
        message_length: w.message.length,
        masked_pii_kinds: piiKinds,
        used_llm,
        now: now(),
      });

      return res.json(
        wrapResponse(
          {
            conversation_id: conv.conversation_id,
            reply,
            suggestions,
            used_intent: intent,
            masked_pii_kinds: piiKinds,
            used_llm,
            quota: { remaining: rate.remaining, reset_at: rate.reset_at },
          },
          ctx,
        ),
      );
    },
  );

  /** GET /v1/copilot/v2/conversations — list current user's conversations. */
  app.get(
    '/v1/copilot/v2/conversations',
    requireTenantMw,
    requireRole('copilot:use'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const user_id =
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() ||
        getRole(req) ||
        'anonymous';
      const items = copilotAuditStore.listConversations(req.tenant!.tenant_id, user_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/copilot/v2/conversations/:conversation_id
   *  Returns conversation header + messages oldest-first. */
  app.get(
    '/v1/copilot/v2/conversations/:conversation_id',
    requireTenantMw,
    requireRole('copilot:use'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.conversation_id ?? '';
      const conv = copilotAuditStore.getConversation(req.tenant!.tenant_id, id);
      if (!conv) {
        return res.status(404).json(
          wrapError(
            {
              code: 'EWS_404_unknown_conversation',
              message: `conversation ${id} not found`,
              severity: 'LOW',
            },
            ctx,
          ),
        );
      }
      const user_id =
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() ||
        getRole(req) ||
        'anonymous';
      if (conv.user_id !== user_id) {
        return res.status(403).json(
          wrapError(
            {
              code: 'EWS_403_conversation_owner_mismatch',
              message: 'conversation belongs to a different user',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const messages = copilotAuditStore.listMessages(req.tenant!.tenant_id, id);
      return res.json(wrapResponse({ ...conv, messages }, ctx));
    },
  );

  /** GET /v1/copilot/v2/quota — current rate-limit window state. */
  app.get(
    '/v1/copilot/v2/quota',
    requireTenantMw,
    requireRole('copilot:use'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const user_id =
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() ||
        getRole(req) ||
        'anonymous';
      const q = inspectRate(defaultRateState, req.tenant!.tenant_id, user_id, now());
      return res.json(
        wrapResponse(
          { limit: COPILOT_DEFAULT_LIMIT, used: q.used, remaining: q.remaining, reset_at: q.reset_at },
          ctx,
        ),
      );
    },
  );

  /** GET /v1/copilot/v2/audit — admin-only compliance review. */
  app.get(
    '/v1/copilot/v2/audit',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const limit = q.limit ? Number(q.limit) : 100;
      const filter: { user_id?: string; since?: string; until?: string } = {};
      if (typeof q.user_id === 'string' && q.user_id) filter.user_id = q.user_id;
      if (typeof q.since === 'string' && q.since) filter.since = q.since;
      if (typeof q.until === 'string' && q.until) filter.until = q.until;
      try {
        const items = copilotAuditStore.listAudit(req.tenant!.tenant_id, filter, limit);
        return res.json(wrapResponse({ items, total: items.length }, ctx));
      } catch (e) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: e instanceof Error ? e.message : String(e),
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
    },
  );

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

  // ── Model performance ledger (T6 M7.5) ──────────────────────────────
  //
  // Per-tenant per-model time-series of quality metrics (precision,
  // recall, AUC, drift_score, calibration_err). Append-only with
  // FIFO retention at 200 entries/model.
  //
  // Route ordering: literal `/performance/summary` declared BEFORE
  // `/performance` so the param doesn't shadow.

  /** GET /v1/ai/models/:model_id/performance/trend?metric=auc
   *  (T6 M7.8) — linear-regression slope over a single metric's
   *  history. Returns null trend when the model has < 2 entries
   *  for the requested metric. Sign convention is neutral: positive
   *  slope = value increasing; SPA maps to improving/declining per
   *  metric polarity. `?since` / `?until` reuse the M7.5 window
   *  filter. Mounted BEFORE /performance/outliers (and the other
   *  /performance/* routes) so the literal /trend segment isn't
   *  captured by a wildcard. */
  app.get(
    '/v1/ai/models/:model_id/performance/trend',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.model_id ?? '';
      const q = req.query;
      const metric = q.metric;
      if (typeof metric !== 'string' || !isPerformanceMetric(metric)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: `metric must be one of ${PERFORMANCE_METRICS.join(', ')}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const filter: PerformanceFilter = { metric };
      if (typeof q.since === 'string' && q.since) filter.since = q.since;
      if (typeof q.until === 'string' && q.until) filter.until = q.until;
      try {
        const entries = modelPerformanceStore.list(req.tenant!.tenant_id, id, filter);
        const { computeMetricTrend } = require('./model_performance_trend') as
          typeof import('./model_performance_trend');
        const trend = computeMetricTrend(entries, metric);
        return res.json(wrapResponse({ tenant_id: req.tenant!.tenant_id, model_id: id, trend }, ctx));
      } catch (e) {
        if (e instanceof ModelPerformanceError && e.code === 'unknown_model') {
          return res.status(404).json(
            wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/ai/models/:model_id/performance/outliers?z=2&metric=…
   *  (T6 M7.7) — z-score-based outlier detection over the M7.5 ledger.
   *  For each metric: sample mean + sample std-dev (Bessel n-1) +
   *  per-entry z-score; flags entries where |z| > z_threshold.
   *  Default z=2 (≈ 95% interval). `?metric=` narrows to a single
   *  metric. `?since` / `?until` reuse the M7.5 filter shape. Mounted
   *  BEFORE the /summary.txt + /summary routes so the literal
   *  /outliers segment isn't captured. customers:read_risk_profile. */
  app.get(
    '/v1/ai/models/:model_id/performance/outliers',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.model_id ?? '';
      const q = req.query;
      const zRaw = q.z as string | undefined;
      const z = zRaw === undefined ? undefined : Number(zRaw);
      if (z !== undefined && !Number.isFinite(z)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'z must be a finite number', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const filter: PerformanceFilter = {};
      if (typeof q.metric === 'string' && q.metric) {
        if (!isPerformanceMetric(q.metric)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: `metric must be one of ${PERFORMANCE_METRICS.join(', ')}`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filter.metric = q.metric;
      }
      if (typeof q.since === 'string' && q.since) filter.since = q.since;
      if (typeof q.until === 'string' && q.until) filter.until = q.until;
      try {
        const entries = modelPerformanceStore.list(req.tenant!.tenant_id, id, filter);
        const { detectPerformanceOutliers, DEFAULT_Z_THRESHOLD } = require('./model_performance_outliers') as
          typeof import('./model_performance_outliers');
        const out = detectPerformanceOutliers(entries, z ?? DEFAULT_Z_THRESHOLD);
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof ModelPerformanceError && e.code === 'unknown_model') {
          return res.status(404).json(
            wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/ai/models/:model_id/performance/summary.txt (T6 M7.6)
   *  — printable plain-text summary suitable for browser print-to-PDF.
   *  Same `?since`/`?until` filter as M7.5 /summary. Returns text/plain
   *  (NOT the T4.24 envelope). Mounted BEFORE the M7.5 /summary route
   *  so the literal ".txt" suffix isn't swallowed by the wildcard. */
  app.get(
    '/v1/ai/models/:model_id/performance/summary.txt',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.model_id ?? '';
      const q = req.query;
      const filter: PerformanceFilter = {};
      const range: { since?: string; until?: string } = {};
      if (typeof q.since === 'string' && q.since) {
        filter.since = q.since;
        range.since = q.since;
      }
      if (typeof q.until === 'string' && q.until) {
        filter.until = q.until;
        range.until = q.until;
      }
      const generated_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const entries = modelPerformanceStore.list(req.tenant!.tenant_id, id, filter);
        const summary = summarizePerformance(req.tenant!.tenant_id, id, entries);
        const text = renderPerformanceSummary(summary, {
          generated_at: now().toISOString(),
          generated_by,
          range: range.since || range.until ? range : undefined,
        });
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.set(
          'Content-Disposition',
          `inline; filename="${id}.performance.summary.txt"`,
        );
        void ctx;
        return res.status(200).send(text);
      } catch (e) {
        if (e instanceof ModelPerformanceError && e.code === 'unknown_model') {
          return res.status(404).json(
            wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/ai/models/:model_id/performance/summary — aggregate
   *  per-metric latest + mean/p50/p95 over the queried window
   *  (?since=ISO&until=ISO). */
  app.get(
    '/v1/ai/models/:model_id/performance/summary',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.model_id ?? '';
      const q = req.query;
      const filter: PerformanceFilter = {};
      if (typeof q.since === 'string' && q.since) filter.since = q.since;
      if (typeof q.until === 'string' && q.until) filter.until = q.until;
      try {
        const entries = modelPerformanceStore.list(req.tenant!.tenant_id, id, filter);
        const summary = summarizePerformance(req.tenant!.tenant_id, id, entries);
        return res.json(wrapResponse(summary, ctx));
      } catch (e) {
        if (e instanceof ModelPerformanceError && e.code === 'unknown_model') {
          return res.status(404).json(
            wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/ai/models/:model_id/performance?metric=&since=&until=
   *  — list raw entries, newest-first by recorded_at. */
  app.get(
    '/v1/ai/models/:model_id/performance',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.model_id ?? '';
      const q = req.query;
      const filter: PerformanceFilter = {};
      if (typeof q.metric === 'string' && q.metric) {
        if (!isPerformanceMetric(q.metric)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: `unknown metric: ${q.metric}`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filter.metric = q.metric as PerformanceMetric;
      }
      if (typeof q.since === 'string' && q.since) filter.since = q.since;
      if (typeof q.until === 'string' && q.until) filter.until = q.until;
      try {
        const items = modelPerformanceStore
          .list(req.tenant!.tenant_id, id, filter)
          .sort((a, b) =>
            a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : 0,
          );
        return res.json(wrapResponse({ items, total: items.length, model_id: id }, ctx));
      } catch (e) {
        if (e instanceof ModelPerformanceError && e.code === 'unknown_model') {
          return res.status(404).json(
            wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/ai/models/:model_id/performance — record a metric
   *  observation. body { metric, value, sample_size, notes? }. */
  app.post(
    '/v1/ai/models/:model_id/performance',
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
        const entry = modelPerformanceStore.record(
          req.tenant!.tenant_id,
          id,
          inner,
          now(),
        );
        return res.status(201).json(wrapResponse(entry, ctx));
      } catch (e) {
        if (e instanceof ModelPerformanceError) {
          if (e.code === 'unknown_model') {
            return res.status(404).json(
              wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
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

  // ── T5.1 — Auto-promotion gate ────────────────────────────────────────
  //
  // Pulls the latest performance summary for the candidate model + runs
  // the gate against the requested target_status. The /evaluate endpoint
  // is read-only — returns the decision + per-check breakdown so the
  // SPA can show a green/red dashboard. The /auto-promote endpoint
  // additionally creates a promotion request when the gate decides
  // 'promote'; production transitions still require human approval.
  /** POST /v1/ai/models/:model_id/promotion-gate/evaluate
   *  body: { target_status: ModelStatus, thresholds?: GateThresholds, since?, until? } */
  app.post(
    '/v1/ai/models/:model_id/promotion-gate/evaluate',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.model_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const b = (inner ?? {}) as {
        target_status?: ModelStatus;
        thresholds?: import('./ai_auto_promotion_gate').GateThresholds;
        since?: string;
        until?: string;
      };
      const VALID_TARGETS: ModelStatus[] = ['staging', 'shadow', 'production'];
      if (!b.target_status || !VALID_TARGETS.includes(b.target_status)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: `target_status must be one of ${VALID_TARGETS.join(',')}`,
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const m = aiModelRegistry.get(id);
      if (!m) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_not_found', message: `model ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      try {
        const filter: PerformanceFilter = {};
        if (typeof b.since === 'string' && b.since) filter.since = b.since;
        if (typeof b.until === 'string' && b.until) filter.until = b.until;
        const entries = modelPerformanceStore.list(req.tenant!.tenant_id, id, filter);
        const summary = summarizePerformance(req.tenant!.tenant_id, id, entries);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const gate = require('./ai_auto_promotion_gate') as
          typeof import('./ai_auto_promotion_gate');
        const result = gate.evaluatePromotionGate(
          {
            summary,
            target_status: b.target_status,
            thresholds: b.thresholds,
          },
          now(),
        );
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'gate failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** POST /v1/ai/models/:model_id/promotion-gate/auto-promote
   *  body: { from_status, target_status, thresholds?, request_notes? }
   *  - Runs the gate. If decision=='promote', creates a promotion request
   *    and immediately approves it (system actor). Production targets get
   *    a `requires_approval` decision instead — caller routes to the
   *    normal approve/reject UI.
   *  - Caller must already have the rights to manage promotions
   *    (audit:read covers admin + supervisor). */
  app.post(
    '/v1/ai/models/:model_id/promotion-gate/auto-promote',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.model_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const b = (inner ?? {}) as {
        from_status?: ModelStatus;
        target_status?: ModelStatus;
        thresholds?: import('./ai_auto_promotion_gate').GateThresholds;
        request_notes?: string;
      };
      const VALID_TARGETS: ModelStatus[] = ['staging', 'shadow', 'production'];
      if (!b.from_status || !b.target_status || !VALID_TARGETS.includes(b.target_status)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: `from_status + target_status (in ${VALID_TARGETS.join(',')}) required`,
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const m = aiModelRegistry.get(id);
      if (!m) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_not_found', message: `model ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      try {
        const entries = modelPerformanceStore.list(req.tenant!.tenant_id, id, {});
        const summary = summarizePerformance(req.tenant!.tenant_id, id, entries);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const gate = require('./ai_auto_promotion_gate') as
          typeof import('./ai_auto_promotion_gate');
        const result = gate.evaluatePromotionGate(
          {
            summary,
            target_status: b.target_status,
            thresholds: b.thresholds,
          },
          now(),
        );
        if (result.decision !== 'promote') {
          return res.status(200).json(
            wrapResponse(
              {
                gate: result,
                promotion_request: null,
                message:
                  result.decision === 'requires_approval'
                    ? 'metrics pass but production transitions require human approval'
                    : 'gate held — see failures for the metric(s) below threshold',
              },
              ctx,
            ),
          );
        }
        // Auto-promote path: create a request + immediately approve as `system`.
        const request = promotionEngine.requestPromotion(
          req.tenant!.tenant_id,
          {
            model_id: id,
            from_status: b.from_status,
            to_status: b.target_status,
            request_notes:
              (b.request_notes && b.request_notes.trim()) ||
              `Auto-promoted by gate (T5.1) — AUC ${summary.metrics.auc?.latest_value ?? '?'}, drift ${summary.metrics.drift_score?.latest_value ?? '?'}`,
          },
          'system:auto-promotion-gate',
          now(),
        );
        const approved = promotionEngine.approve(
          req.tenant!.tenant_id,
          request.request_id,
          'system:auto-promotion-gate',
          `gate decision=promote · ${result.failures.length === 0 ? 'all checks passed' : ''}`,
          now(),
        );
        return res.status(201).json(
          wrapResponse(
            {
              gate: result,
              promotion_request: approved,
            },
            ctx,
            { code: 'EWS_201', message: 'Promoted by gate' },
          ),
        );
      } catch (e) {
        const errFn = (e as { code?: string }).code === 'invalid_transition'
          ? mapPromotionError(e, ctx)
          : null;
        if (errFn) return res.status(errFn.status).json(errFn.body);
        return res.status(500).json(
          wrapError(
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'auto-promote failed', severity: 'HIGH' },
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

  /** GET /v1/scenarios/library/custom/:preset_id/versions (T6 M16.10)
   *  — version snapshots in oldest-first order. Cap 20 per preset. */
  app.get(
    '/v1/scenarios/library/custom/:preset_id/versions',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.preset_id ?? '';
      // Confirm the preset exists in this tenant first — otherwise
      // an empty versions list is misleading.
      const live = customPresetStore.get(req.tenant!.tenant_id, id);
      if (!live) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_preset', message: `custom preset ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const items = customPresetStore.listVersions(req.tenant!.tenant_id, id);
      return res.json(
        wrapResponse({ items, total: items.length, preset_id: id }, ctx),
      );
    },
  );

  /** GET /v1/scenarios/library/custom/:preset_id/versions/diff?from=N&to=M
   *  (T6 M16.11) — field-by-field diff between two snapshots. Mirrors
   *  RP-1's rule version diff shape so the SPA can reuse the diff
   *  viewer. Returns 404 when either version has been evicted by the
   *  M16.10 FIFO cap (default 20). */
  app.get(
    '/v1/scenarios/library/custom/:preset_id/versions/diff',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.preset_id ?? '';
      const fromRaw = req.query.from;
      const toRaw = req.query.to;
      const from_version = Number(fromRaw);
      const to_version = Number(toRaw);
      if (
        typeof fromRaw !== 'string' ||
        typeof toRaw !== 'string' ||
        !Number.isInteger(from_version) ||
        !Number.isInteger(to_version) ||
        from_version < 1 ||
        to_version < 1
      ) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'from and to must be positive integers', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const live = customPresetStore.get(req.tenant!.tenant_id, id);
      if (!live) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_preset', message: `custom preset ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      try {
        const out = diffPresetVersionsByNumber(
          customPresetStore,
          req.tenant!.tenant_id,
          id,
          from_version,
          to_version,
        );
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof CustomPresetError) {
          if (e.code === 'unknown_version') {
            return res.status(404).json(
              wrapError(
                { code: 'EWS_404_unknown_version', message: e.message, severity: 'LOW' },
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

  /** POST /v1/scenarios/library/custom/:preset_id/restore/:version
   *  — apply a prior snapshot as the live state. Records a new
   *  scenario.update audit event with `restored_from_version`. */
  app.post(
    '/v1/scenarios/library/custom/:preset_id/restore/:version',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.preset_id ?? '';
      const versionRaw = req.params.version ?? '';
      const restored_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const version = Number(versionRaw);
      if (!Number.isInteger(version) || version < 1) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'version must be a positive integer', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const previous = customPresetStore.get(req.tenant!.tenant_id, id);
      try {
        const out = customPresetStore.restoreVersion(
          req.tenant!.tenant_id,
          id,
          version,
          restored_by,
          now(),
        );
        // Audit event — restored is a kind of update
        try {
          auditTrailStore.record(
            req.tenant!.tenant_id,
            {
              actor_username: restored_by,
              actor_role: 'admin',
              action: 'scenario.update',
              resource_type: 'scenario',
              resource_id: id,
              outcome: 'success',
              severity: 'info',
              metadata: {
                previous_name: previous?.name ?? null,
                new_name: out.preset.name,
                shocks_before: previous?.shocks ?? null,
                shocks_after: out.preset.shocks,
                restored_from_version: out.restored_from_version,
              },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof CustomPresetError) {
          if (e.code === 'unknown_preset' || e.code === 'unknown_version') {
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
        throw e;
      }
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

  /** POST /v1/scenarios/library/custom/export-bundle (T6 M16.13) —
   *  versioned JSON envelope for migrating N custom scenario presets
   *  between tenants. Body { preset_ids: string[] } (cap 30). Returns
   *  the bundle with deep-copied items stripped of live identity
   *  (re-minted on import). Mirrors M5.11 / M11.9 shape. */
  app.post(
    '/v1/scenarios/library/custom/export-bundle',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { preset_ids?: unknown };
      const exported_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const { exportScenarioBundle, ScenarioBundleError } = require('./scenario_bundle') as
          typeof import('./scenario_bundle');
        const bundle = exportScenarioBundle(customPresetStore, {
          tenant_id: req.tenant!.tenant_id,
          preset_ids: Array.isArray(wrapper.preset_ids)
            ? (wrapper.preset_ids as unknown[]).map((x) => String(x))
            : [],
          exported_by,
          now: now(),
        });
        return res.json(wrapResponse(bundle, ctx));
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        void ScenarioBundleError;
      } catch (e) {
        const { ScenarioBundleError } = require('./scenario_bundle') as
          typeof import('./scenario_bundle');
        if (e instanceof ScenarioBundleError) {
          if (e.code === 'unknown_preset') {
            return res.status(404).json(
              wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
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

  /** POST /v1/scenarios/library/custom/import-bundle (T6 M16.13) —
   *  replay an export-bundle into the caller's tenant. Body
   *  { bundle, name_prefix? }. Per-row outcomes (created / skipped
   *  already_exists / error). */
  app.post(
    '/v1/scenarios/library/custom/import-bundle',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { bundle?: unknown; name_prefix?: unknown };
      const imported_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const { importScenarioBundle } = require('./scenario_bundle') as
          typeof import('./scenario_bundle');
        const result = importScenarioBundle(customPresetStore, {
          target_tenant_id: req.tenant!.tenant_id,
          bundle: wrapper.bundle,
          imported_by,
          name_prefix:
            typeof wrapper.name_prefix === 'string' ? wrapper.name_prefix : undefined,
          now: now(),
        });
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        const { ScenarioBundleError } = require('./scenario_bundle') as
          typeof import('./scenario_bundle');
        if (e instanceof ScenarioBundleError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** POST /v1/scenarios/library/custom/bulk-delete (T6 M16.12) — delete
   *  up to 10 custom presets in one call. Per-row outcomes so a partial
   *  success (some ids unknown / cross-tenant) surfaces each row's
   *  result. Writes a `scenario.delete` audit event per successful delete.
   *  MUST be declared BEFORE `/:preset_id` so the literal segment isn't
   *  captured as a preset_id. */
  app.post(
    '/v1/scenarios/library/custom/bulk-delete',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const deleted_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { preset_ids?: unknown };
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
      const tenantId = req.tenant!.tenant_id;
      const deleted: Array<{ preset_id: string; name: string }> = [];
      const skipped: Array<{ preset_id: string; reason: string }> = [];

      for (const pid of wrapper.preset_ids) {
        if (typeof pid !== 'string' || !pid.trim()) {
          skipped.push({ preset_id: String(pid), reason: 'invalid_id' });
          continue;
        }
        const previous = customPresetStore.get(tenantId, pid);
        if (!previous) {
          skipped.push({ preset_id: pid, reason: 'unknown_preset' });
          continue;
        }
        const removed = customPresetStore.delete(tenantId, pid);
        if (!removed) {
          // Defensive — `get` returned truthy so `delete` should succeed,
          // but covers a race where another caller deleted between calls.
          skipped.push({ preset_id: pid, reason: 'unknown_preset' });
          continue;
        }
        deleted.push({ preset_id: pid, name: previous.name });
        // Best-effort audit per successful delete (mirrors the
        // single-delete route's audit shape with bulk:true marker).
        try {
          auditTrailStore.record(
            tenantId,
            {
              actor_username: deleted_by,
              actor_role: 'admin',
              action: 'scenario.delete',
              resource_type: 'scenario',
              resource_id: pid,
              outcome: 'success',
              severity: 'info',
              metadata: {
                previous_name: previous.name,
                previous_severity: previous.severity,
                bulk: true,
              },
            },
            now(),
          );
        } catch {
          // swallow
        }
      }

      return res.json(
        wrapResponse(
          {
            total: wrapper.preset_ids.length,
            deleted_count: deleted.length,
            skipped_count: skipped.length,
            deleted,
            skipped,
          },
          ctx,
        ),
      );
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

  /** GET /v1/scenarios/library/:preset_id/clones-in-tenant (T6 M16.14)
   *  — back-reference query: for this library scenario preset, list
   *  every custom preset in the calling tenant that was cloned from
   *  it (per the M16.8/M16.9 `cloned_from` audit metadata). Mirror
   *  of M5.13 (rule template clone history). Mounted BEFORE `/:id`
   *  so the literal `/clones-in-tenant` segment isn't captured.
   *  404 EWS_404_unknown_preset when the library id doesn't exist. */
  app.get(
    '/v1/scenarios/library/:preset_id/clones-in-tenant',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.preset_id ?? '';
      const preset = getScenarioPreset(id);
      if (!preset) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_preset', message: `unknown preset: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const page = auditTrailStore.list(req.tenant!.tenant_id, { page_size: 100000 });
      const { analyseScenarioCloneHistory } = require('./scenario_clone_analysis') as
        typeof import('./scenario_clone_analysis');
      const out = analyseScenarioCloneHistory(page.items, id);
      return res.json(wrapResponse(out, ctx));
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
      type?: import('./notifications/types').NotificationType;
      meta?: Record<string, unknown>;
    };
    const errs: string[] = [];
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      errs.push('title is required');
    }
    const validLevels: NotificationLevel[] = ['info', 'success', 'warning', 'danger'];
    if (!body.level || !validLevels.includes(body.level)) {
      errs.push(`level must be one of ${validLevels.join(',')}`);
    }
    const validTypes = ['alert.created', 'case.assigned', 'case.closed', 'scenario.run', 'system'];
    if (body.type && !validTypes.includes(body.type)) {
      errs.push(`type must be one of ${validTypes.join(',')} or omitted`);
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
      type: body.type,
      meta: body.meta,
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

  /** GET /v1/notifications/templates/catalog (T6 M10.11) — unified
   *  template catalog across email + SMS + push. Per-template {channel,
   *  template_id, description, required_vars}. Envelope adds total +
   *  by_channel + distinct_required_vars (union for form-builder UX).
   *  Lets the SPA's notification picker enumerate everything in one
   *  round-trip + one consistent shape (vs 3 channel-specific routes
   *  with 3 different shapes). Platform-static. */
  app.get(
    '/v1/notifications/templates/catalog',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const { introspectNotificationTemplateCatalog } = require('./notification_template_catalog') as
        typeof import('./notification_template_catalog');
      const out = introspectNotificationTemplateCatalog();
      return res.json(wrapResponse(out, ctx));
    },
  );

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

  /** GET /v1/notifications/preferences/effective?username=X&asOf=ISO
   *  (T6 M10.10) — effective preferences with the full 3-way
   *  resolution chain (user_override / tenant_default /
   *  platform_default) per channel. `audit:read` RBAC; admin-only
   *  view of any user. Mounted BEFORE /me + /:username catch-all
   *  routes so the literal /effective segment isn't captured. */
  app.get(
    '/v1/notifications/preferences/effective',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const username = (req.query.username as string | undefined)?.trim();
      if (!username) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'username query param required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const asOfRaw = req.query.asOf as string | undefined;
      let asOf: Date | undefined;
      if (typeof asOfRaw === 'string' && asOfRaw.trim()) {
        const d = new Date(asOfRaw);
        if (!Number.isFinite(d.getTime())) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'asOf must be a valid ISO-8601 timestamp', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        asOf = d;
      }
      try {
        const { resolveEffectivePreference } = require('./notification_preferences_effective') as
          typeof import('./notification_preferences_effective');
        const out = resolveEffectivePreference(
          notificationPreferenceStore,
          req.tenant!.tenant_id,
          username,
          asOf,
        );
        return res.json(wrapResponse(out, ctx));
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
  // ── EWS Case Management System (CMS-3) ───────────────────────────────
  //
  // 19 routes under /v1/cms/cases/*. Sits ALONGSIDE the existing M9.x
  // /v1/cases/* surface — additive only.
  //
  // Route ordering: literal /stats, /sla-breaches, /bulk-assign declared
  // BEFORE the :case_id param routes so the param doesn't shadow.
  //
  // Audit + case-event side effects: every mutation writes a
  // case.{create/update/transition/assign/escalate/close} audit event
  // AND a corresponding M9.4 case-event journal entry so cross-case
  // consumers see one stream.

  function cmsApexUser(req: Request): string {
    return ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
  }

  function cmsErrorResponse(
    e: unknown,
    ctx: ReturnType<typeof extractCtx>,
  ): { status: number; body: ReturnType<typeof wrapError> } {
    if (e instanceof CmsCaseError) {
      const code = e.code;
      const status =
        code === 'unknown_case' ? 404 :
        code === 'case_locked' ? 409 :
        code === 'cap_reached' ? 409 :
        code === 'illegal_transition' ? 409 :
        code === 'invalid_mime_type' ? 415 :
        400;
      const httpCode =
        status === 404 ? `EWS_404_${code}` :
        status === 409 ? `EWS_409_${code}` :
        status === 415 ? `EWS_415_${code}` :
        `EWS_400_${code}`;
      return {
        status,
        body: wrapError(
          { code: httpCode, message: e.message, severity: 'MEDIUM' },
          ctx,
        ),
      };
    }
    throw e;
  }

  function writeCmsAuditEvents(
    tenant_id: string,
    action_suffix: string,
    actor: string,
    case_obj: { case_id: string; case_number?: string },
    metadata: Record<string, unknown>,
  ): void {
    try {
      auditTrailStore.record(
        tenant_id,
        {
          actor_username: actor,
          actor_role: 'admin',
          action: `case.${action_suffix}`,
          resource_type: 'case',
          resource_id: case_obj.case_id,
          outcome: 'success',
          severity: 'info',
          metadata: { case_number: case_obj.case_number, ...metadata },
        },
        now(),
      );
    } catch {
      // swallow — telemetry must not break mutation
    }
    try {
      const journalAction =
        action_suffix === 'create' ? 'opened' :
        action_suffix === 'close' ? 'closed' :
        action_suffix === 'escalate' ? 'escalated' :
        action_suffix === 'transition' || action_suffix === 'reopen' ? 'state_change' :
        action_suffix === 'note_added' ? 'note_added' :
        action_suffix === 'attachment_added' || action_suffix === 'attachment_deleted' ? 'note_added' :
        'state_change';
      caseEventStore.record(
        tenant_id,
        {
          case_id: case_obj.case_id,
          action: journalAction,
          actor: `cms:${actor}`,
          payload: { case_number: case_obj.case_number, action_suffix, ...metadata },
        },
        now(),
      );
    } catch {
      // swallow
    }
  }

  /** GET /v1/cms/cases/stats — dashboard rollup. */
  app.get(
    '/v1/cms/cases/stats',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = cmsCaseStore.list(req.tenant!.tenant_id, {});
      const by_status = Object.fromEntries(
        CMS_CASE_STATES.map((s) => [s, 0]),
      ) as Record<CmsCaseState, number>;
      const by_priority = Object.fromEntries(
        CMS_PRIORITIES.map((p) => [p, 0]),
      ) as Record<CmsPriority, number>;
      let sla_breached_count = 0;
      let sla_warning_count = 0;
      const closedDurations: number[] = [];
      const t = now();
      for (const c of items) {
        by_status[c.status] += 1;
        by_priority[c.priority] += 1;
        if (c.status !== 'CLOSED') {
          const due = new Date(c.sla_due_at);
          const created = new Date(c.created_at);
          if (isSlaBreached(t, due)) sla_breached_count += 1;
          else if (slaProgressPct(t, created, due) >= CMS_SLA_WARNING_PCT) {
            sla_warning_count += 1;
          }
        } else if (c.resolved_at) {
          closedDurations.push(
            new Date(c.resolved_at).getTime() - new Date(c.created_at).getTime(),
          );
        }
      }
      const avg_resolution_hours =
        closedDurations.length === 0
          ? null
          : Math.round(
              (closedDurations.reduce((s, x) => s + x, 0) / closedDurations.length) /
                36_000,
            ) / 100;
      return res.json(
        wrapResponse(
          {
            total: items.length,
            by_status,
            by_priority,
            sla_breached_count,
            sla_warning_count,
            avg_resolution_hours,
          },
          ctx,
        ),
      );
    },
  );

  /** GET /v1/cms/cases/sla-breaches — open cases past sla_due_at,
   *  sorted by overshoot (most-overdue first). */
  app.get(
    '/v1/cms/cases/sla-breaches',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = cmsCaseStore.list(req.tenant!.tenant_id, {});
      const t = now();
      const breaches = items
        .filter((c) => c.status !== 'CLOSED' && isSlaBreached(t, new Date(c.sla_due_at)))
        .map((c) => ({
          case_id: c.case_id,
          case_number: c.case_number,
          title: c.title,
          priority: c.priority,
          assigned_to: c.assigned_to,
          status: c.status,
          sla_due_at: c.sla_due_at,
          overshoot_hours:
            (t.getTime() - new Date(c.sla_due_at).getTime()) / 3_600_000,
          progress_pct: slaProgressPct(t, new Date(c.created_at), new Date(c.sla_due_at)),
        }))
        .sort((a, b) => b.overshoot_hours - a.overshoot_hours);
      return res.json(
        wrapResponse({ items: breaches, total: breaches.length }, ctx),
      );
    },
  );

  /** POST /v1/cms/cases/bulk-assign — assign many cases at once. */
  app.post(
    '/v1/cms/cases/bulk-assign',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as {
        case_ids?: unknown;
        assigned_to?: unknown;
        reason?: unknown;
      };
      if (!Array.isArray(w.case_ids) || w.case_ids.length === 0) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'case_ids[] required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (typeof w.assigned_to !== 'string' || !w.assigned_to.trim()) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'assigned_to required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const assigned_by = cmsApexUser(req);
      const reason = typeof w.reason === 'string' ? w.reason : undefined;
      try {
        const out = cmsCaseStore.bulkAssign(
          req.tenant!.tenant_id,
          w.case_ids as string[],
          w.assigned_to.trim(),
          assigned_by,
          reason,
          now(),
        );
        const ok_count = out.filter((r) => r.status === 'ok').length;
        return res.json(
          wrapResponse(
            { rows: out, ok_count, total: out.length },
            ctx,
          ),
        );
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** GET /v1/cms/cases — list with filters. */
  app.get(
    '/v1/cms/cases',
    requireTenantMw,
    requireRole('cases:list'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filter: CmsListFilter = {};
      if (typeof q.status === 'string' && q.status) {
        if (!isCmsCaseState(q.status)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'invalid status', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filter.status = q.status;
      }
      if (typeof q.priority === 'string' && q.priority) {
        if (!isCmsPriority(q.priority)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'invalid priority', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filter.priority = q.priority;
      }
      if (typeof q.assigned_to === 'string' && q.assigned_to) filter.assigned_to = q.assigned_to;
      if (typeof q.alert_id === 'string' && q.alert_id) filter.alert_id = q.alert_id;
      if (typeof q.since === 'string' && q.since) filter.since = q.since;
      if (typeof q.until === 'string' && q.until) filter.until = q.until;
      if (typeof q.q === 'string' && q.q) filter.q = q.q;
      if (typeof q.case_number === 'string' && q.case_number) filter.case_number = q.case_number;
      if (typeof q.tags === 'string' && q.tags) {
        filter.tags_any = q.tags.split(',').map((s) => s.trim()).filter(Boolean);
      }
      let items = cmsCaseStore.list(req.tenant!.tenant_id, filter);

      // ?breached=true — server-side breach filter using app_admin.sla_config
      // resolver. Same math as the dashboard SLA Breach Matrix, so the
      // dashboard tile click-through lands the user on a list whose
      // count agrees with the tile (BAC §3.1.9.1.4).
      const breachedParam = q.breached;
      if (breachedParam === 'true' && deps.slaMatrixSource) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { buildSlaConfigIndex } = require('./dashboard/sla_breach_matrix') as
          typeof import('./dashboard/sla_breach_matrix');
        const configs = await deps.slaMatrixSource.loadConfigs(req.tenant!.tenant_id);
        const resolveTarget = buildSlaConfigIndex(configs);
        const asOfMs = now().getTime();
        items = items.filter((c) => {
          if (c.status === 'CLOSED') return false;
          const target = resolveTarget(
            req.tenant!.tenant_id,
            // CmsCase doesn't carry case_category in the in-memory shape;
            // PG path stores it on the column added by migration 019.
            // When unavailable, the resolver falls through to
            // default_fallback automatically.
            (c as { case_category?: string | null }).case_category ?? null,
            c.priority,
            null, // no first-class business_unit on cms_cases yet
          );
          if (target === undefined) return false;
          const created = Date.parse(c.created_at);
          if (!Number.isFinite(created)) return false;
          // Float days so sub-day SLAs (P1 fraud = 0.5d) work — same
          // formula as computeSlaBreachMatrix in dashboard/sla_breach_matrix.ts.
          const ageDays = Math.max(0, (asOfMs - created) / 86_400_000);
          return ageDays > target;
        });
      }

      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/cms/cases — create. */
  app.post(
    '/v1/cms/cases',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const created_by = cmsApexUser(req);
      try {
        const c = cmsCaseStore.create(req.tenant!.tenant_id, inner, created_by, now());
        writeCmsAuditEvents(req.tenant!.tenant_id, 'create', created_by, c, {
          priority: c.priority,
          alert_id: c.alert_id,
        });
        return res.status(201).json(wrapResponse(c, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** GET /v1/cms/cases/:case_id — full detail. */
  app.get(
    '/v1/cms/cases/:case_id',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const c = cmsCaseStore.get(req.tenant!.tenant_id, id);
      if (!c) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_case', message: `case ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const t = now();
      const due = new Date(c.sla_due_at);
      const created = new Date(c.created_at);
      const sla = {
        due_at: c.sla_due_at,
        progress_pct: slaProgressPct(t, created, due),
        breached: isSlaBreached(t, due) && c.status !== 'CLOSED',
        warning: !isSlaBreached(t, due)
          && slaProgressPct(t, created, due) >= CMS_SLA_WARNING_PCT
          && c.status !== 'CLOSED',
      };
      return res.json(
        wrapResponse(
          {
            ...c,
            assignments: cmsCaseStore.listAssignments(req.tenant!.tenant_id, id),
            notes_count: cmsCaseStore.listNotes(req.tenant!.tenant_id, id).length,
            attachments_count: cmsCaseStore.listAttachments(req.tenant!.tenant_id, id).length,
            sla,
          },
          ctx,
        ),
      );
    },
  );

  /** PATCH /v1/cms/cases/:case_id — update mutable fields. */
  app.patch(
    '/v1/cms/cases/:case_id',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const updated_by = cmsApexUser(req);
      try {
        const c = cmsCaseStore.update(req.tenant!.tenant_id, id, inner, updated_by, now());
        writeCmsAuditEvents(req.tenant!.tenant_id, 'update', updated_by, c, {});
        return res.json(wrapResponse(c, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** PATCH /v1/cms/cases/:case_id/category — set the case_category column.
   *  Closes the loop on migration 019's heuristic backfill: rows that
   *  fell through to NULL can be re-categorised by an admin so the
   *  dashboard SLA Breach Matrix resolver picks up the right config. */
  app.patch(
    '/v1/cms/cases/:case_id/category',
    requireTenantMw,
    requireRole('cases:set_category'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const body = (inner ?? {}) as { case_category?: unknown; reason?: unknown };
      // case_category accepts string | null. Anything else is rejected.
      if (
        body.case_category !== null &&
        body.case_category !== undefined &&
        typeof body.case_category !== 'string'
      ) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'case_category must be string or null', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const reason =
        typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
      const updated_by = cmsApexUser(req);
      try {
        const c = cmsCaseStore.setCategory(
          req.tenant!.tenant_id,
          id,
          (body.case_category as string | null | undefined) ?? null,
          reason,
          updated_by,
          now(),
        );
        writeCmsAuditEvents(req.tenant!.tenant_id, 'update', updated_by, c, {
          field: 'case_category',
          new_value: c.case_category,
          reason,
        });
        return res.json(wrapResponse(c, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** POST /v1/cms/cases/:case_id/transition body { target } */
  app.post(
    '/v1/cms/cases/:case_id/transition',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as { target?: unknown };
      if (!isCmsCaseState(w.target)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'target required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const performed_by = cmsApexUser(req);
      try {
        const c = cmsCaseStore.transition(req.tenant!.tenant_id, id, w.target, performed_by, now());
        const suffix = w.target === 'OPEN' ? 'reopen' : 'transition';
        writeCmsAuditEvents(req.tenant!.tenant_id, suffix, performed_by, c, {
          target: w.target,
        });
        return res.json(wrapResponse(c, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** POST /v1/cms/cases/:case_id/assign body { assigned_to, reason? } */
  app.post(
    '/v1/cms/cases/:case_id/assign',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const assigned_by = cmsApexUser(req);
      try {
        const c = cmsCaseStore.assign(req.tenant!.tenant_id, id, inner, assigned_by, now());
        writeCmsAuditEvents(req.tenant!.tenant_id, 'assign', assigned_by, c, {
          assigned_to: c.assigned_to,
        });
        // Fan out the lifecycle event — webhooks for external systems +
        // in-process bus for the SPA bell + live alert/case streams.
        webhookDispatcher.dispatch(
          'case.assigned',
          {
            tenant_id: req.tenant!.tenant_id,
            case_id: c.case_id,
            case_number: c.case_number,
            assigned_to: c.assigned_to,
            assigned_by,
            priority: c.priority,
            status: c.status,
            assigned_at: now().toISOString(),
          },
          req.tenant!.tenant_id,
        );
        bus.publish({
          type: 'case.assigned',
          level: 'info',
          title: `Case ${c.case_number} assigned to ${c.assigned_to ?? '(unassigned)'}`,
          body: c.title ?? undefined,
          href: `/cms/cases/${c.case_id}`,
          meta: {
            case_id: c.case_id,
            case_number: c.case_number,
            assigned_to: c.assigned_to,
            assigned_by,
            priority: c.priority,
          },
        });
        return res.json(wrapResponse(c, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** POST /v1/cms/cases/:case_id/escalate body { reason? } */
  app.post(
    '/v1/cms/cases/:case_id/escalate',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as { reason?: unknown };
      const reason = typeof w.reason === 'string' ? w.reason : undefined;
      const performed_by = cmsApexUser(req);
      try {
        const c = cmsCaseStore.escalate(req.tenant!.tenant_id, id, performed_by, reason, now());
        writeCmsAuditEvents(req.tenant!.tenant_id, 'escalate', performed_by, c, {
          reason: reason ?? null,
        });
        return res.json(wrapResponse(c, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** POST /v1/cms/cases/:case_id/close body { resolution_category, resolution_notes } */
  app.post(
    '/v1/cms/cases/:case_id/close',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const closed_by = cmsApexUser(req);
      try {
        const c = cmsCaseStore.close(req.tenant!.tenant_id, id, inner, closed_by, now());
        writeCmsAuditEvents(req.tenant!.tenant_id, 'close', closed_by, c, {
          resolution_category: c.resolution_category,
        });
        webhookDispatcher.dispatch(
          'case.closed',
          {
            tenant_id: req.tenant!.tenant_id,
            case_id: c.case_id,
            case_number: c.case_number,
            closed_by,
            resolution_category: c.resolution_category,
            priority: c.priority,
            status: c.status,
            closed_at: now().toISOString(),
          },
          req.tenant!.tenant_id,
        );
        bus.publish({
          type: 'case.closed',
          level: 'success',
          title: `Case ${c.case_number} closed`,
          body: c.resolution_category ? `Resolution: ${c.resolution_category}` : undefined,
          href: `/cms/cases/${c.case_id}`,
          meta: {
            case_id: c.case_id,
            case_number: c.case_number,
            closed_by,
            resolution_category: c.resolution_category,
            priority: c.priority,
          },
        });
        return res.json(wrapResponse(c, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** POST /v1/cms/cases/:case_id/notes — add a note. */
  app.post(
    '/v1/cms/cases/:case_id/notes',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const user = cmsApexUser(req);
      try {
        const n = cmsCaseStore.addNote(req.tenant!.tenant_id, id, inner, user, now());
        writeCmsAuditEvents(
          req.tenant!.tenant_id,
          'note_added',
          user,
          { case_id: n.case_id },
          { note_id: n.note_id, is_internal: n.is_internal },
        );
        return res.status(201).json(wrapResponse(n, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** GET /v1/cms/cases/:case_id/notes — list (newest-first). */
  app.get(
    '/v1/cms/cases/:case_id/notes',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const cur = cmsCaseStore.get(req.tenant!.tenant_id, id);
      if (!cur) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_case', message: `case ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const items = cmsCaseStore.listNotes(req.tenant!.tenant_id, id);
      return res.json(wrapResponse({ items, total: items.length, case_id: id }, ctx));
    },
  );

  /** POST /v1/cms/cases/:case_id/attachments body
   *  { file_name, file_size, mime_type } — registers metadata. */
  app.post(
    '/v1/cms/cases/:case_id/attachments',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const uploaded_by = cmsApexUser(req);
      try {
        const a = cmsCaseStore.addAttachment(
          req.tenant!.tenant_id,
          id,
          inner,
          uploaded_by,
          now(),
        );
        writeCmsAuditEvents(
          req.tenant!.tenant_id,
          'attachment_added',
          uploaded_by,
          { case_id: a.case_id },
          {
            attachment_id: a.attachment_id,
            file_name: a.file_name,
            mime_type: a.mime_type,
            virus_scan_status: a.virus_scan_status,
          },
        );
        return res.status(201).json(wrapResponse(a, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** GET /v1/cms/cases/:case_id/attachments — list. */
  app.get(
    '/v1/cms/cases/:case_id/attachments',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const cur = cmsCaseStore.get(req.tenant!.tenant_id, id);
      if (!cur) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_case', message: `case ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const items = cmsCaseStore.listAttachments(req.tenant!.tenant_id, id);
      return res.json(wrapResponse({ items, total: items.length, case_id: id }, ctx));
    },
  );

  /** GET /v1/cms/cases/:case_id/attachments/:attachment_id — single
   *  attachment metadata (the prototype's "download" surfaces metadata
   *  + a `cms://` placeholder URL since blobs aren't persisted). */
  app.get(
    '/v1/cms/cases/:case_id/attachments/:attachment_id',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const fid = req.params.attachment_id ?? '';
      const a = cmsCaseStore.getAttachment(req.tenant!.tenant_id, id, fid);
      if (!a) {
        return res.status(404).json(
          wrapError(
            {
              code: 'EWS_404_unknown_attachment',
              message: `attachment ${fid} not found on case ${id}`,
              severity: 'LOW',
            },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(a, ctx));
    },
  );

  /** DELETE /v1/cms/cases/:case_id/attachments/:attachment_id */
  app.delete(
    '/v1/cms/cases/:case_id/attachments/:attachment_id',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const fid = req.params.attachment_id ?? '';
      const deleted_by = cmsApexUser(req);
      try {
        const ok = cmsCaseStore.deleteAttachment(
          req.tenant!.tenant_id,
          id,
          fid,
          deleted_by,
          now(),
        );
        if (!ok) {
          return res.status(404).json(
            wrapError(
              {
                code: 'EWS_404_unknown_attachment',
                message: `attachment ${fid} not found on case ${id}`,
                severity: 'LOW',
              },
              ctx,
            ),
          );
        }
        writeCmsAuditEvents(
          req.tenant!.tenant_id,
          'attachment_deleted',
          deleted_by,
          { case_id: id },
          { attachment_id: fid },
        );
        return res.status(204).send();
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** GET /v1/cms/cases/:case_id/history — full per-case audit. */
  app.get(
    '/v1/cms/cases/:case_id/history',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const limitRaw = req.query.limit as string | undefined;
      const limit = limitRaw === undefined ? 200 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'limit must be 1..200', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const cur = cmsCaseStore.get(req.tenant!.tenant_id, id);
      if (!cur) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_case', message: `case ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const items = cmsCaseStore.listHistory(req.tenant!.tenant_id, id, limit);
      return res.json(wrapResponse({ items, total: items.length, case_id: id }, ctx));
    },
  );

  /** GET /v1/cms/cases/:case_id/tracking?include_stubs=
   *
   *  Per-case tracking timeline — wraps the existing history rows with
   *  type discrimination + payload context so the SPA's Timeline tab can
   *  render each card as a clickable drill-down with appropriate
   *  per-type behaviour. Stub events for cross-service sources
   *  (CAS / CAP / approval) only appear when ?include_stubs=true. */
  app.get(
    '/v1/cms/cases/:case_id/tracking',
    requireTenantMw,
    requireRole('cases:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const tenant_id = req.tenant!.tenant_id;
      const cur = cmsCaseStore.get(tenant_id, id);
      if (!cur) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_case', message: `case ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const role = (req.headers['x-apex-role'] as string | undefined) ?? '';
      const ATT_ROLES = ['admin', 'risk_analyst', 'supervisor', 'collection_officer'];
      const canDownloadAttachment = ATT_ROLES.includes(role);
      const include_stubs = req.query.include_stubs === 'true';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { computeCaseTracking } = require('./cms/case_tracking') as
        typeof import('./cms/case_tracking');
      const out = computeCaseTracking({
        tenant_id,
        case_id: id,
        history: cmsCaseStore.listHistory(tenant_id, id, 200),
        notes: cmsCaseStore.listNotes(tenant_id, id),
        attachments: cmsCaseStore.listAttachments(tenant_id, id),
        canDownloadAttachment,
        include_stubs,
      });
      return res.json(
        wrapResponse(
          { ...out, generated_at: now().toISOString() },
          ctx,
        ),
      );
    },
  );

  // ── CMS-4 — automation surface ───────────────────────────────────────
  //
  // 4 new routes wired against cms_automation.ts. All literal segments
  // (/automation/auto-create-from-alert, /automation/pool, /cases/
  // inactive) live BEFORE the :case_id param routes already declared
  // above — Express dispatches by registration order, and registering
  // these LATER means a request to /v1/cms/cases/inactive would have
  // matched the earlier `:case_id` GET route. Fix: declare these BELOW
  // but with literal-segment paths that don't collide with /:case_id
  // (the `inactive` would match :case_id with id='inactive', which is
  // wrong). So we rely on the fact that the GET /:case_id handler
  // returns 404 for an unknown id — but that's a worse UX than a 200
  // listing. Instead, mount /v1/cms/cases/inactive UNDER a sibling path
  // /v1/cms/automation/inactive-cases to avoid the collision entirely.

  /** POST /v1/cms/automation/auto-create-from-alert
   *  body { alert_id, alert_severity, customer_id?, rule_id?, rule_name?, context? }
   *  Idempotent on alert_id. Returns {case, created, matched_case_id?}. */
  app.post(
    '/v1/cms/automation/auto-create-from-alert',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const created_by = cmsApexUser(req);
      try {
        const pool = cmsAssigneePoolStore.get(req.tenant!.tenant_id).members;
        const result = autoCreateCaseFromAlert(
          inner as AutoCreateInput,
          cmsCaseStore,
          req.tenant!.tenant_id,
          pool,
          created_by,
          now(),
        );
        if (result.created) {
          writeCmsAuditEvents(
            req.tenant!.tenant_id,
            'create',
            created_by,
            result.case,
            { auto_created: true, alert_id: result.case.alert_id },
          );
        }
        return res.status(result.created ? 201 : 200).json(wrapResponse(result, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** GET /v1/cms/automation/pool — current assignee pool. */
  app.get(
    '/v1/cms/automation/pool',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const pool = cmsAssigneePoolStore.get(req.tenant!.tenant_id);
      return res.json(wrapResponse(pool, ctx));
    },
  );

  /** PUT /v1/cms/automation/pool body { members: string[] } */
  app.put(
    '/v1/cms/automation/pool',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as { members?: unknown };
      if (!Array.isArray(w.members)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'members[] required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const updated_by = cmsApexUser(req);
      try {
        const pool = cmsAssigneePoolStore.setMembers(
          req.tenant!.tenant_id,
          w.members as string[],
          updated_by,
          now(),
        );
        return res.json(wrapResponse(pool, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** POST /v1/cms/cases/:case_id/assign-from-pool
   *  Round-robin from the tenant's assignee pool. Updates last
   *  assignment + advances rotation deterministically. */
  app.post(
    '/v1/cms/cases/:case_id/assign-from-pool',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.case_id ?? '';
      const pool = cmsAssigneePoolStore.get(req.tenant!.tenant_id).members;
      if (pool.length === 0) {
        return res.status(409).json(
          wrapError(
            {
              code: 'EWS_409_pool_empty',
              message: 'tenant assignee pool is empty — set members via PUT /v1/cms/automation/pool',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const assigned_by = cmsApexUser(req);
      try {
        const c = cmsCaseStore.assignRoundRobin(
          req.tenant!.tenant_id,
          id,
          pool,
          assigned_by,
          now(),
        );
        writeCmsAuditEvents(req.tenant!.tenant_id, 'assign', assigned_by, c, {
          assigned_to: c.assigned_to,
          via: 'round-robin',
        });
        return res.json(wrapResponse(c, ctx));
      } catch (e) {
        const r = cmsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** GET /v1/cms/automation/inactive-cases?threshold_hours=48
   *  Cases with status != CLOSED + updated_at older than threshold,
   *  sorted longest-inactive first. */
  app.get(
    '/v1/cms/automation/inactive-cases',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.query.threshold_hours;
      const threshold_hours = raw === undefined ? 48 : Number(raw);
      if (!Number.isInteger(threshold_hours) || threshold_hours < 1 || threshold_hours > 720) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'threshold_hours must be 1..720', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const cases = cmsCaseStore.list(req.tenant!.tenant_id, {});
      const items = findInactiveCases(cases, now(), threshold_hours);
      return res.json(
        wrapResponse({ items, total: items.length, threshold_hours }, ctx),
      );
    },
  );

  // ── End CMS-3 routes ─────────────────────────────────────────────────

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

  /** GET /v1/cases/states/graph (T6 M9.7) — investigation state-machine
   *  catalog. Per state: {state, sla_hours_default, terminal,
   *  allowed_next_states[]}. Lets the SPA build a data-driven "Move
   *  case to..." dropdown + "Status legend" tooltip instead of
   *  hardcoding the state graph in two places. Same shape for every
   *  tenant (the state machine is platform-static). audit:read RBAC. */
  app.get(
    '/v1/cases/states/graph',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const graph = listInvestigationStateGraph();
      return res.json(wrapResponse(graph, ctx));
    },
  );

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

  // ── Case event journal (T6 M9.4) ────────────────────────────────────
  //
  // Append-only event stream that downstream systems poll via
  // ?since_seq=N&limit=50. Sequence numbers are per-tenant
  // monotonic and stay stable across the 1000-entry FIFO cap.
  //
  // Route ordering: the literal `/events` and `/events/:event_id`
  // segments are declared BEFORE `/v1/cases/:case_id/events` so
  // the param route doesn't shadow them.

  /** POST /v1/cases/events — record a case event explicitly.
   *  body { case_id, action, actor, payload? }. */
  app.post(
    '/v1/cases/events',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const event = caseEventStore.record(req.tenant!.tenant_id, inner, now());
        return res.status(201).json(wrapResponse(event, ctx));
      } catch (e) {
        if (e instanceof CaseEventError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/cases/events?since_seq=N&limit=50 — cursor poll. */
  app.get(
    '/v1/cases/events',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const sinceRaw = req.query.since_seq;
      const limitRaw = req.query.limit;
      const since_seq = sinceRaw === undefined ? 0 : Number(sinceRaw);
      const limit = limitRaw === undefined ? CASE_EVENT_DEFAULT_LIMIT : Number(limitRaw);
      if (!Number.isInteger(since_seq) || since_seq < 0) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'since_seq must be a non-negative integer', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > CASE_EVENT_MAX_LIMIT) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: `limit must be 1..${CASE_EVENT_MAX_LIMIT}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const page = caseEventStore.fetchSince(req.tenant!.tenant_id, since_seq, limit);
        return res.json(wrapResponse(page, ctx));
      } catch (e) {
        if (e instanceof CaseEventError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/cases/events/:event_id — single event lookup. */
  app.get(
    '/v1/cases/events/:event_id',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.event_id ?? '';
      const event = caseEventStore.get(req.tenant!.tenant_id, id);
      if (!event) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_event', message: `event ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(event, ctx));
    },
  );

  /** GET /v1/cases/:case_id/events — case-specific timeline. */
  app.get(
    '/v1/cases/:case_id/events',
    requireTenantMw,
    requireRole('cases:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const case_id = req.params.case_id ?? '';
      const items = caseEventStore.forCase(req.tenant!.tenant_id, case_id);
      return res.json(wrapResponse({ case_id, items, total: items.length }, ctx));
    },
  );

  /** GET /v1/cases/:case_id/timeline (T6 M9.6) — reconstruct ONE case's
   *  full state-transition ladder from the M9.4 event journal. Returns
   *  CaseTimeline with `transitions[]` (per-state durations), action
   *  counts, current_state + age, total_age_hours. Pure-function over
   *  the existing forCase store API; unknown case returns an empty
   *  timeline (not 404) because the event log is total. */
  app.get(
    '/v1/cases/:case_id/timeline',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const case_id = req.params.case_id ?? '';
      const events = caseEventStore.forCase(req.tenant!.tenant_id, case_id);
      const { reconstructCaseTimeline } = require('./case_timeline') as
        typeof import('./case_timeline');
      const timeline = reconstructCaseTimeline(events, case_id, now());
      return res.json(wrapResponse(timeline, ctx));
    },
  );

  /** GET /v1/cases/sla-breaches (T6 M9.5) — reconstruct each case's
   *  state timeline from the M9.4 event journal, compare time-in-state
   *  against the per-state SLA, and surface cases past their window.
   *  Worst-first list capped at 50 entries. */
  app.get(
    '/v1/cases/sla-breaches',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const page = caseEventStore.fetchSince(
        req.tenant!.tenant_id,
        0,
        CASE_EVENT_MAX_LIMIT,
      );
      const summary = detectCaseSlaBreaches(page.items, now());
      return res.json(wrapResponse({ summary }, ctx));
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

  /** GET /v1/investigations/step-backlog (T6 M9.9) — fleet-wide
   *  per-step backlog. For each step_id seen across the cohort
   *  emits {step_id, name, pending_count, completed_count,
   *  cases_with_step, open_pending_count}. Sorted by
   *  open_pending_count desc — biggest bottleneck first. Lets ops
   *  spot "most cases get stuck at the interview_claimant step".
   *  Mounted BEFORE /:id catch-all so the literal segment wins. */
  app.get(
    '/v1/investigations/step-backlog',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = caseInvestigationStore.list(req.tenant!.tenant_id, { page_size: 100000 }).items;
      const { listInvestigationStepBacklog } = require('./investigation_step_progress') as
        typeof import('./investigation_step_progress');
      const out = listInvestigationStepBacklog(items);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/investigations/:id/step-progress (T6 M9.9) — per-case
   *  step progress card: counts + completion rate + oldest pending +
   *  newest-first recent completions (cap 5). Mounted BEFORE the
   *  catch-all /:id GET so the literal /step-progress segment wins. */
  app.get(
    '/v1/investigations/:id/step-progress',
    requireTenantMw,
    requireRole('audit:read'),
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
      const { summariseInvestigationSteps } = require('./investigation_step_progress') as
        typeof import('./investigation_step_progress');
      const out = summariseInvestigationSteps(inv);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/investigations/summary (T6 M9.8) — executive cohort
   *  rollup over ALL investigations in the tenant. Returns per-status
   *  counts (every state key emitted), per-decision counts for closed
   *  cases (4 named buckets + 'null' bucket for closed-without-
   *  decision), open/closed split, mean age of opens, mean time-to-
   *  close, oldest open + newest closed pointers. Mirrors the M14.19
   *  / M3.5 analytics rollup shape but for case investigations. Mounted
   *  BEFORE `/:id` so the literal `/summary` segment wins. */
  app.get(
    '/v1/investigations/summary',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = caseInvestigationStore.list(req.tenant!.tenant_id, { page_size: 100000 }).items;
      const { summarizeInvestigationCohort } = require('./investigation_cohort_summary') as
        typeof import('./investigation_cohort_summary');
      const out = summarizeInvestigationCohort(req.tenant!.tenant_id, items, now());
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

  // ── Custom dashboard builder (T6 M11.7) ──────────────────────────────
  //
  // Operator-authored layouts on a 12-col grid. Widget catalog is
  // platform-static — operators only choose from the 7 we ship.
  //
  // Route ordering: literal `/widgets/catalog` declared BEFORE
  // `/custom/:dashboard_id` so the param doesn't shadow.

  /** GET /v1/dashboards/widgets/catalog — list widget types. */
  app.get(
    '/v1/dashboards/widgets/catalog',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = Object.values(WIDGET_CATALOG);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** GET /v1/dashboards/widgets/usage (T6 M11.11) — cross-cut over the
   *  tenant's saved dashboards. For each widget_type in WIDGET_CATALOG
   *  (every row always emitted, even at count=0) returns
   *  {widget_type, display_name, dashboard_count, total_instances,
   *   dashboards[]: {dashboard_id, name, count}}. Surfaces popular
   *  widgets + completely-unused catalog entries (candidates for a
   *  cleanup or guided tour). Mounted right after `/widgets/catalog`
   *  so the literal `/widgets/usage` segment isn't captured by any
   *  `:dashboard_id` wildcard. */
  app.get(
    '/v1/dashboards/widgets/usage',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const dashboards = customDashboardStore.list(req.tenant!.tenant_id);
      const out = analyseDashboardWidgetUsage(dashboards);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/dashboards/custom — list custom dashboards. */
  app.get(
    '/v1/dashboards/custom',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = customDashboardStore.list(req.tenant!.tenant_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/dashboards/custom — create. */
  app.post(
    '/v1/dashboards/custom',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const d = customDashboardStore.create(req.tenant!.tenant_id, inner, created_by, now());
        return res.status(201).json(wrapResponse(d, ctx));
      } catch (e) {
        if (e instanceof DashboardError) {
          if (e.code === 'cap_reached') {
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

  /** POST /v1/dashboards/custom/export (T6 M11.9) — bundle N dashboards
   *  into a versioned JSON envelope. body { dashboard_ids: string[] }.
   *  Cap 10/bundle. unknown_dashboard → 404; bad shape → 400. */
  app.post(
    '/v1/dashboards/custom/export',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { dashboard_ids?: unknown };
      const exported_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const bundle = exportDashboardBundle(customDashboardStore, {
          tenant_id: req.tenant!.tenant_id,
          dashboard_ids: Array.isArray(wrapper.dashboard_ids)
            ? (wrapper.dashboard_ids as unknown[]).map((x) => String(x))
            : [],
          exported_by,
          now: now(),
        });
        return res.json(wrapResponse(bundle, ctx));
      } catch (e) {
        if (e instanceof DashboardBundleError) {
          if (e.code === 'unknown_dashboard') {
            return res.status(404).json(
              wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
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

  /** POST /v1/dashboards/custom/import (T6 M11.9) — replay a bundle
   *  into the caller's tenant. body { bundle: DashboardBundle,
   *  name_prefix?: string }. Returns per-row outcomes (created/skipped/
   *  error). */
  app.post(
    '/v1/dashboards/custom/import',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { bundle?: unknown; name_prefix?: unknown };
      const imported_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const result = importDashboardBundle(customDashboardStore, {
          target_tenant_id: req.tenant!.tenant_id,
          bundle: wrapper.bundle,
          imported_by,
          name_prefix:
            typeof wrapper.name_prefix === 'string' ? wrapper.name_prefix : undefined,
          now: now(),
        });
        return res.json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof DashboardBundleError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/dashboards/custom/:dashboard_id/lint (T6 M11.10) —
   *  pure lint pass over a saved layout. Returns LintReport with
   *  errors/warnings/info counts + per-issue details. `passes` flag
   *  is true iff errors_count===0; the SPA gates a "deploy" button
   *  on this. Mounted BEFORE the catch-all `/:dashboard_id` so the
   *  literal "/lint" segment isn't captured. */
  app.get(
    '/v1/dashboards/custom/:dashboard_id/lint',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.dashboard_id ?? '';
      const dashboard = customDashboardStore.get(req.tenant!.tenant_id, id);
      if (!dashboard) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_dashboard', message: `dashboard ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const { lintDashboardLayout } = require('./custom_dashboard_lint') as
        typeof import('./custom_dashboard_lint');
      const report = lintDashboardLayout(dashboard);
      return res.json(wrapResponse(report, ctx));
    },
  );

  /** GET /v1/dashboards/custom/:dashboard_id — single. */
  app.get(
    '/v1/dashboards/custom/:dashboard_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.dashboard_id ?? '';
      const d = customDashboardStore.get(req.tenant!.tenant_id, id);
      if (!d) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_dashboard', message: `dashboard ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(d, ctx));
    },
  );

  /** PUT /v1/dashboards/custom/:dashboard_id — replace + bump version. */
  app.put(
    '/v1/dashboards/custom/:dashboard_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.dashboard_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const updated_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const d = customDashboardStore.replace(req.tenant!.tenant_id, id, inner, updated_by, now());
        return res.json(wrapResponse(d, ctx));
      } catch (e) {
        if (e instanceof DashboardError) {
          if (e.code === 'unknown_dashboard') {
            return res.status(404).json(
              wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
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

  /** DELETE /v1/dashboards/custom/:dashboard_id — remove. */
  app.delete(
    '/v1/dashboards/custom/:dashboard_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.dashboard_id ?? '';
      const ok = customDashboardStore.delete(req.tenant!.tenant_id, id);
      if (!ok) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_dashboard', message: `dashboard ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.status(204).send();
    },
  );

  // ── Custom dashboard data resolver (T6 M11.8) ────────────────────────
  //
  // M11.7 ships the layout builder; M11.8 fills the widgets in one
  // call. Pure-function deterministic synth seeded by (tenant,
  // widget_type, config-hash, day) — same FNV-1a + Mulberry32
  // pattern as M14 adapters, so the SPA renders the same numbers
  // within a day.

  /** POST /v1/dashboards/widgets/resolve (T6 M11.8) — resolve a
   *  single ad-hoc widget. Body { widget_type, position, span, config }. */
  app.post(
    '/v1/dashboards/widgets/resolve',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as Partial<DashboardWidget>;
      if (
        !w ||
        typeof w !== 'object' ||
        !w.widget_type ||
        !w.position ||
        !w.span
      ) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'widget_type, position, and span required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const payload = resolveWidget(
          req.tenant!.tenant_id,
          {
            widget_type: w.widget_type,
            position: w.position,
            span: w.span,
            config: w.config ?? {},
          },
          now(),
        );
        return res.json(wrapResponse(payload, ctx));
      } catch (e) {
        if (e instanceof WidgetResolverError) {
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

  /** POST /v1/dashboards/custom/:dashboard_id/resolve (T6 M11.8) —
   *  resolve every widget on a saved dashboard in one shot. */
  app.post(
    '/v1/dashboards/custom/:dashboard_id/resolve',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.dashboard_id ?? '';
      const dashboard = customDashboardStore.get(req.tenant!.tenant_id, id);
      if (!dashboard) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_dashboard', message: `dashboard ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const resolved = resolveDashboard(dashboard, now());
      return res.json(wrapResponse(resolved, ctx));
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

  /** POST /v1/scoring/presets/custom/clone-from-library (T6 M6.11)
   *  body { source_preset_id, name? } — reads a library weight preset
   *  and creates an editable custom copy (deep-cloned multipliers).
   *  Mirror of M5.9 (rule template clone) for the M6.3 / M6.4 weight
   *  preset surface. 404 EWS_404_unknown_preset when the library id
   *  doesn't resolve; 409 EWS_409_cap_reached when the tenant is at
   *  the 30-preset cap. Mounted BEFORE `/custom/:preset_id` so the
   *  literal `clone-from-library` segment isn't captured. */
  app.post(
    '/v1/scoring/presets/custom/clone-from-library',
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
      const source = getWeightPreset(wrapper.source_preset_id);
      if (!source) {
        return res.status(404).json(
          wrapError(
            {
              code: 'EWS_404_unknown_preset',
              message: `library weight preset ${wrapper.source_preset_id} not found`,
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
        mode: source.mode,
        weight_multipliers: { ...source.weight_multipliers },
      };
      try {
        const preset = customWeightPresetStore.create(
          req.tenant!.tenant_id,
          createInput,
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

  /** GET /v1/scoring/presets/:preset_id/effective-weights?vertical=
   *  (T6 M6.10) — per-indicator effective weights view. Walks the
   *  M6.2 catalog × the preset's multiplier map, emits per-indicator
   *  {catalog_weight, multiplier, effective_weight (clamped [0,1]),
   *  source: 'preset_multiplier'|'catalog_default'}. Library + custom
   *  presets resolved via getEffectiveWeightPreset. customers:read_risk_profile
   *  RBAC. Mounted BEFORE /:id catch-all + before /diff so the
   *  literal /effective-weights segment isn't captured. */
  app.get(
    '/v1/scoring/presets/:preset_id/effective-weights',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.preset_id ?? '';
      const preset = getEffectiveWeightPreset(
        customWeightPresetStore,
        req.tenant!.tenant_id,
        id,
      );
      if (!preset) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_preset', message: `unknown preset: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const verticalRaw = req.query.vertical as string | undefined;
      let vertical: ScoringVertical | undefined;
      if (verticalRaw !== undefined && verticalRaw !== '') {
        if (verticalRaw !== 'banking' && verticalRaw !== 'insurance') {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'vertical must be banking|insurance', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        vertical = verticalRaw;
      }
      const { resolveEffectivePresetWeights } = require('./scoring_preset_effective_weights') as
        typeof import('./scoring_preset_effective_weights');
      const out = resolveEffectivePresetWeights(preset, vertical);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/scoring/presets/diff?from=<id>&to=<id> (T6 M6.9) —
   *  structural diff between two presets (library OR custom).
   *  Resolves each id via getEffectiveWeightPreset (library checked
   *  first, then tenant custom). 404 on either side missing. MUST be
   *  declared before /v1/scoring/presets/:id so "diff" isn't captured
   *  as an id. */
  app.get(
    '/v1/scoring/presets/diff',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const fromRaw = req.query.from;
      const toRaw = req.query.to;
      if (typeof fromRaw !== 'string' || !fromRaw.trim() || typeof toRaw !== 'string' || !toRaw.trim()) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'from and to query params are required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const from = getEffectiveWeightPreset(
        customWeightPresetStore,
        req.tenant!.tenant_id,
        fromRaw,
      );
      if (!from) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_preset', message: `unknown preset: ${fromRaw}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const to = getEffectiveWeightPreset(
        customWeightPresetStore,
        req.tenant!.tenant_id,
        toRaw,
      );
      if (!to) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_preset', message: `unknown preset: ${toRaw}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const diff = diffWeightPresets(from, to);
      return res.json(wrapResponse({ diff }, ctx));
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

  /** POST /v1/scoring/risk/by-preset/backtest (T6 M6.8) — score N
   *  labeled samples through a preset and report precision / recall /
   *  F1 / accuracy + per-sample breakdown at a chosen threshold.
   *
   *  Body: { preset_id, samples: [{ customer_id, items, outcome }],
   *  threshold? (default 50) }. Returns BackTestResult. Cap 200
   *  samples. */
  app.post(
    '/v1/scoring/risk/by-preset/backtest',
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
        const result = backtestPreset(
          (inner ?? {}) as BackTestInput,
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
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'preset back-test failed', severity: 'HIGH' },
            ctx,
          ),
        );
      }
    },
  );

  /** POST /v1/scoring/risk/by-preset/backtest (T6 M6.8) — score N
   *  labeled samples through a preset and report precision / recall /
   *  F1 / accuracy + per-sample breakdown at a chosen threshold.
   *
   *  Body: { preset_id, samples: [{ customer_id, items, outcome }],
   *  threshold? (default 50) }. Returns BackTestResult. Cap 200
   *  samples. */
  app.post(
    '/v1/scoring/risk/by-preset/backtest',
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
        const result = backtestPreset(
          (inner ?? {}) as BackTestInput,
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
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'preset back-test failed', severity: 'HIGH' },
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

  /** GET /v1/indicators/usage (T6 M4.11) — reverse cross-reference
   *  for every indicator in the M6.2 catalog: which rule templates
   *  (M5.1) reference it. Mirror of M5.14 (template → indicators)
   *  but flipped. Includes orphan detection (indicators with zero
   *  references), top-5 most-referenced, per-vertical breakdown,
   *  and has_threshold flag (from M4.3). Platform-static. Mounted
   *  BEFORE /v1/indicators/thresholds so the literal /usage segment
   *  wins. */
  app.get(
    '/v1/indicators/usage',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const { mapIndicatorUsage } = require('./indicator_usage_map') as
        typeof import('./indicator_usage_map');
      const out = mapIndicatorUsage();
      return res.json(wrapResponse(out, ctx));
    },
  );

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

  /** GET /v1/indicators/thresholds/effective?vertical=banking|insurance
   *  (T6 M4.9) — every platform indicator's effective threshold for the
   *  caller's tenant, with the resolution chain (library_default vs
   *  tenant_override) showing which level wins per indicator + the
   *  library_default kept visible side-by-side. `audit:read` RBAC.
   *  Mounted BEFORE the catch-all `/:indicator_id` so the literal
   *  `/effective` segment isn't captured. */
  app.get(
    '/v1/indicators/thresholds/effective',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const verticalRaw = req.query.vertical as string | undefined;
      let vertical: ScoringVertical | undefined;
      if (verticalRaw !== undefined && verticalRaw !== '') {
        if (verticalRaw !== 'banking' && verticalRaw !== 'insurance') {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'vertical must be banking|insurance', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        vertical = verticalRaw;
      }
      const { resolveEffectiveThresholds } = require('./indicator_threshold_effective') as
        typeof import('./indicator_threshold_effective');
      const out = resolveEffectiveThresholds(
        thresholdOverrideStore,
        req.tenant!.tenant_id,
        vertical,
      );
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** POST /v1/indicators/thresholds/:indicator_id/suggest (T6 M4.10)
   *  body { values[], polarity? } — derives suggested {yellow, orange,
   *  red} thresholds from historical observed values via percentile.
   *  Default polarity='higher_is_worse' (red=p95, orange=p75, yellow=p50).
   *  Returns 200 with `suggested=null + insufficient_reason` when
   *  fewer than 5 finite samples — lets ops bootstrap thresholds
   *  from real data without forcing every endpoint into 400-territory
   *  when the cohort is small. 404 unknown_indicator. Mounted BEFORE
   *  `/:indicator_id` GET so the literal `/suggest` segment wins. */
  app.post(
    '/v1/indicators/thresholds/:indicator_id/suggest',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.indicator_id ?? '';
      const { getThreshold } = require('./indicator_thresholds') as
        typeof import('./indicator_thresholds');
      if (!getThreshold(id)) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_indicator', message: `unknown indicator: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { values?: unknown; polarity?: unknown };
      if (!Array.isArray(wrapper.values)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'values must be an array of numbers', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      for (const v of wrapper.values) {
        if (typeof v !== 'number') {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'values[] must contain only numbers', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
      }
      const polarity = wrapper.polarity ?? 'higher_is_worse';
      try {
        const { suggestThresholdsFromHistory } = require('./threshold_auto_tune') as
          typeof import('./threshold_auto_tune');
        const out = suggestThresholdsFromHistory(
          wrapper.values as number[],
          polarity as 'higher_is_worse' | 'lower_is_worse',
        );
        return res.json(wrapResponse({ indicator_id: id, ...out }, ctx));
      } catch (e) {
        if (e instanceof Error && /polarity/.test(e.message)) {
          return res.status(400).json(
            wrapError({ code: 'EWS_400_invalid_input', message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
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

  // ── Customer watchlist (T6 M4.7) ────────────────────────────────────
  //
  // Tenant-managed list of high-risk customers. Composes with
  // M4.6 bulk-scan: POST /scan re-evaluates every watched customer
  // in one shot.

  /** GET /v1/watchlist — list watched customers. */
  app.get(
    '/v1/watchlist',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = watchlistStore.list(req.tenant!.tenant_id);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/watchlist — add a customer.
   *  body { customer_id, reason, vertical? }. */
  app.post(
    '/v1/watchlist',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const added_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const entry = watchlistStore.add(req.tenant!.tenant_id, inner, added_by, now());
        return res.status(201).json(wrapResponse(entry, ctx));
      } catch (e) {
        if (e instanceof WatchlistError) {
          if (e.code === 'already_watched' || e.code === 'cap_reached') {
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

  /** POST /v1/watchlist/scan — run M4.6 bulk breach scan against
   *  every watched customer. Empty watchlist returns an empty
   *  result envelope (not 4xx) since "no one to watch" is valid. */
  app.post(
    '/v1/watchlist/scan',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { vertical?: unknown };
      const watched = watchlistStore.list(req.tenant!.tenant_id);
      if (watched.length === 0) {
        return res.json(
          wrapResponse(
            {
              tenant_id: req.tenant!.tenant_id,
              vertical: (wrapper.vertical as string) ?? 'all',
              scanned_at: now().toISOString(),
              watchlist_size: 0,
              results: [],
              aggregate: {
                customer_count: 0,
                red_total: 0,
                orange_total: 0,
                yellow_total: 0,
                green_total: 0,
                customers_with_red: 0,
                customers_attention_required: 0,
              },
            },
            ctx,
          ),
        );
      }
      try {
        const result = scanCustomerBreachesBulk(
          {
            tenant_id: req.tenant!.tenant_id,
            customer_ids: watched.map((c) => c.customer_id),
            vertical: wrapper.vertical as ScoringVertical | undefined,
          } as BulkBreachScanInput,
          thresholdOverrideStore,
          now(),
        );
        // Annotate each row with the watchlist `reason` so the SPA
        // can show "watched because: X" alongside the breach summary.
        const reasonByCustomer = new Map(watched.map((c) => [c.customer_id, c.reason]));
        const annotated = {
          ...result,
          watchlist_size: watched.length,
          results: result.results.map((r) => ({
            ...r,
            reason: reasonByCustomer.get(r.customer_id) ?? null,
          })),
        };
        return res.json(wrapResponse(annotated, ctx));
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

  /** DELETE /v1/watchlist/:customer_id — remove. */
  app.delete(
    '/v1/watchlist/:customer_id',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.customer_id ?? '';
      const ok = watchlistStore.remove(req.tenant!.tenant_id, id);
      if (!ok) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_customer', message: `customer ${id} not on watchlist`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.status(204).send();
    },
  );

  // ── Field-officer mobile (T6 M14.10) ────────────────────────────────
  //
  // Append-only visit ledger surfaced to the field-officer mobile
  // app. Visits get an outcome enum that downstream M9 case
  // workflows can hook into.

  /** POST /v1/field/visits — log a new visit. body
   *  {officer_id, customer_id, visit_at, outcome, note, location?}. */
  app.post(
    '/v1/field/visits',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const visit = fieldVisitStore.log(req.tenant!.tenant_id, inner, created_by, now());
        return res.status(201).json(wrapResponse(visit, ctx));
      } catch (e) {
        if (e instanceof FieldVisitError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/field/visits — list with optional filters
   *  ?customer_id=&officer_id=&outcome=&since=ISO&until=ISO. */
  app.get(
    '/v1/field/visits',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query as Record<string, string | undefined>;
      const filter: VisitFilter = {};
      if (typeof q.customer_id === 'string' && q.customer_id) filter.customer_id = q.customer_id;
      if (typeof q.officer_id === 'string' && q.officer_id) filter.officer_id = q.officer_id;
      if (typeof q.outcome === 'string' && q.outcome) filter.outcome = q.outcome as VisitOutcome;
      if (typeof q.since === 'string' && q.since) filter.since = q.since;
      if (typeof q.until === 'string' && q.until) filter.until = q.until;
      const items = fieldVisitStore.list(req.tenant!.tenant_id, filter);
      const aggregate = aggregateByOutcome(items);
      return res.json(wrapResponse({ items, total: items.length, aggregate }, ctx));
    },
  );

  /** GET /v1/field/visits/geo-clusters?radius_km=1&since=ISO (T6 M14.21)
   *  — greedy Haversine clustering of field visits with GPS pins.
   *  Visits without GPS are skipped + counted in total_without_gps.
   *  Default radius 1 km, max 500 km. Clusters sorted by visit_count
   *  desc with latest_visit_at tie-break. audit:read RBAC. Mounted
   *  BEFORE any `:visit_id` wildcard would conflict (none currently). */
  app.get(
    '/v1/field/visits/geo-clusters',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query as Record<string, string | undefined>;
      const radiusRaw = q.radius_km;
      const radius_km =
        radiusRaw === undefined || radiusRaw === '' ? undefined : Number(radiusRaw);
      if (radius_km !== undefined && !Number.isFinite(radius_km)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'radius_km must be a finite number', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const filter: VisitFilter = {};
      if (typeof q.since === 'string' && q.since) {
        const d = new Date(q.since);
        if (!Number.isFinite(d.getTime())) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'since must be a valid ISO-8601 timestamp', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filter.since = q.since;
      }
      const visits = fieldVisitStore.list(req.tenant!.tenant_id, filter);
      const { clusterFieldVisits, DEFAULT_RADIUS_KM } = require('./field_visit_geo_clustering') as
        typeof import('./field_visit_geo_clustering');
      const clusters = clusterFieldVisits(visits, radius_km ?? DEFAULT_RADIUS_KM);
      return res.json(wrapResponse({ clusters }, ctx));
    },
  );

  /** GET /v1/field/operations/analytics (T6 M14.19) — supervisor view
   *  rollup over the M14.10 visit ledger: outcome mix, distinct
   *  officers + customers, per-officer breakdown (visit count, success
   *  rate, last visit), mean visits per officer.
   *
   *  Filters mirror /v1/field/visits: ?officer_id= ?customer_id=
   *  ?outcome= ?since= ?until=. */
  app.get(
    '/v1/field/operations/analytics',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query as Record<string, string | undefined>;
      const filter: VisitFilter = {};
      if (typeof q.customer_id === 'string' && q.customer_id) filter.customer_id = q.customer_id;
      if (typeof q.officer_id === 'string' && q.officer_id) filter.officer_id = q.officer_id;
      if (typeof q.outcome === 'string' && q.outcome) {
        if (!isVisitOutcome(q.outcome)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: `outcome '${q.outcome}' is not a recognised visit outcome`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filter.outcome = q.outcome;
      }
      if (typeof q.since === 'string' && q.since) filter.since = q.since;
      if (typeof q.until === 'string' && q.until) filter.until = q.until;
      const visits = fieldVisitStore.list(req.tenant!.tenant_id, filter);
      const analytics = summarizeFieldOperations(visits);
      return res.json(wrapResponse({ analytics }, ctx));
    },
  );

  /** GET /v1/field/visits/dow-hour-heatmap (T6 M14.22) — 7 × 24 day-of-
   *  week × hour-of-day matrix over the M14.10 visit ledger. ISO Mon=0
   *  ..Sun=6 ordering. ?tz= shifts the wall-clock used for bucketing
   *  (13-zone whitelist from M12.4 / report_schedules). Filters mirror
   *  /v1/field/visits: ?officer_id= ?customer_id= ?outcome= ?since=
   *  ?until=. */
  app.get(
    '/v1/field/visits/dow-hour-heatmap',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query as Record<string, string | undefined>;
      const tzRaw = (q.tz as string | undefined) ?? 'UTC';
      if (!isHeatmapTz(tzRaw)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: `tz '${tzRaw}' is not in the supported list`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const filter: VisitFilter = {};
      if (typeof q.customer_id === 'string' && q.customer_id) filter.customer_id = q.customer_id;
      if (typeof q.officer_id === 'string' && q.officer_id) filter.officer_id = q.officer_id;
      if (typeof q.outcome === 'string' && q.outcome) {
        if (!isVisitOutcome(q.outcome)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: `outcome '${q.outcome}' is not a recognised visit outcome`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filter.outcome = q.outcome;
      }
      if (typeof q.since === 'string' && q.since) filter.since = q.since;
      if (typeof q.until === 'string' && q.until) filter.until = q.until;
      const visits = fieldVisitStore.list(req.tenant!.tenant_id, filter);
      const heatmap = bucketVisitsByDowHour(visits, tzRaw);
      return res.json(wrapResponse(heatmap, ctx));
    },
  );

  /** GET /v1/field/officers/:officer_id/today?tz=Asia/Kolkata
   *  — visits logged "today" in the requested zone. */
  app.get(
    '/v1/field/officers/:officer_id/today',
    requireTenantMw,
    requireRole('customers:read_risk_profile'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const officer_id = req.params.officer_id ?? '';
      const tzRaw = (req.query.tz as string | undefined) ?? 'UTC';
      if (!isVisitTz(tzRaw)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_tz', message: `tz '${tzRaw}' is not in the supported list`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const items = fieldVisitStore.todayForOfficer(
        req.tenant!.tenant_id,
        officer_id,
        now(),
        tzRaw,
      );
      const aggregate = aggregateByOutcome(items);
      return res.json(
        wrapResponse({ officer_id, tz: tzRaw, items, total: items.length, aggregate }, ctx),
      );
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

  /** POST /v1/indicators/backtest/compare (T6 M4.8) — structural diff
   *  between two BacktestResult objects. Caller runs both backtests
   *  via /v1/indicators/backtest and passes the resolved results in
   *  body `{a, b}`. Returns `{diff: BacktestCompareResult}` with
   *  fires/precision/recall/F1/mean_value deltas, per-cell confusion
   *  delta, per-day fires delta on the overlapping window, and
   *  same_indicator / same_segment warning bools. Pure-function; no
   *  per-tenant state involved. */
  app.post(
    '/v1/indicators/backtest/compare',
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
        const diff = compareBacktestFromUnknown(inner);
        return res.json(wrapResponse({ diff }, env));
      } catch (e) {
        if (e instanceof BacktestCompareError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, env),
          );
        }
        throw e;
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

  /** GET /v1/tenants/me/onboarding/skip-history (T6 M2.7) — focused
   *  view of just the caller's tenant skipped onboarding steps with
   *  captured reasons. Companion to M2.6 readiness: that gives a
   *  single number + blockers; this is the auditable "why was each
   *  step skipped?" report. Separates M2.5 explicit-reason skips
   *  from legacy markStep('skipped') skips so compliance can spot
   *  steps lacking the new audit trail. Sorted by step.order asc. */
  app.get(
    '/v1/tenants/me/onboarding/skip-history',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const state = onboardingStore.get(req.tenant!.tenant_id);
      const out = listOnboardingSkips(state);
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/tenants/me/onboarding/readiness (T6 M2.6) — caller's tenant
   *  readiness score derived from the M2.2 onboarding state. Weighted
   *  blend (70% required, 30% overall) + structured blockers + next
   *  pending required step. audit:read RBAC. */
  app.get(
    '/v1/tenants/me/onboarding/readiness',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const state = onboardingStore.get(req.tenant!.tenant_id);
      const { computeOnboardingReadiness } = require('./tenant_onboarding_readiness') as
        typeof import('./tenant_onboarding_readiness');
      const readiness = computeOnboardingReadiness(state);
      return res.json(wrapResponse(readiness, ctx));
    },
  );

  /** GET /v1/tenants/:tenant_id/onboarding/readiness (T6 M2.6) — admin
   *  lookup of any tenant's readiness. Mounted BEFORE the catch-all
   *  `/:tenant_id/onboarding` so the literal /readiness segment isn't
   *  captured as a sub-path of the state route. */
  app.get(
    '/v1/tenants/:tenant_id/onboarding/readiness',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const target = req.params.tenant_id ?? '';
      const state = onboardingStore.get(target);
      const { computeOnboardingReadiness } = require('./tenant_onboarding_readiness') as
        typeof import('./tenant_onboarding_readiness');
      const readiness = computeOnboardingReadiness(state);
      return res.json(wrapResponse(readiness, ctx));
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

  /** POST /v1/tenants/:tenant_id/onboarding/steps/:step_id/skip (T6 M2.5)
   *  body { reason }. Forces status=skipped and captures the regulatory/
   *  compliance reason on the StepProgress for audit + reviewer trail.
   *  Validates reason length [5..500] after whitespace collapse.
   *  MUST be declared BEFORE the catch-all .../steps/:step_id so the
   *  literal "/skip" segment isn't swallowed as a step_id. */
  app.post(
    '/v1/tenants/:tenant_id/onboarding/steps/:step_id/skip',
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
      const wrapper = (inner ?? {}) as { reason?: unknown };
      try {
        const state = onboardingStore.skipStepWithReason(
          target,
          step_id,
          actor_username,
          wrapper.reason,
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
            { code: 'EWS_500', message: e instanceof Error ? e.message : 'skip step failed', severity: 'HIGH' },
            ctx,
          ),
        );
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

  // ── Bulk-import staged preview + apply (T6 M2.4) ────────────────────
  //
  // Stage the operator's intent in a per-tenant preview store with
  // a 10-minute TTL, then commit only those exact rows on apply —
  // no CSV-changed-between-screens race.

  /** POST /v1/tenants/bulk-import/preview — body { csv } → 201
   *  with preview_id + dry-run summary. */
  app.post(
    '/v1/tenants/bulk-import/preview',
    requireTenantMw,
    requireRole('audit:read'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { csv?: unknown };
      const created_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const preview = await createBulkImportPreview(
          bulkImportPreviewStore,
          tenantLookup,
          {
            tenant_id: req.tenant!.tenant_id,
            csv: typeof wrapper.csv === 'string' ? wrapper.csv : '',
            created_by,
            now: now(),
          },
        );
        return res.status(201).json(wrapResponse(preview, ctx));
      } catch (e) {
        if (e instanceof PreviewError) {
          if (e.code === 'cap_reached') {
            return res.status(409).json(
              wrapError({ code: `EWS_409_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
            );
          }
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        if (e instanceof TenantBulkError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/tenants/bulk-import/previews — list active previews. */
  app.get(
    '/v1/tenants/bulk-import/previews',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items = bulkImportPreviewStore.list(req.tenant!.tenant_id, now());
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/tenants/bulk-import/apply — body { preview_id } →
   *  consumes the preview + commits the snapshotted rows. */
  app.post(
    '/v1/tenants/bulk-import/apply',
    requireTenantMw,
    requireRole('audit:read'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { preview_id?: unknown };
      if (typeof wrapper.preview_id !== 'string' || !wrapper.preview_id.trim()) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'preview_id required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const out = await applyBulkImportPreview(
          bulkImportPreviewStore,
          tenantLookup,
          {
            tenant_id: req.tenant!.tenant_id,
            preview_id: wrapper.preview_id.trim(),
            now: now(),
          },
        );
        return res.json(
          wrapResponse({ preview: out.preview, result: out.result }, ctx),
        );
      } catch (e) {
        if (e instanceof PreviewError) {
          if (e.code === 'unknown_preview') {
            return res.status(404).json(
              wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
            );
          }
          if (e.code === 'preview_expired' || e.code === 'preview_not_pending') {
            return res.status(410).json(
              wrapError({ code: `EWS_410_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
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

  /** DELETE /v1/tenants/bulk-import/preview/:preview_id — cancel. */
  app.delete(
    '/v1/tenants/bulk-import/preview/:preview_id',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.preview_id ?? '';
      try {
        const cancelled = bulkImportPreviewStore.cancel(req.tenant!.tenant_id, id, now());
        return res.json(wrapResponse(cancelled, ctx));
      } catch (e) {
        if (e instanceof PreviewError) {
          if (e.code === 'unknown_preview') {
            return res.status(404).json(
              wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
            );
          }
          if (e.code === 'preview_not_pending') {
            return res.status(410).json(
              wrapError({ code: `EWS_410_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
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

  /** GET /v1/admin/config/override-ages?fresh_days=&stale_days= (T6 M13.11)
   *  — per-override age tracker. For each tenant override, compute
   *  age_days + bucket into recent/stable/stale via the configurable
   *  thresholds (defaults: fresh<30d → recent; >90d → stale; in
   *  between → stable). Envelope has oldest/newest pointers + bucket
   *  counts so the SPA can render a "config that needs review"
   *  banner. Sorted by age_days desc with key asc tie-break. */
  app.get(
    '/v1/admin/config/override-ages',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const freshRaw = req.query.fresh_days as string | undefined;
      const staleRaw = req.query.stale_days as string | undefined;
      const fresh_days = freshRaw === undefined ? 30 : Number(freshRaw);
      const stale_days = staleRaw === undefined ? 90 : Number(staleRaw);
      if (!Number.isFinite(fresh_days) || !Number.isFinite(stale_days)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'fresh_days + stale_days must be finite numbers', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const entries = configStore.list(req.tenant!.tenant_id);
        const { analyseConfigOverrideAges, OverrideAgeError } = require('./admin_config_override_age') as
          typeof import('./admin_config_override_age');
        try {
          const out = analyseConfigOverrideAges(req.tenant!.tenant_id, entries, now(), fresh_days, stale_days);
          return res.json(wrapResponse(out, ctx));
        } catch (e) {
          if (e instanceof OverrideAgeError) {
            return res.status(400).json(
              wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
            );
          }
          throw e;
        }
      } catch (e) {
        throw e;
      }
    },
  );

  /** GET /v1/admin/config/catalog (T6 M13.10) — schema-only view of the
   *  config registry: per-key {key, category, type, default_value,
   *  description} grouped by category + by_type counts. Lets the SPA
   *  admin form render type-appropriate controls (number stepper,
   *  toggle, textarea for json) without inferring type from value.
   *  Platform-static (same response per tenant). Mounted BEFORE the
   *  catch-all GET /v1/admin/config and `/:key` routes so the literal
   *  `/catalog` segment wins. */
  app.get(
    '/v1/admin/config/catalog',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const { introspectConfigCatalog } = require('./admin_config_catalog') as
        typeof import('./admin_config_catalog');
      const out = introspectConfigCatalog();
      return res.json(wrapResponse(out, ctx));
    },
  );

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
  /** GET /v1/admin/config/summary.txt (T6 M13.9) — printable plain-text
   *  summary of every config key with effective value + override
   *  metadata. Mirrors M15.4 (audit evidence) + M7.6 (model
   *  performance) style. text/plain + Content-Disposition for browser
   *  print-to-PDF. Mounted BEFORE GET /v1/admin/config so the literal
   *  /summary.txt suffix isn't lost in the catch-all. */
  app.get(
    '/v1/admin/config/summary.txt',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const generated_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const entries = configStore.list(req.tenant!.tenant_id);
      const { renderConfigSummary } = require('./admin_config_summary') as
        typeof import('./admin_config_summary');
      const text = renderConfigSummary(req.tenant!.tenant_id, entries, {
        generated_at: now().toISOString(),
        generated_by,
      });
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set(
        'Content-Disposition',
        `inline; filename="${req.tenant!.tenant_id}.admin-config.summary.txt"`,
      );
      void ctx;
      return res.status(200).send(text);
    },
  );

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

  /** POST /v1/admin/config/_clone/selective (T6 M13.7) — copy ONLY the
   *  listed keys from the source tenant's overrides into the caller's
   *  tenant. Body { source_tenant_id, keys: string[], dry_run? }.
   *  Returns SelectiveCloneSummary (ImportSummary + not_in_source +
   *  requested_keys). Admin-only.
   *
   *  M13.6 stays as the full-snapshot variant; this is a strict
   *  additive sibling for the operator who wants to migrate a SUBSET
   *  of tunables (e.g. just the threshold overrides, not the channel
   *  toggles). */
  app.post(
    '/v1/admin/config/_clone/selective',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const applied_by =
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as {
        source_tenant_id?: unknown;
        keys?: unknown;
        dry_run?: unknown;
      };
      try {
        const summary = cloneTenantConfigSelective(
          configStore,
          typeof wrapper.source_tenant_id === 'string' ? wrapper.source_tenant_id : '',
          req.tenant!.tenant_id,
          Array.isArray(wrapper.keys) ? (wrapper.keys as unknown[]) : [],
          applied_by,
          wrapper.dry_run === true,
          now(),
        );
        return res.json(wrapResponse(summary, ctx));
      } catch (e) {
        if (e instanceof ConfigBulkError) {
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

  /** POST /v1/admin/config/_reset-category (T6 M13.8) — bulk-reset
   *  every tenant override in a category back to its platform default.
   *  Body { category: ConfigCategory, dry_run?: boolean }.
   *  Returns per-key outcomes: keys with an override get reset (or
   *  previewed when dry_run=true); keys already at default get skipped
   *  with reason='no_override'. Audit-event writes match the
   *  single-DELETE route (one `config.reset` per actually-reset key
   *  with metadata { previous_value, default_value, bulk:true }).
   *  Mounted BEFORE DELETE /:key + GET /:key/history so the literal
   *  "_reset-category" segment isn't captured as a key. */
  app.post(
    '/v1/admin/config/_reset-category',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const reset_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { category?: unknown; dry_run?: unknown };
      const validCategories: readonly ConfigCategory[] = [
        'alerts',
        'notifications',
        'reporting',
        'scoring',
        'features',
      ];
      if (
        typeof wrapper.category !== 'string' ||
        !validCategories.includes(wrapper.category as ConfigCategory)
      ) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: `category must be one of ${validCategories.join(', ')}`,
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const category = wrapper.category as ConfigCategory;
      const dry_run = wrapper.dry_run === true;
      const tenantId = req.tenant!.tenant_id;
      const entries = configStore.list(tenantId).filter((e) => e.category === category);
      const reset: Array<{
        key: string;
        previous_value: ConfigValue;
        default_value: ConfigValue;
      }> = [];
      const skipped: Array<{ key: string; reason: string }> = [];

      for (const entry of entries) {
        if (entry.is_default) {
          skipped.push({ key: entry.key, reason: 'no_override' });
          continue;
        }
        const previous_value = entry.value;
        if (dry_run) {
          reset.push({
            key: entry.key,
            previous_value,
            default_value: entry.default_value,
          });
          continue;
        }
        try {
          const reverted = configStore.reset(tenantId, entry.key);
          reset.push({
            key: entry.key,
            previous_value,
            default_value: reverted.value,
          });
          // Best-effort audit per key — mirror the single-DELETE shape
          // with a bulk:true marker.
          try {
            auditTrailStore.record(
              tenantId,
              {
                actor_username: reset_by,
                actor_role: 'admin',
                action: 'config.reset',
                resource_type: 'config',
                resource_id: entry.key,
                outcome: 'success',
                severity: 'info',
                metadata: {
                  previous_value,
                  default_value: reverted.value,
                  bulk: true,
                  category,
                },
              },
              now(),
            );
          } catch {
            // swallow
          }
        } catch {
          // Defensive — should never happen since we just listed the
          // key, but covers a race where another caller raced us.
          skipped.push({ key: entry.key, reason: 'reset_failed' });
        }
      }

      return res.json(
        wrapResponse(
          {
            category,
            dry_run,
            total_keys_in_category: entries.length,
            reset_count: reset.length,
            skipped_count: skipped.length,
            reset,
            skipped,
          },
          ctx,
        ),
      );
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

  /** GET /v1/audit/integrity/sample?window=N (T6 M15.5) — spot-check
   *  the newest N events. Cheaper than M15.2's full-chain walk for
   *  dashboard health-pulse polling. Verifies hashes + prev_hash
   *  links within the window AND that the first event in the window
   *  correctly chains to the event before it (or 'GENESIS' when the
   *  window covers the entire chain). Default window=50, max=500. */
  app.get(
    '/v1/audit/integrity/sample',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const windowRaw = req.query.window as string | undefined;
      const window =
        windowRaw === undefined ? CHAIN_SAMPLE_DEFAULT_WINDOW : Number(windowRaw);
      if (!Number.isInteger(window) || window < 1 || window > CHAIN_SAMPLE_MAX_WINDOW) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: `window must be 1..${CHAIN_SAMPLE_MAX_WINDOW}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const out = auditTrailStore.verifyChainSample(req.tenant!.tenant_id, window, now());
      return res.json(wrapResponse(out, ctx));
    },
  );

  /** GET /v1/audit/catalog (T6 M15.6) — discoverable per-action catalog.
   *  For each distinct action emitted by this tenant, returns the
   *  observed_count, distinct resource_types, union of metadata keys,
   *  and latest event timestamp + actor. Lets the SPA build a
   *  data-driven filter dropdown instead of hardcoding the action list. */
  app.get(
    '/v1/audit/catalog',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const page = auditTrailStore.list(req.tenant!.tenant_id, { page_size: 100000 });
      const out = introspectAuditCatalog(page.items);
      return res.json(wrapResponse(out, ctx));
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

  /** GET /v1/audit/evidence/:package_id/summary.txt (T6 M15.4)
   *  — printable plain-text summary suitable for browser print-to-PDF.
   *  Returns text/plain (NOT the T4.24 envelope) so the SPA can pipe
   *  it straight to a print preview. */
  app.get(
    '/v1/audit/evidence/:package_id/summary.txt',
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
      const text = renderEvidenceSummary(pkg);
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set(
        'Content-Disposition',
        `inline; filename="${package_id}.summary.txt"`,
      );
      void ctx;
      return res.status(200).send(text);
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

  /** GET /v1/ingestion/connectors/:id/runs/analytics?window=20 (T6 M3.5)
   *  — aggregate metrics: success rate, mean/p50/p95 latency,
   *  records processed, last failure. */
  app.get(
    '/v1/ingestion/connectors/:id/runs/analytics',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const windowRaw = req.query.window as string | undefined;
      const window = windowRaw === undefined
        ? RUN_ANALYTICS_DEFAULT_WINDOW
        : Number(windowRaw);
      if (!Number.isInteger(window) || window < 1 || window > RUN_ANALYTICS_MAX_WINDOW) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: `window must be 1..${RUN_ANALYTICS_MAX_WINDOW}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const runs = ingestionRegistry.listRuns(req.tenant!.tenant_id, id, window);
        const analytics = aggregateRunAnalytics(runs);
        return res.json(
          wrapResponse({ connector_id: id, window, analytics }, ctx),
        );
      } catch (e) {
        if (e instanceof IngestionError && e.code === 'unknown_connector') {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404_unknown_connector', message: e.message, severity: 'LOW' },
              ctx,
            ),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/ingestion/connectors/:id/runs/failure-patterns?window=N
   *  (T6 M3.6) — cluster failed/partial runs by normalized error
   *  message. Same window semantics as M3.5 (default 20, max 200).
   *  Returns top 10 clusters with pattern + count + recent_messages
   *  (3 newest) + last_failed_at + sample_run_id. */
  app.get(
    '/v1/ingestion/connectors/:id/runs/failure-patterns',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const windowRaw = req.query.window as string | undefined;
      const window =
        windowRaw === undefined ? RUN_ANALYTICS_DEFAULT_WINDOW : Number(windowRaw);
      if (!Number.isInteger(window) || window < 1 || window > RUN_ANALYTICS_MAX_WINDOW) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: `window must be 1..${RUN_ANALYTICS_MAX_WINDOW}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const runs = ingestionRegistry.listRuns(req.tenant!.tenant_id, id, window);
        const { clusterRunFailures } = require('./connector_run_failure_patterns') as
          typeof import('./connector_run_failure_patterns');
        const patterns = clusterRunFailures(runs);
        return res.json(
          wrapResponse({ connector_id: id, window, patterns }, ctx),
        );
      } catch (e) {
        if (e instanceof IngestionError && e.code === 'unknown_connector') {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404_unknown_connector', message: e.message, severity: 'LOW' },
              ctx,
            ),
          );
        }
        throw e;
      }
    },
  );

  /** GET /v1/ingestion/adapters/sla-dashboard (T6 M14.11) — fleet-wide
   *  SLA dashboard. Runs M3.5 analytics across every connector for the
   *  tenant + applies per-adapter SLA gates.
   *
   *  Query params (all optional):
   *    window=N                 (default 20, max RUN_ANALYTICS_MAX_WINDOW)
   *    min_success_rate=0..1    (default 0.95)
   *    max_p95_latency_ms=ms    (default 30000, max 86_400_000)
   *
   *  Connectors with no finished runs in the window report
   *  sla_status='unknown' (not 'breached'). */
  app.get(
    '/v1/ingestion/adapters/sla-dashboard',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const windowRaw = req.query.window as string | undefined;
      const window =
        windowRaw === undefined ? RUN_ANALYTICS_DEFAULT_WINDOW : Number(windowRaw);
      if (
        !Number.isInteger(window) ||
        window < 1 ||
        window > RUN_ANALYTICS_MAX_WINDOW
      ) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: `window must be 1..${RUN_ANALYTICS_MAX_WINDOW}`,
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      // Build per-call override ONLY from what the caller supplied so
      // resolveSlaTargets can fall back to the tenant store / platform
      // default for missing fields.
      const perCall: Partial<AdapterSlaTargets> = {};
      if (typeof req.query.min_success_rate === 'string') {
        const n = Number(req.query.min_success_rate);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          return res.status(400).json(
            wrapError(
              {
                code: 'EWS_400_invalid_input',
                message: 'min_success_rate must be in [0, 1]',
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
        perCall.min_success_rate = n;
      }
      if (typeof req.query.max_p95_latency_ms === 'string') {
        const n = Number(req.query.max_p95_latency_ms);
        if (!Number.isFinite(n) || n < 0 || n > 86_400_000) {
          return res.status(400).json(
            wrapError(
              {
                code: 'EWS_400_invalid_input',
                message: 'max_p95_latency_ms must be in [0, 86400000]',
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
        perCall.max_p95_latency_ms = n;
      }
      const tenantId = req.tenant!.tenant_id;
      const targets = resolveSlaTargets(
        adapterSlaTargetsStore,
        tenantId,
        Object.keys(perCall).length === 0 ? null : perCall,
      );
      const connectors = ingestionRegistry.list(tenantId);
      const runsByConnectorId = new Map<string, readonly ConnectorRun[]>();
      for (const c of connectors) {
        runsByConnectorId.set(c.id, ingestionRegistry.listRuns(tenantId, c.id, window));
      }
      const dashboard = buildAdapterSlaDashboard(connectors, runsByConnectorId, targets, {
        window,
        now: now(),
      });
      // Sanity check (silences unused-import in some builds): default
      // targets are exposed on the response so the SPA can show
      // "evaluated against ... (default …)".
      void DEFAULT_SLA_TARGETS;
      return res.json(wrapResponse(dashboard, ctx));
    },
  );

  /** GET /v1/ingestion/adapters/sla-targets (T6 M14.12) — read the
   *  caller's tenant SLA targets. When the tenant has no override,
   *  returns the platform defaults with `updated_at: null`. */
  app.get(
    '/v1/ingestion/adapters/sla-targets',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const record = adapterSlaTargetsStore.get(req.tenant!.tenant_id);
      return res.json(
        wrapResponse(
          {
            ...record,
            default_targets: DEFAULT_SLA_TARGETS,
            is_override: record.updated_at !== null,
          },
          ctx,
        ),
      );
    },
  );

  /** PUT /v1/ingestion/adapters/sla-targets (T6 M14.12) — set the
   *  tenant override. Body { min_success_rate, max_p95_latency_ms }.
   *  Admin-only. */
  app.put(
    '/v1/ingestion/adapters/sla-targets',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const updated_by =
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      try {
        const targets = validateSlaTargets(inner);
        const out = adapterSlaTargetsStore.set(
          req.tenant!.tenant_id,
          targets,
          updated_by,
          now(),
        );
        return res.json(
          wrapResponse(
            { ...out, default_targets: DEFAULT_SLA_TARGETS, is_override: true },
            ctx,
          ),
        );
      } catch (e) {
        if (e instanceof AdapterSlaError) {
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

  /** DELETE /v1/ingestion/adapters/sla-targets (T6 M14.12) — drop the
   *  tenant override; subsequent dashboard calls fall back to the
   *  platform defaults. Returns { reset: bool }. */
  app.delete(
    '/v1/ingestion/adapters/sla-targets',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const reset = adapterSlaTargetsStore.reset(req.tenant!.tenant_id);
      return res.json(wrapResponse({ reset }, ctx));
    },
  );

  /** POST /v1/ingestion/adapters/sla-snapshot (T6 M14.13) — observe
   *  the current dashboard + record one event per breached row to the
   *  audit store. Returns the dashboard plus the freshly-recorded
   *  event list so the operator can see exactly what was logged.
   *
   *  Use case: cron-trigger every 5 minutes to build a breach
   *  history operators can replay later. Manual button in the SPA
   *  also fires this on demand.
   *
   *  Same query params as `/sla-dashboard` (window + per-call target
   *  overrides apply identically). */
  app.post(
    '/v1/ingestion/adapters/sla-snapshot',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const windowRaw = req.query.window as string | undefined;
      const window =
        windowRaw === undefined ? RUN_ANALYTICS_DEFAULT_WINDOW : Number(windowRaw);
      if (
        !Number.isInteger(window) ||
        window < 1 ||
        window > RUN_ANALYTICS_MAX_WINDOW
      ) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: `window must be 1..${RUN_ANALYTICS_MAX_WINDOW}`,
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const perCall: Partial<AdapterSlaTargets> = {};
      if (typeof req.query.min_success_rate === 'string') {
        const n = Number(req.query.min_success_rate);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'min_success_rate must be in [0, 1]', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        perCall.min_success_rate = n;
      }
      if (typeof req.query.max_p95_latency_ms === 'string') {
        const n = Number(req.query.max_p95_latency_ms);
        if (!Number.isFinite(n) || n < 0 || n > 86_400_000) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'max_p95_latency_ms must be in [0, 86400000]', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        perCall.max_p95_latency_ms = n;
      }
      const tenantId = req.tenant!.tenant_id;
      const targets = resolveSlaTargets(
        adapterSlaTargetsStore,
        tenantId,
        Object.keys(perCall).length === 0 ? null : perCall,
      );
      const connectors = ingestionRegistry.list(tenantId);
      const runsByConnectorId = new Map<string, readonly ConnectorRun[]>();
      for (const c of connectors) {
        runsByConnectorId.set(c.id, ingestionRegistry.listRuns(tenantId, c.id, window));
      }
      const dashboard = buildAdapterSlaDashboard(connectors, runsByConnectorId, targets, {
        window,
        now: now(),
      });
      const recorded = recordBreachEvents(
        adapterSlaBreachEventStore,
        dashboard,
        tenantId,
        now(),
        randomUUID,
      );
      return res.json(
        wrapResponse(
          { dashboard, recorded_events: recorded, recorded_count: recorded.length },
          ctx,
        ),
      );
    },
  );

  /** GET /v1/ingestion/adapters/sla-breaches?since=ISO&limit=N (T6 M14.13)
   *  — list recorded breach events newest-first. */
  app.get(
    '/v1/ingestion/adapters/sla-breaches',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const sinceRaw = req.query.since;
      let since: Date | undefined;
      if (typeof sinceRaw === 'string' && sinceRaw.trim()) {
        const d = new Date(sinceRaw);
        if (!Number.isFinite(d.getTime())) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_since', message: 'since must be a valid ISO timestamp', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        since = d;
      }
      const limitRaw = req.query.limit;
      let limit: number | undefined;
      if (typeof limitRaw === 'string' && limitRaw.trim()) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n <= 0 || n > 200) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_limit', message: 'limit must be 1-200', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        limit = n;
      }
      // M14.14 — optional ?acknowledged=true|false filter
      let acknowledged: boolean | undefined;
      const ackRaw = req.query.acknowledged;
      if (typeof ackRaw === 'string' && ackRaw.trim()) {
        if (ackRaw === 'true') acknowledged = true;
        else if (ackRaw === 'false') acknowledged = false;
        else {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'acknowledged must be true|false', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
      }
      const tenantId = req.tenant!.tenant_id;
      const items = adapterSlaBreachEventStore.query(tenantId, { since, limit, acknowledged });
      const total = adapterSlaBreachEventStore.count(tenantId);
      return res.json(
        wrapResponse({ items, total, returned: items.length }, ctx),
      );
    },
  );

  /** GET /v1/ingestion/adapters/sla-breaches/analytics?since=ISO
   *  (T6 M14.20) — tenant-wide rollup over the M14.13 adapter SLA
   *  breach event store: sample size, distinct connectors, ack split,
   *  ack_rate, by_reason (every key present), by_day (UTC oldest-first),
   *  top_breachers (cap 10) with per-connector breach_count +
   *  last_breached_at + recent_reasons. Mounted BEFORE the DELETE on
   *  /v1/ingestion/adapters/sla-breaches and BEFORE the
   *  /:event_id/acknowledge wildcard so the literal "analytics" segment
   *  isn't captured. */
  app.get(
    '/v1/ingestion/adapters/sla-breaches/analytics',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const sinceRaw = req.query.since;
      let since: Date | undefined;
      if (typeof sinceRaw === 'string' && sinceRaw.trim()) {
        const d = new Date(sinceRaw);
        if (!Number.isFinite(d.getTime())) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'since must be a valid ISO-8601 timestamp', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        since = d;
      }
      const events = adapterSlaBreachEventStore.query(req.tenant!.tenant_id, { since });
      const { summarizeBreachEvents } = require('./adapter_sla_breach_analytics') as
        typeof import('./adapter_sla_breach_analytics');
      const analytics = summarizeBreachEvents(events);
      return res.json(wrapResponse({ analytics }, ctx));
    },
  );

  /** DELETE /v1/ingestion/adapters/sla-breaches (T6 M14.13) — wipe the
   *  tenant's audit history. Returns { cleared: N }. */
  app.delete(
    '/v1/ingestion/adapters/sla-breaches',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const cleared = adapterSlaBreachEventStore.clear(req.tenant!.tenant_id);
      return res.json(wrapResponse({ cleared }, ctx));
    },
  );

  /** POST /v1/ingestion/adapters/sla-breaches/:event_id/acknowledge (T6 M14.14)
   *  — operator acknowledges a recorded breach event so downstream
   *  alerting can dedup repeat pages on the same incident. Body
   *  `{ note?: string }` (optional 0-500 char free text). Idempotent
   *  — re-ack on an already-acknowledged event returns 200 with
   *  `already: true` and leaves the original ack metadata intact so
   *  the audit trail stays honest about who acked first. */
  app.post(
    '/v1/ingestion/adapters/sla-breaches/:event_id/acknowledge',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const eventId = req.params.event_id ?? '';
      if (!eventId.trim()) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'event_id is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const noteIn =
        inner && typeof inner === 'object' && 'note' in (inner as object)
          ? (inner as { note?: unknown }).note
          : undefined;
      let note: string | undefined;
      if (noteIn !== undefined && noteIn !== null) {
        if (typeof noteIn !== 'string') {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'note must be a string', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        const trimmed = noteIn.trim();
        if (trimmed.length > 500) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'note max length is 500 chars', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        if (trimmed.length > 0) note = trimmed;
      }
      const actor =
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const result = adapterSlaBreachEventStore.acknowledge(
        req.tenant!.tenant_id,
        eventId,
        actor,
        now(),
        note,
      );
      if (!result.event) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_event', message: `unknown breach event: ${eventId}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(
        wrapResponse({ event: result.event, already: result.already }, ctx),
      );
    },
  );

  /** POST /v1/ingestion/connectors/:id/schema/compare (T6 M3.9) —
   *  forward-looking compat check: given a candidate schema, report
   *  what BREAKS for existing publishers and what's ADDITIVE. Mirror
   *  of infra/schema-registry/scripts/check_compat.py for the M3.2
   *  connector schema shape. Mounted BEFORE other /schema/* routes
   *  so the literal /compare segment wins. */
  app.post(
    '/v1/ingestion/connectors/:id/schema/compare',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const current = getConnectorSchema(id);
      if (!current) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_connector', message: `unknown connector: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { candidate?: unknown };
      if (!wrapper.candidate) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'candidate schema is required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const { compareConnectorSchemas, validateCandidateSchema, SchemaCompatInputError } = require('./connector_schema_compat') as
          typeof import('./connector_schema_compat');
        const candidate = validateCandidateSchema(wrapper.candidate, id);
        const out = compareConnectorSchemas(current, candidate);
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        const { SchemaCompatInputError } = require('./connector_schema_compat') as
          typeof import('./connector_schema_compat');
        if (e instanceof SchemaCompatInputError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
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

  /** GET /v1/ingestion/schema/field-index (T6 M3.8) — inverted index
   *  over every connector's fields. For each unique field_name across
   *  the platform schema catalogue, returns the connector_ids that
   *  carry it + the distinct observed types (multi-entry signals
   *  type drift across connectors). Useful for the dataops integrity-
   *  audit dashboard ("which connectors share a `customer_id` field
   *  and do they all agree it's a string?"). Mounted BEFORE
   *  `/v1/ingestion/connectors/:id/schema` so the literal
   *  `/schema/field-index` segment isn't captured. */
  app.get(
    '/v1/ingestion/schema/field-index',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const ids = listSchemaConnectorIds();
      const out = indexConnectorSchemaFields(ids, getConnectorSchema);
      return res.json(wrapResponse(out, ctx));
    },
  );

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

  /** GET /v1/ingestion/connectors/:id/schema/source-map (T6 M3.7) —
   *  per-field source attribution (platform vs tenant_addition).
   *  Companion to /schema/effective that lets the SPA badge each
   *  field's origin without comparing platform vs effective by hand.
   *  audit:read RBAC; 404 unknown_connector. */
  app.get(
    '/v1/ingestion/connectors/:id/schema/source-map',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.id ?? '';
      const platform = getConnectorSchema(id);
      if (!platform) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_connector', message: `unknown connector: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const overrides = schemaOverrideStore.list(req.tenant!.tenant_id, id);
      const { mapConnectorSchemaSources } = require('./connector_schema_source_map') as
        typeof import('./connector_schema_source_map');
      const out = mapConnectorSchemaSources(platform, overrides);
      return res.json(wrapResponse(out, ctx));
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
        message: 'ZorEWS webhook test event',
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

  /** GET /v1/reports/jobs/analytics (T6 M12.5) — supervisor rollup
   *  over the M12.1 reports-job ledger: status mix, format mix,
   *  per-report counts + success rate + mean processing time, top
   *  requesters (cap 10), processing latency percentiles, last failure.
   *
   *  Optional ?status= / ?report_id= filters reuse the M12.1 list shape.
   *  MUST be registered before /v1/reports/jobs/:job_id so the literal
   *  segment doesn't get captured as a job_id. */
  app.get(
    '/v1/reports/jobs/analytics',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query as Record<string, string | undefined>;
      const filters: { status?: JobStatus; report_id?: string; page_size?: number } = {
        page_size: 200,
      };
      if (typeof q.status === 'string' && q.status) {
        if (!isJobStatus(q.status)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: `status must be queued|running|completed|failed`, severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filters.status = q.status;
      }
      if (typeof q.report_id === 'string' && q.report_id) filters.report_id = q.report_id;
      const page = reportJobStore.list(req.tenant!.tenant_id, filters);
      const analytics = summarizeReportJobs(page.items);
      return res.json(wrapResponse({ analytics, sample_total: page.total }, ctx));
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

  /** GET /v1/reports/schedules/conflicts?window=15&n=10&from=ISO
   *  (T6 M12.8) — finds pairs of DIFFERENT schedules whose fire_at
   *  falls within `window` minutes of each other. Useful for ops to
   *  spot resource contention (two heavy reports firing the same
   *  minute and slamming the database). Same-schedule self-pairs are
   *  filtered out. Mounted BEFORE /:schedule_id so the literal
   *  /conflicts wins. */
  app.get(
    '/v1/reports/schedules/conflicts',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const windowRaw = req.query.window as string | undefined;
      const nRaw = req.query.n as string | undefined;
      const fromRaw = req.query.from as string | undefined;
      const window_minutes = windowRaw === undefined ? 15 : Number(windowRaw);
      const lookahead_n = nRaw === undefined ? 10 : Number(nRaw);
      const from = fromRaw ? new Date(fromRaw) : now();
      try {
        const page = reportScheduleStore.list(req.tenant!.tenant_id, 1, 500);
        const { detectScheduleConflicts, ConflictDetectionError } = require('./schedule_conflict_detection') as
          typeof import('./schedule_conflict_detection');
        try {
          const out = detectScheduleConflicts(page.items, from, window_minutes, lookahead_n);
          return res.json(wrapResponse(out, ctx));
        } catch (e) {
          if (e instanceof ConflictDetectionError) {
            return res.status(400).json(
              wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
            );
          }
          throw e;
        }
      } catch (e) {
        throw e;
      }
    },
  );

  /** GET /v1/reports/schedules/upcoming?n=20&from=ISO (T6 M12.7)
   *  — fleet-wide calendar view: walks every ENABLED schedule in
   *  the tenant, generates each schedule's next-N firings via
   *  previewScheduleEntryRuns, merges them sorted by fire_at asc,
   *  and trims to the top n overall. Useful for a SPA calendar
   *  ("what's firing in the next hour / day / week across all
   *  my schedules?"). Mounted BEFORE /:schedule_id so the literal
   *  /upcoming wins. */
  app.get(
    '/v1/reports/schedules/upcoming',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const nRaw = req.query.n as string | undefined;
      const fromRaw = req.query.from as string | undefined;
      const n = nRaw === undefined ? 20 : Number(nRaw);
      const from = fromRaw ? new Date(fromRaw) : now();
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'n must be an integer in 1..100', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (Number.isNaN(from.getTime())) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'from must be an ISO timestamp', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const page = reportScheduleStore.list(req.tenant!.tenant_id, 1, 500);
      const { previewScheduleFleet } = require('./report_schedule_fleet_preview') as
        typeof import('./report_schedule_fleet_preview');
      const out = previewScheduleFleet(page.items, from, n);
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

  /** GET /v1/reports/schedules/:schedule_id/preview?n=10&from=ISO
   *  (T6 M12.6) — project the next N firings of a saved schedule by
   *  iterating M12.2 computeNextRun. n bounded [1, 50], default 10.
   *  from defaults to now(). audit:read RBAC. Mounted BEFORE the
   *  catch-all `/:schedule_id` so the literal /preview segment isn't
   *  captured as a schedule_id. */
  app.get(
    '/v1/reports/schedules/:schedule_id/preview',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.schedule_id ?? '';
      const entry = reportScheduleStore.get(req.tenant!.tenant_id, id);
      if (!entry) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_schedule', message: `schedule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const {
        previewScheduleEntryRuns,
        PREVIEW_DEFAULT_N,
        PREVIEW_MAX_N,
        SchedulePreviewError,
      } = require('./report_schedule_preview') as
        typeof import('./report_schedule_preview');
      const nRaw = req.query.n as string | undefined;
      const n = nRaw === undefined ? PREVIEW_DEFAULT_N : Number(nRaw);
      if (!Number.isInteger(n) || n < 1 || n > PREVIEW_MAX_N) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: `n must be an integer in 1..${PREVIEW_MAX_N}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const fromRaw = req.query.from as string | undefined;
      let from = now();
      if (typeof fromRaw === 'string' && fromRaw.trim()) {
        const d = new Date(fromRaw);
        if (!Number.isFinite(d.getTime())) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'from must be a valid ISO-8601 timestamp', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        from = d;
      }
      try {
        const runs = previewScheduleEntryRuns(entry, from, n);
        return res.json(
          wrapResponse({ schedule_id: id, n, from: from.toISOString(), runs }, ctx),
        );
      } catch (e) {
        if (e instanceof SchedulePreviewError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
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

  /** GET /v1/rules/templates/indicator-coverage (T6 M5.14) — cross-
   *  reference each rule template's supporting_indicators against
   *  the M6.2 catalog. Per-template: indicators_total / known_count /
   *  unknown_count / vertical_mismatch_count + status enum
   *  (fully_resolved | has_unknown | has_mismatch | no_indicators).
   *  Envelope counters partition the template set. Lets ops catch
   *  drift when an indicator was renamed in the catalog but the
   *  template wasn't updated. Platform-static (same across tenants).
   *  Mounted BEFORE the catch-all `/:id` so the literal segment wins. */
  app.get(
    '/v1/rules/templates/indicator-coverage',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const { checkTemplateIndicatorCoverage } = require('./template_indicator_coverage') as
        typeof import('./template_indicator_coverage');
      const out = checkTemplateIndicatorCoverage();
      return res.json(wrapResponse(out, ctx));
    },
  );

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

  // ── Custom rule template export/import bundle (T6 M5.11) ────────────
  //
  // JSON envelope for migrating custom templates between tenants.
  // Both routes are literal segments — declared BEFORE the
  // `:template_id` PUT/DELETE so the param doesn't shadow.

  /** POST /v1/rules/templates/custom/export-bundle (T6 M5.11)
   *  body { template_ids: string[] } → bundle envelope. */
  app.post(
    '/v1/rules/templates/custom/export-bundle',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { template_ids?: unknown };
      const exported_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const bundle = exportRuleTemplateBundle(customRuleTemplateStore, {
          tenant_id: req.tenant!.tenant_id,
          template_ids: Array.isArray(wrapper.template_ids)
            ? (wrapper.template_ids as string[])
            : [],
          exported_by,
          now: now(),
        });
        return res.json(wrapResponse(bundle, ctx));
      } catch (e) {
        if (e instanceof BundleError) {
          if (e.code === 'unknown_template') {
            return res.status(404).json(
              wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
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

  /** POST /v1/rules/templates/custom/import-bundle (T6 M5.11)
   *  body { bundle, name_prefix? } → per-row import outcomes. */
  app.post(
    '/v1/rules/templates/custom/import-bundle',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const wrapper = (inner ?? {}) as { bundle?: unknown; name_prefix?: unknown };
      const imported_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const result = importRuleTemplateBundle(customRuleTemplateStore, {
          target_tenant_id: req.tenant!.tenant_id,
          bundle: wrapper.bundle,
          imported_by,
          name_prefix:
            typeof wrapper.name_prefix === 'string' ? wrapper.name_prefix : undefined,
          now: now(),
        });
        return res.status(201).json(wrapResponse(result, ctx));
      } catch (e) {
        if (e instanceof BundleError) {
          return res.status(400).json(
            wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx),
          );
        }
        throw e;
      }
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

  /** GET /v1/rules/templates/custom/:template_id/versions (T6 M5.12)
   *  — version snapshots oldest-first. Cap 20 per template; restored
   *  templates re-snapshot so the restore itself is auditable. */
  app.get(
    '/v1/rules/templates/custom/:template_id/versions',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.template_id ?? '';
      const live = customRuleTemplateStore.get(req.tenant!.tenant_id, id);
      if (!live) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_template', message: `custom template ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const items = customRuleTemplateStore.listVersions(req.tenant!.tenant_id, id);
      return res.json(
        wrapResponse({ items, total: items.length, template_id: id }, ctx),
      );
    },
  );

  /** POST /v1/rules/templates/custom/:template_id/versions/:version/restore
   *  (T6 M5.12) — restore the live template to the captured version.
   *  Returns {template, restored_from_version}. Pushes a new version
   *  snapshot recording the restore. */
  app.post(
    '/v1/rules/templates/custom/:template_id/versions/:version/restore',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.template_id ?? '';
      const versionRaw = req.params.version ?? '';
      const version = Number(versionRaw);
      if (!Number.isInteger(version) || version < 1) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'version must be a positive integer', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const restored_by = ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      try {
        const out = customRuleTemplateStore.restoreVersion(
          req.tenant!.tenant_id,
          id,
          version,
          restored_by,
          now(),
        );
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        if (e instanceof CustomRuleTemplateError) {
          if (e.code === 'unknown_template' || e.code === 'unknown_version') {
            return res.status(404).json(
              wrapError({ code: `EWS_404_${e.code}`, message: e.message, severity: 'LOW' }, ctx),
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

  /** GET /v1/rules/templates/:template_id/clones-in-tenant (T6 M5.13)
   *  — back-reference query: for this library template, list every
   *  custom template in the calling tenant that was cloned from it
   *  (per the M5.9/M5.10 `cloned_from` audit metadata). Companion
   *  to M5.7 (per-custom audit history): that asks "show me the
   *  trail for THIS custom template"; this asks "show me every
   *  custom template traced back to THIS library template" —
   *  opposite direction across the same audit data. Mounted
   *  BEFORE `/:id` so the literal `/clones-in-tenant` segment
   *  isn't captured. 404 EWS_404_unknown_template when the library
   *  id doesn't exist. */
  app.get(
    '/v1/rules/templates/:template_id/clones-in-tenant',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.template_id ?? '';
      const tpl = getRuleTemplate(id);
      if (!tpl) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_template', message: `unknown template: ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const page = auditTrailStore.list(req.tenant!.tenant_id, { page_size: 100000 });
      const out = analyseTemplateCloneHistory(page.items, id);
      return res.json(wrapResponse(out, ctx));
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

  // ── EWS rules engine (EWS-3) ─────────────────────────────────────────
  //
  // CRUD + lifecycle + ad-hoc test + bulk evaluate + execution history,
  // all under /v1/ews/rules/*. Audit-trail wired on every mutation;
  // case-event journal recorded on every match.
  //
  // Route ordering: literal /indicators and /evaluate declared BEFORE
  // /:rule_id paths so the param doesn't shadow.

  function ewsApexUser(req: Request): string {
    return ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
  }

  function ewsErrorResponse(
    e: unknown,
    ctx: ReturnType<typeof extractCtx>,
  ): { status: number; body: ReturnType<typeof wrapError> } {
    if (e instanceof EwsRuleError) {
      const code = e.code;
      const status =
        code === 'unknown_rule' ? 404 :
        code === 'duplicate_rule_id' || code === 'cap_reached' ? 409 :
        code === 'illegal_state' || code === 'illegal_transition' ? 409 :
        400;
      const httpCode =
        status === 404
          ? `EWS_404_${code}`
          : status === 409
            ? `EWS_409_${code}`
            : `EWS_400_${code}`;
      return {
        status,
        body: wrapError(
          { code: httpCode, message: e.message, severity: status >= 500 ? 'HIGH' : 'MEDIUM' },
          ctx,
        ),
      };
    }
    throw e;
  }

  /** GET /v1/ews/rules/indicators — EWS indicator catalog. */
  app.get(
    '/v1/ews/rules/indicators',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const items: EwsIndicator[] = Object.values(EWS_INDICATOR_CATALOG);
      return res.json(wrapResponse({ items, total: items.length }, ctx));
    },
  );

  /** POST /v1/ews/rules/evaluate — bulk evaluate one entity against
   *  all active rules. Body { entity_type, entity_id, values }. */
  app.post(
    '/v1/ews/rules/evaluate',
    requireTenantMw,
    requireRole('rules:simulate'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as {
        entity_type?: unknown;
        entity_id?: unknown;
        values?: unknown;
      };
      if (
        w.entity_type !== 'customer' &&
        w.entity_type !== 'policy' &&
        w.entity_type !== 'claim'
      ) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: "entity_type must be 'customer' | 'policy' | 'claim'",
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      if (typeof w.entity_id !== 'string' || !w.entity_id.trim()) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'entity_id required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      if (!w.values || typeof w.values !== 'object' || Array.isArray(w.values)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: 'values must be an object {indicator_name: number|string}',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const tenant_id = req.tenant!.tenant_id;
      const activeRules = ewsRuleStore
        .list(tenant_id, { state: 'active', is_active: true });
      const result = evaluateRules({
        tenant_id,
        entity_type: w.entity_type as EntityType,
        entity_id: (w.entity_id as string).trim(),
        values: w.values as IndicatorValues,
        rules: activeRules,
        now: now(),
      });
      // Per RFC sign-off Q5 — write a case-event for every match so
      // downstream M9.4 consumers can fan out.
      for (const m of result.matches) {
        try {
          ewsRuleStore.recordExecution(tenant_id, {
            rule_id: m.rule_id,
            entity_type: result.entity_type,
            entity_id: result.entity_id,
            matched: true,
            matched_indicators: m.matched_indicators,
            score_impact: m.weight,
            alert_id: null,
            evaluated_at: result.evaluated_at,
            duration_us: result.duration_us,
          });
          caseEventStore.record(
            tenant_id,
            {
              case_id: `${result.entity_type}-${result.entity_id}`,
              action: 'opened',
              actor: 'system:ews-rules-engine',
              payload: {
                rule_id: m.rule_id,
                rule_name: m.name,
                alert_severity: m.alert_severity,
                weight: m.weight,
                matched_indicators: m.matched_indicators,
                aggregate_severity: result.aggregate_severity,
                cumulative_score: result.cumulative_score,
              },
            },
            now(),
          );
        } catch {
          // best-effort — telemetry failures must not break evaluation
        }
      }
      return res.json(wrapResponse(result, ctx));
    },
  );

  /** GET /v1/ews/rules — list with category/state/is_active filters. */
  app.get(
    '/v1/ews/rules',
    requireTenantMw,
    requireRole('rules:list'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filter: { category?: ReturnType<typeof isEwsRuleCategory> extends boolean ? string : never; state?: string; is_active?: boolean } = {} as never;
      if (typeof q.category === 'string' && q.category) {
        if (!isEwsRuleCategory(q.category)) {
          return res.status(400).json(
            wrapError(
              {
                code: 'EWS_400_invalid_input',
                message: `category must be one of ${EWS_RULE_CATEGORIES.join(', ')}`,
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
        (filter as { category: string }).category = q.category;
      }
      if (typeof q.state === 'string' && q.state) {
        if (!isEwsRuleState(q.state)) {
          return res.status(400).json(
            wrapError(
              {
                code: 'EWS_400_invalid_input',
                message: `state must be one of ${EWS_RULE_STATES.join(', ')}`,
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
        (filter as { state: string }).state = q.state;
      }
      if (typeof q.is_active === 'string') {
        if (q.is_active !== 'true' && q.is_active !== 'false') {
          return res.status(400).json(
            wrapError(
              {
                code: 'EWS_400_invalid_input',
                message: 'is_active must be true or false',
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
        (filter as { is_active: boolean }).is_active = q.is_active === 'true';
      }
      const items = ewsRuleStore.list(req.tenant!.tenant_id, filter as Parameters<EwsRuleStore['list']>[1]);
      // Enrich each row with the latest recorded SemVer so the SPA list
      // can show a v X.Y.Z badge without N extra round-trips.
      const enriched = items.map((rule) => ({
        ...rule,
        latest_semver: ewsRuleVersionsStore.latestSemver(req.tenant!.tenant_id, rule.rule_id),
      }));
      return res.json(wrapResponse({ items: enriched, total: enriched.length }, ctx));
    },
  );

  /** POST /v1/ews/rules — create draft rule. */
  app.post(
    '/v1/ews/rules',
    requireTenantMw,
    requireRole('rules:create'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const created_by = ewsApexUser(req);
      try {
        const rule = ewsRuleStore.create(req.tenant!.tenant_id, inner, created_by, now());
        // Snapshot v0.1.0 — closes the gap where freshly-created rules
        // had no version history, so the Diff Viewer could never show
        // anything until a clone happened.
        try {
          ewsRuleVersionsStore.recordVersion({
            tenant_id: req.tenant!.tenant_id,
            rule,
            semver: SEMVER_INITIAL,
            created_by,
            reason: 'initial draft',
            now: now(),
          });
        } catch {
          // duplicate / store error — never block the create response.
        }
        try {
          auditTrailStore.record(
            req.tenant!.tenant_id,
            {
              actor_username: created_by,
              actor_role: 'admin',
              action: 'rule.create',
              resource_type: 'rule',
              resource_id: rule.rule_id,
              outcome: 'success',
              severity: 'info',
              metadata: { name: rule.name, category: rule.category, semver: SEMVER_INITIAL },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.status(201).json(wrapResponse(rule, ctx));
      } catch (e) {
        const r = ewsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** GET /v1/ews/rules/:rule_id — single rule. */
  app.get(
    '/v1/ews/rules/:rule_id',
    requireTenantMw,
    requireRole('rules:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const r = ewsRuleStore.get(req.tenant!.tenant_id, id);
      if (!r) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_rule', message: `rule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(r, ctx));
    },
  );

  /** PUT /v1/ews/rules/:rule_id — replace + bump version. */
  app.put(
    '/v1/ews/rules/:rule_id',
    requireTenantMw,
    requireRole('rules:create'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const updated_by = ewsApexUser(req);
      const tenant_id = req.tenant!.tenant_id;
      const prev = ewsRuleStore.get(tenant_id, id);
      try {
        const rule = ewsRuleStore.replace(tenant_id, id, inner, updated_by, now());
        // Snapshot the post-edit body. Bump from the latest recorded
        // semver (or v0.1.0 fallback if this is the first edit on a
        // legacy rule that pre-dated the version log). classifyEditBump
        // picks minor for substantive changes vs patch for metadata.
        try {
          const latest =
            ewsRuleVersionsStore.latestSemver(tenant_id, id) ?? SEMVER_INITIAL;
          const bump = prev ? classifyEditBump(prev, rule) : 'minor';
          const next = bumpSemver(latest, bump);
          // Optional reason on the body: { rule, change_reason? }
          const wrap = (inner ?? {}) as { change_reason?: unknown };
          const reason =
            typeof wrap.change_reason === 'string' && wrap.change_reason.trim()
              ? wrap.change_reason.trim().slice(0, 500)
              : 'rule edited';
          ewsRuleVersionsStore.recordVersion({
            tenant_id,
            rule,
            semver: next,
            created_by: updated_by,
            reason,
            now: now(),
          });
        } catch {
          // never block the update on a snapshot failure.
        }
        try {
          auditTrailStore.record(
            tenant_id,
            {
              actor_username: updated_by,
              actor_role: 'admin',
              action: 'rule.update',
              resource_type: 'rule',
              resource_id: rule.rule_id,
              outcome: 'success',
              severity: 'info',
              metadata: { version: rule.version },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.json(wrapResponse(rule, ctx));
      } catch (e) {
        const r = ewsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** DELETE /v1/ews/rules/:rule_id — soft-delete (state→deprecated). */
  app.delete(
    '/v1/ews/rules/:rule_id',
    requireTenantMw,
    requireRole('rules:retire'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const updated_by = ewsApexUser(req);
      try {
        const rule = ewsRuleStore.deprecate(req.tenant!.tenant_id, id, now());
        try {
          auditTrailStore.record(
            req.tenant!.tenant_id,
            {
              actor_username: updated_by,
              actor_role: 'admin',
              action: 'rule.retire',
              resource_type: 'rule',
              resource_id: rule.rule_id,
              outcome: 'success',
              severity: 'info',
              metadata: { deprecated_at: rule.deprecated_at },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.json(wrapResponse(rule, ctx));
      } catch (e) {
        const r = ewsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** POST /v1/ews/rules/:rule_id/test — evaluate rule against ad-hoc
   *  sample values (does NOT record telemetry). */
  app.post(
    '/v1/ews/rules/:rule_id/test',
    requireTenantMw,
    requireRole('rules:simulate'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const rule = ewsRuleStore.get(req.tenant!.tenant_id, id);
      if (!rule) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_rule', message: `rule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as { values?: unknown };
      if (!w.values || typeof w.values !== 'object' || Array.isArray(w.values)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: 'values must be an object',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const values = w.values as IndicatorValues;
      const matched = ruleMatches(rule, values);
      const fired = firingIndicators(rule, values);
      return res.json(
        wrapResponse(
          {
            rule_id: rule.rule_id,
            matched,
            matched_indicators: fired,
            score_impact: matched ? rule.action.weight : 0,
            alert_severity: rule.action.alert_severity,
          },
          ctx,
        ),
      );
    },
  );

  /** POST /v1/ews/rules/:rule_id/activate — promote draft→pending_review→active. */
  app.post(
    '/v1/ews/rules/:rule_id/activate',
    requireTenantMw,
    requireRole('rules:retire'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const tenant_id = req.tenant!.tenant_id;
      const updated_by = ewsApexUser(req);
      const cur = ewsRuleStore.get(tenant_id, id);
      if (!cur) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_rule', message: `rule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      try {
        // Caller can call /activate from either draft or pending_review.
        // From draft we need to submit() first to land in pending_review.
        let rule = cur;
        if (rule.state === 'draft') {
          rule = ewsRuleStore.submit(tenant_id, id, now());
        }
        rule = ewsRuleStore.activate(tenant_id, id, now());
        try {
          auditTrailStore.record(
            tenant_id,
            {
              actor_username: updated_by,
              actor_role: 'admin',
              action: 'rule.activate',
              resource_type: 'rule',
              resource_id: rule.rule_id,
              outcome: 'success',
              severity: 'info',
              metadata: { version: rule.version },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.json(wrapResponse(rule, ctx));
      } catch (e) {
        const r = ewsErrorResponse(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** GET /v1/ews/rules/:rule_id/hits?limit=50 — recent execution telemetry. */
  app.get(
    '/v1/ews/rules/:rule_id/hits',
    requireTenantMw,
    requireRole('audit:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const limitRaw = req.query.limit as string | undefined;
      const limit = limitRaw === undefined ? 50 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'limit must be 1..1000', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const cur = ewsRuleStore.get(req.tenant!.tenant_id, id);
      if (!cur) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_rule', message: `rule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const items = ewsRuleStore.listExecutionsForRule(req.tenant!.tenant_id, id, limit);
      return res.json(wrapResponse({ items, total: items.length, rule_id: id }, ctx));
    },
  );

  // ── EWS Rules-Plus — versions + clone + approve/reject (RP-1) ────────
  //
  // Layered ON TOP of the EWS-1..5 rules engine. Existing /create,
  // /update, /transition, /activate, /:id/test, /:id/hits routes stay
  // UNTOUCHED. Six new routes:
  //   POST   /v1/ews/rules/:rule_id/clone
  //   POST   /v1/ews/rules/:rule_id/approve
  //   POST   /v1/ews/rules/:rule_id/reject
  //   GET    /v1/ews/rules/:rule_id/versions
  //   GET    /v1/ews/rules/:rule_id/versions/:semver
  //   POST   /v1/ews/rules/:rule_id/versions/diff

  function rulesPlusErr(
    e: unknown,
    ctx: ReturnType<typeof extractCtx>,
  ): { status: number; body: ReturnType<typeof wrapError> } {
    if (e instanceof EwsRuleError) {
      const status =
        e.code === 'unknown_rule' ? 404 :
        e.code === 'self_approval_refused' ? 403 :
        e.code === 'duplicate_rule_id' || e.code === 'duplicate_semver' ||
          e.code === 'cap_reached' || e.code === 'no_pending_approval' ||
          e.code === 'illegal_state' || e.code === 'illegal_transition' ? 409 :
        400;
      const httpCode =
        status === 404 ? `EWS_404_${e.code}` :
        status === 403 ? `EWS_403_${e.code}` :
        status === 409 ? `EWS_409_${e.code}` :
        `EWS_400_${e.code}`;
      return {
        status,
        body: wrapError(
          { code: httpCode, message: e.message, severity: status >= 500 ? 'HIGH' : 'MEDIUM' },
          ctx,
        ),
      };
    }
    throw e;
  }

  /** POST /v1/ews/rules/:rule_id/clone (RP-1)
   *  body { new_rule_id, new_name? } → 201 fresh DRAFT v0.1.0. */
  app.post(
    '/v1/ews/rules/:rule_id/clone',
    requireTenantMw,
    requireRole('rules:create'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const tenant_id = req.tenant!.tenant_id;
      const created_by = ewsApexUser(req);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as { new_rule_id?: unknown; new_name?: unknown };
      if (typeof w.new_rule_id !== 'string') {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'new_rule_id required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const source = ewsRuleStore.get(tenant_id, id);
      if (!source) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_rule', message: `rule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      try {
        const input = buildCloneInput(source, {
          new_rule_id: w.new_rule_id,
          new_name: typeof w.new_name === 'string' ? w.new_name : undefined,
        });
        const created = ewsRuleStore.create(tenant_id, input, created_by, now());
        // Snapshot v0.1.0
        ewsRuleVersionsStore.recordVersion({
          tenant_id,
          rule: created,
          semver: SEMVER_INITIAL,
          created_by,
          reason: `cloned from ${id} (${source.name})`,
          now: now(),
        });
        try {
          auditTrailStore.record(
            tenant_id,
            {
              actor_username: created_by,
              actor_role: 'admin',
              action: 'rule.create',
              resource_type: 'rule',
              resource_id: created.rule_id,
              outcome: 'success',
              severity: 'info',
              metadata: { cloned_from: id, semver: SEMVER_INITIAL },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.status(201).json(
          wrapResponse({ rule: created, semver: SEMVER_INITIAL, cloned_from: id }, ctx),
        );
      } catch (e) {
        const r = rulesPlusErr(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** POST /v1/ews/rules/:rule_id/submit (RP-1, additive)
   *  body { reason? } → 200 with rule (PENDING_REVIEW). Records the
   *  maker so /approve can refuse self-approval. */
  app.post(
    '/v1/ews/rules/:rule_id/submit',
    requireTenantMw,
    requireRole('rules:create'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const tenant_id = req.tenant!.tenant_id;
      const maker = ewsApexUser(req);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as { reason?: unknown };
      try {
        // Resubmit-safe: only call the state transition if the rule
        // is currently in DRAFT. If it's already in PENDING_REVIEW
        // (e.g. previously rejected, maker resubmitting), skip the
        // state machine call but still record a fresh approval row.
        const cur = ewsRuleStore.get(tenant_id, id);
        if (!cur) {
          return res.status(404).json(
            wrapError(
              { code: 'EWS_404_unknown_rule', message: `rule ${id} not found`, severity: 'LOW' },
              ctx,
            ),
          );
        }
        const rule =
          cur.state === 'draft' ? ewsRuleStore.submit(tenant_id, id, now()) : cur;
        const approval = ewsRuleVersionsStore.recordSubmission({
          tenant_id,
          rule_id: id,
          maker_username: maker,
          reason: typeof w.reason === 'string' ? w.reason : null,
          now: now(),
        });
        return res.json(wrapResponse({ rule, approval }, ctx));
      } catch (e) {
        const r = rulesPlusErr(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** POST /v1/ews/rules/:rule_id/approve (RP-1)
   *  4-eyes activate. Refuses if approver === maker. */
  app.post(
    '/v1/ews/rules/:rule_id/approve',
    requireTenantMw,
    requireRole('rules:retire'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const tenant_id = req.tenant!.tenant_id;
      const approver = ewsApexUser(req);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as { reason?: unknown };
      try {
        const out = approveWithFourEyes(ewsRuleStore, ewsRuleVersionsStore, {
          tenant_id,
          rule_id: id,
          approver_username: approver,
          reason: typeof w.reason === 'string' ? w.reason : null,
          now: now(),
        });
        try {
          auditTrailStore.record(
            tenant_id,
            {
              actor_username: approver,
              actor_role: 'admin',
              action: 'rule.activate',
              resource_type: 'rule',
              resource_id: id,
              outcome: 'success',
              severity: 'info',
              metadata: { via: 'four_eyes_approve', maker: out.approval.maker_username },
            },
            now(),
          );
        } catch {
          // swallow
        }
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        const r = rulesPlusErr(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** POST /v1/ews/rules/:rule_id/reject (RP-1)
   *  4-eyes reject. body { reason } required. */
  app.post(
    '/v1/ews/rules/:rule_id/reject',
    requireTenantMw,
    requireRole('rules:retire'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const tenant_id = req.tenant!.tenant_id;
      const approver = ewsApexUser(req);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as { reason?: unknown };
      if (typeof w.reason !== 'string' || !w.reason.trim()) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'reason required', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      try {
        const out = rejectWithFourEyes(ewsRuleStore, ewsRuleVersionsStore, {
          tenant_id,
          rule_id: id,
          approver_username: approver,
          reason: w.reason,
          now: now(),
        });
        return res.json(wrapResponse(out, ctx));
      } catch (e) {
        const r = rulesPlusErr(e, ctx);
        return res.status(r.status).json(r.body);
      }
    },
  );

  /** GET /v1/ews/rules/:rule_id/versions — list snapshots (newest first). */
  app.get(
    '/v1/ews/rules/:rule_id/versions',
    requireTenantMw,
    requireRole('rules:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const cur = ewsRuleStore.get(req.tenant!.tenant_id, id);
      if (!cur) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_rule', message: `rule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const items = ewsRuleVersionsStore.listVersions(req.tenant!.tenant_id, id);
      const latest = ewsRuleVersionsStore.latestSemver(req.tenant!.tenant_id, id);
      return res.json(
        wrapResponse({ items, total: items.length, rule_id: id, latest_semver: latest }, ctx),
      );
    },
  );

  /** GET /v1/ews/rules/:rule_id/versions/:semver — single snapshot. */
  app.get(
    '/v1/ews/rules/:rule_id/versions/:semver',
    requireTenantMw,
    requireRole('rules:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const semver = req.params.semver ?? '';
      if (!isSemver(semver)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: `bad semver: ${semver}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const v = ewsRuleVersionsStore.getVersion(req.tenant!.tenant_id, id, semver);
      if (!v) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_version', message: `version ${semver} not found for rule ${id}`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      return res.json(wrapResponse(v, ctx));
    },
  );

  /** POST /v1/ews/rules/:rule_id/versions/diff
   *  body { from, to, format? }
   *    - format='fields'    (default) → returns field-by-field RuleDiffEntry[]
   *    - format='snapshots' (T-diff)  → returns the same diff PLUS the
   *      full from + to snapshots so the SPA can render side-by-side
   *      JSON without a second round-trip. */
  app.post(
    '/v1/ews/rules/:rule_id/versions/diff',
    requireTenantMw,
    requireRole('rules:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      const w = (inner ?? {}) as { from?: unknown; to?: unknown; format?: unknown };
      if (!isSemver(w.from) || !isSemver(w.to)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: 'from + to must be SemVer (X.Y.Z)', severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const format =
        w.format === 'snapshots' ? 'snapshots' : 'fields';
      if (w.format !== undefined && w.format !== 'fields' && w.format !== 'snapshots') {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: 'format must be one of fields,snapshots',
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const tenant_id = req.tenant!.tenant_id;
      const A = ewsRuleVersionsStore.getVersion(tenant_id, id, w.from);
      const B = ewsRuleVersionsStore.getVersion(tenant_id, id, w.to);
      if (!A || !B) {
        return res.status(404).json(
          wrapError(
            {
              code: 'EWS_404_unknown_version',
              message: `version ${A ? w.to : w.from} not found for rule ${id}`,
              severity: 'LOW',
            },
            ctx,
          ),
        );
      }
      const diff = diffRuleSnapshots(A.snapshot, B.snapshot);
      const body: Record<string, unknown> = {
        rule_id: id,
        from: w.from,
        to: w.to,
        diff,
        change_count: diff.length,
      };
      if (format === 'snapshots') {
        body.from_snapshot = A;
        body.to_snapshot = B;
      }
      return res.json(wrapResponse(body, ctx));
    },
  );

  /** POST /v1/ews/rules/:rule_id/versions/:semver/revert
   *  body { reason? } → creates a new version whose snapshot equals the
   *  named version. Bumps the patch number off the latest. Audit row
   *  written to admin_audit_log via the report-audit pool. Refuses if
   *  the rule has a pending approval (4-eyes invariant). */
  app.post(
    '/v1/ews/rules/:rule_id/versions/:semver/revert',
    requireTenantMw,
    requireRole('rules:revert'),
    async (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const target = req.params.semver ?? '';
      const tenant_id = req.tenant!.tenant_id;
      if (!isSemver(target)) {
        return res.status(400).json(
          wrapError(
            { code: 'EWS_400_invalid_input', message: `bad semver: ${target}`, severity: 'MEDIUM' },
            ctx,
          ),
        );
      }
      const rule = ewsRuleStore.get(tenant_id, id);
      if (!rule) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_rule', message: `rule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const targetVersion = ewsRuleVersionsStore.getVersion(tenant_id, id, target);
      if (!targetVersion) {
        return res.status(404).json(
          wrapError(
            {
              code: 'EWS_404_unknown_version',
              message: `version ${target} not found for rule ${id}`,
              severity: 'LOW',
            },
            ctx,
          ),
        );
      }
      // 4-eyes guard: a rule with a pending approval is mid-flight; revert
      // would corrupt the maker-checker ledger. Withdraw the pending
      // submission first via the existing approvals API, then revert.
      const pending = ewsRuleVersionsStore.pendingApproval(tenant_id, id);
      if (pending) {
        return res.status(409).json(
          wrapError(
            {
              code: 'EWS_409_pending_approval',
              message: `rule ${id} has a pending approval (${pending.approval_id}); withdraw it first`,
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
      const w = (inner ?? {}) as { reason?: unknown };
      const userReason =
        typeof w.reason === 'string' && w.reason.trim().length > 0
          ? w.reason.trim().slice(0, 500)
          : null;
      const actor =
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin';
      const latest = ewsRuleVersionsStore.latestSemver(tenant_id, id);
      const newSemver = bumpSemver(latest ?? targetVersion.semver, 'patch');
      let snapshot;
      try {
        snapshot = ewsRuleVersionsStore.recordVersion({
          tenant_id,
          rule: targetVersion.snapshot,
          semver: newSemver,
          created_by: actor,
          reason:
            userReason ??
            `Reverted to v${target} by ${actor}`,
          now: now(),
        });
      } catch (e) {
        return res.status(500).json(
          wrapError(
            {
              code: 'EWS_500',
              message: e instanceof Error ? e.message : 'recordVersion failed',
              severity: 'HIGH',
            },
            ctx,
          ),
        );
      }
      // Audit fan-out — fire-and-forget through the same pool the cases
      // exporter uses (T6 §3.1.8).
      if (deps.reportAuditPool) {
        const auditPayload = {
          rule_id: id,
          reverted_to_semver: target,
          new_semver: newSemver,
          new_version_id: snapshot.version_id,
          reason: snapshot.reason,
        };
        void (async () => {
          try {
            await deps.reportAuditPool.query(
              `INSERT INTO app_admin.admin_audit_log
                 (tenant_id, entity_type, entity_id, action, actor_id,
                  actor_role, after_state, request_id, ip_address, user_agent)
               VALUES ($1, 'ews_rule_version', $2, 'revert', $3, $4, $5::jsonb,
                       $6, $7::inet, $8)`,
              [
                tenant_id,
                snapshot.version_id,
                actor,
                (req.headers['x-apex-role'] as string | undefined) ?? 'admin',
                JSON.stringify(auditPayload),
                (req.headers['x-request-id'] as string | undefined) ?? null,
                (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
                  req.ip ??
                  null,
                req.headers['user-agent'] as string | undefined,
              ],
            );
          } catch {
            // never block on audit — failures are recovered via app_admin
            // backfill jobs in production.
          }
        })();
      }
      return res.status(201).json(
        wrapResponse(snapshot, ctx, { code: 'EWS_201', message: 'Reverted' }),
      );
    },
  );

  /** GET /v1/ews/rules/:rule_id/approvals — full approval ledger. */
  app.get(
    '/v1/ews/rules/:rule_id/approvals',
    requireTenantMw,
    requireRole('rules:read'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const id = req.params.rule_id ?? '';
      const cur = ewsRuleStore.get(req.tenant!.tenant_id, id);
      if (!cur) {
        return res.status(404).json(
          wrapError(
            { code: 'EWS_404_unknown_rule', message: `rule ${id} not found`, severity: 'LOW' },
            ctx,
          ),
        );
      }
      const items = ewsRuleVersionsStore.listApprovals(req.tenant!.tenant_id, id);
      const pending = ewsRuleVersionsStore.pendingApproval(req.tenant!.tenant_id, id);
      return res.json(wrapResponse({ items, total: items.length, pending }, ctx));
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
  // dedup defaults to true (mirrors MSW); explicit ?dedup=false turns it off.
  const dedup = String(req.query.dedup ?? 'true').toLowerCase() !== 'false';
  const sortRaw = (req.query.sort as string | undefined) || 'criticality';
  const sort: 'criticality' | 'severity' | 'age' =
    sortRaw === 'severity' || sortRaw === 'age' ? sortRaw : 'criticality';

  const canonicals = dedupeByAlertId(source.read());
  const items = mapAlertList(
    canonicals,
    lookups,
    { severity: sevRaw as UiSeverity | undefined, assignee, dedup, sort },
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeUserAccessOverrideStore } = require('./admin/user_access_override_store') as
      typeof import('./admin/user_access_override_store');
    const { store: userAccessOverrideStore } = await makeUserAccessOverrideStore();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeSlaMatrixSource } = require('./dashboard/sla_breach_matrix') as
      typeof import('./dashboard/sla_breach_matrix');
    const { source: slaMatrixSource } = await makeSlaMatrixSource();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeSlaConfigStore } = require('./admin/sla_config_store') as
      typeof import('./admin/sla_config_store');
    const { store: slaConfigStore } = await makeSlaConfigStore();
    // T6 M14.22 — PG-back the 4 M14.15 stores. All 4 share the same
    // ADMIN_PG_URL/BFF_PG_URL switch; with no env they fall back to
    // in-memory implementations (matches the M14.16-18 default).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeNotificationTemplateStore } = require('./admin/notification_templates_store') as
      typeof import('./admin/notification_templates_store');
    const { store: notificationTemplateStore } = await makeNotificationTemplateStore();
    // M14.24 dispatch log — env-gated factory (M14.24c). PG-backed
    // when ADMIN_PG_URL/BFF_PG_URL is set; in-memory FIFO otherwise.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeNotificationDispatchStore } = require('./admin/notification_dispatch_store') as
      typeof import('./admin/notification_dispatch_store');
    const { store: notificationDispatchStore } = await makeNotificationDispatchStore();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeEscalationMatrixStore } = require('./admin/escalation_matrix_store') as
      typeof import('./admin/escalation_matrix_store');
    const { store: escalationMatrixStore } = await makeEscalationMatrixStore();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeCaseScenarioHistoryStore } = require('./admin/case_scenario_history_store') as
      typeof import('./admin/case_scenario_history_store');
    const { store: caseScenarioHistoryStore } = await makeCaseScenarioHistoryStore();
    // case_scenarios needs FK resolvers — when running in-memory we
    // wire them to the sibling InMemory* stores so the dev-mode demo
    // works without a DB. PG mode wires Pg-backed resolvers via the
    // factory's auto-injection.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeCaseScenarioStore } = require('./admin/case_scenarios_store') as
      typeof import('./admin/case_scenarios_store');
    const { store: caseScenarioStore } = await makeCaseScenarioStore(process.env, {
      // Only used in the in-memory branch — PG mode auto-resolves.
      resolveEscalation: async (tenant_id, escalation_id) => {
        const row = await escalationMatrixStore.get(tenant_id, escalation_id);
        return row ? { status: row.status } : null;
      },
      resolveTemplate: async (tenant_id, template_id) => {
        const row = await notificationTemplateStore.get(tenant_id, template_id);
        return row
          ? { status: row.status, deleted_at: row.deleted_at }
          : null;
      },
      history: caseScenarioHistoryStore,
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeCasesDetailSource } = require('./reports/cases_detail_query') as
      typeof import('./reports/cases_detail_query');
    const { source: casesDetailSource, pool: casesDetailPool } = await makeCasesDetailSource();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeSavedFilterStore } = require('./reports/saved_filters_store') as
      typeof import('./reports/saved_filters_store');
    const { store: savedFilterStore, pool: savedFilterPool } = await makeSavedFilterStore();
    // Reuse whichever pool is live for audit rows (both target the same DB).
    const reportAuditPool = casesDetailPool ?? savedFilterPool ?? null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeAlertResolutionSource } = require('./analytics/alert_resolution') as
      typeof import('./analytics/alert_resolution');
    const { source: alertResolutionSource } = await makeAlertResolutionSource();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeRiskTrendSource } = require('./analytics/risk_trend') as
      typeof import('./analytics/risk_trend');
    const { source: riskTrendSource } = await makeRiskTrendSource();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makePdDistributionSource } = require('./analytics/pd_distribution') as
      typeof import('./analytics/pd_distribution');
    const { source: pdDistributionSource } = await makePdDistributionSource();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeStageMigrationSource } = require('./analytics/stage_migration') as
      typeof import('./analytics/stage_migration');
    const { source: stageMigrationSource } = await makeStageMigrationSource();
    seedDemoCmsCases(); // populate the default in-memory CMS store on cold start
    // T6 M14.25b — escalation worker cron. Off by default; opt-in via
    // ESCALATION_WORKER_INTERVAL_SEC. Tenants come from
    // ESCALATION_WORKER_TENANTS (CSV), default BANK_DEMO,BIL.
    let escalationWorkerCron:
      | InstanceType<typeof import('./admin/escalation_worker').EscalationWorkerCron>
      | undefined;
    const escIntervalSec = Number(process.env.ESCALATION_WORKER_INTERVAL_SEC ?? '0');
    if (Number.isFinite(escIntervalSec) && escIntervalSec > 0) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CmsCaseSourceFromStore, EscalationWorkerCron } = require('./admin/escalation_worker') as
        typeof import('./admin/escalation_worker');
      const tenants = (process.env.ESCALATION_WORKER_TENANTS ?? 'BANK_DEMO,BIL')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      escalationWorkerCron = new EscalationWorkerCron({
        scenarioStore: caseScenarioStore,
        escalationMatrixStore,
        templateStore: notificationTemplateStore,
        dispatchStore: notificationDispatchStore,
        caseSource: new CmsCaseSourceFromStore(defaultCmsCaseStore),
        tenants,
        intervalMs: escIntervalSec * 1000,
        performed_by: 'system:escalation-worker',
      });
      escalationWorkerCron.start();
      // eslint-disable-next-line no-console
      console.log(
        `escalation worker cron started — every ${escIntervalSec}s across [${tenants.join(', ')}]`,
      );
    }
    // Seed the 10 brief-mandated EWS rules into both tenants so the
    // RulesPlus / EwsRuleBuilder pages aren't empty on a fresh `make up`.
    const { app } = makeApp({
      webhookStore,
      scenarioStore,
      userAccessOverrideStore,
      rolesForUser: defaultRolesForUser,
      slaMatrixSource,
      slaConfigStore,
      notificationTemplateStore,
      notificationDispatchStore,
      escalationMatrixStore,
      caseScenarioStore,
      caseScenarioHistoryStore,
      escalationWorkerCron,
      casesDetailSource,
      savedFilterStore,
      reportAuditPool,
      alertResolutionSource,
      riskTrendSource,
      pdDistributionSource,
      stageMigrationSource,
    });
    const { defaultEwsRuleStore } = require('./ews_rules') as { defaultEwsRuleStore: EwsRuleStore };
    for (const t of ['BANK_DEMO', 'BIL']) {
      try { seedDefaultEwsRules(defaultEwsRuleStore, t, 'system', new Date()); } catch { /* best-effort */ }
    }
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
