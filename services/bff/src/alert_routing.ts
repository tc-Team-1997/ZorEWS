// services/bff/src/alert_routing.ts
//
// T6 M8.2 — Alert auto-routing per BIL class.
//
// M8.1 shipped the BIL Red/Orange/Yellow/Green classification (severity
// → bil_class + colour metadata). M8.2 lands the *routing matrix* — the
// rules that turn a class into "who owns this, on which channels do
// we notify them, what's the SLA, when does it escalate".
//
// Sourced from DataNetworks-EWS-Ver1.pdf §11 escalation matrix:
//
//     red    → head_of_risk + supervisor; email + sms;       SLA  4h; escalate 1h
//     orange → supervisor + analyst;       email + in_app;   SLA 24h; escalate 12h
//     yellow → analyst;                    email + in_app;   SLA 72h; escalate 48h
//     green  → none (monitor-only);        in_app;           no SLA;  no escalation
//
// Per-tenant overrides allow BIL ops to tighten the defaults (e.g.
// red SLA → 2h for the BIL deployment). Override storage is in-memory
// per-tenant; production swaps in a PG-backed store.

import {
  classifyAlertSeverity,
  type BilAlertClass,
  type SeverityInput,
} from './bil_alert_classification';

// ─── Public types ──────────────────────────────────────────────────────

export type NotificationChannel = 'email' | 'sms' | 'in_app' | 'push';
export type AssigneeRole = 'head_of_risk' | 'supervisor' | 'analyst' | 'none';

export interface RoutingRule {
  /** Which BIL class this rule applies to. */
  class: BilAlertClass;
  /** Primary owner — who's accountable. */
  primary_assignee: AssigneeRole;
  /** Secondary CC — pulled in alongside the primary. null when none. */
  secondary_assignee: AssigneeRole | null;
  /** Channels to fire notifications on. Order = priority. */
  channels: NotificationChannel[];
  /** SLA hours for first response. null when monitor_only. */
  sla_hours: number | null;
  /** Hours after which the alert auto-escalates if unacknowledged.
   *  Always < sla_hours when set. null when no escalation. */
  escalate_after_hours: number | null;
  /** Whether ops should treat this as monitor-only (green class). */
  monitor_only: boolean;
}

export interface RoutingDecision {
  /** The class the alert was classified into. */
  class: BilAlertClass;
  /** The severity that produced the class. */
  severity_in: string;
  /** The effective rule applied — defaults merged with tenant overrides. */
  rule: RoutingRule;
  /** Whether the rule was overridden by the tenant or the platform default. */
  source: 'platform_default' | 'tenant_override';
}

export class AlertRoutingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AlertRoutingError';
  }
}

// ─── Platform default rules ────────────────────────────────────────────

export const DEFAULT_RULES: Readonly<Record<BilAlertClass, RoutingRule>> = {
  red: {
    class: 'red',
    primary_assignee: 'head_of_risk',
    secondary_assignee: 'supervisor',
    channels: ['email', 'sms'],
    sla_hours: 4,
    escalate_after_hours: 1,
    monitor_only: false,
  },
  orange: {
    class: 'orange',
    primary_assignee: 'supervisor',
    secondary_assignee: 'analyst',
    channels: ['email', 'in_app'],
    sla_hours: 24,
    escalate_after_hours: 12,
    monitor_only: false,
  },
  yellow: {
    class: 'yellow',
    primary_assignee: 'analyst',
    secondary_assignee: null,
    channels: ['email', 'in_app'],
    sla_hours: 72,
    escalate_after_hours: 48,
    monitor_only: false,
  },
  green: {
    class: 'green',
    primary_assignee: 'none',
    secondary_assignee: null,
    channels: ['in_app'],
    sla_hours: null,
    escalate_after_hours: null,
    monitor_only: true,
  },
};

const VALID_CLASSES: BilAlertClass[] = ['red', 'orange', 'yellow', 'green'];
const VALID_CHANNELS: NotificationChannel[] = ['email', 'sms', 'in_app', 'push'];
const VALID_ROLES: AssigneeRole[] = ['head_of_risk', 'supervisor', 'analyst', 'none'];

export function isNotificationChannel(s: unknown): s is NotificationChannel {
  return typeof s === 'string' && VALID_CHANNELS.includes(s as NotificationChannel);
}
export function isAssigneeRole(s: unknown): s is AssigneeRole {
  return typeof s === 'string' && VALID_ROLES.includes(s as AssigneeRole);
}

// ─── Validation ────────────────────────────────────────────────────────

