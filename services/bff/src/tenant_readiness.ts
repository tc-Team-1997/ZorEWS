// services/bff/src/tenant_readiness.ts
//
// T6 M2.1 — Tenant readiness check.
//
// Module 2 (Multi-Tenancy & API Gateway) had T4.24 surface — tenant
// CRUD, header gating, OAuth client-credentials. M2.1 lands the
// onboarding-readiness query: given a tenant id, run a fixed set of
// structural checks across modules and return a report the SPA renders
// as "this tenant is ready to demo / has warnings / is blocked".
//
// Checks pull from already-shipped engines:
//   - tenantLookup       → tenant exists, has channels declared
//   - configStore        → key BIL operational defaults overridable
//   - alertRoutingEngine → all 4 class rules valid
//   - auditTrailStore    → at least 1 event in the last 7d (signs of life)
//
// Pure function (no I/O): callers pass the engines in, the function
// runs the checks synchronously. This keeps the readiness surface
// deterministic + free of network probes.

import type { ConfigStore } from './admin_config';
import type { AlertRoutingEngine } from './alert_routing';
import type { AuditTrailStore } from './audit_trail';
import { DEFAULTS as CONFIG_DEFAULTS } from './admin_config';

// ─── Public types ──────────────────────────────────────────────────────

export type CheckCategory = 'tenant' | 'config' | 'alerts' | 'audit' | 'security';
export type CheckSeverity = 'blocking' | 'warning' | 'info';
export type OverallStatus = 'ready' | 'warnings' | 'blocked';

export interface ReadinessCheck {
  id: string;
  name: string;
  category: CheckCategory;
  severity: CheckSeverity;
  passing: boolean;
  message: string;
}

export interface ReadinessReport {
  tenant_id: string;
  generated_at: string;
  overall_status: OverallStatus;
  summary: {
    total: number;
    passing: number;
    warnings: number;
    blocking: number;
  };
  checks: ReadinessCheck[];
}

/** Minimal subset of the TenantLookup the readiness checker uses —
 *  the production interface is broader, but keeping our type narrow
 *  here makes the unit tests easy to wire. */
export interface ReadinessTenantLookup {
  /** Returns null when the tenant doesn't exist. Returns the tenant
   *  record otherwise — only the fields we actually inspect. */
  get(tenant_id: string): Promise<ReadinessTenantRecord | null>;
}

export interface ReadinessTenantRecord {
  tenant_id: string;
  name: string;
  /** Channels the tenant is allowed to call (e.g. ['API', 'WEB']). */
  channels: string[];
  active: boolean;
  vertical?: 'banking' | 'insurance';
}

export interface ReadinessDeps {
  tenantLookup: ReadinessTenantLookup;
  configStore: ConfigStore;
  alertRoutingEngine: AlertRoutingEngine;
  auditTrailStore: AuditTrailStore;
  now: () => Date;
}

// ─── Check implementations ─────────────────────────────────────────────

/** Required-key set the readiness check verifies the schema still
 *  declares. Mismatches indicate platform-vs-deploy drift. */
const REQUIRED_CONFIG_KEYS = [
  'alerts.red_sla_hours',
  'alerts.orange_sla_hours',
  'alerts.yellow_sla_hours',
  'notifications.email.enabled',
  'notifications.email.from_address',
  'scoring.default_thresholds.low_max',
  'scoring.default_thresholds.medium_max',
];

/** Aggregate the per-check pass/fail into an OverallStatus. */
export function computeOverallStatus(checks: ReadinessCheck[]): OverallStatus {
  let blocking = 0;
  let warning = 0;
  for (const c of checks) {
    if (c.passing) continue;
    if (c.severity === 'blocking') blocking++;
    else if (c.severity === 'warning') warning++;
  }
  if (blocking > 0) return 'blocked';
  if (warning > 0) return 'warnings';
  return 'ready';
}

export function summariseChecks(checks: ReadinessCheck[]): ReadinessReport['summary'] {
  let passing = 0;
  let warnings = 0;
  let blocking = 0;
  for (const c of checks) {
    if (c.passing) passing++;
    else if (c.severity === 'blocking') blocking++;
    else if (c.severity === 'warning') warnings++;
  }
  return { total: checks.length, passing, warnings, blocking };
}

// ─── Main entry ────────────────────────────────────────────────────────

