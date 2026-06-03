/**
 * Enterprise Integration Marketplace — core engine.
 *
 * Pure-function engine: no I/O, no React, no stores.
 * Deterministic for (tenant, day) via FNV-1a + Mulberry32.
 *
 * 10 sections: Catalog, API Marketplace, Data Exchange Hub,
 * Event Subscription Center, Partner Ecosystem, Governance,
 * Observability, AI Insights, Executive View, Readiness Score.
 *
 * Phase 20 IA overlay — additive; every prior module untouched.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }
function r2(v: number): number { return Math.round(v * 100) / 100; }
function r1(v: number): number { return Math.round(v * 10) / 10; }
function pick<T>(arr: readonly T[], rng: () => number): T { return arr[Math.floor(rng() * arr.length)]; }

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const INTEGRATION_CATEGORIES = ['banking', 'insurance', 'enterprise'] as const;
export type IntegrationCategory = typeof INTEGRATION_CATEGORIES[number];

export const INTEGRATION_STATUSES = ['active', 'inactive', 'degraded', 'maintenance', 'deprecated'] as const;
export type IntegrationStatus = typeof INTEGRATION_STATUSES[number];

export const GOVERNANCE_STATES = ['draft', 'review', 'approved', 'rejected', 'retired'] as const;
export type GovernanceState = typeof GOVERNANCE_STATES[number];

export const API_TYPES = ['REST', 'GraphQL', 'Webhook', 'Event'] as const;
export type ApiType = typeof API_TYPES[number];

export const AUTH_TYPES = ['OAuth2', 'API Key', 'mTLS', 'JWT', 'Basic'] as const;
export type AuthType = typeof AUTH_TYPES[number];

export const PARTNER_TYPES = ['credit_bureau', 'collection_agency', 'investigator', 'audit_firm', 'recovery_agency', 'insurance_surveyor'] as const;
export type PartnerType = typeof PARTNER_TYPES[number];

export const HEALTH_LEVELS = ['healthy', 'degraded', 'critical', 'unknown'] as const;
export type HealthLevel = typeof HEALTH_LEVELS[number];

export const READINESS_DIMENSIONS = ['security', 'reliability', 'performance', 'governance', 'compliance', 'documentation'] as const;
export type ReadinessDimension = typeof READINESS_DIMENSIONS[number];

// ─────────────────────────────────────────────────────────────────────────────
// RBAC
// ─────────────────────────────────────────────────────────────────────────────

export const INTEGRATION_MARKETPLACE_ROLES: readonly string[] = [
  'admin', 'supervisor', 'risk_analyst', 'super_admin', 'country_admin',
  'bank_admin', 'insurance_admin', 'fraud_analyst', 'auditor',
  'compliance_officer', 'operations_user', 'executive', 'cdo', 'cro',
  'ceo', 'coo', 'board_member', 'operations_manager', 'country_head', 'investigation_officer',
];
export function canAccessIntegrationMarketplace(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  const allowed = new Set(INTEGRATION_MARKETPLACE_ROLES);
  for (const r of roles) { if (allowed.has(r)) return true; }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Integration Catalog
// ─────────────────────────────────────────────────────────────────────────────

export interface IntegrationEntry {
  integration_id: string;
  name: string;
  category: IntegrationCategory;
  sub_category: string;
  owner: string;
  status: IntegrationStatus;
  health_score: number;
  last_sync: string;
  version: string;
  description: string;
  records_per_day: number;
  sla_uptime_pct: number;
  dependencies: string[];
  governance_state: GovernanceState;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
}

const BANKING_INTEGRATIONS = [
  { sub: 'Core Banking System',    owner: 'IT - Core Banking',   desc: 'Temenos T24 core banking platform — account master, GL, transactions' },
  { sub: 'Loan Origination System',owner: 'IT - Lending',        desc: 'Finacle LOS — origination, appraisal, sanction, disbursement workflow' },
  { sub: 'Collections Platform',   owner: 'Collections Ops',     desc: 'ARCS Collections — DPD tracking, field allocation, SARFAESI workflow' },
  { sub: 'AML System',             owner: 'Compliance',          desc: 'NICE Actimize AML — transaction monitoring, STR filing, OFAC screening' },
  { sub: 'CRM',                    owner: 'Business Dev',        desc: 'Salesforce CRM — customer 360, relationship management, lead tracking' },
  { sub: 'Treasury System',        owner: 'Treasury',            desc: 'Murex ALM — FX, derivatives, liquidity management, SLR/CRR tracking' },
  { sub: 'Credit Bureau',          owner: 'Risk Analytics',      desc: 'CIBIL TransUnion — bureau pulls, credit score, trade line data' },
  { sub: 'Payment Gateway',        owner: 'Digital Banking',     desc: 'NPCI UPI + NEFT/RTGS — real-time payment processing, reconciliation' },
];

const INSURANCE_INTEGRATIONS = [
  { sub: 'Policy Administration',  owner: 'IT - Policy Ops',     desc: 'IRIS PolicyCenter — new business, endorsements, renewals, surrender' },
  { sub: 'Claims Management',      owner: 'Claims Ops',          desc: 'Guidewire ClaimCenter — FNOL, investigation, settlement, SIU referral' },
  { sub: 'Agent Portal',           owner: 'Distribution',        desc: 'Agency portal — commission, persistency, sales analytics, training' },
  { sub: 'Reinsurance Platform',   owner: 'Reinsurance',         desc: 'RI3K platform — treaty management, bordereau, recovery reconciliation' },
  { sub: 'Fraud System',           owner: 'Fraud Analytics',     desc: 'FRISS fraud detection — claim fraud scoring, network analysis, SIU' },
  { sub: 'Customer Portal',        owner: 'Digital Team',        desc: 'Self-service portal — policy view, claim filing, document management' },
];

const ENTERPRISE_INTEGRATIONS = [
  { sub: 'ERP',                    owner: 'Finance',             desc: 'SAP S4/HANA — GL, AP, AR, fixed assets, cost centre reporting' },
  { sub: 'HRMS',                   owner: 'Human Resources',     desc: 'PeopleSoft HCM — payroll, attendance, leave, performance management' },
  { sub: 'DMS',                    owner: 'Operations',          desc: 'OpenText DMS — document storage, version control, digital signatures' },
  { sub: 'Email',                  owner: 'IT Infrastructure',   desc: 'Microsoft Exchange / AWS SES — transactional + marketing email' },
  { sub: 'SMS',                    owner: 'Digital Channels',    desc: 'Africa\'s Talking / Twilio — OTP, alerts, collection reminders' },
  { sub: 'WhatsApp',               owner: 'CX Team',             desc: 'WhatsApp Business API — customer notifications, chatbot, KYC' },
  { sub: 'Data Lake',              owner: 'Data Engineering',    desc: 'AWS S3 + Glue — raw ingestion, transformation, analytics store' },
  { sub: 'BI Platform',            owner: 'Analytics',           desc: 'Power BI / Tableau — dashboards, reports, executive scorecards' },
];

const STATUS_DIST: IntegrationStatus[] = ['active', 'active', 'active', 'active', 'degraded', 'active', 'active', 'maintenance'];

export function buildIntegrationCatalog(tenant: string, asOf: Date): IntegrationEntry[] {
  const rng = mulberry32(fnv1a(`${tenant}:catalog:${dayKey(asOf)}`));
  const allDefs = [
    ...BANKING_INTEGRATIONS.map(d => ({ ...d, category: 'banking' as IntegrationCategory })),
    ...INSURANCE_INTEGRATIONS.map(d => ({ ...d, category: 'insurance' as IntegrationCategory })),
    ...ENTERPRISE_INTEGRATIONS.map(d => ({ ...d, category: 'enterprise' as IntegrationCategory })),
  ];
  const govStates: GovernanceState[] = ['approved', 'approved', 'approved', 'review', 'approved'];
  const risks: Array<'low' | 'medium' | 'high' | 'critical'> = ['low', 'medium', 'medium', 'high', 'low', 'low', 'medium', 'high'];

  return allDefs.map((def, i) => {
    const status = STATUS_DIST[i % STATUS_DIST.length];
    const isActive = status === 'active';
    const health = isActive ? Math.floor(82 + rng() * 17) : Math.floor(45 + rng() * 35);
    const daysAgo = Math.floor(rng() * 3);
    const hoursAgo = Math.floor(rng() * 8);
    const last_sync = new Date(asOf.getTime() - (daysAgo * 86400 + hoursAgo * 3600) * 1000).toISOString();

    return {
      integration_id: `INT-${def.category.toUpperCase().slice(0, 3)}-${String(i + 1).padStart(3, '0')}`,
      name: def.sub,
      category: def.category,
      sub_category: def.sub,
      owner: def.owner,
      status,
      health_score: health,
      last_sync,
      version: `v${Math.floor(1 + rng() * 4)}.${Math.floor(rng() * 9)}.${Math.floor(rng() * 9)}`,
      description: def.desc,
      records_per_day: Math.floor(500 + rng() * 49500),
      sla_uptime_pct: r2(isActive ? 98.5 + rng() * 1.4 : 85 + rng() * 10),
      dependencies: pick([['CBS', 'Audit'], ['LOS', 'CRM'], ['Claims', 'Fraud'], ['ERP', 'DMS']], rng) as string[],
      governance_state: govStates[i % govStates.length],
      risk_level: risks[i % risks.length],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — API Marketplace
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiEntry {
  api_id: string;
  name: string;
  version: string;
  endpoint: string;
  owner: string;
  environment: 'production' | 'staging' | 'sandbox';
  api_type: ApiType;
  auth_type: AuthType;
  sla_ms: number;
  availability_pct: number;
  calls_per_day: number;
  error_rate_pct: number;
  status: 'active' | 'deprecated' | 'beta';
  description: string;
}

const API_DEFS = [
  { name: 'Customer 360 API',          ep: '/v1/customers/:id/360',          type: 'REST' as ApiType,     auth: 'OAuth2' as AuthType,     sla: 800,  owner: 'Data Platform' },
  { name: 'Risk Score API',            ep: '/v1/scoring/risk',               type: 'REST' as ApiType,     auth: 'JWT' as AuthType,        sla: 400,  owner: 'AI Platform' },
  { name: 'Alert Ingest API',          ep: '/v1/alerts/ingest',              type: 'REST' as ApiType,     auth: 'API Key' as AuthType,    sla: 200,  owner: 'Alert Engine' },
  { name: 'Decision Engine API',       ep: '/v1/decisions/evaluate',         type: 'REST' as ApiType,     auth: 'OAuth2' as AuthType,     sla: 1200, owner: 'AI Decisioning' },
  { name: 'Predictive Risk API',       ep: '/v1/predictions/risk',           type: 'REST' as ApiType,     auth: 'JWT' as AuthType,        sla: 600,  owner: 'Predictive Center' },
  { name: 'Compliance Check API',      ep: '/v1/compliance/verify',          type: 'REST' as ApiType,     auth: 'mTLS' as AuthType,       sla: 500,  owner: 'Compliance Center' },
  { name: 'Investigation API',         ep: '/v1/investigations',             type: 'REST' as ApiType,     auth: 'OAuth2' as AuthType,     sla: 1000, owner: 'Investigation Center' },
  { name: 'Platform Events',           ep: 'wss://events.ews.internal',      type: 'Event' as ApiType,    auth: 'JWT' as AuthType,        sla: 100,  owner: 'Event Bus' },
  { name: 'Case Management API',       ep: '/v1/cases',                      type: 'REST' as ApiType,     auth: 'OAuth2' as AuthType,     sla: 700,  owner: 'Case Center' },
  { name: 'Audit Trail API',           ep: '/v1/audit/events',               type: 'REST' as ApiType,     auth: 'API Key' as AuthType,    sla: 300,  owner: 'Audit Center' },
  { name: 'Digital Twin Sim API',      ep: '/v1/scenarios/run',              type: 'REST' as ApiType,     auth: 'JWT' as AuthType,        sla: 3000, owner: 'Digital Twin' },
  { name: 'Agent Recommendation API', ep: '/v1/agents/recommendations',     type: 'REST' as ApiType,     auth: 'OAuth2' as AuthType,     sla: 800,  owner: 'Autonomous Agents' },
  { name: 'Webhook Subscription API', ep: '/v1/webhooks',                   type: 'Webhook' as ApiType,  auth: 'API Key' as AuthType,    sla: 500,  owner: 'Integration Team' },
  { name: 'Feature Store Query API',   ep: '/v1/feature-store/customers/:id',type: 'REST' as ApiType,     auth: 'mTLS' as AuthType,       sla: 400,  owner: 'Data Engineering' },
  { name: 'EWS GraphQL Gateway',      ep: '/graphql',                       type: 'GraphQL' as ApiType,  auth: 'OAuth2' as AuthType,     sla: 600,  owner: 'API Platform' },
];

const ENVS = ['production', 'staging', 'sandbox'] as const;

export function buildApiMarketplace(tenant: string, asOf: Date): ApiEntry[] {
  const rng = mulberry32(fnv1a(`${tenant}:apis:${dayKey(asOf)}`));
  return API_DEFS.map((def, i) => ({
    api_id: `API-${String(i + 1).padStart(3, '0')}`,
    name: def.name,
    version: `v${Math.floor(1 + rng() * 3)}.${Math.floor(rng() * 8)}.${Math.floor(rng() * 5)}`,
    endpoint: def.ep,
    owner: def.owner,
    environment: pick(ENVS, rng),
    api_type: def.type,
    auth_type: def.auth,
    sla_ms: def.sla,
    availability_pct: r2(98 + rng() * 1.9),
    calls_per_day: Math.floor(500 + rng() * 49500),
    error_rate_pct: r2(rng() * 1.8),
    status: rng() > 0.1 ? 'active' : rng() > 0.5 ? 'beta' : 'deprecated',
    description: `${def.name} — tenant-scoped, SLA ${def.sla}ms p95`,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Data Exchange Hub
// ─────────────────────────────────────────────────────────────────────────────

export interface DataExchangeFlow {
  flow_id: string;
  source: string;
  target: string;
  records_processed_today: number;
  failures_today: number;
  avg_latency_ms: number;
  throughput_per_min: number;
  success_rate_pct: number;
  last_run: string;
  status: 'running' | 'paused' | 'failed' | 'idle';
  data_type: string;
  volume_mb_today: number;
}

export interface DataExchangeMetrics {
  period: 'daily' | 'weekly' | 'monthly';
  total_records: number;
  total_failures: number;
  avg_latency_ms: number;
  peak_throughput_per_min: number;
  success_rate_pct: number;
  top_flow_by_volume: string;
  anomalies_detected: number;
}

const FLOW_DEFS = [
  { src: 'CBS',             tgt: 'ZorEWS mart',      dtype: 'Loan + Customer' },
  { src: 'CIBIL Bureau',    tgt: 'Risk Engine',       dtype: 'Credit Score' },
  { src: 'AML System',      tgt: 'Compliance Center', dtype: 'STR + Watchlist' },
  { src: 'LOS',             tgt: 'EWS Indicators',    dtype: 'Application Data' },
  { src: 'Collections',     tgt: 'Recovery Center',   dtype: 'DPD + Buckets' },
  { src: 'Policy Admin',    tgt: 'Predictive Risk',   dtype: 'Policy Data' },
  { src: 'Claims System',   tgt: 'Fraud Engine',      dtype: 'Claim Events' },
  { src: 'Agent Portal',    tgt: 'AI Agents',         dtype: 'Agent KPIs' },
  { src: 'ERP',             tgt: 'Digital Twin',      dtype: 'Financial Data' },
  { src: 'HRMS',            tgt: 'Governance Center', dtype: 'Employee Data' },
  { src: 'Data Lake',       tgt: 'Feature Store',     dtype: 'ML Features' },
  { src: 'ZorEWS Events',   tgt: 'BI Platform',       dtype: 'Analytics Events' },
];

export function buildDataExchangeFlows(tenant: string, asOf: Date): DataExchangeFlow[] {
  const rng = mulberry32(fnv1a(`${tenant}:flows:${dayKey(asOf)}`));
  const statuses: Array<DataExchangeFlow['status']> = ['running', 'running', 'running', 'running', 'paused', 'idle'];
  return FLOW_DEFS.map((def, i) => {
    const st = statuses[i % statuses.length];
    const records = st === 'running' ? Math.floor(5000 + rng() * 95000) : 0;
    const fail = st === 'running' ? Math.floor(rng() * records * 0.01) : 0;
    return {
      flow_id: `FLOW-${String(i + 1).padStart(3, '0')}`,
      source: def.src,
      target: def.tgt,
      records_processed_today: records,
      failures_today: fail,
      avg_latency_ms: Math.floor(50 + rng() * 950),
      throughput_per_min: Math.floor(100 + rng() * 1900),
      success_rate_pct: records > 0 ? r2(((records - fail) / records) * 100) : 0,
      last_run: new Date(asOf.getTime() - Math.floor(rng() * 3600) * 1000).toISOString(),
      status: st,
      data_type: def.dtype,
      volume_mb_today: r1(records * 0.0002 * (0.5 + rng())),
    };
  });
}

export function buildDataExchangeMetrics(tenant: string, asOf: Date): DataExchangeMetrics[] {
  const periods: Array<'daily' | 'weekly' | 'monthly'> = ['daily', 'weekly', 'monthly'];
  const multipliers = [1, 7, 30];
  return periods.map((period, i) => {
    const rng = mulberry32(fnv1a(`${tenant}:metrics:${period}:${dayKey(asOf)}`));
    const base = Math.floor(800000 + rng() * 400000);
    return {
      period,
      total_records: base * multipliers[i],
      total_failures: Math.floor(base * multipliers[i] * 0.005),
      avg_latency_ms: Math.floor(280 + rng() * 220),
      peak_throughput_per_min: Math.floor(2000 + rng() * 3000),
      success_rate_pct: r2(99 + rng() * 0.9),
      top_flow_by_volume: pick(['CBS → ZorEWS mart', 'Data Lake → Feature Store', 'Policy Admin → Predictive Risk'], rng),
      anomalies_detected: Math.floor(rng() * 5),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Event Subscription Center
// ─────────────────────────────────────────────────────────────────────────────

export interface EventDefinition {
  event_type: string;
  category: string;
  description: string;
  avg_daily_volume: number;
  subscribers_count: number;
}

export interface EventSubscription {
  subscription_id: string;
  event_type: string;
  subscriber: string;
  endpoint: string;
  delivery_status: 'healthy' | 'degraded' | 'failed';
  retry_count: number;
  success_rate_pct: number;
  last_delivered: string;
  events_24h: number;
  auth_type: AuthType;
}

export const EVENT_DEFINITIONS: readonly EventDefinition[] = [
  { event_type: 'alert.created',          category: 'Alerts',     description: 'New risk alert generated by rule engine or AI model', avg_daily_volume: 2500,  subscribers_count: 8 },
  { event_type: 'alert.escalated',         category: 'Alerts',     description: 'Alert severity upgraded to high/critical',            avg_daily_volume: 320,   subscribers_count: 6 },
  { event_type: 'case.opened',             category: 'Cases',      description: 'New investigation case opened',                       avg_daily_volume: 180,   subscribers_count: 5 },
  { event_type: 'case.closed',             category: 'Cases',      description: 'Case closed with outcome documented',                 avg_daily_volume: 145,   subscribers_count: 5 },
  { event_type: 'rule.triggered',          category: 'Rules',      description: 'EWS rule fired on indicator threshold breach',        avg_daily_volume: 8500,  subscribers_count: 12 },
  { event_type: 'model.drift_detected',    category: 'AI',         description: 'ML model drift score exceeded threshold',             avg_daily_volume: 12,    subscribers_count: 4 },
  { event_type: 'compliance.breach',       category: 'Compliance', description: 'Regulatory obligation breach detected',               avg_daily_volume: 25,    subscribers_count: 7 },
  { event_type: 'fraud.detected',          category: 'Fraud',      description: 'High-confidence fraud signal flagged',                avg_daily_volume: 85,    subscribers_count: 9 },
  { event_type: 'decision.approved',       category: 'Decisions',  description: 'AI decision approved through workflow',               avg_daily_volume: 1200,  subscribers_count: 6 },
  { event_type: 'customer.risk_changed',   category: 'Risk',       description: 'Customer risk band changed (e.g. Low→High)',          avg_daily_volume: 450,   subscribers_count: 10 },
];

const SUBSCRIBERS = ['CBS Integration', 'AML System', 'Collections Platform', 'LOS System', 'CRM', 'BI Platform', 'Mobile App', 'Email Service', 'Compliance System', 'Executive Dashboard'];

export function buildEventSubscriptions(tenant: string, asOf: Date): EventSubscription[] {
  const rng = mulberry32(fnv1a(`${tenant}:subscriptions:${dayKey(asOf)}`));
  const deliveryStatuses: Array<EventSubscription['delivery_status']> = ['healthy', 'healthy', 'healthy', 'degraded', 'healthy'];
  const results: EventSubscription[] = [];
  let idx = 0;

  EVENT_DEFINITIONS.forEach(evt => {
    const subCount = Math.min(evt.subscribers_count, 3);
    for (let i = 0; i < subCount; i++) {
      const status = deliveryStatuses[idx % deliveryStatuses.length];
      results.push({
        subscription_id: `SUB-${String(idx + 1).padStart(3, '0')}`,
        event_type: evt.event_type,
        subscriber: pick(SUBSCRIBERS, rng),
        endpoint: `https://integration.${pick(['cbs', 'aml', 'los', 'crm', 'bi'], rng)}.internal/webhooks/ews`,
        delivery_status: status,
        retry_count: status === 'healthy' ? 0 : Math.floor(rng() * 5),
        success_rate_pct: status === 'healthy' ? r2(98 + rng() * 2) : r2(60 + rng() * 30),
        last_delivered: new Date(asOf.getTime() - Math.floor(rng() * 1800) * 1000).toISOString(),
        events_24h: Math.floor(evt.avg_daily_volume * (0.2 + rng() * 0.3)),
        auth_type: pick(AUTH_TYPES, rng),
      });
      idx++;
    }
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — Partner Ecosystem
// ─────────────────────────────────────────────────────────────────────────────

export interface PartnerEntry {
  partner_id: string;
  name: string;
  type: PartnerType;
  contract_status: 'active' | 'renewal_due' | 'expired' | 'under_negotiation';
  sla_response_hours: number;
  sla_met_pct: number;
  performance_score: number;
  compliance_rating: 'AAA' | 'AA' | 'A' | 'BBB' | 'BB';
  contract_value_cr: number;
  contract_expiry: string;
  incidents_30d: number;
  escalations_30d: number;
  region: string;
}

const PARTNER_DEFS: Array<{name: string; type: PartnerType; region: string; sla: number; value: number}> = [
  { name: 'CIBIL TransUnion',              type: 'credit_bureau',      region: 'Pan India',      sla: 2,   value: 4.8 },
  { name: 'CRIF High Mark',                type: 'credit_bureau',      region: 'Pan India',      sla: 2,   value: 2.2 },
  { name: 'Experian India',                type: 'credit_bureau',      region: 'Pan India',      sla: 4,   value: 1.8 },
  { name: 'Mahindra Finance Recovery',     type: 'collection_agency',  region: 'Maharashtra',    sla: 24,  value: 8.5 },
  { name: 'Dun & Bradstreet Collections',  type: 'collection_agency',  region: 'North India',    sla: 24,  value: 6.2 },
  { name: 'Kroll India Investigators',     type: 'investigator',       region: 'Pan India',      sla: 48,  value: 3.4 },
  { name: 'Control Risks India',           type: 'investigator',       region: 'Metro Cities',   sla: 48,  value: 2.8 },
  { name: 'Deloitte India (Forensics)',    type: 'audit_firm',         region: 'Pan India',      sla: 72,  value: 12.0 },
  { name: 'KPMG Advisory',                type: 'audit_firm',         region: 'Pan India',      sla: 72,  value: 9.5 },
  { name: 'Encore Capital Recovery',       type: 'recovery_agency',    region: 'South India',    sla: 24,  value: 5.6 },
  { name: 'McLR Surveyors India',          type: 'insurance_surveyor', region: 'Pan India',      sla: 12,  value: 1.8 },
  { name: 'Vipul Surveyors',              type: 'insurance_surveyor', region: 'West India',     sla: 12,  value: 1.2 },
];

const CONTRACT_STATUSES: Array<PartnerEntry['contract_status']> = ['active', 'active', 'active', 'renewal_due', 'active', 'active'];
const COMPLIANCE_RATINGS: Array<PartnerEntry['compliance_rating']> = ['AAA', 'AA', 'A', 'AAA', 'AA', 'A', 'BBB'];

export function buildPartnerEcosystem(tenant: string, asOf: Date): PartnerEntry[] {
  const rng = mulberry32(fnv1a(`${tenant}:partners:${dayKey(asOf)}`));
  return PARTNER_DEFS.map((def, i) => {
    const perf = Math.floor(72 + rng() * 26);
    const expiryDays = Math.floor(30 + rng() * 335);
    return {
      partner_id: `PTR-${String(i + 1).padStart(3, '0')}`,
      name: def.name,
      type: def.type,
      contract_status: CONTRACT_STATUSES[i % CONTRACT_STATUSES.length],
      sla_response_hours: def.sla,
      sla_met_pct: r2(88 + rng() * 11),
      performance_score: perf,
      compliance_rating: COMPLIANCE_RATINGS[i % COMPLIANCE_RATINGS.length],
      contract_value_cr: r2(def.value * (0.9 + rng() * 0.2)),
      contract_expiry: new Date(asOf.getTime() + expiryDays * 86400000).toISOString().slice(0, 10),
      incidents_30d: Math.floor(rng() * 4),
      escalations_30d: Math.floor(rng() * 2),
      region: def.region,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Integration Governance
// ─────────────────────────────────────────────────────────────────────────────

export interface GovernanceRecord {
  record_id: string;
  integration_name: string;
  category: IntegrationCategory;
  state: GovernanceState;
  security_review: 'passed' | 'pending' | 'failed' | 'not_required';
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  data_classification: 'public' | 'internal' | 'confidential' | 'restricted';
  compliance_review: 'passed' | 'pending' | 'failed';
  approver: string;
  submitted_by: string;
  submitted_at: string;
  approved_at: string | null;
  comments: string;
}

const APPROVERS = ['CTO', 'CISO', 'CRO', 'Chief Compliance Officer', 'CDO'];

export function buildGovernanceRecords(tenant: string, asOf: Date): GovernanceRecord[] {
  const rng = mulberry32(fnv1a(`${tenant}:governance:${dayKey(asOf)}`));
  const catalog = buildIntegrationCatalog(tenant, asOf).slice(0, 12);
  const secReviews: Array<GovernanceRecord['security_review']> = ['passed', 'passed', 'pending', 'passed', 'not_required'];
  const dataClass: Array<GovernanceRecord['data_classification']> = ['restricted', 'confidential', 'internal', 'restricted', 'confidential'];

  return catalog.map((int, i) => {
    const daysAgo = Math.floor(20 + rng() * 180);
    const submitted = new Date(asOf.getTime() - daysAgo * 86400000).toISOString();
    const isApproved = int.governance_state === 'approved';

    return {
      record_id: `GOV-${String(i + 1).padStart(3, '0')}`,
      integration_name: int.name,
      category: int.category,
      state: int.governance_state,
      security_review: secReviews[i % secReviews.length],
      risk_level: int.risk_level,
      data_classification: dataClass[i % dataClass.length],
      compliance_review: isApproved ? 'passed' : 'pending',
      approver: pick(APPROVERS, rng),
      submitted_by: pick(['IT Team', 'Risk Analytics', 'Operations', 'Digital Team'], rng),
      submitted_at: submitted,
      approved_at: isApproved ? new Date(new Date(submitted).getTime() + Math.floor(rng() * 5) * 86400000).toISOString() : null,
      comments: isApproved
        ? pick(['Approved — security and compliance requirements met', 'Approved with quarterly review clause', 'Approved — aligns with data governance policy'], rng)
        : pick(['Pending CISO sign-off', 'Awaiting data classification confirmation', 'Under compliance review'], rng),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — Observability Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export interface ObservabilityMetrics {
  total_integrations: number;
  healthy_count: number;
  degraded_count: number;
  failed_count: number;
  overall_availability_pct: number;
  avg_response_ms: number;
  total_api_calls_24h: number;
  total_errors_24h: number;
  error_rate_pct: number;
  throughput_per_min: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  top_error_source: string;
  error_trend: Array<{ hour: string; errors: number; requests: number }>;
}

export function buildObservabilityMetrics(tenant: string, asOf: Date): ObservabilityMetrics {
  const rng = mulberry32(fnv1a(`${tenant}:obs:${dayKey(asOf)}`));
  const catalog = buildIntegrationCatalog(tenant, asOf);
  const healthy = catalog.filter(c => c.status === 'active').length;
  const degraded = catalog.filter(c => c.status === 'degraded' || c.status === 'maintenance').length;
  const failed = catalog.length - healthy - degraded;
  const totalCalls = Math.floor(250000 + rng() * 150000);
  const totalErrors = Math.floor(totalCalls * 0.008 * (0.5 + rng()));

  return {
    total_integrations: catalog.length,
    healthy_count: healthy,
    degraded_count: degraded,
    failed_count: Math.max(0, failed),
    overall_availability_pct: r2(98 + rng() * 1.8),
    avg_response_ms: Math.floor(180 + rng() * 220),
    total_api_calls_24h: totalCalls,
    total_errors_24h: totalErrors,
    error_rate_pct: r2((totalErrors / totalCalls) * 100),
    throughput_per_min: Math.floor(1200 + rng() * 1800),
    p95_latency_ms: Math.floor(350 + rng() * 450),
    p99_latency_ms: Math.floor(800 + rng() * 700),
    top_error_source: pick(['CBS Integration', 'AML System', 'Bureau API', 'Claims System'], rng),
    error_trend: Array.from({ length: 12 }, (_, i) => {
      const r = mulberry32(fnv1a(`${tenant}:trend:${i}:${dayKey(asOf)}`));
      const hrs = 23 - i * 2;
      const req = Math.floor(8000 + r() * 6000);
      return { hour: `${String(hrs).padStart(2, '0')}:00`, errors: Math.floor(req * 0.01 * r()), requests: req };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 8 — AI Integration Insights
// ─────────────────────────────────────────────────────────────────────────────

export interface IntegrationInsight {
  insight_id: string;
  type: 'risk' | 'bottleneck' | 'sla_breach' | 'capacity' | 'optimization';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  affected_integration: string;
  recommendation: string;
  estimated_impact: string;
  confidence_score: number;
  generated_at: string;
}

const INSIGHT_TEMPLATES = [
  { type: 'risk' as const,         sev: 'critical' as const, title: 'Single Point of Failure Detected',         desc: 'CBS Integration has no failover path — 8 downstream systems depend on it.',           rec: 'Implement active-passive failover with 30s switchover. Deploy redundant connector instance.' },
  { type: 'sla_breach' as const,   sev: 'warning' as const,  title: 'Bureau API SLA Trending Adverse',           desc: 'P95 latency 680ms vs 500ms SLA. Breach probability 74% in next 7 days.',             rec: 'Pre-fetch + cache bureau scores for repeat inquiries. Negotiate batch pull SLA with CIBIL.' },
  { type: 'bottleneck' as const,   sev: 'warning' as const,  title: 'Data Exchange Throughput Constraint',       desc: 'Claims → Fraud Engine flow is at 89% of allocated bandwidth during 14:00–16:00.',     rec: 'Increase message queue partition count from 6 to 12. Enable flow compression.' },
  { type: 'capacity' as const,     sev: 'info' as const,     title: 'API Rate Limit Headroom Narrow',            desc: 'Decision Engine API at 78% of quota. At current growth rate, limit reached in 22 days.',rec: 'Request 2× quota increase from API platform team. Implement request batching at consumer side.' },
  { type: 'optimization' as const, sev: 'info' as const,     title: 'Redundant Event Subscriptions Detected',    desc: '3 subscribers consuming the same alert.created event at identical frequency.',          rec: 'Consolidate to single event fan-out with internal routing. Reduces broker load by 35%.' },
  { type: 'risk' as const,         sev: 'warning' as const,  title: 'Deprecated API Still in Production Use',   desc: 'LOS integration v1.2 API marked deprecated. 4 consumers not yet migrated.',              rec: 'Force migration to v2.1 by Q3. Create migration guide and notify integration owners.' },
  { type: 'capacity' as const,     sev: 'info' as const,     title: '30-Day Throughput Forecast Exceeds Plan',  desc: 'Predicted 34% volume growth will exceed current data exchange capacity by day 28.',     rec: 'Pre-scale message broker cluster nodes. Review data retention policy to free headroom.' },
];

export function buildIntegrationInsights(tenant: string, asOf: Date): IntegrationInsight[] {
  const rng = mulberry32(fnv1a(`${tenant}:insights:${dayKey(asOf)}`));
  const sources = ['CBS Integration', 'CIBIL Bureau', 'Claims System', 'Decision Engine API', 'AML System', 'LOS', 'ERP'];

  return INSIGHT_TEMPLATES.map((tpl, i) => ({
    insight_id: `INS-${String(i + 1).padStart(3, '0')}`,
    type: tpl.type,
    severity: tpl.sev,
    title: tpl.title,
    description: tpl.desc,
    affected_integration: pick(sources, rng),
    recommendation: tpl.rec,
    estimated_impact: pick(['₹8–15 Cr revenue at risk', '22% SLA breach probability', '35% latency reduction achievable', 'Zero customer impact if actioned now', 'Capacity headroom restored'], rng),
    confidence_score: r2(0.72 + rng() * 0.26),
    generated_at: new Date(asOf.getTime() - Math.floor(rng() * 6) * 3600000).toISOString(),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — Executive View KPIs
// ─────────────────────────────────────────────────────────────────────────────

export interface IntegrationExecutiveKpis {
  total_integrations: number;
  active_integrations: number;
  failed_integrations: number;
  critical_dependencies: number;
  vendor_risk_score: number;
  integration_maturity_score: number;
  total_api_sla_breaches_30d: number;
  partner_sla_compliance_pct: number;
  data_quality_score: number;
  estimated_integration_value_cr: number;
  integrations_by_category: Record<IntegrationCategory, number>;
  top_risks: string[];
}

export function buildExecutiveKpis(tenant: string, asOf: Date): IntegrationExecutiveKpis {
  const rng = mulberry32(fnv1a(`${tenant}:exec-kpis:${dayKey(asOf)}`));
  const catalog = buildIntegrationCatalog(tenant, asOf);
  const active = catalog.filter(c => c.status === 'active').length;

  return {
    total_integrations: catalog.length,
    active_integrations: active,
    failed_integrations: catalog.filter(c => c.status === 'inactive').length,
    critical_dependencies: Math.floor(4 + rng() * 4),
    vendor_risk_score: Math.floor(62 + rng() * 24),
    integration_maturity_score: Math.floor(68 + rng() * 20),
    total_api_sla_breaches_30d: Math.floor(rng() * 12),
    partner_sla_compliance_pct: r2(91 + rng() * 8),
    data_quality_score: Math.floor(82 + rng() * 14),
    estimated_integration_value_cr: r2(280 + rng() * 220),
    integrations_by_category: {
      banking: BANKING_INTEGRATIONS.length,
      insurance: INSURANCE_INTEGRATIONS.length,
      enterprise: ENTERPRISE_INTEGRATIONS.length,
    },
    top_risks: [
      'CBS single-point-of-failure risk — failover not implemented',
      'Bureau API latency SLA breach trend in next 7 days',
      '3 partner contracts expiring within 60 days',
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 10 — Integration Readiness Score
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadinessScore {
  overall_score: number;
  grade: 'A+' | 'A' | 'B+' | 'B' | 'C' | 'D';
  dimensions: Record<ReadinessDimension, { score: number; status: 'good' | 'fair' | 'poor'; gap: string }>;
  strengths: string[];
  improvement_areas: string[];
  benchmark_comparison: { industry_avg: number; top_quartile: number; our_score: number };
}

const GAPS: Record<ReadinessDimension, string[]> = {
  security: ['mTLS not enforced on 4 integrations', 'API key rotation overdue for 2 endpoints'],
  reliability: ['Failover untested for CBS path', '3 flows lack circuit breaker'],
  performance: ['P99 latency >1s for 5 APIs', 'No auto-scaling on event broker'],
  governance: ['2 integrations pending security review', '4 approvals pending > 30 days'],
  compliance: ['DPDP 2023 data localisation review pending', 'RBI data residency check overdue'],
  documentation: ['API contracts outdated for 6 endpoints', 'Runbooks missing for 3 integrations'],
};

export function buildReadinessScore(tenant: string, asOf: Date): ReadinessScore {
  const rng = mulberry32(fnv1a(`${tenant}:readiness:${dayKey(asOf)}`));
  const scores: Record<ReadinessDimension, number> = {
    security: Math.floor(70 + rng() * 22),
    reliability: Math.floor(75 + rng() * 18),
    performance: Math.floor(72 + rng() * 20),
    governance: Math.floor(68 + rng() * 22),
    compliance: Math.floor(78 + rng() * 18),
    documentation: Math.floor(62 + rng() * 25),
  };
  const weights = { security: 0.25, reliability: 0.20, performance: 0.15, governance: 0.20, compliance: 0.15, documentation: 0.05 };
  const overall = Math.floor(Object.entries(scores).reduce((s, [k, v]) => s + v * weights[k as ReadinessDimension], 0));
  const grade: ReadinessScore['grade'] = overall >= 92 ? 'A+' : overall >= 85 ? 'A' : overall >= 78 ? 'B+' : overall >= 70 ? 'B' : overall >= 60 ? 'C' : 'D';

  return {
    overall_score: overall,
    grade,
    dimensions: (Object.keys(scores) as ReadinessDimension[]).reduce((acc, dim) => {
      const s = scores[dim];
      acc[dim] = { score: s, status: s >= 80 ? 'good' : s >= 65 ? 'fair' : 'poor', gap: pick(GAPS[dim], rng) };
      return acc;
    }, {} as ReadinessScore['dimensions']),
    strengths: ['Compliance framework well-established', 'Data exchange reliability above 99%', 'Partner SLA compliance strong at 93%'],
    improvement_areas: ['Security hardening for 4 integrations', 'Documentation refresh required', 'Governance review backlog clearance'],
    benchmark_comparison: { industry_avg: 68, top_quartile: 85, our_score: overall },
  };
}
