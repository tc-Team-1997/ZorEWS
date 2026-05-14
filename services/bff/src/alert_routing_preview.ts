// services/bff/src/alert_routing_preview.ts
//
// T6 M8.7 — Alert routing decision preview.
//
// M8.2 ships the routing matrix + `route(tenant, severity)` decision
// engine that returns the matched RoutingRule. /v1/alerts/routing/decide
// already exposes it. What ops want next is a richer "what happens
// if I fire this alert RIGHT NOW?" view that includes:
//   - the computed SLA deadline (when the alert MUST be ack'd)
//   - the computed escalation deadline (when M8.3 auto-escalates)
//   - the ordered notification_chain (channel → assignee_role)
//     so the SPA can render "primary email + sms head_of_risk, then
//     secondary in_app supervisor" as a numbered list
// M8.7 ships the dry-run preview. Pure function over the existing
// engine — no new state, no audit events. Read-only.
//
// Design:
//  - Pure decorator on top of `engine.route()`. The engine already
//    handles tenant_override resolution; we just add temporal +
//    chain-shape projections.
//  - `at` is the reference clock. Defaults are the route's `now()`.
//  - SLA + escalation deadlines are derived as `at + hours` and
//    serialized as ISO. Both null when monitor_only.

import {
  type AlertRoutingEngine,
  type AssigneeRole,
  type NotificationChannel,
  type RoutingDecision,
  type RoutingRule,
} from './alert_routing';
import { type SeverityInput } from './bil_alert_classification';

// ─── Public types ─────────────────────────────────────────────────────

export interface NotificationLink {
  /** 1-based ordinal for the chain renderer. */
  step_no: number;
  channel: NotificationChannel;
  /** Either the primary or secondary role; secondary always comes after
   *  primary in the chain. */
  assignee_role: AssigneeRole;
  /** 'primary' for the first channel × primary, 'secondary' for the
   *  channels delivered to the secondary CC. Distinguishes how the SPA
   *  renders the chain visually. */
  tier: 'primary' | 'secondary';
}

export interface AlertRoutingPreview {
  /** Echo of the severity input the caller passed. */
  severity_in: string;
  /** BIL class the severity classified into. */
  class: RoutingDecision['class'];
  /** Whether the matched rule was a tenant override or platform default. */
  source: RoutingDecision['source'];
  /** Effective rule (post-override). */
  rule: RoutingRule;
  /** ISO timestamp of the reference clock used to compute deadlines. */
  applied_at: string;
  /** ISO of when the alert MUST be ack'd. null when monitor_only. */
  sla_deadline: string | null;
  /** ISO of when M8.3 auto-escalation fires. null when monitor_only or
   *  no escalation configured. */
  escalation_deadline: string | null;
  /** Ordered chain of {channel, assignee_role, tier} pairs the SPA
   *  renders as the notification flow. Empty when monitor_only AND
   *  primary='none' (green-class default). */
  notifications_chain: NotificationLink[];
  /** Whether the routing is monitor-only (green class default). */
  monitor_only: boolean;
}

// ─── Pure preview ─────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

function addHoursIso(at: Date, hours: number | null): string | null {
  if (hours === null) return null;
  return new Date(at.getTime() + hours * HOUR_MS).toISOString();
}

/**
 * Pure preview decorator. Takes the routing engine + tenant +
 * severity + reference clock, returns the full preview envelope.
 */
export function previewAlertRouting(
  engine: AlertRoutingEngine,
  tenant_id: string,
  severity: SeverityInput,
  at: Date,
): AlertRoutingPreview {
  const decision = engine.route(tenant_id, severity);
  const rule = decision.rule;
  const sla_deadline = rule.monitor_only ? null : addHoursIso(at, rule.sla_hours);
  const escalation_deadline = rule.monitor_only
    ? null
    : addHoursIso(at, rule.escalate_after_hours);

  const chain: NotificationLink[] = [];
  let step = 1;
  // Primary tier — every channel × primary_assignee. Skip when
  // primary_assignee='none' (green default).
  if (rule.primary_assignee !== 'none') {
    for (const channel of rule.channels) {
      chain.push({
        step_no: step++,
        channel,
        assignee_role: rule.primary_assignee,
        tier: 'primary',
      });
    }
  }
  // Secondary tier — every channel × secondary_assignee. Only when
  // secondary is set (red+orange have one; yellow doesn't).
  if (rule.secondary_assignee !== null && rule.secondary_assignee !== 'none') {
    for (const channel of rule.channels) {
      chain.push({
        step_no: step++,
        channel,
        assignee_role: rule.secondary_assignee,
        tier: 'secondary',
      });
    }
  }

  return {
    severity_in: decision.severity_in,
    class: decision.class,
    source: decision.source,
    rule,
    applied_at: at.toISOString(),
    sla_deadline,
    escalation_deadline,
    notifications_chain: chain,
    monitor_only: rule.monitor_only,
  };
}
