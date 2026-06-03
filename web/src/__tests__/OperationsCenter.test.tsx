/**
 * Production Operations Center — Phase 23 engine tests.
 *
 * 102 tests covering all 15 groups:
 * RBAC, enums, health KPIs, service registry, API ops, incidents,
 * change requests, releases, environments, capacity, security ops,
 * business continuity, observability, executive dashboard, AI insights.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPlatformHealthKpis,
  buildServiceRegistry,
  buildApiOperations,
  buildIncidents,
  buildChangeRequests,
  buildReleases,
  buildEnvironments,
  buildCapacityMetrics,
  buildSecurityOpsView,
  buildBusinessContinuity,
  buildObservabilitySnapshot,
  buildExecutiveOpsDashboard,
  buildAiOpsInsights,
  canAccessOperationsCenter,
  SERVICE_NAMES,
  SERVICE_STATUSES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  CHANGE_STATES,
  ENVIRONMENTS,
  HEALTH_COLORS,
  AI_INSIGHT_TYPES,
} from '@/modules/operationsCenter/operationsCenterEngine';

const TENANT = 'BANK_DEMO';
const AS_OF = new Date('2026-06-01T12:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1 — canAccessOperationsCenter (5 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('canAccessOperationsCenter', () => {
  it('undefined roles → false', () => {
    expect(canAccessOperationsCenter(undefined)).toBe(false);
  });

  it('empty array → false', () => {
    expect(canAccessOperationsCenter([])).toBe(false);
  });

  it('admin → true', () => {
    expect(canAccessOperationsCenter(['admin'])).toBe(true);
  });

  it('cro → true', () => {
    expect(canAccessOperationsCenter(['cro'])).toBe(true);
  });

  it('operations_manager → true', () => {
    expect(canAccessOperationsCenter(['operations_manager'])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2 — Enum constants (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Enum constants', () => {
  it('SERVICE_NAMES has 12 values', () => {
    expect(SERVICE_NAMES.length).toBe(12);
  });

  it('SERVICE_STATUSES has 5 values', () => {
    expect(SERVICE_STATUSES.length).toBe(5);
  });

  it('INCIDENT_SEVERITIES has 4 values: P1,P2,P3,P4', () => {
    expect([...INCIDENT_SEVERITIES]).toEqual(['P1', 'P2', 'P3', 'P4']);
  });

  it('INCIDENT_STATES has 6 values', () => {
    expect(INCIDENT_STATES.length).toBe(6);
  });

  it('ENVIRONMENTS has 5 values', () => {
    expect(ENVIRONMENTS.length).toBe(5);
  });

  it('HEALTH_COLORS has 3 values: green, amber, red', () => {
    expect([...HEALTH_COLORS]).toEqual(['green', 'amber', 'red']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3 — buildPlatformHealthKpis (10 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPlatformHealthKpis', () => {
  const kpis = () => buildPlatformHealthKpis(TENANT, AS_OF);

  it('overall_health is within HEALTH_COLORS', () => {
    expect(([...HEALTH_COLORS] as string[]).includes(kpis().overall_health)).toBe(true);
  });

  it('health_score is between 0 and 100', () => {
    const { health_score } = kpis();
    expect(health_score).toBeGreaterThanOrEqual(0);
    expect(health_score).toBeLessThanOrEqual(100);
  });

  it('availability_pct is between 99 and 100', () => {
    const { availability_pct } = kpis();
    expect(availability_pct).toBeGreaterThanOrEqual(99);
    expect(availability_pct).toBeLessThanOrEqual(100);
  });

  it('active + failed + degraded services <= total_services', () => {
    const { active_services, failed_services, degraded_services, total_services } = kpis();
    expect(active_services + failed_services + degraded_services).toBeLessThanOrEqual(total_services);
  });

  it('critical_alerts >= 0', () => {
    expect(kpis().critical_alerts).toBeGreaterThanOrEqual(0);
  });

  it('active_incidents >= 0', () => {
    expect(kpis().active_incidents).toBeGreaterThanOrEqual(0);
  });

  it('system_load_pct is between 0 and 100', () => {
    const { system_load_pct } = kpis();
    expect(system_load_pct).toBeGreaterThanOrEqual(0);
    expect(system_load_pct).toBeLessThanOrEqual(100);
  });

  it('capacity_utilization_pct is between 0 and 100', () => {
    const { capacity_utilization_pct } = kpis();
    expect(capacity_utilization_pct).toBeGreaterThanOrEqual(0);
    expect(capacity_utilization_pct).toBeLessThanOrEqual(100);
  });

  it('result is deterministic for same tenant+date', () => {
    const a = buildPlatformHealthKpis(TENANT, AS_OF);
    const b = buildPlatformHealthKpis(TENANT, AS_OF);
    expect(a).toEqual(b);
  });

  it('green overall_health implies health_score >= 90', () => {
    const { overall_health, health_score } = kpis();
    if (overall_health === 'green') {
      expect(health_score).toBeGreaterThanOrEqual(90);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4 — buildServiceRegistry (10 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildServiceRegistry', () => {
  const registry = () => buildServiceRegistry(TENANT, AS_OF);

  it('returns exactly 12 services', () => {
    expect(registry().length).toBe(SERVICE_NAMES.length);
  });

  it('every service has service_id, name, version, owner, status', () => {
    for (const svc of registry()) {
      expect(svc.service_id).toBeTruthy();
      expect(svc.name).toBeTruthy();
      expect(svc.version).toBeTruthy();
      expect(svc.owner).toBeTruthy();
      expect(svc.status).toBeTruthy();
    }
  });

  it('every service status is within SERVICE_STATUSES', () => {
    const valid = new Set([...SERVICE_STATUSES]);
    for (const svc of registry()) {
      expect(valid.has(svc.status)).toBe(true);
    }
  });

  it('uptime_pct is between 0 and 100 for every service', () => {
    for (const svc of registry()) {
      expect(svc.uptime_pct).toBeGreaterThanOrEqual(0);
      expect(svc.uptime_pct).toBeLessThanOrEqual(100);
    }
  });

  it('avg_response_ms > 0 for every service', () => {
    for (const svc of registry()) {
      expect(svc.avg_response_ms).toBeGreaterThan(0);
    }
  });

  it('instances >= 1 for every service', () => {
    for (const svc of registry()) {
      expect(svc.instances).toBeGreaterThanOrEqual(1);
    }
  });

  it('cpu_pct is between 0 and 100', () => {
    for (const svc of registry()) {
      expect(svc.cpu_pct).toBeGreaterThanOrEqual(0);
      expect(svc.cpu_pct).toBeLessThanOrEqual(100);
    }
  });

  it('memory_pct is between 0 and 100', () => {
    for (const svc of registry()) {
      expect(svc.memory_pct).toBeGreaterThanOrEqual(0);
      expect(svc.memory_pct).toBeLessThanOrEqual(100);
    }
  });

  it('result is deterministic for same tenant+date', () => {
    expect(registry()).toEqual(buildServiceRegistry(TENANT, AS_OF));
  });

  it('port > 0 for every service', () => {
    for (const svc of registry()) {
      expect(svc.port).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5 — buildApiOperations (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildApiOperations', () => {
  const apis = () => buildApiOperations(TENANT, AS_OF);

  it('returns exactly 10 API operations', () => {
    expect(apis().length).toBe(10);
  });

  it('every API has api_id, name, availability_pct, avg_latency_ms', () => {
    for (const api of apis()) {
      expect(api.api_id).toBeTruthy();
      expect(api.name).toBeTruthy();
      expect(typeof api.availability_pct).toBe('number');
      expect(typeof api.avg_latency_ms).toBe('number');
    }
  });

  it('availability_pct is between 0 and 100', () => {
    for (const api of apis()) {
      expect(api.availability_pct).toBeGreaterThanOrEqual(0);
      expect(api.availability_pct).toBeLessThanOrEqual(100);
    }
  });

  it('avg_latency_ms > 0 for every API', () => {
    for (const api of apis()) {
      expect(api.avg_latency_ms).toBeGreaterThan(0);
    }
  });

  it('p95_latency_ms > avg_latency_ms for every API', () => {
    for (const api of apis()) {
      expect(api.p95_latency_ms).toBeGreaterThan(api.avg_latency_ms);
    }
  });

  it('sla_met is a boolean for every API', () => {
    for (const api of apis()) {
      expect(typeof api.sla_met).toBe('boolean');
    }
  });

  it('healthy APIs have availability_pct >= 99.5', () => {
    for (const api of apis()) {
      if (api.status === 'healthy') {
        expect(api.availability_pct).toBeGreaterThanOrEqual(99.5);
      }
    }
  });

  it('requests_per_min > 0 for every API', () => {
    for (const api of apis()) {
      expect(api.requests_per_min).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6 — buildIncidents (10 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildIncidents', () => {
  const incidents = () => buildIncidents(TENANT, AS_OF);

  it('returns exactly 8 incidents', () => {
    expect(incidents().length).toBe(8);
  });

  it('every incident has incident_id, severity, state', () => {
    for (const inc of incidents()) {
      expect(inc.incident_id).toBeTruthy();
      expect(inc.severity).toBeTruthy();
      expect(inc.state).toBeTruthy();
    }
  });

  it('every severity is within INCIDENT_SEVERITIES', () => {
    const valid = new Set([...INCIDENT_SEVERITIES]);
    for (const inc of incidents()) {
      expect(valid.has(inc.severity)).toBe(true);
    }
  });

  it('every state is within INCIDENT_STATES', () => {
    const valid = new Set([...INCIDENT_STATES]);
    for (const inc of incidents()) {
      expect(valid.has(inc.state)).toBe(true);
    }
  });

  it('resolved incidents have resolved_at non-null', () => {
    for (const inc of incidents()) {
      if (inc.state === 'resolved' || inc.state === 'closed') {
        expect(inc.resolved_at).not.toBeNull();
      }
    }
  });

  it('open and investigating incidents have resolved_at null', () => {
    for (const inc of incidents()) {
      if (inc.state === 'open' || inc.state === 'investigating') {
        expect(inc.resolved_at).toBeNull();
      }
    }
  });

  it('P1 incidents with state=investigating have war_room_active=true', () => {
    for (const inc of incidents()) {
      if (inc.severity === 'P1' && inc.state === 'investigating') {
        expect(inc.war_room_active).toBe(true);
      }
    }
  });

  it('postmortem_due is non-null for resolved/closed incidents', () => {
    for (const inc of incidents()) {
      if (inc.state === 'resolved' || inc.state === 'closed') {
        expect(inc.postmortem_due).not.toBeNull();
      }
    }
  });

  it('resolution_time_min >= 0 for resolved incidents', () => {
    for (const inc of incidents()) {
      if (inc.resolution_time_min !== null) {
        expect(inc.resolution_time_min).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('result is deterministic for same tenant+date', () => {
    expect(incidents()).toEqual(buildIncidents(TENANT, AS_OF));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 7 — buildChangeRequests (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildChangeRequests', () => {
  const changes = () => buildChangeRequests(TENANT, AS_OF);

  it('returns exactly 8 change requests', () => {
    expect(changes().length).toBe(8);
  });

  it('every CR has cr_id, state, change_type', () => {
    for (const cr of changes()) {
      expect(cr.cr_id).toBeTruthy();
      expect(cr.state).toBeTruthy();
      expect(cr.change_type).toBeTruthy();
    }
  });

  it('every state is within CHANGE_STATES', () => {
    const valid = new Set([...CHANGE_STATES]);
    for (const cr of changes()) {
      expect(valid.has(cr.state)).toBe(true);
    }
  });

  it('change_type is standard, emergency or normal', () => {
    const valid = new Set(['standard', 'emergency', 'normal']);
    for (const cr of changes()) {
      expect(valid.has(cr.change_type)).toBe(true);
    }
  });

  it('risk_level is low, medium, or high', () => {
    const valid = new Set(['low', 'medium', 'high']);
    for (const cr of changes()) {
      expect(valid.has(cr.risk_level)).toBe(true);
    }
  });

  it('has_rollback is always true', () => {
    for (const cr of changes()) {
      expect(cr.has_rollback).toBe(true);
    }
  });

  it('estimated_downtime_min >= 0', () => {
    for (const cr of changes()) {
      expect(cr.estimated_downtime_min).toBeGreaterThanOrEqual(0);
    }
  });

  it('approved and implemented CRs have a non-null approver', () => {
    for (const cr of changes()) {
      if (cr.state === 'approved' || cr.state === 'implemented') {
        expect(cr.approver).not.toBeNull();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 8 — buildReleases (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildReleases', () => {
  const releases = () => buildReleases(TENANT, AS_OF);

  it('returns exactly 10 releases', () => {
    expect(releases().length).toBe(10);
  });

  it('every release has release_id, version, service, success', () => {
    for (const rel of releases()) {
      expect(rel.release_id).toBeTruthy();
      expect(rel.version).toBeTruthy();
      expect(rel.service).toBeTruthy();
      expect(typeof rel.success).toBe('boolean');
    }
  });

  it('success is a boolean', () => {
    for (const rel of releases()) {
      expect(typeof rel.success).toBe('boolean');
    }
  });

  it('rollback_triggered implies success is false (a rollback means it failed)', () => {
    for (const rel of releases()) {
      if (rel.rollback_triggered) {
        expect(rel.success).toBe(false);
      }
    }
  });

  it('deployment_time_min > 0', () => {
    for (const rel of releases()) {
      expect(rel.deployment_time_min).toBeGreaterThan(0);
    }
  });

  it('features_count >= 0', () => {
    for (const rel of releases()) {
      expect(rel.features_count).toBeGreaterThanOrEqual(0);
    }
  });

  it('bug_fixes_count >= 0', () => {
    for (const rel of releases()) {
      expect(rel.bug_fixes_count).toBeGreaterThanOrEqual(0);
    }
  });

  it('result is deterministic for same tenant+date', () => {
    expect(releases()).toEqual(buildReleases(TENANT, AS_OF));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 9 — buildEnvironments (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildEnvironments', () => {
  const envs = () => buildEnvironments(TENANT, AS_OF);

  it('returns exactly 5 environments', () => {
    expect(envs().length).toBe(ENVIRONMENTS.length);
  });

  it('every environment has env_id, name, health_score, health_color', () => {
    for (const env of envs()) {
      expect(env.env_id).toBeTruthy();
      expect(env.name).toBeTruthy();
      expect(typeof env.health_score).toBe('number');
      expect(env.health_color).toBeTruthy();
    }
  });

  it('every name is within ENVIRONMENTS', () => {
    const valid = new Set([...ENVIRONMENTS]);
    for (const env of envs()) {
      expect(valid.has(env.name)).toBe(true);
    }
  });

  it('every health_color is within HEALTH_COLORS', () => {
    const valid = new Set([...HEALTH_COLORS]);
    for (const env of envs()) {
      expect(valid.has(env.health_color)).toBe(true);
    }
  });

  it('health_score is between 0 and 100', () => {
    for (const env of envs()) {
      expect(env.health_score).toBeGreaterThanOrEqual(0);
      expect(env.health_score).toBeLessThanOrEqual(100);
    }
  });

  it('uptime_days >= 0 for every environment', () => {
    for (const env of envs()) {
      expect(env.uptime_days).toBeGreaterThanOrEqual(0);
    }
  });

  it('services_healthy <= services_total', () => {
    for (const env of envs()) {
      expect(env.services_healthy).toBeLessThanOrEqual(env.services_total);
    }
  });

  it('production environment has the highest uptime_days', () => {
    const all = envs();
    const prod = all.find(e => e.name === 'production');
    const others = all.filter(e => e.name !== 'production');
    if (prod) {
      for (const other of others) {
        expect(prod.uptime_days).toBeGreaterThanOrEqual(other.uptime_days);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 10 — buildCapacityMetrics (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCapacityMetrics', () => {
  const cap = () => buildCapacityMetrics(TENANT, AS_OF);

  it('cpu_current_pct is between 0 and 100', () => {
    const { cpu_current_pct } = cap();
    expect(cpu_current_pct).toBeGreaterThanOrEqual(0);
    expect(cpu_current_pct).toBeLessThanOrEqual(100);
  });

  it('memory_current_pct is between 0 and 100', () => {
    const { memory_current_pct } = cap();
    expect(memory_current_pct).toBeGreaterThanOrEqual(0);
    expect(memory_current_pct).toBeLessThanOrEqual(100);
  });

  it('storage_current_pct is between 0 and 100', () => {
    const { storage_current_pct } = cap();
    expect(storage_current_pct).toBeGreaterThanOrEqual(0);
    expect(storage_current_pct).toBeLessThanOrEqual(100);
  });

  it('cpu_forecast_7d_pct >= cpu_current_pct (usage generally trends up)', () => {
    const { cpu_current_pct, cpu_forecast_7d_pct } = cap();
    // forecast is always >= current due to clamp(current + positive_delta)
    expect(cpu_forecast_7d_pct).toBeGreaterThanOrEqual(cpu_current_pct);
  });

  it('queue_backlog >= 0', () => {
    expect(cap().queue_backlog).toBeGreaterThanOrEqual(0);
  });

  it('pod_count <= pod_capacity', () => {
    const { pod_count, pod_capacity } = cap();
    expect(pod_count).toBeLessThanOrEqual(pod_capacity);
  });

  it('hourly_trend has exactly 12 entries', () => {
    expect(cap().hourly_trend.length).toBe(12);
  });

  it('scale_out_recommended is a boolean', () => {
    expect(typeof cap().scale_out_recommended).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 11 — buildSecurityOpsView (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSecurityOpsView', () => {
  const sec = () => buildSecurityOpsView(TENANT, AS_OF);

  it('failed_logins_24h >= 0', () => {
    expect(sec().failed_logins_24h).toBeGreaterThanOrEqual(0);
  });

  it('mfa_compliance_pct is between 0 and 100', () => {
    const { mfa_compliance_pct } = sec();
    expect(mfa_compliance_pct).toBeGreaterThanOrEqual(0);
    expect(mfa_compliance_pct).toBeLessThanOrEqual(100);
  });

  it('patch_compliance_pct is between 0 and 100', () => {
    const { patch_compliance_pct } = sec();
    expect(patch_compliance_pct).toBeGreaterThanOrEqual(0);
    expect(patch_compliance_pct).toBeLessThanOrEqual(100);
  });

  it('security_score is between 0 and 100', () => {
    const { security_score } = sec();
    expect(security_score).toBeGreaterThanOrEqual(0);
    expect(security_score).toBeLessThanOrEqual(100);
  });

  it('recent_events has at least 3 entries', () => {
    expect(sec().recent_events.length).toBeGreaterThanOrEqual(3);
  });

  it('vulnerability_critical >= 0', () => {
    expect(sec().vulnerability_critical).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 12 — buildBusinessContinuity (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildBusinessContinuity', () => {
  const bcp = () => buildBusinessContinuity(TENANT, AS_OF);

  it('backup_status is current, stale, or failed', () => {
    const valid = new Set(['current', 'stale', 'failed']);
    expect(valid.has(bcp().backup_status)).toBe(true);
  });

  it('rto_tested_min > 0', () => {
    expect(bcp().rto_tested_min).toBeGreaterThan(0);
  });

  it('rpo_tested_min > 0', () => {
    expect(bcp().rpo_tested_min).toBeGreaterThan(0);
  });

  it('recovery_readiness is ready, partial, or not_ready', () => {
    const valid = new Set(['ready', 'partial', 'not_ready']);
    expect(valid.has(bcp().recovery_readiness)).toBe(true);
  });

  it('recovery_tier has at least 4 entries', () => {
    expect(bcp().recovery_tier.length).toBeGreaterThanOrEqual(4);
  });

  it('failover_tested is a boolean', () => {
    expect(typeof bcp().failover_tested).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 13 — buildObservabilitySnapshot (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildObservabilitySnapshot', () => {
  const obs = () => buildObservabilitySnapshot(TENANT, AS_OF);

  it('logs_per_min > 0', () => {
    expect(obs().logs_per_min).toBeGreaterThan(0);
  });

  it('error_logs_per_min >= 0', () => {
    expect(obs().error_logs_per_min).toBeGreaterThanOrEqual(0);
  });

  it('error_logs_per_min < logs_per_min', () => {
    const { logs_per_min, error_logs_per_min } = obs();
    expect(error_logs_per_min).toBeLessThan(logs_per_min);
  });

  it('traces_per_min > 0', () => {
    expect(obs().traces_per_min).toBeGreaterThan(0);
  });

  it('service_dependencies has at least 4 entries', () => {
    expect(obs().service_dependencies.length).toBeGreaterThanOrEqual(4);
  });

  it('top_error_sources has at least 2 entries', () => {
    expect(obs().top_error_sources.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 14 — buildExecutiveOpsDashboard (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildExecutiveOpsDashboard', () => {
  const exec = () => buildExecutiveOpsDashboard(TENANT, AS_OF);

  it('platform_availability_pct is between 99 and 100', () => {
    const { platform_availability_pct } = exec();
    expect(platform_availability_pct).toBeGreaterThanOrEqual(99);
    expect(platform_availability_pct).toBeLessThanOrEqual(100);
  });

  it('sla_compliance_pct is between 95 and 100', () => {
    const { sla_compliance_pct } = exec();
    expect(sla_compliance_pct).toBeGreaterThanOrEqual(95);
    expect(sla_compliance_pct).toBeLessThanOrEqual(100);
  });

  it('incident_trend has exactly 7 entries', () => {
    expect(exec().incident_trend.length).toBe(7);
  });

  it('operational_risk_score is between 0 and 50', () => {
    const { operational_risk_score } = exec();
    expect(operational_risk_score).toBeGreaterThanOrEqual(0);
    expect(operational_risk_score).toBeLessThanOrEqual(50);
  });

  it('service_maturity_score is between 0 and 100', () => {
    const { service_maturity_score } = exec();
    expect(service_maturity_score).toBeGreaterThanOrEqual(0);
    expect(service_maturity_score).toBeLessThanOrEqual(100);
  });

  it('executive_narrative is a non-empty string', () => {
    const { executive_narrative } = exec();
    expect(typeof executive_narrative).toBe('string');
    expect(executive_narrative.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 15 — buildAiOpsInsights (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildAiOpsInsights', () => {
  const insights = () => buildAiOpsInsights(TENANT, AS_OF);

  it('returns exactly 6 insights', () => {
    expect(insights().length).toBe(6);
  });

  it('every insight has insight_id, type, severity, title', () => {
    for (const ins of insights()) {
      expect(ins.insight_id).toBeTruthy();
      expect(ins.type).toBeTruthy();
      expect(ins.severity).toBeTruthy();
      expect(ins.title).toBeTruthy();
    }
  });

  it('every type is within AI_INSIGHT_TYPES', () => {
    const valid = new Set([...AI_INSIGHT_TYPES]);
    for (const ins of insights()) {
      expect(valid.has(ins.type)).toBe(true);
    }
  });

  it('every severity is critical, warning, or info', () => {
    const valid = new Set(['critical', 'warning', 'info']);
    for (const ins of insights()) {
      expect(valid.has(ins.severity)).toBe(true);
    }
  });

  it('confidence_score is between 0 and 1', () => {
    for (const ins of insights()) {
      expect(ins.confidence_score).toBeGreaterThanOrEqual(0);
      expect(ins.confidence_score).toBeLessThanOrEqual(1);
    }
  });

  it('recommendation is a non-empty string', () => {
    for (const ins of insights()) {
      expect(typeof ins.recommendation).toBe('string');
      expect(ins.recommendation.length).toBeGreaterThan(0);
    }
  });
});
