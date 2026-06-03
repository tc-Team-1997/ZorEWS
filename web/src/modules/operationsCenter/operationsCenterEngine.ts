/**
 * Production Operations Center — core engine.
 *
 * Pure-function engine: no I/O, no React, no stores.
 * Deterministic for (tenant, day) via FNV-1a + Mulberry32.
 *
 * 13 sections: Platform Health, Service Registry, API Operations,
 * Incident Management, Change Management, Release Management,
 * Environment Management, Capacity & Performance, Security Ops,
 * Business Continuity, Observability, Executive Dashboard, AI Insights.
 *
 * Phase 23 IA overlay — additive; every prior module untouched.
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
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function pick<T>(arr: readonly T[], rng: () => number): T { return arr[Math.floor(rng() * arr.length)]; }
function tsAgo(d: Date, ms: number): string { return new Date(d.getTime() - ms).toISOString(); }
function addDays(d: Date, n: number): string { return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10); }

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const SERVICE_NAMES = [
  'Alert Engine', 'Rules Engine', 'AI Engine', 'Investigation Engine',
  'Compliance Engine', 'Integration Engine', 'Event Streaming Engine',
  'Reporting Engine', 'IAM Service', 'BFF Gateway', 'Audit Service', 'Recovery Service',
] as const;
export type ServiceName = typeof SERVICE_NAMES[number];

export const SERVICE_STATUSES = ['healthy', 'degraded', 'critical', 'offline', 'maintenance'] as const;
export type ServiceStatus = typeof SERVICE_STATUSES[number];

export const INCIDENT_SEVERITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type IncidentSeverity = typeof INCIDENT_SEVERITIES[number];

export const INCIDENT_STATES = ['open', 'assigned', 'investigating', 'mitigated', 'resolved', 'closed'] as const;
export type IncidentState = typeof INCIDENT_STATES[number];

export const CHANGE_STATES = ['draft', 'review', 'approved', 'implemented', 'rejected'] as const;
export type ChangeState = typeof CHANGE_STATES[number];

export const ENVIRONMENTS = ['development', 'sit', 'uat', 'pre_production', 'production'] as const;
export type Environment = typeof ENVIRONMENTS[number];

export const HEALTH_COLORS = ['green', 'amber', 'red'] as const;
export type HealthColor = typeof HEALTH_COLORS[number];

export const API_TYPES = ['REST', 'GraphQL', 'Event'] as const;
export type OpsApiType = typeof API_TYPES[number];

export const AI_INSIGHT_TYPES = ['failure_prediction', 'capacity_forecast', 'incident_hotspot', 'release_risk', 'recommendation'] as const;
export type AiInsightType = typeof AI_INSIGHT_TYPES[number];

// ─────────────────────────────────────────────────────────────────────────────
// RBAC
// ─────────────────────────────────────────────────────────────────────────────

export const OPERATIONS_ROLES: readonly string[] = [
  'admin', 'supervisor', 'risk_analyst', 'super_admin', 'country_admin',
  'bank_admin', 'insurance_admin', 'auditor', 'compliance_officer',
  'operations_user', 'executive', 'cdo', 'cro', 'ceo', 'coo',
  'board_member', 'operations_manager', 'country_head',
];
export function canAccessOperationsCenter(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  const allowed = new Set(OPERATIONS_ROLES);
  for (const r of roles) { if (allowed.has(r)) return true; }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Platform Health Command Center
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformHealthKpis {
  overall_health: HealthColor;
  health_score: number;
  availability_pct: number;
  active_services: number;
  total_services: number;
  failed_services: number;
  degraded_services: number;
  critical_alerts: number;
  active_incidents: number;
  system_load_pct: number;
  capacity_utilization_pct: number;
  mttr_minutes: number;
  mtbf_days: number;
  sla_compliance_pct: number;
}

export function buildPlatformHealthKpis(tenant: string, asOf: Date): PlatformHealthKpis {
  const rng = mulberry32(fnv1a(`${tenant}:health-kpis:${dayKey(asOf)}`));
  const total = SERVICE_NAMES.length;
  const failed = Math.floor(rng() * 2);
  const degraded = Math.floor(rng() * 3);
  const active = total - failed - degraded;
  const score = Math.floor(clamp(80 + rng() * 18 - failed * 8 - degraded * 3, 60, 99));
  const color: HealthColor = score >= 90 ? 'green' : score >= 75 ? 'amber' : 'red';

  return {
    overall_health: color,
    health_score: score,
    availability_pct: r2(99 + rng() * 0.95),
    active_services: active,
    total_services: total,
    failed_services: failed,
    degraded_services: degraded,
    critical_alerts: Math.floor(rng() * 6),
    active_incidents: Math.floor(rng() * 4),
    system_load_pct: r1(35 + rng() * 40),
    capacity_utilization_pct: r1(42 + rng() * 35),
    mttr_minutes: Math.floor(12 + rng() * 28),
    mtbf_days: Math.floor(18 + rng() * 42),
    sla_compliance_pct: r2(97.5 + rng() * 2.4),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Service Registry
// ─────────────────────────────────────────────────────────────────────────────

export interface ServiceEntry {
  service_id: string;
  name: ServiceName;
  version: string;
  owner: string;
  environment: Environment;
  uptime_pct: number;
  status: ServiceStatus;
  last_deployment: string;
  health_checks_passed: number;
  health_checks_total: number;
  avg_response_ms: number;
  instances: number;
  cpu_pct: number;
  memory_pct: number;
  dependencies: string[];
  port: number;
}

const SERVICE_OWNERS: Record<ServiceName, string> = {
  'Alert Engine': 'Risk Platform Team', 'Rules Engine': 'Risk Platform Team',
  'AI Engine': 'AI/ML Team', 'Investigation Engine': 'Case Management Team',
  'Compliance Engine': 'Compliance Team', 'Integration Engine': 'Integration Team',
  'Event Streaming Engine': 'Data Platform Team', 'Reporting Engine': 'Analytics Team',
  'IAM Service': 'Security Team', 'BFF Gateway': 'Frontend Platform Team',
  'Audit Service': 'Governance Team', 'Recovery Service': 'Operations Team',
};

const SERVICE_PORTS: Record<ServiceName, number> = {
  'Alert Engine': 8081, 'Rules Engine': 8082, 'AI Engine': 8083,
  'Investigation Engine': 8084, 'Compliance Engine': 8085, 'Integration Engine': 8086,
  'Event Streaming Engine': 8087, 'Reporting Engine': 8088,
  'IAM Service': 8080, 'BFF Gateway': 8000, 'Audit Service': 8089, 'Recovery Service': 8090,
};

const STATUS_POOL: ServiceStatus[] = ['healthy', 'healthy', 'healthy', 'healthy', 'healthy', 'degraded', 'healthy', 'healthy', 'healthy', 'healthy', 'healthy', 'maintenance'];

export function buildServiceRegistry(tenant: string, asOf: Date): ServiceEntry[] {
  const rng = mulberry32(fnv1a(`${tenant}:services:${dayKey(asOf)}`));
  return SERVICE_NAMES.map((name, i) => {
    const status = STATUS_POOL[i];
    const isHealthy = status === 'healthy';
    return {
      service_id: `SVC-${String(i + 1).padStart(3, '0')}`,
      name,
      version: `v${Math.floor(2 + rng() * 8)}.${Math.floor(rng() * 15)}.${Math.floor(rng() * 10)}`,
      owner: SERVICE_OWNERS[name],
      environment: 'production',
      uptime_pct: r2(isHealthy ? 99.5 + rng() * 0.49 : 92 + rng() * 6),
      status,
      last_deployment: tsAgo(asOf, Math.floor(2 + rng() * 30) * 86400000),
      health_checks_passed: isHealthy ? 100 : Math.floor(85 + rng() * 14),
      health_checks_total: 100,
      avg_response_ms: Math.floor(isHealthy ? 28 + rng() * 72 : 180 + rng() * 320),
      instances: Math.floor(2 + rng() * 4),
      cpu_pct: r1(isHealthy ? 20 + rng() * 45 : 65 + rng() * 25),
      memory_pct: r1(isHealthy ? 30 + rng() * 40 : 72 + rng() * 22),
      dependencies: pick([['PostgreSQL', 'Redis', 'Kafka'], ['PostgreSQL', 'Kafka'], ['PostgreSQL', 'Redis', 'S3'], ['PostgreSQL']], rng) as string[],
      port: SERVICE_PORTS[name],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — API Operations
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiOperation {
  api_id: string;
  name: string;
  endpoint: string;
  api_type: OpsApiType;
  availability_pct: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  error_rate_pct: number;
  requests_per_min: number;
  owner: string;
  sla_ms: number;
  sla_met: boolean;
  status: 'healthy' | 'degraded' | 'down';
}

const API_DEFS = [
  { name: 'Risk Score API',         ep: '/v1/scoring/risk',                type: 'REST' as OpsApiType,     sla: 500,  owner: 'AI Team' },
  { name: 'Alert Ingest API',        ep: '/v1/alerts/ingest',              type: 'REST' as OpsApiType,     sla: 200,  owner: 'Alerts Team' },
  { name: 'Customer 360 API',        ep: '/v1/customers/:id/360',          type: 'REST' as OpsApiType,     sla: 800,  owner: 'Data Platform' },
  { name: 'Decision Engine API',     ep: '/v1/decisions/evaluate',         type: 'REST' as OpsApiType,     sla: 1200, owner: 'AI Decisioning' },
  { name: 'Compliance Check API',    ep: '/v1/compliance/verify',          type: 'REST' as OpsApiType,     sla: 600,  owner: 'Compliance Team' },
  { name: 'Case Management API',     ep: '/v1/cases',                      type: 'REST' as OpsApiType,     sla: 700,  owner: 'Case Team' },
  { name: 'Audit Events API',        ep: '/v1/audit/events',               type: 'REST' as OpsApiType,     sla: 300,  owner: 'Audit Team' },
  { name: 'Platform Events Bus',     ep: 'wss://events.platform.internal', type: 'Event' as OpsApiType,   sla: 100,  owner: 'Data Platform' },
  { name: 'EWS GraphQL Gateway',     ep: '/graphql',                       type: 'GraphQL' as OpsApiType, sla: 600,  owner: 'API Platform' },
  { name: 'Feature Store API',       ep: '/v1/feature-store/snapshot',     type: 'REST' as OpsApiType,     sla: 400,  owner: 'ML Platform' },
];

export function buildApiOperations(tenant: string, asOf: Date): ApiOperation[] {
  const rng = mulberry32(fnv1a(`${tenant}:api-ops:${dayKey(asOf)}`));
  return API_DEFS.map((def, i) => {
    const latency = Math.floor(def.sla * (0.4 + rng() * 0.6));
    const errRate = r2(rng() * 1.5);
    const avail = r2(99 + rng() * 0.95);
    const slaOk = latency < def.sla && errRate < 1;
    return {
      api_id: `API-OPS-${String(i + 1).padStart(3, '0')}`,
      name: def.name,
      endpoint: def.ep,
      api_type: def.type,
      availability_pct: avail,
      avg_latency_ms: latency,
      p95_latency_ms: Math.floor(latency * (1.8 + rng() * 0.8)),
      error_rate_pct: errRate,
      requests_per_min: Math.floor(80 + rng() * 820),
      owner: def.owner,
      sla_ms: def.sla,
      sla_met: slaOk,
      status: avail >= 99.5 && slaOk ? 'healthy' : avail >= 97 ? 'degraded' : 'down',
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Incident Management
// ─────────────────────────────────────────────────────────────────────────────

export interface Incident {
  incident_id: string;
  title: string;
  severity: IncidentSeverity;
  state: IncidentState;
  affected_service: ServiceName;
  owner: string;
  root_cause: string;
  business_impact: string;
  opened_at: string;
  resolved_at: string | null;
  resolution_time_min: number | null;
  mttr_actual_min: number | null;
  war_room_active: boolean;
  postmortem_due: string | null;
}

const INCIDENT_TITLES = [
  'Alert Engine high latency — P95 > 2s threshold breach',
  'AI Engine memory pressure — instance restart required',
  'Database connection pool exhaustion — Compliance Engine',
  'Kafka topic partition lag growing — Event Streaming Engine',
  'SSL certificate approaching expiry — BFF Gateway',
  'Deployment failure — Rules Engine v8.2.1 rollback triggered',
  'Disk I/O saturation — Audit Service primary instance',
  'Network connectivity intermittent — Integration Engine to CBS',
];

const ROOT_CAUSES = [
  'Memory leak introduced in v8.1.0 — unbounded cache growth under load',
  'Connection pool misconfiguration post migration — max_connections too low',
  'Kafka consumer group rebalance storm — too many consumers joining simultaneously',
  'Certificate auto-renewal job failed silently — alerting not wired to renewal service',
  'Schema migration missing index — full table scan on high-volume queries',
];

const IMPACTS = [
  'Risk alert processing delayed by 8-12 minutes — SLA breach risk',
  'AI scoring unavailable for 22 minutes — manual fallback activated',
  'Compliance reporting delayed — no data loss, audit trail intact',
  'Event delivery latency increased 4× — downstream dashboards affected',
];

const SEVERITY_DIST: IncidentSeverity[] = ['P2', 'P3', 'P1', 'P3', 'P4', 'P2', 'P3', 'P3'];

export function buildIncidents(tenant: string, asOf: Date): Incident[] {
  const rng = mulberry32(fnv1a(`${tenant}:incidents:${dayKey(asOf)}`));
  const states: IncidentState[] = ['investigating', 'mitigated', 'resolved', 'open', 'assigned', 'closed', 'resolved', 'closed'];

  return INCIDENT_TITLES.map((title, i) => {
    const sev = SEVERITY_DIST[i];
    const state = states[i];
    const hoursAgo = Math.floor(2 + rng() * 168);
    const openedAt = tsAgo(asOf, hoursAgo * 3600000);
    const isResolved = state === 'resolved' || state === 'closed';
    const resMins = isResolved ? Math.floor(sev === 'P1' ? 30 + rng() * 90 : sev === 'P2' ? 60 + rng() * 180 : 120 + rng() * 480) : null;
    const resolvedAt = isResolved && resMins ? tsAgo(asOf, (hoursAgo * 60 - resMins) * 60000) : null;

    return {
      incident_id: `INC-${dayKey(asOf).replace(/-/g, '')}-${String(i + 1).padStart(4, '0')}`,
      title,
      severity: sev,
      state,
      affected_service: pick(SERVICE_NAMES, rng),
      owner: pick(['ops-lead@bank.com', 'sre-primary@bank.com', 'platform-ops@bank.com'], rng),
      root_cause: isResolved ? pick(ROOT_CAUSES, rng) : 'Under investigation',
      business_impact: pick(IMPACTS, rng),
      opened_at: openedAt,
      resolved_at: resolvedAt,
      resolution_time_min: resMins,
      mttr_actual_min: resMins,
      war_room_active: state === 'investigating' && sev === 'P1',
      postmortem_due: isResolved ? addDays(asOf, Math.floor(3 + rng() * 7)) : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — Change Management
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangeRequest {
  cr_id: string;
  title: string;
  state: ChangeState;
  change_type: 'standard' | 'emergency' | 'normal';
  affected_service: ServiceName;
  risk_level: 'low' | 'medium' | 'high';
  submitter: string;
  approver: string | null;
  submitted_at: string;
  planned_window: string;
  rollback_plan: string;
  estimated_downtime_min: number;
  has_rollback: boolean;
}

const CR_TITLES = [
  'Alert Engine v8.3.0 — performance optimisation + NPA indicator fix',
  'AI Engine model refresh — PD XGBoost v3.3 deployment',
  'Database index rebuild — compliance_events partition table',
  'Kafka partition rebalance — risk.alerts throughput increase',
  'BFF Gateway TLS certificate renewal — production',
  'Rules Engine bulk-load configuration — 50 new MSME rules',
  'Integration Engine CBS connector upgrade — v2.4 API migration',
  'Recovery Service — enhanced backup policy deployment',
];

const CHANGE_STATES_DIST: ChangeState[] = ['approved', 'review', 'implemented', 'draft', 'approved', 'implemented', 'review', 'rejected'];

export function buildChangeRequests(tenant: string, asOf: Date): ChangeRequest[] {
  const rng = mulberry32(fnv1a(`${tenant}:changes:${dayKey(asOf)}`));
  return CR_TITLES.map((title, i) => {
    const state = CHANGE_STATES_DIST[i];
    const isApproved = state === 'approved' || state === 'implemented';
    const daysAgo = Math.floor(1 + rng() * 14);
    return {
      cr_id: `CR-${dayKey(asOf).replace(/-/g, '').slice(-6)}-${String(i + 1).padStart(4, '0')}`,
      title,
      state,
      change_type: rng() > 0.8 ? 'emergency' : rng() > 0.3 ? 'normal' : 'standard',
      affected_service: pick(SERVICE_NAMES, rng),
      risk_level: rng() > 0.6 ? 'low' : rng() > 0.3 ? 'medium' : 'high',
      submitter: pick(['devops@bank.com', 'sre@bank.com', 'release-mgr@bank.com'], rng),
      approver: isApproved ? pick(['cto@bank.com', 'ops-head@bank.com', 'ciso@bank.com'], rng) : null,
      submitted_at: tsAgo(asOf, daysAgo * 86400000),
      planned_window: addDays(asOf, Math.floor(1 + rng() * 7)) + 'T02:00:00Z',
      rollback_plan: `Revert to previous version using blue/green toggle. Estimated rollback time: 8 minutes.`,
      estimated_downtime_min: Math.floor(rng() * 5),
      has_rollback: true,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Release Management
// ─────────────────────────────────────────────────────────────────────────────

export interface ReleaseEntry {
  release_id: string;
  version: string;
  service: ServiceName;
  deployed_at: string;
  deployed_by: string;
  environment: Environment;
  success: boolean;
  rollback_triggered: boolean;
  deployment_time_min: number;
  release_notes: string;
  features_count: number;
  bug_fixes_count: number;
  breaking_changes: boolean;
}

const RELEASE_NOTES_POOL = [
  'NPA ratio calculation fix + MSME sector indicator tuning',
  'PD model v3.3 rollout — AUC improved from 0.847 to 0.863',
  'Event streaming partition rebalance + throughput optimisation',
  'Compliance reporting IRDAI Q1 form update + Basel III LCR fix',
  'Alert Engine latency hotfix — connection pool deadlock resolution',
  'IAM Center user lifecycle workflow + 2FA enforced for admin roles',
];

export function buildReleases(tenant: string, asOf: Date): ReleaseEntry[] {
  const rng = mulberry32(fnv1a(`${tenant}:releases:${dayKey(asOf)}`));
  return Array.from({ length: 10 }, (_, i) => {
    const success = rng() > 0.08;
    const rollback = !success && rng() > 0.5;
    return {
      release_id: `REL-${String(i + 1).padStart(4, '0')}`,
      version: `v${Math.floor(2 + rng() * 8)}.${Math.floor(rng() * 15)}.${Math.floor(rng() * 10)}`,
      service: pick(SERVICE_NAMES, rng),
      deployed_at: tsAgo(asOf, Math.floor(i * 3 + rng() * 3) * 86400000),
      deployed_by: pick(['ci-cd@bank.com', 'devops@bank.com', 'release-mgr@bank.com'], rng),
      environment: 'production',
      success,
      rollback_triggered: rollback,
      deployment_time_min: Math.floor(4 + rng() * 22),
      release_notes: pick(RELEASE_NOTES_POOL, rng),
      features_count: Math.floor(rng() * 8),
      bug_fixes_count: Math.floor(1 + rng() * 6),
      breaking_changes: rng() < 0.1,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — Environment Management
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvironmentEntry {
  env_id: string;
  name: Environment;
  label: string;
  health_score: number;
  health_color: HealthColor;
  active_deployments: number;
  active_incidents: number;
  services_healthy: number;
  services_total: number;
  cpu_pct: number;
  memory_pct: number;
  last_deployment: string;
  uptime_days: number;
}

const ENV_LABELS: Record<Environment, string> = {
  development: 'DEV', sit: 'SIT', uat: 'UAT', pre_production: 'PRE-PROD', production: 'PROD',
};

export function buildEnvironments(tenant: string, asOf: Date): EnvironmentEntry[] {
  const rng = mulberry32(fnv1a(`${tenant}:envs:${dayKey(asOf)}`));
  return ENVIRONMENTS.map((env, i) => {
    const isProd = env === 'production';
    const health = Math.floor(isProd ? 88 + rng() * 10 : 70 + rng() * 25);
    const color: HealthColor = health >= 88 ? 'green' : health >= 72 ? 'amber' : 'red';
    const total = isProd ? SERVICE_NAMES.length : Math.floor(6 + rng() * 6);
    const healthy = Math.floor(total * (health / 100));
    return {
      env_id: `ENV-${String(i + 1).padStart(2, '0')}`,
      name: env,
      label: ENV_LABELS[env],
      health_score: health,
      health_color: color,
      active_deployments: Math.floor(rng() * (isProd ? 2 : 5)),
      active_incidents: Math.floor(rng() * (isProd ? 3 : 1)),
      services_healthy: healthy,
      services_total: total,
      cpu_pct: r1(isProd ? 35 + rng() * 40 : 15 + rng() * 55),
      memory_pct: r1(isProd ? 42 + rng() * 35 : 20 + rng() * 50),
      last_deployment: tsAgo(asOf, Math.floor(rng() * (isProd ? 5 : 1)) * 86400000),
      uptime_days: Math.floor(isProd ? 45 + rng() * 180 : 5 + rng() * 60),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 8 — Capacity & Performance
// ─────────────────────────────────────────────────────────────────────────────

export interface CapacityMetrics {
  cpu_current_pct: number;
  cpu_forecast_7d_pct: number;
  memory_current_pct: number;
  memory_forecast_7d_pct: number;
  storage_current_pct: number;
  storage_forecast_7d_pct: number;
  db_connections_pct: number;
  db_iops_pct: number;
  queue_backlog: number;
  network_bandwidth_pct: number;
  scale_out_recommended: boolean;
  capacity_headroom_days: number;
  pod_count: number;
  pod_capacity: number;
  hourly_trend: Array<{ hour: string; cpu: number; memory: number; requests: number }>;
}

export function buildCapacityMetrics(tenant: string, asOf: Date): CapacityMetrics {
  const rng = mulberry32(fnv1a(`${tenant}:capacity:${dayKey(asOf)}`));
  const cpu = r1(38 + rng() * 42);
  const memory = r1(44 + rng() * 38);
  const storage = r1(52 + rng() * 30);

  return {
    cpu_current_pct: cpu,
    cpu_forecast_7d_pct: r1(clamp(cpu + rng() * 8, 0, 95)),
    memory_current_pct: memory,
    memory_forecast_7d_pct: r1(clamp(memory + rng() * 6, 0, 95)),
    storage_current_pct: storage,
    storage_forecast_7d_pct: r1(clamp(storage + rng() * 12, 0, 95)),
    db_connections_pct: r1(35 + rng() * 40),
    db_iops_pct: r1(28 + rng() * 45),
    queue_backlog: Math.floor(rng() * 450),
    network_bandwidth_pct: r1(22 + rng() * 38),
    scale_out_recommended: cpu > 72 || memory > 78,
    capacity_headroom_days: Math.floor(clamp(90 - (cpu + memory) / 2, 10, 90)),
    pod_count: Math.floor(18 + rng() * 14),
    pod_capacity: 48,
    hourly_trend: Array.from({ length: 12 }, (_, i) => {
      const r = mulberry32(fnv1a(`${tenant}:cap-trend:${i}:${dayKey(asOf)}`));
      const h = (asOf.getHours() - 11 + i + 24) % 24;
      return {
        hour: `${String(h).padStart(2, '0')}:00`,
        cpu: r1(30 + r() * 50),
        memory: r1(38 + r() * 40),
        requests: Math.floor(600 + r() * 1400),
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — Security Operations View
// ─────────────────────────────────────────────────────────────────────────────

export interface SecurityOpsView {
  failed_logins_24h: number;
  suspicious_activities_24h: number;
  privilege_changes_24h: number;
  security_incidents_active: number;
  mfa_compliance_pct: number;
  privileged_sessions_active: number;
  vulnerability_critical: number;
  vulnerability_high: number;
  patch_compliance_pct: number;
  security_score: number;
  recent_events: Array<{ event: string; severity: string; time: string; actor: string }>;
}

export function buildSecurityOpsView(tenant: string, asOf: Date): SecurityOpsView {
  const rng = mulberry32(fnv1a(`${tenant}:sec-ops:${dayKey(asOf)}`));
  const secEvents = [
    { event: 'Admin login from new IP — 2FA verified', severity: 'info' },
    { event: 'Service account password rotated', severity: 'info' },
    { event: 'Failed login attempt — brute force blocked', severity: 'warning' },
    { event: 'Privilege escalation request — CRO approved', severity: 'warning' },
    { event: 'API key revoked — dormant > 90 days', severity: 'info' },
  ];

  return {
    failed_logins_24h: Math.floor(rng() * 28),
    suspicious_activities_24h: Math.floor(rng() * 6),
    privilege_changes_24h: Math.floor(1 + rng() * 8),
    security_incidents_active: Math.floor(rng() * 3),
    mfa_compliance_pct: r2(96 + rng() * 3.8),
    privileged_sessions_active: Math.floor(2 + rng() * 8),
    vulnerability_critical: Math.floor(rng() * 2),
    vulnerability_high: Math.floor(rng() * 5),
    patch_compliance_pct: r2(92 + rng() * 7.8),
    security_score: Math.floor(78 + rng() * 18),
    recent_events: secEvents.map(e => ({
      ...e,
      time: tsAgo(asOf, Math.floor(rng() * 7200000)),
      actor: pick(['admin@bank.com', 'svc-ci@bank.com', 'cro@bank.com', 'devops@bank.com'], rng),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 10 — Business Continuity Center
// ─────────────────────────────────────────────────────────────────────────────

export interface BusinessContinuityStatus {
  backup_status: 'current' | 'stale' | 'failed';
  last_backup_at: string;
  backup_success_rate_pct: number;
  recovery_readiness: 'ready' | 'partial' | 'not_ready';
  dr_readiness: 'ready' | 'partial' | 'not_ready';
  rto_target_min: number;
  rto_tested_min: number;
  rpo_target_min: number;
  rpo_tested_min: number;
  last_dr_drill: string;
  next_dr_drill: string;
  failover_tested: boolean;
  recovery_tier: Array<{ service: ServiceName; rto_min: number; rpo_min: number; status: 'ready' | 'partial' | 'untested' }>;
}

export function buildBusinessContinuity(tenant: string, asOf: Date): BusinessContinuityStatus {
  const rng = mulberry32(fnv1a(`${tenant}:bcp:${dayKey(asOf)}`));
  const rtoTested = Math.floor(12 + rng() * 28);
  return {
    backup_status: rng() > 0.05 ? 'current' : 'stale',
    last_backup_at: tsAgo(asOf, Math.floor(2 + rng() * 4) * 3600000),
    backup_success_rate_pct: r2(98 + rng() * 1.9),
    recovery_readiness: 'ready',
    dr_readiness: rng() > 0.2 ? 'ready' : 'partial',
    rto_target_min: 15,
    rto_tested_min: rtoTested,
    rpo_target_min: 5,
    rpo_tested_min: Math.floor(3 + rng() * 4),
    last_dr_drill: addDays(asOf, -Math.floor(15 + rng() * 75)),
    next_dr_drill: addDays(asOf, Math.floor(15 + rng() * 75)),
    failover_tested: rng() > 0.15,
    recovery_tier: SERVICE_NAMES.slice(0, 6).map(svc => ({
      service: svc,
      rto_min: Math.floor(5 + rng() * 25),
      rpo_min: Math.floor(1 + rng() * 8),
      status: pick(['ready', 'ready', 'ready', 'partial', 'untested'] as const, rng),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 11 — Observability Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export interface ObservabilitySnapshot {
  logs_per_min: number;
  error_logs_per_min: number;
  traces_per_min: number;
  active_alerts: number;
  alert_noise_ratio: number;
  service_dependencies: Array<{ from: ServiceName; to: string; latency_ms: number; status: 'ok' | 'slow' | 'down' }>;
  top_error_sources: Array<{ service: ServiceName; error_count: number; top_error: string }>;
  metric_anomalies_24h: number;
}

const DEPENDENCIES = [
  { from: 'Alert Engine' as ServiceName, to: 'PostgreSQL', latency_ms: 8 },
  { from: 'AI Engine' as ServiceName, to: 'Feature Store', latency_ms: 42 },
  { from: 'Rules Engine' as ServiceName, to: 'Kafka', latency_ms: 12 },
  { from: 'Compliance Engine' as ServiceName, to: 'PostgreSQL', latency_ms: 9 },
  { from: 'BFF Gateway' as ServiceName, to: 'Alert Engine', latency_ms: 35 },
  { from: 'Event Streaming Engine' as ServiceName, to: 'Kafka', latency_ms: 6 },
];

const TOP_ERRORS = [
  'Connection timeout — PostgreSQL pool exhaustion',
  'Schema validation error — unknown field in payload',
  'Downstream service unavailable — retry exhausted',
  'Memory pressure — GC pause exceeding threshold',
];

export function buildObservabilitySnapshot(tenant: string, asOf: Date): ObservabilitySnapshot {
  const rng = mulberry32(fnv1a(`${tenant}:observability:${dayKey(asOf)}`));
  return {
    logs_per_min: Math.floor(2800 + rng() * 2200),
    error_logs_per_min: Math.floor(8 + rng() * 32),
    traces_per_min: Math.floor(380 + rng() * 420),
    active_alerts: Math.floor(rng() * 12),
    alert_noise_ratio: r2(0.08 + rng() * 0.12),
    service_dependencies: DEPENDENCIES.map(dep => ({
      ...dep,
      latency_ms: Math.floor(dep.latency_ms * (0.8 + rng() * 0.5)),
      status: rng() > 0.1 ? 'ok' : rng() > 0.5 ? 'slow' : 'down',
    })),
    top_error_sources: SERVICE_NAMES.slice(0, 4).map(svc => ({
      service: svc,
      error_count: Math.floor(rng() * 45),
      top_error: pick(TOP_ERRORS, rng),
    })),
    metric_anomalies_24h: Math.floor(rng() * 8),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 12 — Executive Operations Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutiveOpsDashboard {
  platform_availability_pct: number;
  sla_compliance_pct: number;
  incident_trend: Array<{ day: string; p1: number; p2: number; p3: number }>;
  operational_risk_score: number;
  service_maturity_score: number;
  cost_optimization_opportunity_cr: number;
  mttr_trend_min: number[];
  release_success_rate_pct: number;
  executive_narrative: string;
}

export function buildExecutiveOpsDashboard(tenant: string, asOf: Date): ExecutiveOpsDashboard {
  const rng = mulberry32(fnv1a(`${tenant}:exec-ops:${dayKey(asOf)}`));
  return {
    platform_availability_pct: r2(99.2 + rng() * 0.78),
    sla_compliance_pct: r2(97.5 + rng() * 2.4),
    incident_trend: Array.from({ length: 7 }, (_, i) => {
      const r = mulberry32(fnv1a(`${tenant}:inc-trend:${i}:${dayKey(asOf)}`));
      const d = new Date(asOf.getTime() - (6 - i) * 86400000);
      return { day: d.toLocaleDateString('en-IN', { weekday: 'short' }), p1: Math.floor(r() * 2), p2: Math.floor(r() * 3), p3: Math.floor(1 + r() * 5) };
    }),
    operational_risk_score: Math.floor(22 + rng() * 28),
    service_maturity_score: Math.floor(72 + rng() * 22),
    cost_optimization_opportunity_cr: r2(8.5 + rng() * 14.5),
    mttr_trend_min: Array.from({ length: 5 }, () => Math.floor(15 + rng() * 45)),
    release_success_rate_pct: r2(92 + rng() * 7.8),
    executive_narrative: `Platform operating at ${r2(99.2 + rng() * 0.78)}% availability this week. MTTR improved to ${Math.floor(15 + rng() * 28)} minutes (target: 30 min). Two P3 incidents resolved without SLA breach. Release cadence healthy — ${Math.floor(4 + rng() * 6)} deployments across production with ${r2(92 + rng() * 7.8)}% success rate. Security posture strong — no critical vulnerabilities outstanding. Capacity headroom adequate; no scaling action required for 30+ days.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 13 — AI Operations Insights
// ─────────────────────────────────────────────────────────────────────────────

export interface AiOpsInsight {
  insight_id: string;
  type: AiInsightType;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  affected_service: ServiceName;
  confidence_score: number;
  recommendation: string;
  predicted_impact: string;
  detected_at: string;
}

const AI_OPS_TEMPLATES = [
  { type: 'failure_prediction' as AiInsightType, sev: 'warning' as const,  title: 'AI Engine Memory Exhaustion in ~18 Hours',          desc: 'Memory usage trending at +2.4%/hour. At current rate, OOM-kill threshold reached in 18 hours.', rec: 'Restart AI Engine with increased heap allocation (8GB → 12GB) during next maintenance window.' },
  { type: 'capacity_forecast' as AiInsightType,  sev: 'info' as const,    title: 'Event Streaming capacity saturation in 22 days',     desc: 'Kafka topic partition count will reach 95% utilisation on current trajectory.', rec: 'Pre-scale Event Streaming Engine. Add 8 partitions to risk.alerts and ai.decisions topics.' },
  { type: 'incident_hotspot' as AiInsightType,   sev: 'warning' as const, title: 'Compliance Engine — recurring 03:00 UTC failures',    desc: '4 of 7 incidents in past 30 days originated at 03:00–03:30 UTC — batch job conflict pattern.', rec: 'Stagger RBI reporting batch job 60 minutes. Investigate connection pool contention during batch window.' },
  { type: 'release_risk' as AiInsightType,       sev: 'warning' as const, title: 'High-risk deployment window detected',               desc: 'Rules Engine v8.3.0 scheduled during peak load Friday 14:00–15:00 IST. Historical failure rate 38% at this window.', rec: 'Shift deployment to Saturday 02:00–04:00 IST. Activate war room protocol.' },
  { type: 'recommendation' as AiInsightType,     sev: 'info' as const,    title: 'Database connection pool right-sizing opportunity',   desc: 'Compliance Engine using avg 12 of 100 connections. Pool is over-provisioned by 7×.', rec: 'Reduce max_connections to 20. Free 80 connections for other services. Estimated saving: 4GB RAM.' },
  { type: 'failure_prediction' as AiInsightType, sev: 'info' as const,    title: 'SSL certificate expiry in 14 days — BFF Gateway',    desc: 'Auto-renewal job for BFF Gateway TLS cert failed on last 2 attempts. Manual intervention needed.', rec: 'Trigger manual certificate renewal now. Verify ACME challenge propagation to load balancer.' },
];

export function buildAiOpsInsights(tenant: string, asOf: Date): AiOpsInsight[] {
  const rng = mulberry32(fnv1a(`${tenant}:ai-ops-insights:${dayKey(asOf)}`));
  return AI_OPS_TEMPLATES.map((tpl, i) => ({
    insight_id: `AIOPS-${String(i + 1).padStart(3, '0')}`,
    type: tpl.type,
    severity: tpl.sev,
    title: tpl.title,
    description: tpl.desc,
    affected_service: pick(SERVICE_NAMES, rng),
    confidence_score: r2(0.74 + rng() * 0.24),
    recommendation: tpl.rec,
    predicted_impact: pick(['Revenue risk: ₹2–8 Cr if not addressed', 'SLA breach probability 72% in next 24h', 'No immediate revenue impact — preventive action', 'Capacity risk — operational impact in 3 weeks'], rng),
    detected_at: tsAgo(asOf, Math.floor(rng() * 14400000)),
  }));
}
