// Enterprise Data Fabric Center — pure resolver. 14th IA overlay (additive).
// Foundational module — declares shared closed enums + types + Source Registry +
// Integration Connections + Executions + Hub summary. No I/O, no React, deterministic.

// ============================================================================
// Deterministic synthesis helpers (FNV-1a + Mulberry32)
// ============================================================================

function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayIndex(asOf: Date): number {
  return Math.floor(asOf.getTime() / 86_400_000);
}

function toIsoTimestamp(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
}

function toIsoDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function pickFrom<T>(arr: readonly T[], rng: () => number): T {
  const idx = Math.floor(rng() * arr.length);
  return arr[Math.min(idx, arr.length - 1)];
}

function weightedPick<T extends string>(rng: () => number, choices: ReadonlyArray<[T, number]>): T {
  const total = choices.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [v, w] of choices) {
    roll -= w;
    if (roll <= 0) return v;
  }
  return choices[choices.length - 1][0];
}

function padNumber(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function roundTo(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

// ============================================================================
// Closed enums — shared across the Data Fabric Center
// ============================================================================

export const DATA_DOMAINS = ['banking', 'insurance', 'common'] as const;
export type DataDomain = (typeof DATA_DOMAINS)[number];

export const BANKING_SOURCE_KINDS = [
  'cbs',
  'los',
  'lms',
  'crm_banking',
  'collections',
  'treasury',
  'aml',
  'kyc',
  'credit_bureau',
  'payments',
] as const;
export type BankingSourceKind = (typeof BANKING_SOURCE_KINDS)[number];

export const INSURANCE_SOURCE_KINDS = [
  'policy_admin',
  'claims_mgmt',
  'agency_mgmt',
  'crm_insurance',
  'billing',
  'underwriting',
  'fraud_detection',
  'customer_service',
] as const;
export type InsuranceSourceKind = (typeof INSURANCE_SOURCE_KINDS)[number];

export const COMMON_SOURCE_KINDS = [
  'rest_api',
  'soap_api',
  'file',
  'sftp',
  'postgresql',
  'oracle',
  'sql_server',
  'kafka',
  'webhook',
] as const;
export type CommonSourceKind = (typeof COMMON_SOURCE_KINDS)[number];

export type DataSourceKind = BankingSourceKind | InsuranceSourceKind | CommonSourceKind;

export const INTEGRATION_TYPES = [
  'api',
  'file',
  'streaming',
  'database_replication',
  'event_driven',
] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const INTEGRATION_STATUSES = [
  'active',
  'paused',
  'failed',
  'retrying',
  'degraded',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const EXECUTION_STATUSES = [
  'success',
  'failure',
  'partial',
  'running',
  'queued',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const PIPELINE_STATUSES = [
  'idle',
  'scheduled',
  'running',
  'paused',
  'failed',
  'success',
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const PIPELINE_ACTIONS = [
  'create',
  'schedule',
  'execute',
  'pause',
  'resume',
  'retry',
] as const;
export type PipelineAction = (typeof PIPELINE_ACTIONS)[number];

export const DATA_CLASSIFICATIONS = [
  'public',
  'internal',
  'confidential',
  'restricted',
  'pii',
  'pci',
  'phi',
  'regulatory',
] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const QUALITY_DIMENSIONS = [
  'completeness',
  'accuracy',
  'consistency',
  'validity',
  'timeliness',
  'uniqueness',
] as const;
export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

export const QUALITY_BANDS = ['excellent', 'good', 'fair', 'poor', 'critical'] as const;
export type QualityBand = (typeof QUALITY_BANDS)[number];

export const OBSERVABILITY_EVENT_KINDS = [
  'freshness_lag',
  'volume_anomaly',
  'schema_change',
  'failed_load',
  'pipeline_latency_spike',
  'data_drift',
  'quality_degradation',
] as const;
export type ObservabilityEventKind = (typeof OBSERVABILITY_EVENT_KINDS)[number];

export const OBSERVABILITY_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type ObservabilitySeverity = (typeof OBSERVABILITY_SEVERITIES)[number];

export const READINESS_STATES = ['ready', 'degraded', 'unavailable'] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const DATA_FABRIC_ROLES = [
  'super_admin',
  'country_admin',
  'data_governance_admin',
  'data_steward',
  'data_owner',
  'risk_analyst',
  'auditor',
  'cro',
  'ceo',
  'cfo',
  'coo',
  'board_member',
  'country_head',
  'admin',
  'supervisor',
  'executive',
] as const;
export type DataFabricRole = (typeof DATA_FABRIC_ROLES)[number];

const DATA_FABRIC_ROLES_SET: ReadonlySet<string> = new Set(DATA_FABRIC_ROLES);

export function canAccessDataFabricCenter(roles?: string[] | null): boolean {
  if (!roles || !Array.isArray(roles) || roles.length === 0) return false;
  for (const r of roles) {
    if (typeof r === 'string' && DATA_FABRIC_ROLES_SET.has(r)) return true;
  }
  return false;
}

// ============================================================================
// Source Registry — DataSource
// ============================================================================

export interface DataSource {
  source_id: string;
  tenant_id: string;
  name: string;
  kind: DataSourceKind;
  domain: DataDomain;
  integration_type: IntegrationType;
  status: IntegrationStatus;
  endpoint: string;
  schema_version: string;
  owner: string;
  steward: string;
  classification: DataClassification;
  refresh_frequency: string;
  last_sync_at: string | null;
  created_at: string;
  tags: string[];
  description: string;
}

const STATUS_PRIORITY: Record<IntegrationStatus, number> = {
  failed: 0,
  retrying: 1,
  degraded: 2,
  paused: 3,
  active: 4,
};

const SOURCE_KIND_LABELS: Record<DataSourceKind, string> = {
  cbs: 'Core Banking',
  los: 'Loan Origination',
  lms: 'Loan Mgmt System',
  crm_banking: 'Banking CRM',
  collections: 'Collections',
  treasury: 'Treasury',
  aml: 'AML Engine',
  kyc: 'KYC System',
  credit_bureau: 'Credit Bureau',
  payments: 'Payments Hub',
  policy_admin: 'Policy Admin',
  claims_mgmt: 'Claims Mgmt',
  agency_mgmt: 'Agency Mgmt',
  crm_insurance: 'Insurance CRM',
  billing: 'Billing',
  underwriting: 'Underwriting',
  fraud_detection: 'Fraud Detection',
  customer_service: 'Customer Service',
  rest_api: 'REST API',
  soap_api: 'SOAP API',
  file: 'File Drop',
  sftp: 'SFTP',
  postgresql: 'PostgreSQL',
  oracle: 'Oracle DB',
  sql_server: 'SQL Server',
  kafka: 'Kafka Topic',
  webhook: 'Webhook',
};

const KIND_TO_INTEGRATION_TYPE: Record<DataSourceKind, IntegrationType> = {
  cbs: 'database_replication',
  los: 'api',
  lms: 'database_replication',
  crm_banking: 'api',
  collections: 'api',
  treasury: 'database_replication',
  aml: 'event_driven',
  kyc: 'api',
  credit_bureau: 'api',
  payments: 'streaming',
  policy_admin: 'database_replication',
  claims_mgmt: 'api',
  agency_mgmt: 'api',
  crm_insurance: 'api',
  billing: 'database_replication',
  underwriting: 'api',
  fraud_detection: 'event_driven',
  customer_service: 'api',
  rest_api: 'api',
  soap_api: 'api',
  file: 'file',
  sftp: 'file',
  postgresql: 'database_replication',
  oracle: 'database_replication',
  sql_server: 'database_replication',
  kafka: 'streaming',
  webhook: 'event_driven',
};

const KIND_TO_DEFAULT_CLASSIFICATION: Record<DataSourceKind, DataClassification> = {
  cbs: 'pci',
  los: 'pii',
  lms: 'pii',
  crm_banking: 'pii',
  collections: 'pii',
  treasury: 'restricted',
  aml: 'regulatory',
  kyc: 'pii',
  credit_bureau: 'pii',
  payments: 'pci',
  policy_admin: 'pii',
  claims_mgmt: 'phi',
  agency_mgmt: 'internal',
  crm_insurance: 'pii',
  billing: 'pci',
  underwriting: 'confidential',
  fraud_detection: 'regulatory',
  customer_service: 'internal',
  rest_api: 'internal',
  soap_api: 'internal',
  file: 'internal',
  sftp: 'confidential',
  postgresql: 'internal',
  oracle: 'internal',
  sql_server: 'internal',
  kafka: 'internal',
  webhook: 'internal',
};

const REFRESH_FREQUENCIES = [
  'real-time',
  'every 5 min',
  'every 15 min',
  'hourly',
  'every 4 hours',
  'daily',
  'weekly',
] as const;

const OWNER_POOL = [
  'priya.sharma',
  'raj.patel',
  'anita.desai',
  'vikram.singh',
  'meera.iyer',
  'arjun.reddy',
  'sunita.rao',
  'kiran.malhotra',
  'rohit.gupta',
  'divya.nair',
  'sandeep.kumar',
  'lakshmi.menon',
];

const STEWARD_POOL = [
  'data.steward.banking',
  'data.steward.insurance',
  'data.steward.common',
  'governance.lead.in',
  'governance.lead.apac',
  'steward.cbs.team',
  'steward.claims.team',
  'steward.crm.team',
];

const TAG_POOL = [
  'core',
  'real-time',
  'batch',
  'critical',
  'regulatory',
  'mart',
  'feature-store',
  'legacy',
  'cloud',
  'on-prem',
  'tier-1',
  'tier-2',
];

function makeSourceId(seq: number): string {
  return `SRC-${padNumber(seq + 1, 5)}`;
}

function endpointFor(kind: DataSourceKind, tenant: string, seq: number): string {
  const t = tenant.toLowerCase();
  switch (KIND_TO_INTEGRATION_TYPE[kind]) {
    case 'api':
      return `https://api.${t}.example.com/${kind}/v1`;
    case 'streaming':
      return `kafka://msk.${t}.internal/${kind}.events.v1`;
    case 'database_replication':
      return `${kind === 'oracle' ? 'oracle' : kind === 'sql_server' ? 'mssql' : 'postgres'}://db-${kind}-${seq}.${t}.internal/${kind}_prod`;
    case 'file':
      return `sftp://files.${t}.example.com/inbound/${kind}/`;
    case 'event_driven':
      return `https://webhook.${t}.example.com/events/${kind}`;
    default:
      return `https://${t}.example.com/${kind}`;
  }
}

function refreshFor(integration_type: IntegrationType, rng: () => number): string {
  if (integration_type === 'streaming' || integration_type === 'event_driven') {
    return rng() < 0.7 ? 'real-time' : 'every 5 min';
  }
  if (integration_type === 'database_replication') {
    return pickFrom(['every 15 min', 'hourly', 'every 4 hours', 'daily'] as const, rng);
  }
  if (integration_type === 'file') {
    return pickFrom(['hourly', 'daily', 'weekly'] as const, rng);
  }
  return pickFrom(REFRESH_FREQUENCIES, rng);
}

function pickStatus(rng: () => number): IntegrationStatus {
  return weightedPick<IntegrationStatus>(rng, [
    ['active', 65],
    ['degraded', 15],
    ['paused', 10],
    ['retrying', 7],
    ['failed', 3],
  ]);
}

function lastSyncFor(status: IntegrationStatus, asOf: Date, rng: () => number): string | null {
  if (status === 'paused' || status === 'failed') return null;
  // 0..7 days back, with hours/minutes jitter
  const hoursBack = Math.floor(rng() * 24 * 7);
  const minutesBack = Math.floor(rng() * 60);
  const t = asOf.getTime() - hoursBack * 3600_000 - minutesBack * 60_000;
  return toIsoTimestamp(new Date(t));
}

function pickTags(_kind: DataSourceKind, integration_type: IntegrationType, rng: () => number): string[] {
  const out: string[] = [];
  // 2..4 tags
  const count = 2 + Math.floor(rng() * 3);
  const used = new Set<string>();
  // Always include integration_type hint
  if (integration_type === 'streaming') used.add('real-time');
  if (integration_type === 'file') used.add('batch');
  while (used.size < count) {
    used.add(pickFrom(TAG_POOL, rng));
  }
  for (const t of used) out.push(t);
  return out.sort();
}

function makeDataSource(
  tenant_id: string,
  kind: DataSourceKind,
  domain: DataDomain,
  seq: number,
  asOf: Date,
): DataSource {
  const seed = fnv1a(`${tenant_id}|datasource|${kind}|${seq}|${dayIndex(asOf)}`);
  const rng = mulberry32(seed);
  const status = pickStatus(rng);
  const integration_type = KIND_TO_INTEGRATION_TYPE[kind];
  const refresh = refreshFor(integration_type, rng);
  const owner = pickFrom(OWNER_POOL, rng);
  const steward = pickFrom(STEWARD_POOL, rng);
  const classification = KIND_TO_DEFAULT_CLASSIFICATION[kind];
  const versionMajor = 1 + Math.floor(rng() * 3);
  const versionMinor = Math.floor(rng() * 10);
  const label = SOURCE_KIND_LABELS[kind];
  // created_at: 30..720 days back
  const createdDaysBack = 30 + Math.floor(rng() * 690);
  const createdMs = asOf.getTime() - createdDaysBack * 86_400_000;
  const last_sync_at = lastSyncFor(status, asOf, rng);
  return {
    source_id: makeSourceId(seq),
    tenant_id,
    name: `${label} ${padNumber(seq + 1, 3)}`,
    kind,
    domain,
    integration_type,
    status,
    endpoint: endpointFor(kind, tenant_id, seq),
    schema_version: `v${versionMajor}.${versionMinor}`,
    owner,
    steward,
    classification,
    refresh_frequency: refresh,
    last_sync_at,
    created_at: toIsoDate(new Date(createdMs)),
    tags: pickTags(kind, integration_type, rng),
    description: `${label} integration for ${domain} domain in ${tenant_id}.`,
  };
}

function generateAllDataSources(tenant_id: string, asOf: Date): DataSource[] {
  const out: DataSource[] = [];
  let seq = 0;

  // 12 banking sources spanning all 10 banking kinds (2 kinds repeat)
  const bankingKinds: BankingSourceKind[] = [];
  for (let i = 0; i < BANKING_SOURCE_KINDS.length; i++) bankingKinds.push(BANKING_SOURCE_KINDS[i]);
  // pick 2 extras deterministically
  const tenantSeed = fnv1a(`${tenant_id}|source-distribution`);
  const distRng = mulberry32(tenantSeed);
  bankingKinds.push(pickFrom(BANKING_SOURCE_KINDS, distRng));
  bankingKinds.push(pickFrom(BANKING_SOURCE_KINDS, distRng));
  for (const k of bankingKinds) {
    out.push(makeDataSource(tenant_id, k, 'banking', seq++, asOf));
  }

  // 12 insurance sources spanning all 8 insurance kinds (4 kinds repeat)
  const insuranceKinds: InsuranceSourceKind[] = [];
  for (let i = 0; i < INSURANCE_SOURCE_KINDS.length; i++) insuranceKinds.push(INSURANCE_SOURCE_KINDS[i]);
  for (let i = 0; i < 4; i++) insuranceKinds.push(pickFrom(INSURANCE_SOURCE_KINDS, distRng));
  for (const k of insuranceKinds) {
    out.push(makeDataSource(tenant_id, k, 'insurance', seq++, asOf));
  }

  // 12 common sources spanning all 9 common kinds (3 repeat)
  const commonKinds: CommonSourceKind[] = [];
  for (let i = 0; i < COMMON_SOURCE_KINDS.length; i++) commonKinds.push(COMMON_SOURCE_KINDS[i]);
  for (let i = 0; i < 3; i++) commonKinds.push(pickFrom(COMMON_SOURCE_KINDS, distRng));
  for (const k of commonKinds) {
    out.push(makeDataSource(tenant_id, k, 'common', seq++, asOf));
  }

  return out;
}

function matchesSourceFilters(
  s: DataSource,
  filters?: {
    domain?: DataDomain;
    kind?: DataSourceKind;
    status?: IntegrationStatus;
    integration_type?: IntegrationType;
    classification?: DataClassification;
  },
): boolean {
  if (!filters) return true;
  if (filters.domain && s.domain !== filters.domain) return false;
  if (filters.kind && s.kind !== filters.kind) return false;
  if (filters.status && s.status !== filters.status) return false;
  if (filters.integration_type && s.integration_type !== filters.integration_type) return false;
  if (filters.classification && s.classification !== filters.classification) return false;
  return true;
}

export function listDataSources(
  tenant_id: string,
  asOf?: Date,
  filters?: {
    domain?: DataDomain;
    kind?: DataSourceKind;
    status?: IntegrationStatus;
    integration_type?: IntegrationType;
    classification?: DataClassification;
  },
): DataSource[] {
  const when = asOf ?? new Date();
  const all = generateAllDataSources(tenant_id, when);
  const filtered = all.filter((s) => matchesSourceFilters(s, filters));
  filtered.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status];
    const pb = STATUS_PRIORITY[b.status];
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
  return filtered;
}

export function getDataSource(
  source_id: string,
  tenant_id: string,
  asOf?: Date,
): DataSource | null {
  if (!source_id || !tenant_id) return null;
  const when = asOf ?? new Date();
  const all = generateAllDataSources(tenant_id, when);
  for (const s of all) {
    if (s.source_id === source_id) return s;
  }
  return null;
}

// ============================================================================
// Integration Connections
// ============================================================================

export interface IntegrationConnection {
  connection_id: string;
  tenant_id: string;
  source_id: string;
  target: string;
  integration_type: IntegrationType;
  status: IntegrationStatus;
  throughput_per_min: number;
  avg_latency_ms: number;
  availability_pct: number;
  success_rate: number;
  retry_count_last_hour: number;
  last_run_at: string | null;
  created_at: string;
  status_priority_helper?: never;
}

const TARGET_POOL_BY_DOMAIN: Record<DataDomain, string[]> = {
  banking: [
    'mart.customer_360',
    'mart.loan_360',
    'mart.txn_features',
    'mart.indicator_values',
    'rules_engine.alerts',
    'feature_store.banking',
    'analytics.banking_dashboard',
  ],
  insurance: [
    'mart.policy_360',
    'mart.claims_360',
    'mart.agent_360',
    'feature_store.insurance',
    'rules_engine.insurance_alerts',
    'analytics.insurance_dashboard',
  ],
  common: [
    'audit.event_log',
    'data_lake.raw',
    'data_lake.curated',
    'mart.shared_dim',
    'feature_store.shared',
    'analytics.executive_dashboard',
  ],
};

function makeConnectionId(seq: number): string {
  return `CNX-${padNumber(seq + 1, 5)}`;
}

function generateAllConnections(tenant_id: string, asOf: Date): IntegrationConnection[] {
  const sources = generateAllDataSources(tenant_id, asOf);
  const out: IntegrationConnection[] = [];
  const totalConnections = 28;
  // Cycle through sources so every connection has a stable source_id
  for (let i = 0; i < totalConnections; i++) {
    const src = sources[i % sources.length];
    const seed = fnv1a(`${tenant_id}|connection|${i}|${dayIndex(asOf)}`);
    const rng = mulberry32(seed);
    // Connection inherits source status with some drift
    let status: IntegrationStatus = src.status;
    const drift = rng();
    if (drift < 0.15) status = pickStatus(rng);
    const targets = TARGET_POOL_BY_DOMAIN[src.domain];
    const target = pickFrom(targets, rng);

    // Throughput depends on integration type
    let throughput = 0;
    if (status === 'active' || status === 'degraded' || status === 'retrying') {
      switch (src.integration_type) {
        case 'streaming':
          throughput = Math.floor(500 + rng() * 4500);
          break;
        case 'event_driven':
          throughput = Math.floor(50 + rng() * 950);
          break;
        case 'api':
          throughput = Math.floor(20 + rng() * 280);
          break;
        case 'database_replication':
          throughput = Math.floor(100 + rng() * 900);
          break;
        case 'file':
          throughput = Math.floor(5 + rng() * 45);
          break;
      }
      if (status === 'degraded') throughput = Math.floor(throughput * 0.4);
      if (status === 'retrying') throughput = Math.floor(throughput * 0.2);
    }

    // Latency
    let latency = 50 + rng() * 200;
    if (status === 'degraded') latency *= 3;
    if (status === 'retrying') latency *= 5;
    latency = Math.round(latency);

    // Availability
    let availability = 99.5;
    if (status === 'degraded') availability = 92 + rng() * 6;
    else if (status === 'retrying') availability = 85 + rng() * 8;
    else if (status === 'failed') availability = 70 + rng() * 15;
    else if (status === 'paused') availability = 100;
    else availability = 99 + rng();
    availability = roundTo(availability, 2);

    // Success rate
    let success = 0.99;
    if (status === 'active') success = 0.97 + rng() * 0.03;
    else if (status === 'degraded') success = 0.85 + rng() * 0.1;
    else if (status === 'retrying') success = 0.7 + rng() * 0.15;
    else if (status === 'failed') success = 0.3 + rng() * 0.3;
    else if (status === 'paused') success = 1.0;
    success = roundTo(success, 4);

    // Retry counts
    let retryCount = 0;
    if (status === 'retrying') retryCount = 5 + Math.floor(rng() * 20);
    else if (status === 'degraded') retryCount = 1 + Math.floor(rng() * 5);
    else if (status === 'failed') retryCount = 3 + Math.floor(rng() * 10);

    // last_run_at
    let last_run_at: string | null = null;
    if (status !== 'paused') {
      const minutesBack = Math.floor(rng() * 60 * 24);
      last_run_at = toIsoTimestamp(new Date(asOf.getTime() - minutesBack * 60_000));
    }

    // created_at: 30..600 days back
    const createdDaysBack = 30 + Math.floor(rng() * 570);
    const created_at = toIsoDate(new Date(asOf.getTime() - createdDaysBack * 86_400_000));

    out.push({
      connection_id: makeConnectionId(i),
      tenant_id,
      source_id: src.source_id,
      target,
      integration_type: src.integration_type,
      status,
      throughput_per_min: throughput,
      avg_latency_ms: latency,
      availability_pct: availability,
      success_rate: success,
      retry_count_last_hour: retryCount,
      last_run_at,
      created_at,
    });
  }
  return out;
}

export function listIntegrationConnections(
  tenant_id: string,
  asOf?: Date,
  filters?: { status?: IntegrationStatus; integration_type?: IntegrationType },
): IntegrationConnection[] {
  const when = asOf ?? new Date();
  const all = generateAllConnections(tenant_id, when);
  const filtered = all.filter((c) => {
    if (filters?.status && c.status !== filters.status) return false;
    if (filters?.integration_type && c.integration_type !== filters.integration_type) return false;
    return true;
  });
  filtered.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status];
    const pb = STATUS_PRIORITY[b.status];
    if (pa !== pb) return pa - pb;
    return a.connection_id.localeCompare(b.connection_id);
  });
  return filtered;
}

// ============================================================================
// Integration Executions
// ============================================================================

export interface IntegrationExecution {
  execution_id: string;
  connection_id: string;
  tenant_id: string;
  status: ExecutionStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  records_processed: number;
  records_failed: number;
  error_message: string | null;
}

const EXECUTION_ERROR_MESSAGES: Record<ExecutionStatus, string[]> = {
  success: [],
  partial: [
    'Some records failed validation: schema mismatch',
    'Partial load completed: 3% records skipped',
    'Source returned incomplete payload',
  ],
  failure: [
    'Connection timed out after 30s',
    'Authentication failed: invalid credentials',
    'Source endpoint returned 503',
    'Schema validation failed: required field missing',
    'Database lock timeout exceeded',
    'Kafka consumer group rebalance failed',
  ],
  running: [],
  queued: [],
};

function makeExecutionId(seq: number): string {
  return `EXE-${padNumber(seq + 1, 7)}`;
}

function generateAllExecutions(tenant_id: string, asOf: Date): IntegrationExecution[] {
  const connections = generateAllConnections(tenant_id, asOf);
  const out: IntegrationExecution[] = [];
  const totalExecutions = 80;
  for (let i = 0; i < totalExecutions; i++) {
    const conn = connections[i % connections.length];
    const seed = fnv1a(`${tenant_id}|execution|${i}|${dayIndex(asOf)}`);
    const rng = mulberry32(seed);

    // Execution status distribution: tied loosely to connection status
    let status: ExecutionStatus;
    if (conn.status === 'paused') {
      status = 'queued';
    } else if (conn.status === 'failed') {
      status = rng() < 0.7 ? 'failure' : 'partial';
    } else if (conn.status === 'retrying') {
      status = weightedPick<ExecutionStatus>(rng, [
        ['failure', 40],
        ['partial', 30],
        ['running', 15],
        ['success', 15],
      ]);
    } else if (conn.status === 'degraded') {
      status = weightedPick<ExecutionStatus>(rng, [
        ['success', 50],
        ['partial', 30],
        ['failure', 15],
        ['running', 5],
      ]);
    } else {
      // active
      status = weightedPick<ExecutionStatus>(rng, [
        ['success', 80],
        ['partial', 10],
        ['failure', 5],
        ['running', 4],
        ['queued', 1],
      ]);
    }

    // Started: 0..72 hours back
    const startBackMin = Math.floor(rng() * 60 * 72);
    const startedAt = new Date(asOf.getTime() - startBackMin * 60_000);

    // Duration
    let duration_ms = 0;
    let finished_at: string | null = null;
    if (status === 'running' || status === 'queued') {
      duration_ms = 0;
      finished_at = null;
    } else {
      const baseMs =
        conn.integration_type === 'streaming'
          ? 100 + rng() * 2000
          : conn.integration_type === 'event_driven'
            ? 200 + rng() * 3000
            : conn.integration_type === 'api'
              ? 500 + rng() * 5000
              : conn.integration_type === 'database_replication'
                ? 5000 + rng() * 60000
                : 10000 + rng() * 120000;
      duration_ms = Math.round(baseMs);
      finished_at = toIsoTimestamp(new Date(startedAt.getTime() + duration_ms));
    }

    // Records
    let records_processed = 0;
    if (status !== 'queued') {
      const base = conn.throughput_per_min > 0 ? conn.throughput_per_min : 100;
      records_processed = Math.floor(base * (0.5 + rng() * 2));
    }
    let records_failed = 0;
    if (status === 'partial') {
      records_failed = Math.floor(records_processed * (0.02 + rng() * 0.08));
    } else if (status === 'failure') {
      records_failed = records_processed;
      records_processed = 0;
    }

    // Error message
    let error_message: string | null = null;
    if (status === 'failure' || status === 'partial') {
      const pool = EXECUTION_ERROR_MESSAGES[status];
      if (pool.length > 0) error_message = pickFrom(pool, rng);
    }

    out.push({
      execution_id: makeExecutionId(i),
      connection_id: conn.connection_id,
      tenant_id,
      status,
      started_at: toIsoTimestamp(startedAt),
      finished_at,
      duration_ms,
      records_processed,
      records_failed,
      error_message,
    });
  }
  return out;
}

export function listIntegrationExecutions(
  tenant_id: string,
  asOf?: Date,
  filters?: { connection_id?: string; status?: ExecutionStatus },
  limit?: number,
): IntegrationExecution[] {
  const when = asOf ?? new Date();
  const all = generateAllExecutions(tenant_id, when);
  let filtered = all.filter((e) => {
    if (filters?.connection_id && e.connection_id !== filters.connection_id) return false;
    if (filters?.status && e.status !== filters.status) return false;
    return true;
  });
  // Sort newest-first by started_at, tiebreak by execution_id desc for stability
  filtered.sort((a, b) => {
    if (a.started_at < b.started_at) return 1;
    if (a.started_at > b.started_at) return -1;
    return b.execution_id.localeCompare(a.execution_id);
  });
  const cap = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50;
  return filtered.slice(0, cap);
}

// ============================================================================
// Integration Hub Summary
// ============================================================================

export interface IntegrationHubSummary {
  tenant_id: string;
  generated_at: string;
  total_sources: number;
  total_connections: number;
  active_integrations: number;
  failed_integrations: number;
  retrying_count: number;
  retry_queue_depth: number;
  total_throughput_per_min: number;
  avg_latency_ms: number;
  availability_pct: number;
  success_rate: number;
  by_status: Record<IntegrationStatus, number>;
  by_integration_type: Record<IntegrationType, number>;
  by_domain: Record<DataDomain, number>;
}

function emptyByStatus(): Record<IntegrationStatus, number> {
  const out = {} as Record<IntegrationStatus, number>;
  for (const s of INTEGRATION_STATUSES) out[s] = 0;
  return out;
}

function emptyByIntegrationType(): Record<IntegrationType, number> {
  const out = {} as Record<IntegrationType, number>;
  for (const t of INTEGRATION_TYPES) out[t] = 0;
  return out;
}

function emptyByDomain(): Record<DataDomain, number> {
  const out = {} as Record<DataDomain, number>;
  for (const d of DATA_DOMAINS) out[d] = 0;
  return out;
}

export function buildIntegrationHubSummary(
  tenant_id: string,
  asOf?: Date,
): IntegrationHubSummary {
  const when = asOf ?? new Date();
  const sources = generateAllDataSources(tenant_id, when);
  const connections = generateAllConnections(tenant_id, when);
  const executions = generateAllExecutions(tenant_id, when);

  const by_status = emptyByStatus();
  const by_integration_type = emptyByIntegrationType();
  const by_domain = emptyByDomain();

  for (const c of connections) {
    by_status[c.status] = (by_status[c.status] || 0) + 1;
    by_integration_type[c.integration_type] = (by_integration_type[c.integration_type] || 0) + 1;
  }
  for (const s of sources) {
    by_domain[s.domain] = (by_domain[s.domain] || 0) + 1;
  }

  const active_integrations = by_status.active;
  const failed_integrations = by_status.failed;
  const retrying_count = by_status.retrying;

  // Retry queue depth = Σ retry_count_last_hour across retrying + degraded + failed connections
  let retry_queue_depth = 0;
  for (const c of connections) {
    if (c.status === 'retrying' || c.status === 'degraded' || c.status === 'failed') {
      retry_queue_depth += c.retry_count_last_hour;
    }
  }

  // total throughput = sum across active connections
  let total_throughput_per_min = 0;
  for (const c of connections) {
    if (c.status === 'active') total_throughput_per_min += c.throughput_per_min;
  }

  // avg_latency across active
  let activeLatencySum = 0;
  let activeLatencyCount = 0;
  for (const c of connections) {
    if (c.status === 'active') {
      activeLatencySum += c.avg_latency_ms;
      activeLatencyCount += 1;
    }
  }
  const avg_latency_ms = activeLatencyCount > 0
    ? Math.round(activeLatencySum / activeLatencyCount)
    : 0;

  // availability across ALL connections
  let availSum = 0;
  for (const c of connections) availSum += c.availability_pct;
  const availability_pct = connections.length > 0
    ? roundTo(availSum / connections.length, 2)
    : 0;

  // success rate across executions that have a terminal outcome (success, partial, failure)
  let succWeight = 0;
  let succCount = 0;
  for (const e of executions) {
    if (e.status === 'success') {
      succWeight += 1;
      succCount += 1;
    } else if (e.status === 'partial') {
      succWeight += 0.5;
      succCount += 1;
    } else if (e.status === 'failure') {
      succWeight += 0;
      succCount += 1;
    }
  }
  const success_rate = succCount > 0 ? roundTo(succWeight / succCount, 4) : 0;

  return {
    tenant_id,
    generated_at: toIsoTimestamp(when),
    total_sources: sources.length,
    total_connections: connections.length,
    active_integrations,
    failed_integrations,
    retrying_count,
    retry_queue_depth,
    total_throughput_per_min,
    avg_latency_ms,
    availability_pct,
    success_rate,
    by_status,
    by_integration_type,
    by_domain,
  };
}
