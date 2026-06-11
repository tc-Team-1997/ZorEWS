// services/bff/src/alert_escalation_patterns.ts
//
// T6 M8.23 — Alert escalation pattern analysis.
//
// Analyzes alert routing records to find escalation patterns.
// An alert is "escalated" if acked_at is after sla_deadline OR
// still open past escalation_deadline.

import type { RoutingLedger, RoutedAlertRecord } from './alert_routing_analytics';
import type { BilAlertClass } from './bil_alert_classification';

// ─── Public types ──────────────────────────────────────────────────────

export interface AlertEscalationPatternsResult {
  tenant_id: string;
  generated_at: string;
  total_records_analyzed: number;
  total_escalations: number;
  escalation_rate: number;
  by_class: Record<BilAlertClass, number>;
  escalation_rate_by_class: Record<BilAlertClass, number>;
  most_escalated_class: BilAlertClass | null;
  avg_escalation_hours: number | null;
}

const BIL_CLASSES: BilAlertClass[] = ['red', 'orange', 'yellow', 'green'];

// ─── Helper ──────────────────────────────────────────────────────────

function isEscalated(record: RoutedAlertRecord, now: Date): boolean {
  if (record.monitor_only) return false;
  const nowMs = now.getTime();
  const createdMs = new Date(record.created_at).getTime();

  if (record.sla_hours !== null) {
    const slaDeadlineMs = createdMs + record.sla_hours * 3600 * 1000;
    if (record.acked_at) {
      const ackedMs = new Date(record.acked_at).getTime();
      if (ackedMs > slaDeadlineMs) return true;
    } else {
      // Still open past SLA
      if (nowMs > slaDeadlineMs) return true;
    }
  }

  if (record.escalate_after_hours !== null && !record.acked_at) {
    const escalateDeadlineMs = createdMs + record.escalate_after_hours * 3600 * 1000;
    if (nowMs > escalateDeadlineMs) return true;
  }

  return false;
}

// ─── Main function ────────────────────────────────────────────────────

export function analyzeAlertEscalationPatterns(
  tenant_id: string,
  ledger: RoutingLedger,
  now: Date,
  window: number = 100,
): AlertEscalationPatternsResult {
  const records = ledger.list(tenant_id, window);
  const total_records_analyzed = records.length;

  const by_class: Record<BilAlertClass, number> = {
    red: 0,
    orange: 0,
    yellow: 0,
    green: 0,
  };
  const class_totals: Record<BilAlertClass, number> = {
    red: 0,
    orange: 0,
    yellow: 0,
    green: 0,
  };

  const escalationTimes: number[] = [];

  for (const record of records) {
    const cls = record.class as BilAlertClass;
    if (!BIL_CLASSES.includes(cls)) continue;

    class_totals[cls]++;

    if (isEscalated(record, now)) {
      by_class[cls]++;

      // Compute time to ack (if acked) as the escalation time
      if (record.acked_at) {
        const createdMs = new Date(record.created_at).getTime();
        const ackedMs = new Date(record.acked_at).getTime();
        const hours = (ackedMs - createdMs) / 3600000;
        if (hours > 0 && hours < 10000) {
          escalationTimes.push(hours);
        }
      }
    }
  }

  const total_escalations = BIL_CLASSES.reduce((s, cls) => s + by_class[cls], 0);
  const escalation_rate =
    total_records_analyzed > 0
      ? Math.round((total_escalations / total_records_analyzed) * 10000) / 10000
      : 0;

  const escalation_rate_by_class: Record<BilAlertClass, number> = {
    red: 0,
    orange: 0,
    yellow: 0,
    green: 0,
  };
  for (const cls of BIL_CLASSES) {
    escalation_rate_by_class[cls] =
      class_totals[cls] > 0
        ? Math.round((by_class[cls] / class_totals[cls]) * 10000) / 10000
        : 0;
  }

  let most_escalated_class: BilAlertClass | null = null;
  let maxEsc = -1;
  for (const cls of BIL_CLASSES) {
    if (by_class[cls] > maxEsc) {
      maxEsc = by_class[cls];
      most_escalated_class = cls;
    }
  }
  if (maxEsc === 0) most_escalated_class = null;

  const avg_escalation_hours =
    escalationTimes.length > 0
      ? Math.round(
          (escalationTimes.reduce((s, h) => s + h, 0) / escalationTimes.length) * 100,
        ) / 100
      : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_records_analyzed,
    total_escalations,
    escalation_rate,
    by_class,
    escalation_rate_by_class,
    most_escalated_class,
    avg_escalation_hours,
  };
}