export async function runReadinessChecks(
  tenant_id: string,
  deps: ReadinessDeps,
): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];

  // ── Tenant exists ──
  const tenant = await deps.tenantLookup.get(tenant_id);
  checks.push({
    id: 'tenant_exists',
    name: 'Tenant record exists',
    category: 'tenant',
    severity: 'blocking',
    passing: tenant !== null,
    message:
      tenant === null
        ? `Tenant '${tenant_id}' is not registered in the platform`
        : 'Tenant record found',
  });

  // If the tenant doesn't exist, skip all subsequent checks — they're
  // meaningless. Return early with the single failing check.
  if (!tenant) {
    return {
      tenant_id,
      generated_at: deps.now().toISOString(),
      overall_status: computeOverallStatus(checks),
      summary: summariseChecks(checks),
      checks,
    };
  }

  // ── Tenant active ──
  checks.push({
    id: 'tenant_active',
    name: 'Tenant marked active',
    category: 'tenant',
    severity: 'blocking',
    passing: tenant.active === true,
    message: tenant.active ? 'Tenant is active' : 'Tenant is inactive — flip active=true to enable',
  });

  // ── Channels configured ──
  const hasChannels = Array.isArray(tenant.channels) && tenant.channels.length > 0;
  checks.push({
    id: 'channels_configured',
    name: 'At least one ingress channel declared',
    category: 'tenant',
    severity: 'blocking',
    passing: hasChannels,
    message: hasChannels
      ? `Channels declared: ${tenant.channels.join(', ')}`
      : 'No channels declared — add at least one of API/WEB/MOBILE',
  });

  // ── Vertical assigned ──
  const hasVertical = tenant.vertical === 'banking' || tenant.vertical === 'insurance';
  checks.push({
    id: 'vertical_assigned',
    name: 'Vertical assigned (banking | insurance)',
    category: 'tenant',
    severity: 'warning',
    passing: hasVertical,
    message: hasVertical
      ? `Vertical: ${tenant.vertical}`
      : 'Vertical not set — defaults to banking but should be explicit for BIL',
  });

  // ── Config schema completeness ──
  const declaredKeys = new Set(CONFIG_DEFAULTS.map((d) => d.key));
  const missingRequired = REQUIRED_CONFIG_KEYS.filter((k) => !declaredKeys.has(k));
  checks.push({
    id: 'config_schema_complete',
    name: 'Config schema declares all required keys',
    category: 'config',
    severity: 'blocking',
    passing: missingRequired.length === 0,
    message:
      missingRequired.length === 0
        ? `All ${REQUIRED_CONFIG_KEYS.length} required keys present in schema`
        : `Missing schema keys: ${missingRequired.join(', ')}`,
  });

  // ── Email channel enabled (warning) ──
  const emailEnabled = deps.configStore.get(tenant_id, 'notifications.email.enabled');
  checks.push({
    id: 'email_channel_enabled',
    name: 'Email notification channel enabled',
    category: 'config',
    severity: 'warning',
    passing: emailEnabled?.value === true,
    message:
      emailEnabled?.value === true
        ? 'Email channel enabled'
        : 'Email channel disabled — escalations will not deliver via email',
  });

  // ── Email from-address looks valid (sanity) ──
  const fromAddr = deps.configStore.get(tenant_id, 'notifications.email.from_address');
  const fromAddrValid =
    typeof fromAddr?.value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddr.value);
  checks.push({
    id: 'email_from_address_valid',
    name: 'Email from-address is well-formed',
    category: 'config',
    severity: 'warning',
    passing: fromAddrValid,
    message: fromAddrValid
      ? `From: ${fromAddr!.value}`
      : `notifications.email.from_address is missing or malformed (got '${fromAddr?.value}')`,
  });

  // ── Alert routing rules valid for all 4 classes ──
  // listRules implicitly checks that overrides + defaults round-trip;
  // if any class has no rule the listRules result would be < 4.
  const rules = deps.alertRoutingEngine.listRules(tenant_id);
  const expectedClasses = ['red', 'orange', 'yellow', 'green'] as const;
  const actualClasses = new Set<string>(rules.map((r) => r.class));
  const missingClasses = expectedClasses.filter((c) => !actualClasses.has(c));
  checks.push({
    id: 'alert_routing_complete',
    name: 'Alert routing rules cover all 4 BIL classes',
    category: 'alerts',
    severity: 'blocking',
    passing: missingClasses.length === 0,
    message:
      missingClasses.length === 0
        ? 'All 4 classes (red/orange/yellow/green) have routing rules'
        : `Missing routing rules: ${missingClasses.join(', ')}`,
  });

  // ── At least one alert routing rule has a primary assignee != 'none'
  // (i.e. the platform isn't entirely monitor-only) ──
  const hasActiveRule = rules.some((r) => !r.monitor_only && r.primary_assignee !== 'none');
  checks.push({
    id: 'has_active_routing',
    name: 'At least one routing rule has an owner',
    category: 'alerts',
    severity: 'blocking',
    passing: hasActiveRule,
    message: hasActiveRule
      ? 'Active routing path present'
      : 'All routing rules are monitor_only — alerts will never reach a human',
  });

  // ── Audit trail signs-of-life: at least 1 event in last 7 days ──
  const auditSummary = deps.auditTrailStore.summarise(tenant_id, 7, deps.now());
  checks.push({
    id: 'audit_trail_active',
    name: 'Audit trail recorded events in last 7 days',
    category: 'audit',
    severity: 'info',
    passing: auditSummary.total > 0,
    message:
      auditSummary.total > 0
        ? `${auditSummary.total} audit events in trailing 7 days`
        : 'No audit events in last 7 days — this is normal pre-launch but should pick up post-go-live',
  });

  return {
    tenant_id,
    generated_at: deps.now().toISOString(),
    overall_status: computeOverallStatus(checks),
    summary: summariseChecks(checks),
    checks,
  };
}