export function validateRule(rule: Partial<RoutingRule>): RoutingRule {
  if (!rule || typeof rule !== 'object') {
    throw new AlertRoutingError('invalid_input', 'rule body required');
  }
  const cls = rule.class;
  if (cls === undefined || !VALID_CLASSES.includes(cls)) {
    throw new AlertRoutingError(
      'invalid_class',
      `class must be one of ${VALID_CLASSES.join(',')}`,
    );
  }
  if (!isAssigneeRole(rule.primary_assignee)) {
    throw new AlertRoutingError('invalid_assignee', `invalid primary_assignee: ${rule.primary_assignee}`);
  }
  if (
    rule.secondary_assignee !== null &&
    rule.secondary_assignee !== undefined &&
    !isAssigneeRole(rule.secondary_assignee)
  ) {
    throw new AlertRoutingError(
      'invalid_assignee',
      `invalid secondary_assignee: ${rule.secondary_assignee}`,
    );
  }
  if (!Array.isArray(rule.channels) || rule.channels.length === 0) {
    throw new AlertRoutingError('invalid_channels', 'channels must be a non-empty array');
  }
  for (const c of rule.channels) {
    if (!isNotificationChannel(c)) {
      throw new AlertRoutingError('invalid_channels', `invalid channel: ${c}`);
    }
  }
  if (rule.sla_hours !== null && rule.sla_hours !== undefined) {
    if (typeof rule.sla_hours !== 'number' || rule.sla_hours <= 0 || !Number.isFinite(rule.sla_hours)) {
      throw new AlertRoutingError('invalid_sla', 'sla_hours must be a positive number or null');
    }
  }
  if (rule.escalate_after_hours !== null && rule.escalate_after_hours !== undefined) {
    if (
      typeof rule.escalate_after_hours !== 'number' ||
      rule.escalate_after_hours <= 0 ||
      !Number.isFinite(rule.escalate_after_hours)
    ) {
      throw new AlertRoutingError(
        'invalid_escalation',
        'escalate_after_hours must be a positive number or null',
      );
    }
    // escalation < SLA invariant
    if (
      rule.sla_hours !== null &&
      rule.sla_hours !== undefined &&
      rule.escalate_after_hours >= rule.sla_hours
    ) {
      throw new AlertRoutingError(
        'invalid_escalation',
        'escalate_after_hours must be < sla_hours',
      );
    }
  }
  if (typeof rule.monitor_only !== 'boolean') {
    throw new AlertRoutingError('invalid_monitor_only', 'monitor_only must be a boolean');
  }
  // monitor_only ⇒ no SLA, no escalation
  if (rule.monitor_only && (rule.sla_hours !== null || rule.escalate_after_hours !== null)) {
    throw new AlertRoutingError(
      'invalid_monitor_only',
      'monitor_only=true requires sla_hours=null AND escalate_after_hours=null',
    );
  }

  return {
    class: cls,
    primary_assignee: rule.primary_assignee,
    secondary_assignee: rule.secondary_assignee ?? null,
    channels: [...rule.channels],
    sla_hours: rule.sla_hours ?? null,
    escalate_after_hours: rule.escalate_after_hours ?? null,
    monitor_only: rule.monitor_only,
  };
}

// ─── Engine + store ────────────────────────────────────────────────────

export interface AlertRoutingEngine {
  /**
   * Decide the routing for an alert. Pure-ish: tenant overrides come
   * from the engine's per-tenant store; the same severity+tenant on
   * the same overrides yields the same decision.
   */
  route(tenant_id: string, severity: SeverityInput): RoutingDecision;
  /** Effective rules for a tenant — defaults merged with overrides. */
  listRules(tenant_id: string): RoutingRule[];
  /** The single effective rule for a class (default or override). */
  getRule(tenant_id: string, cls: BilAlertClass): { rule: RoutingRule; source: 'platform_default' | 'tenant_override' };
  /** Set/update a tenant's override for a class. Validates the rule. */
  setOverride(tenant_id: string, rule: Partial<RoutingRule>): RoutingRule;
  /** Clear a tenant's override for a class — reverts to platform default. */
  clearOverride(tenant_id: string, cls: BilAlertClass): RoutingRule;
}

export class InMemoryAlertRoutingEngine implements AlertRoutingEngine {
  /** tenant_id → class → override. */
  private readonly overrides = new Map<string, Map<BilAlertClass, RoutingRule>>();

  route(tenant_id: string, severity: SeverityInput): RoutingDecision {
    const cls = classifyAlertSeverity(severity);
    const { rule, source } = this.getRule(tenant_id, cls);
    return { class: cls, severity_in: String(severity), rule, source };
  }

  listRules(tenant_id: string): RoutingRule[] {
    return VALID_CLASSES.map((c) => this.getRule(tenant_id, c).rule);
  }

  getRule(
    tenant_id: string,
    cls: BilAlertClass,
  ): { rule: RoutingRule; source: 'platform_default' | 'tenant_override' } {
    const ov = this.overrides.get(tenant_id)?.get(cls);
    if (ov) return { rule: ov, source: 'tenant_override' };
    return { rule: DEFAULT_RULES[cls], source: 'platform_default' };
  }

  setOverride(tenant_id: string, rule: Partial<RoutingRule>): RoutingRule {
    const validated = validateRule(rule);
    let tMap = this.overrides.get(tenant_id);
    if (!tMap) {
      tMap = new Map();
      this.overrides.set(tenant_id, tMap);
    }
    tMap.set(validated.class, validated);
    return validated;
  }

  clearOverride(tenant_id: string, cls: BilAlertClass): RoutingRule {
    if (!VALID_CLASSES.includes(cls)) {
      throw new AlertRoutingError('invalid_class', `class must be one of ${VALID_CLASSES.join(',')}`);
    }
    this.overrides.get(tenant_id)?.delete(cls);
    return DEFAULT_RULES[cls];
  }

  /** Test helper. */
  reset(): void {
    this.overrides.clear();
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultAlertRoutingEngine: AlertRoutingEngine = new InMemoryAlertRoutingEngine();
